// Phase 0 proof for the v4 "fee mode": opens one small ETH/token pool behind HoodSaleV4FeeHook on
// the real chain, to see whether the Uniswap app and the trackers accept a pool whose hook only
// gates initialization and liquidity (address flags 0x2800). scripts/test-v4-fee-pool.js proved the
// same for a hookless pool; the platform needs the gate, so this is the pool shape that matters.
//
//   DEPLOYER_KEY=0x... npx hardhat run scripts/test-v4-fee-hook-pool.js --network robinhood
//
// Steps, chosen with STEP:
//   open      (default) deploy a test token, the proof launcher and the hook, open the pool with
//             register, initialize and the launch mint in one call, then check the gate by
//             simulation. The addresses are written to deployments/fee-hook-proof.json.
//   collect   after a buy and a sell through the Uniswap app: collect the position's fees, sell
//             the token part for ETH, pay the shares out, and print every figure.
//   rehearse  fork only: open, trade with a test swapper, collect, and assert the results.
//
// Environment:
//   ETH=0.004          ETH put into the pool (default 0.004)
//   TOKENS=500000      tokens put into the pool (default 500000 of a 1,000,000 supply)
//   MARKETING_BPS=200  marketing share in bps (default 200)
//   REWARDS_BPS=100    rewards share in bps (default 100); with the platform's 25 the fee is 3.25%
//
// The liquidity cannot be taken back: the hook holds the position for good, which is the design
// under test. Every share of the fee is paid to the deployer's own wallet. Nothing here prints or
// stores a private key.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { v4For, V4_BY_CHAIN } = require("./lib/uniswap-v4");
const Miner = require("./lib/hook-miner");

const STATE_FILE = path.join(__dirname, "..", "deployments", "fee-hook-proof.json");
const KEY = "(address,address,uint24,int24,address)";
const FAR = 2n ** 40n;
const { ethers } = hre;
const coder = ethers.AbiCoder.defaultAbiCoder();
const fmt = (x) => ethers.formatEther(x);

function mintCalldata(keyTuple, tickLower, tickUpper, liquidity, amount0Max, amount1Max, recipient, sweepTo) {
  const actions = ethers.solidityPacked(["uint8", "uint8", "uint8"], [0x02, 0x0d, 0x14]); // MINT_POSITION, SETTLE_PAIR, SWEEP
  const params = [
    coder.encode([KEY, "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"], [keyTuple, tickLower, tickUpper, liquidity, amount0Max, amount1Max, recipient, "0x"]),
    coder.encode(["address", "address"], [keyTuple[0], keyTuple[1]]),
    coder.encode(["address", "address"], [keyTuple[0], sweepTo]),
  ];
  return coder.encode(["bytes", "bytes[]"], [actions, params]);
}

// The proof instance opened on mainnet on 2026-09-20 carries the first convert signature,
// (id, minEthOut, deadline). The hook in this repo has since gained a quoted size, so a record
// without `convertArgs` is read through this ABI instead of the current artifact.
const PROOF_V0_HOOK_ABI = [
  "function collect(bytes32 id) returns (uint256 ethFees, uint256 tokenFees)",
  "function convert(bytes32 id, uint256 minEthOut, uint256 deadline) returns (uint256 tokensSold, uint256 ethOut)",
  "function flush(bytes32 id)",
  "function flushPlatform()",
  "function pendingTokens(bytes32 id) view returns (uint256)",
  "function nextConvertAt(bytes32 id) view returns (uint256)",
  "function pendingMarketing(bytes32 id) view returns (uint256)",
  "function pendingRewards(bytes32 id) view returns (uint256)",
  "function pendingPlatform() view returns (uint256)",
];

/** A call that must revert. Simulated only, so it costs nothing. */
async function mustRevert(label, call) {
  try {
    await call();
  } catch (e) {
    console.log(`  refused   ${label}`);
    return;
  }
  throw new Error(`gate is open: ${label} did not revert`);
}

async function context() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const { chainId } = await ethers.provider.getNetwork();
  // A mainnet fork keeps the mainnet contracts but answers with the local chain id.
  const v4 = await v4For(hre, process.env.FORK_URL ? V4_BY_CHAIN[4663] : {});
  if (!v4) throw new Error(`no Uniswap v4 known for chain ${chainId}`);
  if (process.env.FORK_URL) await hre.network.provider.send("evm_mine");
  const positionManager = new ethers.Contract(
    v4.positionManager,
    [
      "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
      "function nextTokenId() view returns (uint256)",
      "function ownerOf(uint256) view returns (address)",
      "function getPositionLiquidity(uint256) view returns (uint128)",
    ],
    deployer
  );
  const poolManager = new ethers.Contract(v4.poolManager, [`function initialize(${KEY} key, uint160 sqrtPriceX96) returns (int24)`], deployer);
  const stateView = new ethers.Contract(
    v4.stateView,
    [
      "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
      "function getLiquidity(bytes32) view returns (uint128)",
    ],
    deployer
  );
  return { deployer, chainId, v4, positionManager, poolManager, stateView };
}

async function open(ctx) {
  const { deployer, chainId, v4, positionManager, poolManager, stateView } = ctx;
  const ethAmount = ethers.parseEther(process.env.ETH || "0.004");
  const tokenAmount = ethers.parseEther(process.env.TOKENS || "500000");
  const marketingBps = BigInt(process.env.MARKETING_BPS || 200);
  const rewardsBps = BigInt(process.env.REWARDS_BPS || 100);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Fee hook proof on chain ${chainId} with ${deployer.address}, balance ${fmt(balance)} ETH`);

  const token = await ethers.deployContract("MockOwnedERC20", ["Fee Hook Test", "FEEHOOK", ethers.parseEther("1000000"), deployer.address]);
  await token.waitForDeployment();
  console.log(`Token     ${token.target}`);

  const launcher = await ethers.deployContract("FeeHookProofLauncher", [v4.poolManager, v4.positionManager, v4.permit2]);
  await launcher.waitForDeployment();
  console.log(`Launcher  ${launcher.target}`);

  const initcode = await Miner.feeHookInitcode(hre, v4.poolManager, v4.positionManager, launcher.target, deployer.address);
  const mined = Miner.mineHookSalt(ethers, initcode, Miner.FEE_HOOK_FLAGS);
  await Miner.deployWithCreate2(hre, deployer, initcode, mined.salt, mined.address);
  const hook = await ethers.getContractAt("HoodSaleV4FeeHook", mined.address);
  const flags = BigInt(hook.target) & BigInt(Miner.ALL_HOOK_MASK);
  if (flags !== 0x2800n) throw new Error(`hook flags are 0x${flags.toString(16)}, not 0x2800`);
  console.log(`Hook      ${hook.target} (flags 0x${flags.toString(16)}, salt tried ${mined.tried})`);
  await (await launcher.setHook(hook.target)).wait();

  await (await token.approve(launcher.target, tokenAmount)).wait();
  const tx = await launcher.launch(token.target, tokenAmount, deployer.address, marketingBps, rewardsBps, { value: ethAmount });
  const receipt = await tx.wait();
  const poolId = await hook.poolIdOf(token.target);
  const tokenId = await hook.positionIdOf(poolId);
  console.log(`Launch    tx ${receipt.hash}, gas ${receipt.gasUsed}`);

  // ------------------------------------------------------------------ checks
  const slot0 = await stateView.getSlot0(poolId);
  const fee = Number(slot0.lpFee);
  const keyTuple = [ethers.ZeroAddress, token.target, fee, 200, hook.target];
  const owner = await positionManager.ownerOf(tokenId);
  const positionLiquidity = await positionManager.getPositionLiquidity(tokenId);
  const poolLiquidity = await stateView.getLiquidity(poolId);
  if (owner !== hook.target) throw new Error("the hook does not hold the launch position");
  if (positionLiquidity !== poolLiquidity) throw new Error("pool liquidity is not the launch position's");
  if (!(await hook.seeded(poolId))) throw new Error("pool is not seeded");
  console.log(`Position  #${tokenId}, held by the hook, liquidity ${positionLiquidity} = the pool's`);

  console.log("Gate");
  const lower = -887200n;
  const upper = 887200n;
  const tryMint = (tickLower, tickUpper, recipient) =>
    positionManager.modifyLiquidities.staticCall(
      mintCalldata(keyTuple, tickLower, tickUpper, 10n ** 12n, ethAmount, tokenAmount, recipient, deployer.address),
      FAR,
      { value: ethAmount }
    );
  // The deployer is a stranger to the pool now: it holds tokens and ETH, and nothing lets it in.
  const permit2 = new ethers.Contract(v4.permit2, ["function approve(address token, address spender, uint160 amount, uint48 expiration)"], deployer);
  await (await token.approve(v4.permit2, ethers.MaxUint256)).wait();
  await (await permit2.approve(token.target, v4.positionManager, tokenAmount, Math.floor(Date.now() / 1000) + 3600)).wait();
  await mustRevert("a second full-range position", () => tryMint(lower, upper, deployer.address));
  await mustRevert("a full-range position owned by the hook", () => tryMint(lower, upper, hook.target));
  await mustRevert("a narrow position around the price", () => tryMint(BigInt(slot0.tick) / 200n * 200n - 200n, BigInt(slot0.tick) / 200n * 200n + 200n, deployer.address));
  const otherKey = [ethers.ZeroAddress, token.target, 10000, 200, hook.target];
  await mustRevert("a second pool opened with the hook", () => poolManager.initialize.staticCall(otherKey, slot0.sqrtPriceX96));

  const state = {
    chainId: Number(chainId),
    openedAt: new Date().toISOString(),
    token: token.target,
    launcher: launcher.target,
    hook: hook.target,
    hookSalt: mined.salt,
    poolId,
    tokenId: tokenId.toString(),
    feePips: fee,
    marketingBps: Number(marketingBps),
    rewardsBps: Number(rewardsBps),
    eth: fmt(ethAmount),
    tokens: fmt(tokenAmount),
    launchTx: receipt.hash,
    convertArgs: 4,
  };
  if (!process.env.FORK_URL) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  console.log(`\nPool ${poolId}`);
  console.log(`  token      ${token.target}`);
  console.log(`  hook       ${hook.target}`);
  console.log(`  fee        ${fee / 10000}% (protocol fee ${slot0.protocolFee})`);
  console.log("\nCheck");
  console.log(`  Uniswap app   https://app.uniswap.org/swap?chain=robinhood&inputCurrency=ETH&outputCurrency=${token.target}`);
  console.log(`  Uniswap pool  https://app.uniswap.org/explore/pools/robinhood/${poolId}`);
  console.log(`  DexScreener   https://dexscreener.com/robinhood/${poolId}`);
  console.log(`  GeckoTerminal https://www.geckoterminal.com/robinhood/pools/${poolId}`);
  return { ...state, tokenContract: token, hookContract: hook, keyTuple };
}

async function collect(ctx, state) {
  const { deployer, positionManager } = ctx;
  const legacy = state.convertArgs === undefined;
  const hook = legacy
    ? new ethers.Contract(state.hook, PROOF_V0_HOOK_ABI, deployer)
    : await ethers.getContractAt("HoodSaleV4FeeHook", state.hook);
  const { poolId } = state;
  const liquidityBefore = await positionManager.getPositionLiquidity(state.tokenId);

  const waiting = await hook.collect.staticCall(poolId);
  console.log(`Waiting in the position: ${fmt(waiting.ethFees)} ETH and ${fmt(waiting.tokenFees)} tokens`);
  if (waiting.ethFees === 0n && waiting.tokenFees === 0n && (await hook.pendingTokens(poolId)) === 0n) {
    console.log("Nothing to collect yet: make a buy and a sell through the Uniswap app first.");
    return;
  }
  const c = await (await hook.collect(poolId)).wait();
  console.log(`Collected, gas ${c.gasUsed}, tx ${c.hash}`);

  const pendingTokens = await hook.pendingTokens(poolId);
  const { timestamp } = await ethers.provider.getBlock("latest");
  const nextConvertAt = await hook.nextConvertAt(poolId);
  if (pendingTokens > 0n && BigInt(timestamp) < nextConvertAt) {
    console.log(`Conversion is cooling down for another ${nextConvertAt - BigInt(timestamp)} s; run this step again after that.`);
  } else if (pendingTokens > 0n) {
    // The floor is 3% under what the conversion returns right now, for the size it sells right now.
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const preview = legacy ? await hook.convert.staticCall(poolId, 0, FAR) : await hook.convert.staticCall(poolId, 1, 0, FAR);
    const floor = (preview.ethOut * 97n) / 100n;
    const sent = legacy ? hook.convert(poolId, floor, deadline) : hook.convert(poolId, preview.tokensSold, floor, deadline);
    const v = await (await sent).wait();
    console.log(`Converted ${fmt(preview.tokensSold)} tokens for about ${fmt(preview.ethOut)} ETH, gas ${v.gasUsed}, tx ${v.hash}`);
    console.log(`  tokens still waiting ${fmt(await hook.pendingTokens(poolId))}`);
  } else {
    console.log("No token fees to convert: no sell has gone through the pool yet.");
  }

  const marketing = await hook.pendingMarketing(poolId);
  const rewards = await hook.pendingRewards(poolId);
  const platform = await hook.pendingPlatform();
  const held = await ethers.provider.getBalance(hook.target);
  console.log(`Booked: marketing ${fmt(marketing)}, rewards ${fmt(rewards)}, platform ${fmt(platform)} ETH (hook holds ${fmt(held)})`);
  if (marketing + rewards + platform !== held) throw new Error("the ledgers do not add up to the hook's balance");

  const before = await ethers.provider.getBalance(deployer.address);
  const f1 = await (await hook.flush(poolId)).wait();
  const f2 = await (await hook.flushPlatform()).wait();
  const after = await ethers.provider.getBalance(deployer.address);
  console.log(`Paid out to ${deployer.address}: wallet change ${fmt(after - before)} ETH after gas (tx ${f1.hash}, ${f2.hash})`);
  if ((await ethers.provider.getBalance(hook.target)) !== 0n) throw new Error("the hook still holds ETH after the payout");

  const liquidityAfter = await positionManager.getPositionLiquidity(state.tokenId);
  if (liquidityAfter !== liquidityBefore) throw new Error("the position's liquidity changed");
  if ((await positionManager.ownerOf(state.tokenId)) !== hook.target) throw new Error("the hook no longer holds the position");
  console.log(`Position #${state.tokenId} untouched: liquidity ${liquidityAfter}, held by the hook`);
  return { marketing, rewards, platform };
}

/** Fork only: trades against the pool with the test swapper, then runs the collect step. */
async function rehearse(ctx) {
  if (!process.env.FORK_URL) throw new Error("rehearse runs on a fork only");
  const state = await open(ctx);
  const { deployer, v4 } = ctx;
  const swapper = await ethers.deployContract("V4TestSwapper", [v4.poolManager]);
  await swapper.waitForDeployment();
  const token = state.tokenContract;
  const buyEth = ethers.parseEther("0.0005");
  await (await swapper.swapExactIn(state.keyTuple, true, buyEth, 0, deployer.address, { value: buyEth })).wait();
  const sellTokens = ethers.parseEther("10000");
  await (await token.approve(swapper.target, sellTokens)).wait();
  await (await swapper.swapExactIn(state.keyTuple, false, sellTokens, 0, deployer.address)).wait();
  console.log(`\nTraded: bought with ${fmt(buyEth)} ETH, sold ${fmt(sellTokens)} tokens`);

  const hook = state.hookContract;
  const waiting = await hook.collect.staticCall(state.poolId);
  const fee = BigInt(state.feePips);
  const near = (a, b) => (a > b ? a - b : b - a) <= 2n;
  if (!near(waiting.ethFees, (buyEth * fee) / 1000000n)) throw new Error(`ETH fee ${waiting.ethFees} is not the pool fee`);
  if (!near(waiting.tokenFees, (sellTokens * fee) / 1000000n)) throw new Error(`token fee ${waiting.tokenFees} is not the pool fee`);
  const booked = await collect(ctx, state);
  const total = 25n + BigInt(state.marketingBps) + BigInt(state.rewardsBps);
  console.log(`Split check: marketing ${(Number(booked.marketing * 10000n / (booked.marketing + booked.rewards + booked.platform)) / 100).toFixed(2)}% of the fee, expected ${(Number(BigInt(state.marketingBps) * 10000n / total) / 100).toFixed(2)}%`);
  console.log("\nRehearsal passed.");
}

async function main() {
  const ctx = await context();
  const step = process.env.STEP || "open";
  if (step === "open") return void (await open(ctx));
  if (step === "rehearse") return rehearse(ctx);
  if (step === "collect") {
    if (!fs.existsSync(STATE_FILE)) throw new Error(`no ${STATE_FILE}: run the open step first`);
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // A fork answers with the local chain id; there the step rehearses against the forked record.
    if (!process.env.FORK_URL && state.chainId !== Number(ctx.chainId)) throw new Error(`the proof was opened on chain ${state.chainId}`);
    return void (await collect(ctx, state));
  }
  throw new Error(`unknown STEP ${step}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
