const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = require("hardhat");
const { loadFixture, time, getStorageAt, setStorageAt, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { createKeeper } = require("../../scripts/launch-keeper");
const { setLaunchKeeper, rotationRecord } = require("../../scripts/set-launch-keeper");
const { deployPlatformV4Fee, feeTaxConfig, taxConfig, keyArray } = require("../v4/helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const BPS = 10_000n;
const Burn = 1;
// TokenFactory.TokenType
const Standard = 0, Tax = 1, Rewards = 2;
const COOLDOWN = 300;
// The keeper's own thresholds (scripts/launch-keeper.js): what a flush or a collect is sent for,
// what the quote of a conversion must reach, and the same once more than one conversion's worth
// of tokens is waiting
const FLUSH_MIN = E("0.005");
const CONVERT_MIN = E("0.0005");
const BACKLOG_MIN = E("0.0001");
const HOUR_MS = 60 * 60 * 1000;

// In fee mode the tax is the pool's LP fee. It waits in the launch position the fee hook holds,
// ETH from buys and tokens from sells, and reaches nobody until someone collects it and sells the
// token side. The platform keeper does both, then sends the ETH on as it does for hook mode.
describe("V4 fee mode keeper", function () {
  // ------------------------------------------------------------------ building launches

  async function createFeeToken(ctx, tokenType, rates = {}, rewardToken = ctx.weth.target) {
    const { feeLauncher, alice, marketing } = ctx;
    await feeLauncher.connect(alice).createToken(
      tokenType,
      { name: "Fee", symbol: "FEE", totalSupply: E("1000000"), rewardToken: tokenType === Rewards ? rewardToken : ethers.ZeroAddress },
      feeTaxConfig(marketing.address, rates),
      alice.address
    );
    const created = await feeLauncher.tokensOfCreator(alice.address);
    return created[created.length - 1];
  }

  /** A hook mode Rewards token, 2% to marketing and 2% to holders, as test/v4/keeper.test.js launches it. */
  async function createHookToken(ctx) {
    const { launcher, alice, marketing, weth } = ctx;
    await launcher.connect(alice).createToken(
      Rewards,
      { name: "Hook", symbol: "HOOK", totalSupply: E("1000000"), rewardToken: weth.target },
      taxConfig(marketing.address, { marketingBuyBps: 200, marketingSellBps: 200, rewardsBuyBps: 200, rewardsSellBps: 200 }),
      alice.address
    );
    const created = await launcher.tokensOfCreator(alice.address);
    return created[created.length - 1];
  }

  /**
   * A sale of alice's token filled to its hard cap; finalized and fully claimed unless told not
   * to. 60% of what it raises opens the pool, so a small hard cap makes a small pool.
   */
  async function runSale(ctx, tokenAddr, { finalize = true, hardCap = E("4") } = {}) {
    const { presaleFactory, alice, bob, carol } = ctx;
    const start = BigInt(await time.latest()) + 1000n;
    const params = {
      token: tokenAddr,
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: hardCap / 2n,
      hardCap,
      minContribution: hardCap / 40n,
      maxContribution: hardCap / 2n,
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction: Burn,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: hardCap / 2n });
    await presale.connect(carol).contribute({ value: hardCap / 2n });
    if (!finalize) return presale;
    await presale.connect(alice).finalize(0, 0);
    await presale.connect(bob).claim();
    await presale.connect(carol).claim();
    return presale;
  }

  /** Creates and launches a fee mode token, and lets alice (who holds the supply) and dave sell it. */
  async function launchFee(ctx, tokenType, rates, rewardToken, sale) {
    const { feeLauncher, swapper, alice, dave } = ctx;
    const tokenAddr = await createFeeToken(ctx, tokenType, rates, rewardToken);
    const presale = await runSale(ctx, tokenAddr, sale);
    const token = await ethers.getContractAt(tokenType === Rewards ? "RewardsTokenV4" : "HoodSaleTokenV4", tokenAddr);
    for (const who of [alice, dave]) await token.connect(who).approve(swapper.target, ethers.MaxUint256);
    const key = keyArray(await feeLauncher.poolKeyOf(tokenAddr));
    const poolId = (await feeLauncher.launchOf(tokenAddr)).poolId;
    return { tokenAddr, token, presale, key, poolId };
  }

  /** A Tax launch that is trading: 3% to marketing, so the pool's fee is 3.25%. */
  async function launchedTax() {
    const ctx = await deployPlatformV4Fee();
    return { ...ctx, ...(await launchFee(ctx, Tax, { marketingBps: 300 })) };
  }

  /**
   * A Tax launch at the 10% cap. One conversion sells at most 1% of the pool's tokens whatever
   * the tax, so at this rate a single sell leaves several conversions' worth of token fees.
   */
  async function launchedHighTax() {
    const ctx = await deployPlatformV4Fee();
    return { ...ctx, ...(await launchFee(ctx, Tax, { marketingBps: 975 })) };
  }

  /**
   * Two Tax launches at the 10% cap with very little liquidity, where a whole conversion is worth
   * less than the keeper sends one for: `a` raised 0.05 ETH and `b` 0.01 ETH.
   */
  async function launchedSmall() {
    const ctx = await deployPlatformV4Fee();
    const a = await launchFee(ctx, Tax, { marketingBps: 975 }, undefined, { hardCap: E("0.05") });
    const b = await launchFee(ctx, Tax, { marketingBps: 975 }, undefined, { hardCap: E("0.01") });
    return { ...ctx, a, b };
  }

  /** Two fee mode launches side by side. */
  async function launchedTwo() {
    const ctx = await deployPlatformV4Fee();
    const a = await launchFee(ctx, Tax, { marketingBps: 300 });
    const b = await launchFee(ctx, Tax, { marketingBps: 300 });
    return { ...ctx, a, b };
  }

  /** One Rewards launch in each v4 mode, both paying holders in WETH. */
  async function launchedBothModes() {
    const ctx = await deployPlatformV4Fee();
    const { launcher } = ctx;
    const hookTokenAddr = await createHookToken(ctx);
    await runSale(ctx, hookTokenAddr);
    const hookSide = {
      tokenAddr: hookTokenAddr,
      token: await ethers.getContractAt("RewardsTokenV4", hookTokenAddr),
      key: keyArray(await launcher.poolKeyOf(hookTokenAddr)),
      poolId: (await launcher.launchOf(hookTokenAddr)).poolId,
    };
    const feeSide = await launchFee(ctx, Rewards, { marketingBps: 100, rewardsBps: 200 });
    return { ...ctx, hookSide, feeSide };
  }

  const buy = (ctx, key, who, eth) => ctx.swapper.connect(who).swapExactIn(key, true, eth, 0, who.address, { value: eth });
  const sell = (ctx, key, who, tokens) => ctx.swapper.connect(who).swapExactIn(key, false, tokens, 0, who.address);

  /**
   * Sells `percent` of the pool's token reserve from alice's supply. At the 10% cap the fee left
   * behind is about 10 * p / (1 + 0.9 * p) conversions' worth for a sell of p reserves: 17% leaves
   * about 1.5, 33% about 2.5 and 65% about 4.
   */
  async function sellReserveShare(ctx, percent, pool = ctx) {
    const reserve = ((await ctx.feeHook.maxConvert(pool.poolId)) * BPS) / 100n;
    await sell(ctx, pool.key, ctx.alice, (reserve * BigInt(percent)) / 100n);
  }

  /** The token fees waiting for conversion, collected or not, and what one conversion may sell. */
  async function waiting(ctx, poolId = ctx.poolId) {
    const { ethFees, tokenFees } = await ctx.feeHook.collect.staticCall(poolId);
    const tokens = (await ctx.feeHook.pendingTokens(poolId)) + tokenFees;
    return { ethFees, tokens, cap: await ctx.feeHook.maxConvert(poolId) };
  }

  /** What Uniswap's quoter says selling `tokens` in the pool brings in now. */
  async function quoteOf(ctx, key, tokens) {
    const [out] = await ctx.quoter.quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne: false, exactAmount: tokens, hookData: "0x" });
    return out;
  }

  /**
   * The backlog from which the multi-window conversion attack pays: tax / (1 - tax) of the pool's
   * token reserve, the reserve read back from what one conversion sells (min(tax / 2, 1%) of it).
   */
  function attackBacklog(cap, totalBps) {
    const convertBps = totalBps / 2n < 100n ? totalBps / 2n : 100n;
    return (((cap * BPS) / convertBps) * totalBps) / (BPS - totalBps);
  }

  /** A fresh keeper per test, with both v4 modes unless the test takes one away. */
  async function makeKeeper(ctx, extra = {}) {
    const lines = [];
    const keeper = await createKeeper(hre, {
      factoryAddress: ctx.presaleFactory.target,
      signer: ctx.keeper,
      log: (l) => lines.push(l),
      retrySeconds: 60,
      v4LauncherAddress: ctx.launcher.target,
      v4HookAddress: ctx.hook.target,
      v4FeeLauncherAddress: ctx.feeLauncher.target,
      v4FeeHookAddress: ctx.feeHook.target,
      v4QuoterAddress: ctx.quoter.target,
      ...extra,
    });
    return { keeper, lines };
  }

  const sent = (lines, kind) => lines.filter((l) => l.startsWith(`${kind} `) && l.includes(" sent "));
  const kinds = (keeper) => keeper.actions.map((a) => a.kind);

  /** The arguments of the conversions a keeper sent and what each one sold, oldest first. */
  async function conversions(ctx, keeper) {
    const out = [];
    for (const action of keeper.actions.filter((a) => a.kind === "v4fee-convert")) {
      const tx = await ethers.provider.getTransaction(action.hash);
      const receipt = await ethers.provider.getTransactionReceipt(action.hash);
      const { args } = ctx.feeHook.interface.parseTransaction({ data: tx.data });
      const event = receipt.logs
        .filter((l) => l.address === ctx.feeHook.target)
        .map((l) => ctx.feeHook.interface.parseLog(l))
        .find((e) => e && e.name === "Converted");
      out.push({ token: action.presale, args, tokensSold: event.args.tokensSold, ethOut: event.args.ethOut });
    }
    return out;
  }

  // ------------------------------------------------------------------ discovery

  describe("finding the pools", function () {
    it("finds a fee mode pool through its finalized sale, and nothing through created tokens or open sales", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeLauncher, dave, marketing, tokenAddr, poolId } = ctx;
      for (let i = 0; i < 3; i++) {
        await feeLauncher.connect(dave).createToken(
          Standard,
          { name: `Spam ${i}`, symbol: "SPAM", totalSupply: E("1000"), rewardToken: ethers.ZeroAddress },
          feeTaxConfig(marketing.address),
          dave.address
        );
      }
      // A sale that has reached its cap but has not launched opens no pool yet.
      const waitingSale = await runSale(ctx, await createFeeToken(ctx, Tax, { marketingBps: 100 }), { finalize: false });

      const { keeper } = await makeKeeper(ctx);
      await keeper.poll();
      expect([...keeper.v4Fee.launched.keys()]).to.deep.equal([tokenAddr]);
      expect(keeper.v4Fee.launched.get(tokenAddr).poolId).to.equal(poolId);
      expect(keeper.v4.launched.size).to.equal(0);
      expect(keeper.v4Modes.map((m) => m.kind)).to.deep.equal(["hook", "fee"]);

      // It launches, and the next poll knows its pool.
      await waitingSale.connect(ctx.alice).finalize(0, 0);
      await keeper.poll();
      expect(keeper.v4Fee.launched.size).to.equal(2);
    });

    // Inherited from hook mode: a delivered sale was marked done even when reading its pool had
    // just failed, and a done sale is never read again, so its fees stayed in the hook for good.
    it("keeps a delivered sale on its list until the sale's pool has been read", async function () {
      const ctx = await loadFixture(launchedTax);
      const { presale, tokenAddr } = ctx;
      expect(await presale.distributionComplete()).to.equal(true);
      const { keeper, lines } = await makeKeeper(ctx);

      const provider = ethers.provider;
      const original = provider.getCode;
      let failures = 1;
      provider.getCode = async function (address, ...rest) {
        if (address === presale.target && failures-- > 0) throw new Error("rpc down");
        return original.call(this, address, ...rest);
      };
      try {
        await keeper.poll();
      } finally {
        provider.getCode = original;
      }
      expect(lines.filter((l) => l.startsWith(`read v4 ${presale.target} failed: `)).length).to.equal(1);
      expect(keeper.v4Fee.launched.size).to.equal(0);
      expect(keeper.done.has(presale.target)).to.equal(false);

      await keeper.poll();
      expect([...keeper.v4Fee.launched.keys()]).to.deep.equal([tokenAddr]);
      expect(keeper.done.has(presale.target)).to.equal(true);
    });
  });

  // ------------------------------------------------------------------ the fee step

  describe("collecting", function () {
    it("collects ETH fees worth a transaction and sends them on in the same pass", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, treasury, key, poolId, tokenAddr, marketing, dave } = ctx;
      const spend = E("3");
      await buy(ctx, key, dave, spend);
      const { ethFees, tokens } = await waiting(ctx);
      expect(ethFees).to.be.closeTo((spend * 325n) / BPS, 2n);
      expect(tokens).to.equal(0);

      const marketingBefore = await ethers.provider.getBalance(marketing.address);
      const reserveBefore = await treasury.buybackReserve();
      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();

      // Only buys so far: nothing to convert, so the position's ETH is collected, and the flush
      // that hook mode gets follows on the ledgers it filled.
      expect(kinds(keeper)).to.deep.equal(["v4fee-collect", "v4-flush", "v4-flush-platform"]);
      expect(sent(lines, "v4fee-collect")[0]).to.include(tokenAddr);
      expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal((ethFees * 300n) / 325n);
      expect(await treasury.buybackReserve()).to.be.greaterThan(reserveBefore);
      expect((await feeHook.collect.staticCall(poolId)).ethFees).to.equal(0);
      expect(await feeHook.pendingMarketing(poolId)).to.equal(0);
      expect(await feeHook.pendingPlatform()).to.equal(0);
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(0);

      // Nothing new: nothing sent.
      await keeper.poll();
      expect(keeper.actions.length).to.equal(3);
    });

    // Every fee pool ever launched is read on every poll, so a pool where nothing is happening
    // must cost as few round trips as it can: its ledgers are read together with its fees.
    it("reads a quiet pool's ledgers once per pass, and again only after the fee step has sent something", async function () {
      const ctx = await loadFixture(launchedTax);
      const { key, dave } = ctx;
      const { keeper } = await makeKeeper(ctx);
      await keeper.poll(); // finds the pool
      const hook = keeper.v4Fee.hook;
      const original = hook.pendingMarketing;
      let reads = 0;
      hook.pendingMarketing = async (id) => {
        reads++;
        return original(id);
      };
      await keeper.poll();
      await keeper.poll();
      expect(reads).to.equal(2);
      expect(keeper.actions).to.deep.equal([]);

      // The collect books ETH into the ledgers, so what was read before it is not what the flush
      // is decided on: on a chain that mines on demand the flush follows in the same pass.
      await buy(ctx, key, dave, E("3"));
      await keeper.poll();
      expect(reads).to.equal(4);
      expect(kinds(keeper)).to.deep.equal(["v4fee-collect", "v4-flush", "v4-flush-platform"]);
    });

    it("leaves dust alone", async function () {
      const ctx = await loadFixture(launchedTax);
      const { key, dave } = ctx;
      await buy(ctx, key, dave, E("0.01"));
      const before = await waiting(ctx);
      expect(before.ethFees).to.be.greaterThan(0);

      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();
      expect(keeper.actions).to.deep.equal([]);
      expect(lines.some((l) => l.startsWith("v4"))).to.equal(false);
      expect((await waiting(ctx)).ethFees).to.equal(before.ethFees);
    });

    it("collects the ETH side while the token side is not worth converting", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, dave } = ctx;
      await buy(ctx, key, dave, E("3"));
      await sell(ctx, key, dave, E("100"));
      const { ethFees, tokens, cap } = await waiting(ctx);
      expect(ethFees).to.be.greaterThan(FLUSH_MIN);
      expect(tokens).to.be.greaterThan(0).and.lessThan(cap);

      const { keeper } = await makeKeeper(ctx, { v4FeeConvertMinWei: E("1000") });
      await keeper.poll();
      expect(kinds(keeper)).to.include("v4fee-collect").and.not.include("v4fee-convert");
      // The tokens are in the hook now, still waiting for a conversion that pays.
      expect(await feeHook.pendingTokens(poolId)).to.equal(tokens);
    });

    // The ETH fees are collected by a conversion, but they are not what it brings in. Counted
    // towards it, any token dust turned 0.002 ETH of waiting ETH fees into a conversion, which
    // started the cooldown for a sale of nothing.
    it("does not let waiting ETH fees turn token dust into a conversion", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, alice, dave } = ctx;
      await sell(ctx, key, alice, E("0.001"));
      await buy(ctx, key, dave, E("0.1"));
      const { ethFees, tokens } = await waiting(ctx);
      expect(tokens).to.be.greaterThan(0);
      expect(ethFees).to.be.greaterThan(CONVERT_MIN).and.lessThan(FLUSH_MIN);

      const { keeper } = await makeKeeper(ctx);
      await keeper.poll();
      expect(keeper.actions).to.deep.equal([]);

      // Once the ETH side is worth a flush it is collected, and the dust is still not sold.
      await buy(ctx, key, dave, E("0.1"));
      await keeper.poll();
      expect(kinds(keeper)).to.deep.equal(["v4fee-collect", "v4-flush"]);
      expect(await feeHook.lastConvertAt(poolId)).to.equal(0);
      expect(await feeHook.pendingTokens(poolId)).to.equal(tokens);
    });

    it("takes what a flush is worth from v4FlushMinWei, for the collect as for the flush", async function () {
      const ctx = await loadFixture(launchedTax);
      const { key, marketing, dave } = ctx;
      await buy(ctx, key, dave, E("0.15"));
      const { ethFees } = await waiting(ctx);
      expect(ethFees).to.be.greaterThan(E("0.004")).and.lessThan(FLUSH_MIN);

      const { keeper: byDefault } = await makeKeeper(ctx);
      await byDefault.poll();
      expect(byDefault.actions).to.deep.equal([]);

      // A small pool's fees are not stranded: the operator can lower the threshold, and one
      // setting moves the collect and the flush behind it together.
      const marketingBefore = await ethers.provider.getBalance(marketing.address);
      const { keeper } = await makeKeeper(ctx, { v4FlushMinWei: E("0.001") });
      await keeper.poll();
      expect(kinds(keeper)).to.deep.equal(["v4fee-collect", "v4-flush"]);
      expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal((ethFees * 300n) / 325n);
    });
  });

  describe("converting", function () {
    it("sells the token fees for ETH with a price floor from Uniswap's quoter", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, quoter, key, poolId, tokenAddr, marketing, dave } = ctx;
      await buy(ctx, key, dave, E("3"));
      await sell(ctx, key, dave, E("100"));
      const { ethFees, tokens, cap } = await waiting(ctx);
      expect(tokens).to.be.closeTo((E("100") * 325n) / BPS, 2n);
      expect(tokens).to.be.lessThan(cap);
      const [quote] = await quoter.quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne: false, exactAmount: tokens, hookData: "0x" });
      const chainTime = await time.latest();

      const marketingBefore = await ethers.provider.getBalance(marketing.address);
      // A machine clock behind the chain's, so the deadline below is counted from the chain's time.
      const { keeper, lines } = await makeKeeper(ctx, { now: () => Date.parse("2020-01-01") });
      await keeper.poll();

      // The conversion collects as it goes, so no collect of its own is sent.
      expect(kinds(keeper)).to.deep.equal(["v4fee-convert", "v4-flush", "v4-flush-platform"]);
      const [conversion] = await conversions(ctx, keeper);
      expect(conversion.token).to.equal(tokenAddr);
      expect(conversion.args.id).to.equal(poolId);
      // The floor is a price: the size it was quoted for, and the quote less 1%.
      expect(conversion.args.quotedTokens).to.equal(tokens);
      expect(conversion.args.minEthOut).to.equal((quote * 9900n) / BPS);
      expect(conversion.args.deadline).to.equal(chainTime + 120);
      expect(conversion.tokensSold).to.equal(tokens);
      expect(conversion.ethOut).to.equal(quote);
      expect(sent(lines, "v4fee-convert")[0]).to.include(`quoted ${ethers.formatEther(quote)} ETH`);

      expect(await feeHook.pendingTokens(poolId)).to.equal(0);
      const paid = (await ethers.provider.getBalance(marketing.address)) - marketingBefore;
      expect(paid).to.equal((ethFees * 300n) / 325n + (quote * 300n) / 325n);
    });

    it("takes its slippage from v4FeeSlippageBps, not from the reward swaps' settings, and its deadline from the later clock", async function () {
      const ctx = await loadFixture(launchedTax);
      const { quoter, key, dave } = ctx;
      await buy(ctx, key, dave, E("3"));
      await sell(ctx, key, dave, E("100"));
      const { tokens } = await waiting(ctx);
      const [quote] = await quoter.quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne: false, exactAmount: tokens, hookData: "0x" });

      // A chain that mines on demand leaves its latest block behind: the deadline is then
      // counted from the machine's clock, or the conversion would expire before it is mined.
      const ahead = (await time.latest()) + 5000;
      const { keeper } = await makeKeeper(ctx, {
        v4FeeSlippageBps: 250,
        rewardsSlippageBps: 900,
        rewardsMaxImpactBps: 5000,
        now: () => ahead * 1000,
      });
      await keeper.poll();
      const [conversion] = await conversions(ctx, keeper);
      expect(conversion.args.minEthOut).to.equal((quote * 9750n) / BPS);
      expect(conversion.args.deadline).to.equal(ahead + 120);
    });

    it("does not send a conversion the price floor refuses, and still collects and sends on", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, dave } = ctx;
      await buy(ctx, key, dave, E("3"));
      await sell(ctx, key, dave, E("100"));
      const { tokens } = await waiting(ctx);

      let clock = Date.now();
      const { keeper, lines } = await makeKeeper(ctx, { now: () => clock });
      // The pool moved against the quote before the transaction ran: here, a quote 5% too high.
      const real = keeper.v4Fee.quoter;
      keeper.v4Fee.quoter = {
        quoteExactInputSingle: {
          staticCall: async (params) => {
            const [out, gas] = await real.quoteExactInputSingle.staticCall(params);
            return [(out * 105n) / 100n, gas];
          },
        },
      };
      await keeper.poll();
      expect(lines.filter((l) => /^v4fee-convert .* not sent: .*\(retry in 60s\)$/.test(l)).length).to.equal(1);
      expect(kinds(keeper)).to.deep.equal(["v4fee-collect", "v4-flush", "v4-flush-platform"]);
      expect(await feeHook.pendingTokens(poolId)).to.equal(tokens);

      // With an honest quote it goes through once the back-off is over.
      keeper.v4Fee.quoter = real;
      clock += 61_000;
      await keeper.poll();
      expect(kinds(keeper)).to.include("v4fee-convert");
      expect(await feeHook.pendingTokens(poolId)).to.equal(0);
    });

    it("never converts without a quote", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, dave } = ctx;
      await sell(ctx, key, ctx.alice, E("100"));
      await buy(ctx, key, dave, E("0.01"));
      const { tokens } = await waiting(ctx);

      // A quoter that cannot answer: logged once per waiting amount, and nothing is sent.
      const { keeper, lines } = await makeKeeper(ctx);
      keeper.v4Fee.quoter = { quoteExactInputSingle: { staticCall: async () => { throw new Error("quoter down"); } } };
      await keeper.poll();
      await keeper.poll();
      expect(lines.filter((l) => l.startsWith("v4fee-convert ") && l.includes("skipped: quote failed: quoter down")).length).to.equal(1);
      expect(keeper.actions).to.deep.equal([]);

      // No quoter at all: said once at start, and only the ETH side is ever handled.
      const { keeper: blind, lines: blindLines } = await makeKeeper(ctx, { v4QuoterAddress: undefined });
      expect(blindLines.filter((l) => l.startsWith("warning: no Uniswap v4 quoter")).length).to.equal(1);
      await buy(ctx, key, dave, E("3"));
      await blind.poll();
      expect(kinds(blind)).to.deep.equal(["v4fee-collect", "v4-flush", "v4-flush-platform"]);
      expect(await feeHook.pendingTokens(poolId)).to.equal(tokens);
    });

    it("converts from a quote of 0.0005 ETH by default, and leaves less waiting", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, alice } = ctx;
      await sell(ctx, key, alice, E("10"));
      let w = await waiting(ctx);
      expect(w.ethFees).to.equal(0);
      expect(w.tokens).to.be.lessThan(w.cap);
      expect(await quoteOf(ctx, key, w.tokens)).to.be.greaterThan(BACKLOG_MIN).and.lessThan(CONVERT_MIN);

      const { keeper } = await makeKeeper(ctx);
      await keeper.poll();
      expect(keeper.actions).to.deep.equal([]);

      await sell(ctx, key, alice, E("5"));
      w = await waiting(ctx);
      expect(await quoteOf(ctx, key, w.tokens)).to.be.greaterThanOrEqual(CONVERT_MIN).and.lessThan(2n * CONVERT_MIN);
      await keeper.poll();
      const done = await conversions(ctx, keeper);
      expect(done.length).to.equal(1);
      expect(done[0].tokensSold).to.equal(w.tokens);
      expect(await feeHook.pendingTokens(poolId)).to.equal(0);
    });

    // Anyone may convert, and the site offers a button for it. A conversion that lands between
    // the keeper's reads and its send has collected the ETH side already: a collect sent for what
    // was read before it would pay gas for nothing.
    it("does not collect what another caller's conversion has just taken", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, tokenAddr, dave } = ctx;
      await buy(ctx, key, dave, E("3"));
      await sell(ctx, key, dave, E("100"));
      expect((await waiting(ctx)).ethFees).to.be.greaterThan(FLUSH_MIN);

      const { keeper, lines } = await makeKeeper(ctx);
      const real = keeper.v4Fee.quoter;
      keeper.v4Fee.quoter = {
        quoteExactInputSingle: {
          staticCall: async (params) => {
            const quote = await real.quoteExactInputSingle.staticCall(params);
            await feeHook.connect(dave).convert(poolId, 1, 0, (await time.latest()) + 120);
            return quote;
          },
        },
      };
      await keeper.poll();
      expect(lines.filter((l) => l.startsWith(`v4fee-convert ${tokenAddr} not sent: `)).length).to.equal(1);
      // What the other conversion booked is sent on; nothing is collected a second time.
      expect(kinds(keeper)).to.deep.equal(["v4-flush", "v4-flush-platform"]);
      expect(await feeHook.pendingMarketing(poolId)).to.equal(0);
    });

    it("does not quote again a pool where nothing has traded, and reads the latest block once per poll", async function () {
      const ctx = await loadFixture(launchedTwo);
      const { a, b, alice } = ctx;
      // Token dust in both pools: every conversion leaves some, so this is where most pools rest.
      await sell(ctx, a.key, alice, E("1"));
      await sell(ctx, b.key, alice, E("1"));

      let clock = Date.now();
      const { keeper } = await makeKeeper(ctx, { now: () => clock });
      const real = keeper.v4Fee.quoter;
      let quotes = 0;
      keeper.v4Fee.quoter = {
        quoteExactInputSingle: {
          staticCall: async (params) => {
            quotes++;
            return real.quoteExactInputSingle.staticCall(params);
          },
        },
      };
      const provider = ethers.provider;
      const original = provider.getBlock;
      let blocks = 0;
      provider.getBlock = async function (...args) {
        blocks++;
        return original.apply(this, args);
      };
      try {
        await keeper.poll();
        expect([quotes, blocks]).to.deep.equal([2, 1]);
        await keeper.poll();
        await keeper.poll();
        expect([quotes, blocks]).to.deep.equal([2, 1]);

        // A trade brings that pool's quote back, and not the other pool's.
        await sell(ctx, a.key, alice, E("1"));
        await keeper.poll();
        expect([quotes, blocks]).to.deep.equal([3, 2]);

        // Whatever the figures say, the decision is taken afresh every five minutes.
        clock += 5 * 60 * 1000;
        await keeper.poll();
        expect([quotes, blocks]).to.deep.equal([5, 3]);
      } finally {
        provider.getBlock = original;
      }
      expect(keeper.actions).to.deep.equal([]);
    });
  });

  describe("a backlog", function () {
    it("is drained one capped conversion per cooldown window", async function () {
      const ctx = await loadFixture(launchedHighTax);
      const { feeHook, poolId } = ctx;
      await sellReserveShare(ctx, 33);
      const { tokens, cap } = await waiting(ctx);
      expect(tokens).to.be.greaterThan(2n * cap).and.lessThan(3n * cap);

      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();
      let done = await conversions(ctx, keeper);
      expect(done.length).to.equal(1);
      // The hook sells one cap and no more; the keeper quoted exactly that.
      expect(done[0].args.quotedTokens).to.equal(cap);
      expect(done[0].tokensSold).to.equal(cap);
      expect(await feeHook.pendingTokens(poolId)).to.equal(tokens - cap);
      expect(sent(lines, "v4fee-convert")[0]).to.include(`${ethers.formatEther(cap)} of ${ethers.formatEther(tokens)} tokens`);

      // A conversion is a sell like any other: it pays the pool's fee, which comes back to the
      // same position as new token fees, so a tenth of what was sold is waiting again.
      let w = await waiting(ctx);
      expect(w.tokens - (tokens - cap)).to.be.closeTo(cap / 10n, 2n);

      // Inside the cooldown nothing is sent, up to its last second.
      const convertedAt = Number(await feeHook.lastConvertAt(poolId));
      await keeper.poll();
      await time.increaseTo(convertedAt + COOLDOWN - 1);
      await keeper.poll();
      expect((await conversions(ctx, keeper)).length).to.equal(1);
      expect(lines.some((l) => l.includes("not sent"))).to.equal(false);

      await time.increaseTo(convertedAt + COOLDOWN);
      await keeper.poll();
      done = await conversions(ctx, keeper);
      expect(done.length).to.equal(2);
      expect(w.tokens).to.be.greaterThan(w.cap);
      expect(done[1].args.quotedTokens).to.equal(w.cap);
      expect(done[1].tokensSold).to.equal(w.cap);
      expect(await feeHook.pendingTokens(poolId)).to.equal(w.tokens - w.cap);

      // The third window takes what is left, less than a cap.
      w = await waiting(ctx);
      expect(w.tokens).to.be.greaterThan(0).and.lessThan(w.cap);
      await time.increase(COOLDOWN);
      await keeper.poll();
      done = await conversions(ctx, keeper);
      expect(done.length).to.equal(3);
      expect(done[2].args.quotedTokens).to.equal(w.tokens);
      expect(done[2].tokensSold).to.equal(w.tokens);
      expect(await feeHook.pendingTokens(poolId)).to.equal(0);

      // The tenth that sale recycled is still worth a conversion of its own. The tenth of that is
      // dust, and there is nothing more to do.
      w = await waiting(ctx);
      expect(await quoteOf(ctx, ctx.key, w.tokens)).to.be.greaterThan(CONVERT_MIN);
      await time.increase(COOLDOWN);
      await keeper.poll();
      done = await conversions(ctx, keeper);
      expect(done.length).to.equal(4);
      expect(done[3].tokensSold).to.equal(w.tokens);
      w = await waiting(ctx);
      expect(w.tokens).to.be.greaterThan(0);
      expect(await quoteOf(ctx, ctx.key, w.tokens)).to.be.lessThan(CONVERT_MIN);
      await time.increase(COOLDOWN);
      await keeper.poll();
      expect((await conversions(ctx, keeper)).length).to.equal(4);
      expect((await waiting(ctx)).tokens).to.equal(w.tokens);
    });

    it("of more than one conversion is converted from the lower floor, a single conversion's worth only from the full one", async function () {
      const ctx = await loadFixture(launchedHighTax);
      const { key } = ctx;
      // No conversion is ever worth this much, so only the backlog rule can send one.
      const { keeper, lines } = await makeKeeper(ctx, { v4FeeConvertMinWei: E("1000") });

      await sellReserveShare(ctx, 5);
      let w = await waiting(ctx);
      expect(w.tokens).to.be.greaterThan(0).and.lessThan(w.cap);
      expect(await quoteOf(ctx, key, w.tokens)).to.be.greaterThan(BACKLOG_MIN);
      await keeper.poll();
      expect(keeper.actions).to.deep.equal([]);

      // More than one window's worth is waiting: a backlog is forming, and it is drained.
      await sellReserveShare(ctx, 12);
      w = await waiting(ctx);
      expect(w.tokens).to.be.greaterThan(w.cap).and.lessThan(2n * w.cap);
      await keeper.poll();
      const done = await conversions(ctx, keeper);
      expect(done.length).to.equal(1);
      expect(done[0].tokensSold).to.equal(w.cap);

      // One conversion later less than a cap waits, and the full floor is back.
      await time.increase(COOLDOWN);
      w = await waiting(ctx);
      expect(w.tokens).to.be.greaterThan(0).and.lessThan(w.cap);
      await keeper.poll();
      expect((await conversions(ctx, keeper)).length).to.equal(1);
      expect((await waiting(ctx)).tokens).to.equal(w.tokens);
      expect(lines.some((l) => l.startsWith("warning: v4fee"))).to.equal(false);
    });

    it("whose quote is under the backlog floor is not converted, not even one wei under", async function () {
      const ctx = await loadFixture(launchedHighTax);
      const { feeHook, key, poolId } = ctx;
      await sellReserveShare(ctx, 33);
      const { tokens, cap } = await waiting(ctx);
      expect(tokens).to.be.greaterThan(2n * cap);
      const quote = await quoteOf(ctx, key, cap);

      const { keeper: strict } = await makeKeeper(ctx, { v4FeeConvertMinWei: E("1000"), v4FeeBacklogMinWei: quote + 1n });
      await strict.poll();
      expect(strict.actions).to.deep.equal([]);
      expect(await feeHook.lastConvertAt(poolId)).to.equal(0);

      const { keeper } = await makeKeeper(ctx, { v4FeeConvertMinWei: E("1000"), v4FeeBacklogMinWei: quote });
      await keeper.poll();
      const done = await conversions(ctx, keeper);
      expect(done.length).to.equal(1);
      expect(done[0].ethOut).to.equal(quote);
    });

    // Without a floor the backlog rule sent a conversion every window into a pool whose whole cap
    // is worth less than the gas: an owner trading against himself could keep it going for good.
    it("in a pool too small for a conversion to matter is left alone by default, from 0.0001 ETH a window it is drained", async function () {
      const ctx = await loadFixture(launchedSmall);
      const { feeHook, a, b } = ctx;
      await sellReserveShare(ctx, 17, a);
      await sellReserveShare(ctx, 65, b);
      const wa = await waiting(ctx, a.poolId);
      const wb = await waiting(ctx, b.poolId);
      expect(wa.tokens).to.be.greaterThan(wa.cap).and.lessThan(2n * wa.cap);
      expect(wb.tokens).to.be.greaterThan(3n * wb.cap);
      // A whole cap: under the full floor in both pools, under the backlog floor in the smaller one.
      expect(await quoteOf(ctx, a.key, wa.cap)).to.be.greaterThanOrEqual(BACKLOG_MIN).and.lessThan(CONVERT_MIN);
      expect(await quoteOf(ctx, b.key, wb.cap)).to.be.greaterThan(0).and.lessThan(BACKLOG_MIN);

      const { keeper } = await makeKeeper(ctx);
      await keeper.poll();
      await time.increase(COOLDOWN);
      await keeper.poll();
      const done = await conversions(ctx, keeper);
      expect(done.map((d) => d.token)).to.deep.equal([a.tokenAddr]);
      expect(done[0].tokensSold).to.equal(wa.cap);
      expect(await feeHook.lastConvertAt(b.poolId)).to.equal(0);
      expect((await waiting(ctx, b.poolId)).tokens).to.equal(wb.tokens);
    });

    // The multi-window conversion attack pays once tax / (1 - tax) of the token reserve waits:
    // measured in test/v4fee/sandwich.test.js. In caps that depends on the tax, about 11 at 10%
    // and about 3.4 at 3.25%, so the warning level is derived from the pool's own tax.
    it("reaching half of the pool's attack backlog is reported, once per backlog", async function () {
      const ctx = await loadFixture(launchedHighTax);
      const { tokenAddr } = ctx;
      const { keeper, lines } = await makeKeeper(ctx);
      const warnings = () => lines.filter((l) => l.startsWith(`warning: v4fee ${tokenAddr} backlog: `));

      // Four caps at a 10% tax are well under half of it.
      await sellReserveShare(ctx, 65);
      let w = await waiting(ctx);
      expect(w.tokens).to.be.greaterThan(3n * w.cap);
      expect(2n * w.tokens).to.be.lessThan(attackBacklog(w.cap, 1000n));
      await keeper.poll();
      expect((await conversions(ctx, keeper)).length).to.equal(1);
      expect(warnings().length).to.equal(0);

      await sellReserveShare(ctx, 100);
      await time.increase(COOLDOWN);
      w = await waiting(ctx);
      expect(2n * w.tokens).to.be.greaterThanOrEqual(attackBacklog(w.cap, 1000n));
      await keeper.poll();
      await keeper.poll();
      expect(warnings().length).to.equal(1);
      expect(warnings()[0]).to.include(`${ethers.formatEther(w.tokens)} tokens wait`);
      expect(warnings()[0]).to.include(`the ${ethers.formatEther(attackBacklog(w.cap, 1000n))} from which`);
      expect((await conversions(ctx, keeper)).length).to.equal(2);

      // Drained window by window without another line, and a new backlog is a new line.
      for (let i = 0; i < 16 && (w = await waiting(ctx)).tokens > w.cap; i++) {
        await time.increase(COOLDOWN);
        await keeper.poll();
      }
      expect((await waiting(ctx)).tokens).to.be.lessThan(w.cap);
      expect(warnings().length).to.equal(1);
      await sellReserveShare(ctx, 200);
      await time.increase(COOLDOWN);
      w = await waiting(ctx);
      expect(2n * w.tokens).to.be.greaterThanOrEqual(attackBacklog(w.cap, 1000n));
      await keeper.poll();
      expect(warnings().length).to.equal(2);
    });

    it("is reported from under two caps in a pool with a 3.25% tax", async function () {
      const ctx = await loadFixture(launchedTax);
      const { tokenAddr } = ctx;
      const { keeper, lines } = await makeKeeper(ctx);
      const warnings = () => lines.filter((l) => l.startsWith(`warning: v4fee ${tokenAddr} backlog: `));

      await sellReserveShare(ctx, 80);
      let w = await waiting(ctx);
      expect(w.tokens).to.be.greaterThan(w.cap);
      expect(2n * w.tokens).to.be.lessThan(attackBacklog(w.cap, 325n));
      await keeper.poll();
      expect(warnings().length).to.equal(0);

      await sellReserveShare(ctx, 100);
      await time.increase(COOLDOWN);
      w = await waiting(ctx);
      expect(w.tokens).to.be.lessThan(2n * w.cap);
      expect(2n * w.tokens).to.be.greaterThanOrEqual(attackBacklog(w.cap, 325n));
      await keeper.poll();
      expect(warnings().length).to.equal(1);
    });
  });

  // ------------------------------------------------------------------ a recipient that refuses

  // A flush never reverts when its recipient refuses the ETH: the hook books the share back and
  // the transaction succeeds. The token owner may point the marketing wallet anywhere, so without
  // a memory of what was refused the keeper sent the same flush on every poll, for good, from the
  // wallet that also launches the sales.
  describe("a flush that was refused", function () {
    it("is not sent again until the ledger has grown by a flush's worth or an hour has passed", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, tokenAddr, alice, marketing, dave } = ctx;
      // The token takes no ETH, and its owner names it as the marketing wallet.
      await feeHook.connect(alice).setMarketingWallet(poolId, tokenAddr);
      await buy(ctx, key, dave, E("3"));

      let clock = Date.now();
      const { keeper, lines } = await makeKeeper(ctx, { now: () => clock });
      const flushes = () => keeper.actions.filter((x) => x.kind === "v4-flush").length;
      const refusals = () => lines.filter((l) => l.startsWith(`warning: v4-flush ${tokenAddr} refused by ${tokenAddr}: `));
      for (let i = 0; i < 6; i++) await keeper.poll();
      expect(kinds(keeper)).to.deep.equal(["v4fee-collect", "v4-flush", "v4-flush-platform"]);
      // The flush succeeded and paid nobody: the share is booked as before, and that is said once.
      let booked = await feeHook.pendingMarketing(poolId);
      expect(booked).to.be.greaterThan(FLUSH_MIN);
      expect(lines.filter((l) => l.startsWith(`v4-flush ${tokenAddr} `) && l.includes("mined, success")).length).to.equal(1);
      expect(refusals().length).to.equal(1);
      expect(refusals()[0]).to.include(`${ethers.formatEther(booked)} ETH stays booked`);

      // Growth by less than a flush's worth changes nothing.
      await buy(ctx, key, dave, E("0.1"));
      await feeHook.collect(poolId);
      expect((await feeHook.pendingMarketing(poolId)) - booked).to.be.greaterThan(0).and.lessThan(FLUSH_MIN);
      await keeper.poll();
      expect(flushes()).to.equal(1);

      // Growth by a flush's worth is tried, once, and refused again.
      await buy(ctx, key, dave, E("0.2"));
      for (let i = 0; i < 4; i++) await keeper.poll();
      expect((await feeHook.pendingMarketing(poolId)) - booked).to.be.greaterThanOrEqual(FLUSH_MIN);
      expect(flushes()).to.equal(2);
      expect(refusals().length).to.equal(2);

      // So is the same amount after an hour, and not a second before.
      clock += HOUR_MS - 1000;
      await keeper.poll();
      expect(flushes()).to.equal(2);
      clock += 1000;
      for (let i = 0; i < 4; i++) await keeper.poll();
      expect(flushes()).to.equal(3);
      expect(refusals().length).to.equal(3);

      // The owner repairs the wallet and anyone's flush pays it. The ledger is under what was
      // refused then, which ends the hold: the next fees go out in the pass that collects them.
      booked = await feeHook.pendingMarketing(poolId);
      await feeHook.connect(alice).setMarketingWallet(poolId, marketing.address);
      await feeHook.connect(dave).flush(poolId);
      await buy(ctx, key, dave, E("1"));
      const marketingBefore = await ethers.provider.getBalance(marketing.address);
      await keeper.poll();
      expect(flushes()).to.equal(4);
      expect(await feeHook.pendingMarketing(poolId)).to.equal(0);
      expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.be.greaterThan(0).and.lessThan(booked);
      await keeper.poll();
      expect(refusals().length).to.equal(3);
    });

    it("by the Treasury holds flushPlatform back the same way", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, treasury, key, tokenAddr, dave } = ctx;
      // A Treasury that takes no ETH: the token's code, which has no receive, in its place.
      await setCode(treasury.target, await ethers.provider.getCode(tokenAddr));
      await buy(ctx, key, dave, E("3"));

      let clock = Date.now();
      const { keeper, lines } = await makeKeeper(ctx, { now: () => clock });
      const platformFlushes = () => keeper.actions.filter((x) => x.kind === "v4-flush-platform").length;
      const refusals = () => lines.filter((l) => l.startsWith(`warning: v4-flush-platform ${feeHook.target} refused: `));
      for (let i = 0; i < 6; i++) await keeper.poll();
      expect(kinds(keeper)).to.deep.equal(["v4fee-collect", "v4-flush", "v4-flush-platform"]);
      const booked = await feeHook.pendingPlatform();
      expect(booked).to.be.greaterThan(FLUSH_MIN);
      expect(refusals().length).to.equal(1);
      expect(refusals()[0]).to.include(`${ethers.formatEther(booked)} ETH stays booked`);

      // A flush's worth more (25 of the 325 points of a 3 ETH buy), or an hour.
      await buy(ctx, key, dave, E("3"));
      for (let i = 0; i < 3; i++) await keeper.poll();
      expect(platformFlushes()).to.equal(2);
      clock += HOUR_MS;
      for (let i = 0; i < 3; i++) await keeper.poll();
      expect(platformFlushes()).to.equal(3);
      expect(await feeHook.pendingPlatform()).to.be.greaterThan(booked);
    });
  });

  // ------------------------------------------------------------------ one pool failing

  describe("a pool that fails", function () {
    /** The storage slot of a pool's PoolState.seeded, found through the position id beside it. */
    async function seededSlotOf(feeHook, poolId) {
      const positionId = await feeHook.positionIdOf(poolId);
      for (let n = 0n; n < 16n; n++) {
        const base = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, n])));
        if (BigInt(await getStorageAt(feeHook.target, base)) === positionId) return base + 2n;
      }
      throw new Error("PoolState not found in the hook's storage");
    }

    it("is logged and skipped while the other pools are served, and its own ledgers are still sent on", async function () {
      const ctx = await loadFixture(launchedTwo);
      const { feeHook, a, b, marketing, dave } = ctx;
      // Pool A has ETH booked from an earlier collection, then every read of its position fails.
      await buy(ctx, a.key, dave, E("3"));
      await feeHook.collect(a.poolId);
      const booked = await feeHook.pendingMarketing(a.poolId);
      expect(booked).to.be.greaterThan(FLUSH_MIN);
      const slot = await seededSlotOf(feeHook, a.poolId);
      expect(BigInt(await getStorageAt(feeHook.target, slot))).to.equal(1n << 64n); // seeded, never converted
      await setStorageAt(feeHook.target, slot, 0);
      await expect(feeHook.collect.staticCall(a.poolId)).to.be.revertedWithCustomError(feeHook, "NotSeeded");

      await buy(ctx, a.key, dave, E("1"));
      await buy(ctx, b.key, dave, E("3"));
      await sell(ctx, b.key, dave, E("100"));

      const marketingBefore = await ethers.provider.getBalance(marketing.address);
      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();
      await keeper.poll();

      expect(lines.filter((l) => l.startsWith(`read v4fee ${a.tokenAddr} failed: `)).length).to.equal(2);
      expect(keeper.actions.map((x) => [x.kind, x.presale])).to.deep.equal([
        ["v4-flush", a.tokenAddr],
        ["v4fee-convert", b.tokenAddr],
        ["v4-flush", b.tokenAddr],
        ["v4-flush-platform", feeHook.target],
      ]);
      expect(await feeHook.pendingMarketing(a.poolId)).to.equal(0);
      expect(await feeHook.pendingTokens(b.poolId)).to.equal(0);
      expect(await feeHook.pendingMarketing(b.poolId)).to.equal(0);
      expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.be.greaterThan(booked);
    });

    it("at its flush does not stop the pools after it", async function () {
      const ctx = await loadFixture(launchedTwo);
      const { feeHook, a, b, dave } = ctx;
      await buy(ctx, a.key, dave, E("3"));
      await buy(ctx, b.key, dave, E("3"));

      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll(); // discovers both pools and serves them
      await buy(ctx, a.key, dave, E("3"));
      await buy(ctx, b.key, dave, E("3"));
      const original = keeper.v4Fee.hook.pendingMarketing;
      keeper.v4Fee.hook.pendingMarketing = async (id) => {
        if (id === a.poolId) throw new Error("rpc down");
        return original(id);
      };
      const before = keeper.actions.length;
      await keeper.poll();

      expect(lines.filter((l) => l.startsWith(`read v4 ${a.tokenAddr} failed: `)).length).to.equal(1);
      expect(keeper.actions.slice(before).map((x) => [x.kind, x.presale])).to.deep.equal([
        ["v4fee-collect", a.tokenAddr],
        ["v4fee-collect", b.tokenAddr],
        ["v4-flush", b.tokenAddr],
        ["v4-flush-platform", feeHook.target],
      ]);
    });
  });

  // ------------------------------------------------------------------ rewards

  describe("a fee mode Rewards token", function () {
    it("is paid from buys and from sells in one pass: convert, flush, distribute", async function () {
      const ctx = await loadFixture(launchedBothModes);
      const { feeHook, weth, bob, dave } = ctx;
      const { token, tokenAddr, key, poolId } = ctx.feeSide;
      await buy(ctx, key, dave, E("3"));
      await sell(ctx, key, dave, E("100"));
      const { ethFees, tokens } = await waiting(ctx, poolId);

      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();
      expect(keeper.actions.filter((x) => x.presale === tokenAddr).map((x) => x.kind)).to.deep.equal([
        "v4fee-convert",
        "v4-flush",
        "v4-rewards",
      ]);
      const [conversion] = await conversions(ctx, keeper);
      expect(conversion.tokensSold).to.equal(tokens);

      // The holders' 2 of the pool's 3.25 points, from both sides of the tax, as WETH.
      const holders = (ethFees * 200n) / 325n + (conversion.ethOut * 200n) / 325n;
      expect(await feeHook.pendingRewards(poolId)).to.equal(0);
      expect(await token.pendingRewardEth()).to.equal(0);
      expect(await token.totalRewardsDistributed()).to.equal(holders);
      expect(sent(lines, "v4-rewards")[0]).to.include(tokenAddr);

      const owed = await token.withdrawableRewardOf(bob.address);
      expect(owed).to.be.greaterThan(0);
      await token.connect(bob).claimRewards();
      expect(await weth.balanceOf(bob.address)).to.equal(owed);
    });

    it("is paid the part a thin reward route can take, the rest waits", async function () {
      // A stock that trades against WETH on Uniswap V3 in a pool of 0.1 WETH, at 6.9 TSLA each.
      const ctx = await deployPlatformV4Fee();
      const { v3Factory, weth, quickLaunch, dave } = ctx;
      const tsla = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E("1000000")]);
      await v3Factory.createPool(weth.target, tsla.target, 3000);
      const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, tsla.target, 3000));
      await weth.deposit({ value: E("0.1") });
      await weth.transfer(pool.target, E("0.1"));
      await tsla.transfer(pool.target, E("0.69"));
      await pool.sync();
      await quickLaunch.setRewardTokenAllowed(tsla.target, true);
      await quickLaunch.setRewardRouteV3(tsla.target, ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, tsla.target]));
      const { token, key } = await launchFee(ctx, Rewards, { marketingBps: 100, rewardsBps: 200 }, tsla.target);

      // 2 of the 3.25 points of a 3 ETH buy is 0.06 ETH for holders: a large bite out of 0.1 WETH.
      await buy(ctx, key, dave, E("3"));
      const { keeper, lines } = await makeKeeper(ctx);
      await keeper.poll();
      expect(await token.pendingRewardEth()).to.be.greaterThan(0);
      expect(await token.totalRewardsDistributed()).to.be.greaterThan(0);
      expect(sent(lines, "v4-rewards").some((l) => l.includes(" of "))).to.equal(true);
    });

    it("cannot be paid out by a wallet that is not the fee launcher's keeper, which is said at start", async function () {
      const ctx = await loadFixture(launchedBothModes);
      const { feeLauncher, launcher, keeper: wallet, dave } = ctx;
      const { token, tokenAddr, key } = ctx.feeSide;
      await buy(ctx, key, dave, E("3"));
      await sell(ctx, key, dave, E("100"));

      const { lines: quiet } = await makeKeeper(ctx);
      expect(quiet.some((l) => l.startsWith("warning: v4 "))).to.equal(false);

      const { keeper, lines } = await makeKeeper(ctx, { signer: dave });
      expect(lines.filter((l) => l.startsWith("warning: v4 fee mode reward distributions will fail")).length).to.equal(1);
      expect(lines.find((l) => l.startsWith("warning: v4 fee mode"))).to.include(feeLauncher.target).and.include(wallet.address);
      expect(lines.filter((l) => l.startsWith("warning: v4 hook mode")).length).to.equal(1);
      expect(lines.find((l) => l.startsWith("warning: v4 hook mode"))).to.include(launcher.target);

      // Converting and sending on are open to anyone; only the payout is refused.
      await keeper.poll();
      expect(keeper.actions.filter((x) => x.presale === tokenAddr).map((x) => x.kind)).to.deep.equal(["v4fee-convert", "v4-flush"]);
      expect(lines.filter((l) => l.startsWith(`v4-rewards ${tokenAddr} not sent: `)).length).to.equal(1);
      expect(await token.pendingRewardEth()).to.be.greaterThan(0);
      expect(await token.totalRewardsDistributed()).to.equal(0);
    });
  });

  // ------------------------------------------------------------------ the modes together and apart

  describe("the two v4 modes", function () {
    async function tradedBothModes() {
      const ctx = await launchedBothModes();
      const { hookSide, feeSide, dave } = ctx;
      await buy(ctx, hookSide.key, dave, E("2"));
      await buy(ctx, feeSide.key, dave, E("3"));
      await sell(ctx, feeSide.key, dave, E("100"));
      return ctx;
    }

    it("are served side by side, each pool through its own hook", async function () {
      const ctx = await loadFixture(tradedBothModes);
      const { hook, feeHook, treasury, hookSide, feeSide } = ctx;
      const reserveBefore = await treasury.buybackReserve();
      const treasuryBefore = await ethers.provider.getBalance(treasury.target);
      // The tax hook has booked the platform's share already; the fee hook's is still in the position.
      const bookedPlatform = await hook.pendingPlatform();
      expect(bookedPlatform).to.be.greaterThan(0);
      expect(await feeHook.pendingPlatform()).to.equal(0);

      const { keeper } = await makeKeeper(ctx);
      await keeper.poll();
      expect([...keeper.v4.launched.keys()]).to.deep.equal([hookSide.tokenAddr]);
      expect([...keeper.v4Fee.launched.keys()]).to.deep.equal([feeSide.tokenAddr]);
      expect(keeper.actions.map((x) => [x.kind, x.presale])).to.deep.equal([
        ["v4-flush", hookSide.tokenAddr],
        ["v4-rewards", hookSide.tokenAddr],
        ["v4-flush-platform", hook.target],
        ["v4fee-convert", feeSide.tokenAddr],
        ["v4-flush", feeSide.tokenAddr],
        ["v4-rewards", feeSide.tokenAddr],
        ["v4-flush-platform", feeHook.target],
      ]);

      for (const [h, side] of [[hook, hookSide], [feeHook, feeSide]]) {
        expect(await h.pendingMarketing(side.poolId)).to.equal(0);
        expect(await h.pendingRewards(side.poolId)).to.equal(0);
        expect(await h.pendingPlatform()).to.equal(0);
        expect(await ethers.provider.getBalance(h.target)).to.equal(0);
        expect(await side.token.totalRewardsDistributed()).to.be.greaterThan(0);
      }
      expect(await feeHook.pendingTokens(feeSide.poolId)).to.equal(0);
      // Both hooks paid the Treasury: more arrived than the tax hook alone owed.
      expect((await ethers.provider.getBalance(treasury.target)) - treasuryBefore).to.be.greaterThan(bookedPlatform);
      expect(await treasury.buybackReserve()).to.be.greaterThan(reserveBefore);
    });

    it("hold back a refused flush alike, while the share that is taken still goes out", async function () {
      const ctx = await loadFixture(tradedBothModes);
      const { hook, feeHook, presaleFactory, alice, hookSide, feeSide } = ctx;
      // A Rewards token takes ETH (its hook funds it), so the wallet here is the PresaleFactory,
      // which takes none.
      const refuser = presaleFactory.target;
      for (const [h, side] of [[hook, hookSide], [feeHook, feeSide]]) {
        await h.connect(alice).setMarketingWallet(side.poolId, refuser);
      }

      const { keeper, lines } = await makeKeeper(ctx);
      for (let i = 0; i < 5; i++) await keeper.poll();
      // One flush per pool, not one per poll: the holders' share was paid and distributed, the
      // creator's share was refused and stays booked.
      for (const [h, side] of [[hook, hookSide], [feeHook, feeSide]]) {
        expect(keeper.actions.filter((x) => x.presale === side.tokenAddr).map((x) => x.kind)).to.include.members(["v4-flush", "v4-rewards"]);
        expect(keeper.actions.filter((x) => x.presale === side.tokenAddr && x.kind === "v4-flush").length).to.equal(1);
        expect(lines.filter((l) => l.startsWith(`warning: v4-flush ${side.tokenAddr} refused by ${refuser}: `)).length).to.equal(1);
        expect(await h.pendingMarketing(side.poolId)).to.be.greaterThan(FLUSH_MIN);
        expect(await h.pendingRewards(side.poolId)).to.equal(0);
        expect(await side.token.totalRewardsDistributed()).to.be.greaterThan(0);
      }
    });

    it("without fee mode the keeper does what it did before fee mode existed", async function () {
      const ctx = await loadFixture(tradedBothModes);
      const { hook, feeHook, hookSide, feeSide } = ctx;
      const feeBefore = await waiting(ctx, feeSide.poolId);

      const { keeper, lines } = await makeKeeper(ctx, { v4FeeLauncherAddress: undefined, v4FeeHookAddress: undefined });
      expect(keeper.v4Fee).to.equal(null);
      expect(keeper.v4Modes.map((m) => m.kind)).to.deep.equal(["hook"]);
      await keeper.poll();
      await keeper.poll();

      // Hook mode exactly as test/v4/keeper.test.js has it; the fee mode sale is a sale like any
      // V2 one to this keeper, delivered and forgotten, and its pool is never touched.
      expect(keeper.actions.map((x) => [x.kind, x.presale])).to.deep.equal([
        ["v4-flush", hookSide.tokenAddr],
        ["v4-rewards", hookSide.tokenAddr],
        ["v4-flush-platform", hook.target],
      ]);
      expect([...keeper.v4.launched.keys()]).to.deep.equal([hookSide.tokenAddr]);
      expect(lines.some((l) => l.includes("v4fee") || l.startsWith("warning"))).to.equal(false);
      expect(keeper.done.has(feeSide.presale.target)).to.equal(true);
      expect(await waiting(ctx, feeSide.poolId)).to.deep.equal(feeBefore);
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(0);
    });

    it("fee mode alone leaves hook mode pools alone", async function () {
      const ctx = await loadFixture(tradedBothModes);
      const { hook, feeHook, hookSide, feeSide } = ctx;
      const owedBefore = await hook.pendingMarketing(hookSide.poolId);
      expect(owedBefore).to.be.greaterThan(FLUSH_MIN);

      const { keeper } = await makeKeeper(ctx, { v4LauncherAddress: undefined, v4HookAddress: undefined });
      expect(keeper.v4).to.equal(null);
      expect(keeper.v4Modes.map((m) => m.kind)).to.deep.equal(["fee"]);
      await keeper.poll();
      expect(keeper.actions.map((x) => [x.kind, x.presale])).to.deep.equal([
        ["v4fee-convert", feeSide.tokenAddr],
        ["v4-flush", feeSide.tokenAddr],
        ["v4-rewards", feeSide.tokenAddr],
        ["v4-flush-platform", feeHook.target],
      ]);
      expect(await hook.pendingMarketing(hookSide.poolId)).to.equal(owedBefore);
    });

    it("with neither mode nothing of v4 is read, and a mode needs both of its addresses", async function () {
      const ctx = await loadFixture(tradedBothModes);
      const none = { v4LauncherAddress: undefined, v4HookAddress: undefined, v4FeeLauncherAddress: undefined, v4FeeHookAddress: undefined };
      const { keeper, lines } = await makeKeeper(ctx, none);
      expect(keeper.v4).to.equal(null);
      expect(keeper.v4Fee).to.equal(null);
      expect(keeper.v4Modes).to.deep.equal([]);
      await keeper.poll();
      expect(keeper.actions).to.deep.equal([]);
      expect(lines).to.deep.equal([]);
      expect(keeper.done.size).to.equal(2);

      const { keeper: half } = await makeKeeper(ctx, { ...none, v4FeeLauncherAddress: ctx.feeLauncher.target });
      expect(half.v4Modes).to.deep.equal([]);
    });
  });

  // ------------------------------------------------------------------ rotating the keeper wallet

  describe("set-launch-keeper", function () {
    const deploymentsOf = (ctx) => ({
      presaleFactory: ctx.presaleFactory.target,
      v4Launcher: ctx.launcher.target,
      v4FeeLauncher: ctx.feeLauncher.target,
    });

    it("names the new wallet on the factory and on both launchers, and only where it is not named yet", async function () {
      const ctx = await loadFixture(deployPlatformV4Fee);
      const { presaleFactory, launcher, feeLauncher, deployer, keeper: old, dave } = ctx;
      const lines = [];
      const run = (next, deployments = deploymentsOf(ctx)) =>
        setLaunchKeeper(hre, { deployments, next, signer: deployer, log: (l) => lines.push(l) });

      const first = await run(dave.address);
      expect(first.previousLaunchKeeper).to.equal(old.address);
      expect(first.changed.map((c) => c.name)).to.deep.equal(["PresaleFactory", "V4Launcher", "V4FeeLauncher"]);
      expect(await presaleFactory.launchKeeper()).to.equal(dave.address);
      expect(await launcher.keeper()).to.equal(dave.address);
      expect(await feeLauncher.keeper()).to.equal(dave.address);

      expect((await run(dave.address)).changed).to.deep.equal([]);
      expect(lines[lines.length - 1]).to.equal("Nothing to change.");

      // A launcher that lags behind (a run that stopped half way, a launcher deployed later) is
      // brought in line on its own.
      await feeLauncher.setKeeper(old.address);
      const third = await run(dave.address);
      expect(third.changed.map((c) => c.name)).to.deep.equal(["V4FeeLauncher"]);
      expect(await feeLauncher.keeper()).to.equal(dave.address);

      // A deployments file from before the v4 modes still rotates the factory's keeper.
      const v2Only = await run(old.address, { presaleFactory: presaleFactory.target });
      expect(v2Only.changed.map((c) => c.name)).to.deep.equal(["PresaleFactory"]);
      expect(await launcher.keeper()).to.equal(dave.address);
    });

    // The deployments file was written only by the run that changed the factory. A run that
    // changed the factory and then failed at a launcher wrote nothing, and the run that finished
    // the job found the factory in line and wrote nothing either.
    it("records a rotation that an earlier run began and could not finish", async function () {
      const ctx = await loadFixture(deployPlatformV4Fee);
      const { presaleFactory, launcher, deployer, keeper: old, dave, carol } = ctx;
      const base = deploymentsOf(ctx);
      const run = (deployments) => setLaunchKeeper(hre, { deployments, next: dave.address, signer: deployer, log: () => {} });

      // The first run got as far as the factory.
      await presaleFactory.setLaunchKeeper(dave.address);
      const named = { ...base, launchKeeper: old.address, other: 1 };
      const result = await run(named);
      expect(result.changed.map((c) => c.name)).to.deep.equal(["V4Launcher", "V4FeeLauncher"]);
      expect(rotationRecord(named, dave.address, result)).to.deep.equal({
        addresses: { ...named, launchKeeper: dave.address, previousLaunchKeeper: old.address },
        previous: old.address,
        rotated: true,
      });
      // A file that never named a keeper takes the old wallet from the launcher that still did.
      expect(rotationRecord(base, dave.address, result)).to.deep.equal({
        addresses: { ...base, launchKeeper: dave.address, previousLaunchKeeper: old.address },
        previous: old.address,
        rotated: true,
      });

      // Nothing left to change. A file that agrees is left alone, one without the record gets it
      // and no rotation is announced.
      const again = await run(base);
      expect(again.changed).to.deep.equal([]);
      const current = { ...base, launchKeeper: dave.address, previousLaunchKeeper: old.address };
      expect(rotationRecord(current, dave.address, again)).to.deep.equal({ addresses: null, previous: null, rotated: false });
      expect(rotationRecord(base, dave.address, again)).to.deep.equal({
        addresses: { ...base, launchKeeper: dave.address },
        previous: null,
        rotated: false,
      });

      // A launcher brought in line with a factory the file agrees with rotates no wallet.
      await launcher.setKeeper(carol.address);
      const lagging = await run(current);
      expect(lagging.changed.map((c) => c.name)).to.deep.equal(["V4Launcher"]);
      expect(rotationRecord(current, dave.address, lagging)).to.deep.equal({ addresses: null, previous: null, rotated: false });

      // A complete run records the factory's old keeper, whatever the file said before.
      const stale = { ...base, launchKeeper: carol.address, previousLaunchKeeper: carol.address };
      const back = await setLaunchKeeper(hre, { deployments: stale, next: old.address, signer: deployer, log: () => {} });
      expect(back.changed.map((c) => c.name)).to.deep.equal(["PresaleFactory", "V4Launcher", "V4FeeLauncher"]);
      expect(rotationRecord(stale, old.address, back)).to.deep.equal({
        addresses: { ...stale, launchKeeper: old.address, previousLaunchKeeper: dave.address },
        previous: dave.address,
        rotated: true,
      });
    });

    it("sends nothing unless the signer owns every contract it has to change", async function () {
      const ctx = await loadFixture(deployPlatformV4Fee);
      const { presaleFactory, launcher, feeLauncher, deployer, keeper: old, dave, carol } = ctx;
      await feeLauncher.transferOwnership(carol.address);
      await expect(
        setLaunchKeeper(hre, { deployments: deploymentsOf(ctx), next: dave.address, signer: deployer, log: () => {} })
      ).to.be.rejectedWith("the signer must own V4FeeLauncher");
      expect(await presaleFactory.launchKeeper()).to.equal(old.address);
      expect(await launcher.keeper()).to.equal(old.address);

      await expect(
        setLaunchKeeper(hre, { deployments: deploymentsOf(ctx), next: "0x1234", signer: deployer, log: () => {} })
      ).to.be.rejectedWith("set LAUNCH_KEEPER");
    });
  });
});
