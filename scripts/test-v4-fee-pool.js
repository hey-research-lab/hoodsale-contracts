// Opens a small hookless Uniswap v4 pool with a high LP fee, the shape of the planned "fee mode":
// the trading tax is the pool's own fee instead of a hook, so Uniswap's router needs no allowlist
// entry. The point is to see, on the real chain, whether the Uniswap app quotes such a pool and
// how fast the trackers pick it up, before any platform contract is written for it.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/test-v4-fee-pool.js --network robinhood
//
// Environment:
//   ETH=0.004          ETH put into the pool (default 0.004)
//   TOKENS=500000      tokens put into the pool (default 500000 of a 1,000,000 supply)
//   FEE_BPS=325        pool fee in bps (default 325 = 3.25%)
//   TOKEN=0x...        reuse an already deployed test token instead of deploying one
//
// Deploys a plain ERC-20 (the MockERC20 of the test suite), initializes ETH/token at the price the
// two amounts imply, mints one full-range position to the deployer's wallet and prints the links
// to check. The position stays in the wallet; it can be withdrawn later through the Uniswap app.
// Nothing here prints or stores a private key.
const hre = require("hardhat");
const { v4For, V4_BY_CHAIN } = require("./lib/uniswap-v4");

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

// TickMath.getSqrtPriceAtTick, ported from v4-core (same constants, same rounding).
const TICK_CONSTANTS = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

function getSqrtPriceAtTick(tick) {
  const absTick = Math.abs(tick);
  let price = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, c] of TICK_CONSTANTS) if (absTick & bit) price = (price * c) >> 128n;
  if (tick > 0) price = MAX_UINT256 / price;
  return (price + ((1n << 32n) - 1n)) >> 32n;
}

const usableTick = (tick, spacing) => BigInt(Math.trunc(tick / spacing) * spacing);
const mulDiv = (a, b, d) => (a * b) / d;

/** LiquidityAmounts.getLiquidityForAmounts for a price inside the range. */
function liquidityFor(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  if (sqrtP <= sqrtA) return mulDiv(amount0, mulDiv(sqrtA, sqrtB, Q96), sqrtB - sqrtA);
  if (sqrtP >= sqrtB) return mulDiv(amount1, Q96, sqrtB - sqrtA);
  const l0 = mulDiv(amount0, mulDiv(sqrtP, sqrtB, Q96), sqrtB - sqrtP);
  const l1 = mulDiv(amount1, Q96, sqrtP - sqrtA);
  return l0 < l1 ? l0 : l1;
}

function bigintSqrt(x) {
  if (x < 2n) return x;
  let z = x;
  let y = x / 2n + 1n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const { chainId } = await hre.ethers.provider.getNetwork();
  // A mainnet fork keeps the mainnet contracts but answers with the local chain id.
  const v4 = await v4For(hre, process.env.FORK_URL ? V4_BY_CHAIN[4663] : {});
  if (!v4) throw new Error(`no Uniswap v4 known for chain ${chainId}`);
  if (process.env.FORK_URL) await hre.network.provider.send("evm_mine");

  const ethAmount = hre.ethers.parseEther(process.env.ETH || "0.004");
  const tokenAmount = hre.ethers.parseEther(process.env.TOKENS || "500000");
  const feeBps = Number(process.env.FEE_BPS || 325);
  const fee = feeBps * 100; // pips
  const tickSpacing = 200;
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Fee mode test pool on chain ${chainId} with ${deployer.address}, balance ${hre.ethers.formatEther(balance)} ETH`);
  console.log(`  pool fee ${feeBps / 100}%, liquidity ${hre.ethers.formatEther(ethAmount)} ETH + ${hre.ethers.formatEther(tokenAmount)} tokens`);

  // ---------------------------------------------------------------- token
  let token;
  if (process.env.TOKEN) {
    token = await hre.ethers.getContractAt("MockERC20", process.env.TOKEN);
    console.log(`Token: reusing ${token.target}`);
  } else {
    token = await hre.ethers.deployContract("MockERC20", ["Fee Mode Test", "FEETEST", 18, hre.ethers.parseEther("1000000")]);
    await token.waitForDeployment();
    console.log(`Token: deployed ${token.target}`);
  }

  // ----------------------------------------------------------------- pool
  const key = { currency0: hre.ethers.ZeroAddress, currency1: token.target, fee, tickSpacing, hooks: hre.ethers.ZeroAddress };
  const keyTuple = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
  const coder = hre.ethers.AbiCoder.defaultAbiCoder();
  const KEY = "(address,address,uint24,int24,address)";
  const poolId = hre.ethers.keccak256(coder.encode([KEY], [keyTuple]));

  const poolManager = new hre.ethers.Contract(
    v4.poolManager,
    [`function initialize(${KEY} key, uint160 sqrtPriceX96) returns (int24)`],
    deployer
  );
  const stateView = new hre.ethers.Contract(
    v4.stateView,
    ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"],
    deployer
  );
  // sqrt(token per ETH) in Q64.96: currency1 over currency0.
  const sqrtPriceX96 = bigintSqrt((tokenAmount * (1n << 192n)) / ethAmount);
  const slot0 = await stateView.getSlot0(poolId);
  if (slot0.sqrtPriceX96 === 0n) {
    await (await poolManager.initialize(keyTuple, sqrtPriceX96)).wait();
    console.log(`Pool: initialized ${poolId}`);
  } else {
    console.log(`Pool: already open ${poolId}`);
  }

  // ------------------------------------------------------------- position
  const tickLower = usableTick(MIN_TICK, tickSpacing);
  const tickUpper = usableTick(MAX_TICK, tickSpacing);
  const liquidity = liquidityFor(
    sqrtPriceX96,
    getSqrtPriceAtTick(Number(tickLower)),
    getSqrtPriceAtTick(Number(tickUpper)),
    ethAmount,
    tokenAmount
  );
  if (liquidity === 0n) throw new Error("zero liquidity");

  const permit2 = new hre.ethers.Contract(
    v4.permit2,
    ["function approve(address token, address spender, uint160 amount, uint48 expiration)"],
    deployer
  );
  const allowance = await token.allowance(deployer.address, v4.permit2);
  if (allowance < tokenAmount) await (await token.approve(v4.permit2, hre.ethers.MaxUint256)).wait();
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  await (await permit2.approve(token.target, v4.positionManager, tokenAmount, deadline)).wait();

  const actions = hre.ethers.solidityPacked(["uint8", "uint8", "uint8"], [0x02, 0x0d, 0x14]); // MINT_POSITION, SETTLE_PAIR, SWEEP
  const params = [
    coder.encode(
      [KEY, "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"],
      [keyTuple, tickLower, tickUpper, liquidity, ethAmount, tokenAmount, deployer.address, "0x"]
    ),
    coder.encode(["address", "address"], [key.currency0, key.currency1]),
    coder.encode(["address", "address"], [key.currency0, deployer.address]),
  ];
  const positionManager = new hre.ethers.Contract(
    v4.positionManager,
    ["function modifyLiquidities(bytes unlockData, uint256 deadline) payable", "function nextTokenId() view returns (uint256)"],
    deployer
  );
  const tokenId = await positionManager.nextTokenId();
  const tx = await positionManager.modifyLiquidities(coder.encode(["bytes", "bytes[]"], [actions, params]), deadline, { value: ethAmount });
  const receipt = await tx.wait();
  console.log(`Position: minted #${tokenId} to ${deployer.address}, gas ${receipt.gasUsed}, tx ${receipt.hash}`);

  const after = await stateView.getSlot0(poolId);
  console.log(`\nPool ${poolId}`);
  console.log(`  token      ${token.target}`);
  console.log(`  fee        ${Number(after.lpFee) / 10000}% (protocol fee ${after.protocolFee})`);
  console.log(`  tick       ${after.tick}`);
  console.log("\nCheck");
  console.log(`  Uniswap app   https://app.uniswap.org/swap?chain=robinhood&inputCurrency=ETH&outputCurrency=${token.target}`);
  console.log(`  Uniswap pool  https://app.uniswap.org/explore/pools/robinhood/${poolId}`);
  console.log(`  DexScreener   https://dexscreener.com/robinhood/${poolId}`);
  console.log(`  GeckoTerminal https://www.geckoterminal.com/robinhood/pools/${poolId}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
