// A fee mode launch run end to end from the terminal, the rehearsal sale of the fee mode release
// (docs/FEE-MODE-RELEASE.md) and the way a dev chain gets a fee mode launch with data in it. It
// creates a small token through the V4FeeLauncher, opens a presale for it, fills the sale,
// finalizes it so the Uniswap v4 pool opens with the tax as its fee, buys and sells a little
// through the site's fee mode router, and then does what the keeper does: collect the fees of the
// launch position, convert the token side with a quoted price floor, and send every share on.
// Every figure is printed. Everything happens from the deployer wallet.
//
// On a real chain the key is read without an echo, so it reaches neither the screen nor the shell
// history (never type DEPLOYER_KEY=0x... in front of a command):
//
//   cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && npx hardhat run scripts/test-v4-fee-launch.js --network robinhood
//
//   npx hardhat run scripts/test-v4-fee-launch.js --network localhost
//
// What it spends: the sale's hard cap (HARD_CAP, default 0.02 ETH) plus gas, plus the small test
// buy (TEST_BUY, default 0.002 ETH). Of the hard cap, the platform takes its share into the
// Treasury, the liquidity share goes into the pool and stays there for good (fee mode holds the
// launch position forever, whether the sale says Lock or Burn), and the rest comes straight back
// to the wallet at finalize. All the tokens stay in the wallet too.
//
// Optional environment:
//   KIND              tax (default: 3% marketing, so the pool's fee is 3.25%) or rewards (1%
//                     marketing and 2% to the holders, paid in REWARD_TOKEN)
//   ACTION            lock (default) or burn: what the sale asks for. Fee mode treats both alike
//   NAME, SYMBOL      the token (default "HoodSale Fee", "HSFEE"; "HoodSale Fee Rewards", "HSFR")
//   REWARD_TOKEN      the reward of a rewards token (default WETH)
//   HARD_CAP          the sale size in ETH (default 0.02)
//   TEST_BUY          the router buy in ETH (default 0.002); half of what it buys is sold again
//   SLIPPAGE_BPS      the slack below the quote that the conversion's price floor allows (default
//                     100, the keeper's V4_FEE_SLIPPAGE_BPS)
//   TOKEN=0x...       reuse a token this script already created, instead of making another
//   PRESALE=0x...     reuse a presale this script already opened
//   OPEN_TO_CREATE=1  when the launcher's creation brake is on and this wallet owns the launcher:
//                     open it, create the one token, close it again (three transactions). The
//                     brake never touches a launch, so everything after the token runs with it on
//   LEAVE_FEES=1      trade once more at the very end and leave those fees in the launch position,
//                     so the site's fee panel (and the keeper) has something waiting to collect
//
// Nothing here prints or stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { v4AddressesFor } = require("./lib/uniswap-v4");

const { ethers } = hre;
const E = ethers.parseEther;
const eth = ethers.formatEther;
const DAY = 86400n;
const BPS = 10_000n;
const LOCK = 0;
const BURN = 1;
const TAX = 1;
const REWARDS = 2;

// V4Quoter is not compiled by this project (v4-periphery builds at cancun), so it has no artifact
const V4_QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const pct = (part, whole) => (whole === 0n ? "0.00" : ((Number(part) / Number(whole)) * 100).toFixed(2));

async function main() {
  const network = hre.network.name;
  const live = network === "robinhood";
  const tx = (hash) => (live ? `https://robin.etherscan.io/tx/${hash}` : hash);
  const addr = (a) => (live ? `https://robin.etherscan.io/address/${a}` : a);
  const send = async (label, promise) => {
    const t = await promise;
    const r = await t.wait();
    console.log(`  ${label}: ${tx(t.hash)} (${r.gasUsed} gas)`);
    return r;
  };
  /** The arguments of every `name` event of `contract` in a receipt. */
  const events = (receipt, contract, name) =>
    receipt.logs
      .filter((l) => same(l.address, contract.target))
      .map((l) => contract.interface.parseLog(l))
      .filter((l) => l && l.name === name)
      .map((l) => l.args);

  const devChain = network === "localhost" || network === "hardhat";
  /**
   * The chain's clock. A dev node's only moves when it mines, and it may have been pushed ahead of
   * the wall clock, so its last block can be older than a start time or a deadline counted from
   * it: a block is mined there first.
   */
  const chainNow = async () => {
    if (devChain) await hre.network.provider.send("evm_mine", []);
    return BigInt((await ethers.provider.getBlock("latest")).timestamp);
  };

  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network}.json`), "utf8"));
  for (const k of ["v4FeeLauncher", "v4FeeHook", "v4FeeRouter", "presaleFactory", "tokenFactory", "lens", "treasury"]) {
    if (!d[k]) throw new Error(`deployments/${network}.json lacks ${k}: run scripts/deploy-v4-fee.js first`);
  }
  const [me] = await ethers.getSigners();
  if (!me) throw new Error("no signer: set DEPLOYER_KEY");

  const kind = (process.env.KIND || "tax").toLowerCase();
  if (!["tax", "rewards"].includes(kind)) throw new Error(`KIND is "${process.env.KIND}": tax or rewards`);
  const actionName = (process.env.ACTION || "lock").toLowerCase();
  if (!["lock", "burn"].includes(actionName)) throw new Error(`ACTION is "${process.env.ACTION}": lock or burn`);
  const tokenType = kind === "rewards" ? REWARDS : TAX;
  const liquidityAction = actionName === "burn" ? BURN : LOCK;
  const marketingBps = kind === "rewards" ? 100 : 300;
  const rewardsBps = kind === "rewards" ? 200 : 0;
  const hardCap = E(process.env.HARD_CAP || "0.02");
  const testBuy = E(process.env.TEST_BUY || "0.002");
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS || "100");
  const name = process.env.NAME || (kind === "rewards" ? "HoodSale Fee Rewards" : "HoodSale Fee");
  let symbol = process.env.SYMBOL || (kind === "rewards" ? "HSFR" : "HSFEE");

  const balance = await ethers.provider.getBalance(me.address);
  console.log(`Wallet ${me.address}, balance ${eth(balance)} ETH, network ${network}`);
  const needed = hardCap + testBuy + E("0.002"); // the rest is gas headroom
  if (balance < needed) throw new Error(`not enough ETH: the launch needs about ${eth(needed)} ETH`);

  const launcher = await ethers.getContractAt("V4FeeLauncher", d.v4FeeLauncher, me);
  const hook = await ethers.getContractAt("HoodSaleV4FeeHook", d.v4FeeHook, me);
  const router = await ethers.getContractAt("HoodSaleV4Router", d.v4FeeRouter, me);
  const presaleFactory = await ethers.getContractAt("PresaleFactory", d.presaleFactory, me);
  const tokenFactory = await ethers.getContractAt("TokenFactory", d.tokenFactory, me);
  const lens = await ethers.getContractAt("HoodSaleLens", d.lens, me);
  const treasury = await ethers.getContractAt("Treasury", d.treasury, me);
  if (!same(await launcher.hook(), d.v4FeeHook)) throw new Error("the fee launcher does not point at the recorded fee hook");
  if (!same(await router.launcher(), d.v4FeeLauncher)) throw new Error("the recorded fee router trades another launcher's pools");
  const { chainId } = await ethers.provider.getNetwork();
  const quoterAddress = d.v4Quoter || (v4AddressesFor(chainId) || {}).quoter;
  if (!quoterAddress) throw new Error("no Uniswap v4 quoter known for this chain: the conversion is never sent without a quote");
  const quoter = new ethers.Contract(quoterAddress, V4_QUOTER_ABI, me);

  // ------------------------------------------------------------ 1. token

  let tokenAddr = process.env.TOKEN;
  if (tokenAddr) {
    console.log(`\n1. Using the token ${tokenAddr}`);
    if (!same(await launcher.creatorOf(tokenAddr), me.address)) throw new Error(`${tokenAddr} was not created by this wallet through the fee launcher`);
  } else {
    const weth = await new ethers.Contract(await tokenFactory.router(), ["function WETH() view returns (address)"], ethers.provider).WETH();
    const rewardToken = kind === "rewards" ? process.env.REWARD_TOKEN || weth : ethers.ZeroAddress;
    const total = 25 + marketingBps + rewardsBps;
    console.log(`\n1. Creating ${name} (${symbol}), a ${kind === "rewards" ? "Rewards" : "Tax"} token for a Uniswap v4 pool in fee mode`);
    console.log(`  pool fee ${total / 100}% = 0.25% platform + ${marketingBps / 100}% marketing${rewardsBps ? ` + ${rewardsBps / 100}% holders, paid in ${rewardToken}` : ""}`);
    console.log("  one rate for buys and sells, fixed for good once the pool opens");
    const spec = { name, symbol, totalSupply: E("1000000"), rewardToken };
    const cfg = {
      marketingWallet: me.address,
      marketingBuyBps: marketingBps,
      marketingSellBps: marketingBps,
      rewardsBuyBps: rewardsBps,
      rewardsSellBps: rewardsBps,
      taxLocked: true,
      walletLocked: false,
    };
    const create = () => send("created", launcher.createToken(tokenType, spec, cfg, me.address));
    if (await launcher.creationOpen()) {
      await create();
    } else {
      // The owner's brake on createToken is on (the release keeps it on until the site is out)
      const owner = await launcher.owner();
      if (process.env.OPEN_TO_CREATE !== "1") {
        throw new Error(
          "V4FeeLauncher creation is closed. With OPEN_TO_CREATE=1 the launcher's owner opens it for this one createToken and closes it again"
        );
      }
      if (!same(owner, me.address)) throw new Error(`V4FeeLauncher creation is closed and only its owner ${owner} can open it`);
      await send("creation opened", launcher.setCreationOpen(true));
      try {
        await create();
      } finally {
        await send("creation closed again", launcher.setCreationOpen(false));
      }
    }
    const mine = await launcher.tokensOfCreator(me.address);
    tokenAddr = mine[mine.length - 1];
    console.log(`  token ${tokenAddr}`);
  }
  const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr, me);
  if (!same(await token.launcher(), d.v4FeeLauncher)) throw new Error(`${tokenAddr} is not a fee mode token of this launcher`);
  // A token that is reused says itself what it is; KIND and SYMBOL describe only a new one
  symbol = await token.symbol();
  const isRewards = Number((await tokenFactory.tokenInfo(tokenAddr)).tokenType) === REWARDS;

  // ------------------------------------------------------------ 2. presale

  let presaleAddr = process.env.PRESALE;
  if (presaleAddr) {
    console.log(`\n2. Using the presale ${presaleAddr}`);
  } else {
    const start = (await chainNow()) + 60n;
    // 20M tokens per ETH in the sale, listed at 16M per ETH, so the sale buys below the listing.
    const params = {
      token: tokenAddr,
      presaleRate: E("20000000"),
      listingRate: E("16000000"),
      softCap: hardCap / 4n,
      hardCap,
      minContribution: hardCap / 20n,
      maxContribution: hardCap,
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    const required = await presaleFactory.requiredTokensFor(params);
    console.log(`\n2. Opening a ${eth(hardCap)} ETH presale, 60% liquidity, the sale says ${actionName === "burn" ? "Burn" : "Lock for 30 days"}`);
    console.log("  fee mode holds the launch position forever either way");
    await send("approved", token.approve(d.presaleFactory, required));
    const fee = await presaleFactory.creationFee();
    await send("presale created", presaleFactory.createPresale(params, { value: fee }));
    presaleAddr = await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n);
    console.log(`  presale ${presaleAddr}`);
  }
  const presale = await ethers.getContractAt("Presale", presaleAddr, me);
  if (!(await presale.isV4Launch())) throw new Error("this presale would not list on Uniswap v4");

  // ------------------------------------------------------ 3. fill and launch

  const params = await presale.getParams();
  if (Number(await presale.state()) === 0) {
    process.stdout.write("\n3. Waiting for the sale to open");
    // A dev node only moves its clock when it mines, so a rehearsal there jumps to the start.
    if (devChain) {
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      if (now < params.startTime) {
        await hre.network.provider.send("evm_increaseTime", [Number(params.startTime - now) + 1]);
        await hre.network.provider.send("evm_mine", []);
      }
    }
    while (BigInt((await ethers.provider.getBlock("latest")).timestamp) < params.startTime) {
      process.stdout.write(".");
      await sleep(5000);
    }
    console.log("");
    const raised = await presale.totalRaised();
    if (raised < params.hardCap) {
      await send(`contributed ${eth(params.hardCap - raised)} ETH`, presale.contribute({ value: params.hardCap - raised }));
    }
    if (Number(await presale.state()) === 0) {
      console.log("\n4. Finalizing: the Uniswap v4 pool opens now, with the tax as its fee");
      const receipt = await send("finalized", presale.finalize(0, 0));
      for (const e of events(receipt, launcher, "LockTreatedAsForever")) {
        console.log(`  the sale asked for a ${e.lockDuration / DAY} day lock; the launcher treats it as forever (LockTreatedAsForever)`);
      }
    }
    await send("tokens claimed", presale.claim());
  } else {
    console.log("\n3-4. The sale is already finalized");
  }

  const launch = await launcher.launchOf(tokenAddr);
  if (!launch.done) throw new Error("the sale did not open a pool");
  const key = [...(await hook.poolKeyOf(launch.poolId))];
  const positionManager = new ethers.Contract(
    await launcher.positionManager(),
    ["function ownerOf(uint256) view returns (address)", "function getPositionLiquidity(uint256) view returns (uint128)"],
    ethers.provider
  );
  const holder = await positionManager.ownerOf(launch.tokenId);
  console.log(`  pool id ${launch.poolId}`);
  console.log(`  pool fee ${Number(key[2]) / 10000}% (${key[2]} pips), tick spacing ${key[3]}, hook ${key[4]}`);
  console.log(`  launch position #${launch.tokenId}, liquidity ${await positionManager.getPositionLiquidity(launch.tokenId)}`);
  console.log(`  held by ${holder}${same(holder, d.v4FeeHook) ? " (the fee hook, which has no way to move it)" : "  WARNING: not the fee hook"}`);
  console.log(`  the sale's lpLockId is ${await presale.lpLockId()}: fee mode uses no locker, the hook is the lock`);
  const view = await lens.launchView(presaleAddr);
  console.log(`  price ${eth(view.currentPriceWei)} ETH, liquidity ${eth(view.liquidityWeth)} ETH, pool kind ${view.poolKind === 1n ? "Uniswap v4" : "V2"}`);

  // ------------------------------------------------------------ 5. trade

  const feePips = BigInt(key[2]);
  const deadlineSoon = async () => (await chainNow()) + 600n;
  /** Buys `testBuy` ETH of the token through the fee mode router and sells half of it again. */
  const roundTrip = async () => {
    let deadline = await deadlineSoon();
    const tokensBefore = await token.balanceOf(me.address);
    await send("bought", router.buy(tokenAddr, 0, me.address, deadline, { value: testBuy }));
    const bought = (await token.balanceOf(me.address)) - tokensBefore;
    console.log(`  received ${eth(bought)} ${symbol}; the pool kept ${eth((testBuy * feePips) / 1_000_000n)} ETH of the buy as its fee`);
    const selling = bought / 2n;
    await send("router approved", token.approve(d.v4FeeRouter, selling));
    deadline = await deadlineSoon();
    const sold = await send("sold", router.sell(tokenAddr, selling, 0, me.address, deadline));
    const [swap] = events(sold, router, "Swapped");
    console.log(`  sold ${eth(selling)} ${symbol} for ${eth(swap.amountOut)} ETH; the pool kept ${eth((selling * feePips) / 1_000_000n)} ${symbol} of the sell as its fee`);
    return selling;
  };
  // What an earlier run or another trader left waiting is not this run's doing
  const [earlierEth, earlierTokens] = await hook.collect.staticCall(launch.poolId);
  console.log(`\n5. Buying ${eth(testBuy)} ETH of ${symbol} through the site's fee mode router, then selling half of it`);
  const selling = await roundTrip();

  // ---------------------------------------------------------- 6. the fees

  console.log("\n6. The fees, the way the keeper handles them");
  const [waitingEth, waitingTokens] = await hook.collect.staticCall(launch.poolId);
  console.log(`  waiting in the launch position: ${eth(waitingEth)} ETH and ${eth(waitingTokens)} ${symbol}`);
  console.log(
    `  of which these two trades paid ${eth(waitingEth - earlierEth)} ETH (${pct(waitingEth - earlierEth, testBuy)}% of the buy) ` +
      `and ${eth(waitingTokens - earlierTokens)} ${symbol} (${pct(waitingTokens - earlierTokens, selling)}% of the sell)`
  );
  const collected = await send("collected", hook.collect(launch.poolId));
  for (const e of events(collected, hook, "FeesCollected")) console.log(`  collected ${eth(e.ethFees)} ETH and ${eth(e.tokenFees)} ${symbol}`);
  for (const e of events(collected, hook, "FeeBooked")) {
    console.log(`  booked: platform ${eth(e.platform)} ETH, marketing ${eth(e.marketing)} ETH, holders ${eth(e.rewards)} ETH`);
  }

  // The token side is sold for ETH in the pool it came from. The hook picks the size itself (at
  // most maxConvert, once per cooldown); the caller only sets the price floor, as a quoted pair.
  const pendingTokens = await hook.pendingTokens(launch.poolId);
  const maxConvert = await hook.maxConvert(launch.poolId);
  const amount = pendingTokens < maxConvert ? pendingTokens : maxConvert;
  console.log(`  token fees waiting to be converted: ${eth(pendingTokens)} ${symbol}; one conversion sells at most ${eth(maxConvert)}`);
  const nextConvertAt = await hook.nextConvertAt(launch.poolId);
  const clock = BigInt((await ethers.provider.getBlock("latest")).timestamp);
  if (amount === 0n) {
    console.log("  nothing to convert");
  } else if (clock < nextConvertAt) {
    console.log(`  the pool converted less than five minutes ago; the next conversion is possible in ${nextConvertAt - clock} s (run again with TOKEN and PRESALE)`);
  } else {
    const [quoted] = await quoter.quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne: false, exactAmount: amount, hookData: "0x" });
    const minEthOut = (quoted * (BPS - slippageBps)) / BPS;
    console.log(`  quote for ${eth(amount)} ${symbol}: ${eth(quoted)} ETH; floor ${eth(minEthOut)} ETH (${Number(slippageBps) / 100}% below the quote)`);
    const converted = await send("converted", hook.convert(launch.poolId, amount, minEthOut, await deadlineSoon()));
    for (const e of events(converted, hook, "Converted")) {
      console.log(`  sold ${eth(e.tokensSold)} ${symbol} for ${eth(e.ethOut)} ETH (${pct(e.ethOut, quoted)}% of the quote)`);
    }
    for (const e of events(converted, hook, "FeeBooked")) {
      console.log(`  booked: platform ${eth(e.platform)} ETH, marketing ${eth(e.marketing)} ETH, holders ${eth(e.rewards)} ETH`);
    }
    console.log(`  still waiting: ${eth(await hook.pendingTokens(launch.poolId))} ${symbol}; the conversion's own fee is back in the position for the next collect`);
  }

  const [pendingMarketing, pendingRewards, pendingPlatform] = await Promise.all([
    hook.pendingMarketing(launch.poolId),
    hook.pendingRewards(launch.poolId),
    hook.pendingPlatform(),
  ]);
  console.log(`  owed now: marketing ${eth(pendingMarketing)} ETH, holders ${eth(pendingRewards)} ETH, platform ${eth(pendingPlatform)} ETH (all pools)`);
  const flushed = await send("creator and holders' shares sent", hook.flush(launch.poolId));
  for (const e of events(flushed, hook, "Flushed")) console.log(`  ${eth(e.amount)} ETH to ${e.to}${e.ok ? "" : "  (rejected, still owed)"}`);
  const reserveBefore = await treasury.buybackReserve();
  const platformFlushed = await send("platform share sent", hook.flushPlatform());
  for (const e of events(platformFlushed, hook, "PlatformFlushed")) console.log(`  ${eth(e.amount)} ETH to the Treasury${e.ok ? "" : "  (rejected, still owed)"}`);
  console.log(`  Treasury buyback reserve grew by ${eth((await treasury.buybackReserve()) - reserveBefore)} ETH`);
  if (isRewards) {
    console.log(`  the token holds ${eth(await ethers.provider.getBalance(tokenAddr))} ETH for its holders; the keeper turns it into the reward with distributeRewards`);
  }

  if (process.env.LEAVE_FEES === "1") {
    console.log("\n7. Trading once more and leaving the fees where they are (LEAVE_FEES)");
    await roundTrip();
    const [leftEth, leftTokens] = await hook.collect.staticCall(launch.poolId);
    console.log(`  waiting in the launch position: ${eth(leftEth)} ETH and ${eth(leftTokens)} ${symbol} (what these two trades paid, and the pool fee of a conversion above)`);
    console.log("  left there for the site's fee panel or the keeper to collect");
  }

  console.log(`\nDone. A fee mode launch, ${isRewards ? "Rewards" : "Tax"} token, the sale said ${Number(params.liquidityAction) === BURN ? "Burn" : "Lock"}:`);
  console.log(`  token       ${addr(tokenAddr)}`);
  console.log(`  presale     ${addr(presaleAddr)}`);
  console.log(`  pool id     ${launch.poolId}`);
  if (live) {
    console.log(`  sale page   https://www.hoodsale.io/presale/${presaleAddr}   (add it to frontend/src/config/hidden.js before the site release)`);
    console.log(`  Uniswap     https://app.uniswap.org/explore/pools/robinhood/${launch.poolId}   (the app lists a new pool after about 15 minutes)`);
    console.log(`  DexScreener https://dexscreener.com/robinhood/${launch.poolId}`);
  } else {
    console.log(`  sale page   http://localhost:5173/presale/${presaleAddr}`);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
