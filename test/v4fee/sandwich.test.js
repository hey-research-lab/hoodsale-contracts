const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, takeSnapshot } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { deployV4Core, deployFeeHook, poolKeyFor, sqrtPriceX96For, mintCalldata, PERMIT2 } = require("../v4/helpers");

const E = ethers.parseEther;
const FAR = 2n ** 40n;
const BPS = 10_000n;
const COOLDOWN = 300;
// V4FeeSandwich.Kind; ALL closes the position the earlier steps opened.
const KIND = { SellExactIn: 0, BuyExactIn: 1, SellExactOut: 2, BuyExactOut: 3, Convert: 4 };
const ALL = ethers.MaxUint256;

// A conversion is a sale of tokens by the hook that anyone may trigger, so it can be traded around.
// These tests pin what that is worth to an attacker and to the tax recipients, with the numbers of
// docs/fee-mode-plan.md (sections 0, 4 and 8). A wallet stands in for the launcher, as in
// fee-hook.test.js: the numbers live in the hook and the PoolManager, and one hook can then hold a
// pool at every tax.
describe("V4 fee mode conversion sandwich", function () {
  const TOKEN_LIQUIDITY = E("500000");
  const ETH_LIQUIDITY = E("10");

  /** What the attacker brings, as a fraction of the pool's token reserve: 0.1, 0.5, 1 and 2 times. */
  const INVENTORIES = [
    [1n, 10n],
    [1n, 2n],
    [1n, 1n],
    [2n, 1n],
  ];
  /**
   * One pool per total tax, in bps. `capBps` is what one conversion may sell, in bps of the reserve.
   * `loss` is what the one-transaction sandwich costs the attacker at each of the inventories above,
   * in percent of the pool's ETH reserve.
   */
  const TAXES = [
    { total: 25n, marketing: 0n, rewards: 0n, capBps: 12n, loss: [0.0249, 0.1089, 0.1961, 0.349] },
    { total: 100n, marketing: 75n, rewards: 0n, capBps: 50n, loss: [0.0972, 0.4254, 0.7676, 1.3711] },
    { total: 200n, marketing: 100n, rewards: 75n, capBps: 100n, loss: [0.1979, 0.8683, 1.5711, 2.82] },
    { total: 325n, marketing: 200n, rewards: 100n, capBps: 100n, loss: [0.4441, 1.9589, 3.5659, 6.4792] },
    { total: 500n, marketing: 300n, rewards: 175n, capBps: 100n, loss: [0.7956, 3.5359, 6.4929, 12.0119] },
    { total: 1000n, marketing: 600n, rewards: 375n, capBps: 100n, loss: [1.8478, 8.3949, 15.8285, 31.0332] },
  ];

  async function pools() {
    const [deployer, trader, keeper, mallory, creator, marketing, launcher] = await ethers.getSigners();
    const v4 = await deployV4Core(deployer);
    const treasury = await ethers.deployContract("Treasury", [deployer.address]);
    const sink = await ethers.deployContract("RewardsSinkMock");
    const { hook } = await deployFeeHook(
      deployer,
      v4.poolManager.target,
      v4.positionManager.target,
      launcher.address,
      treasury.target
    );
    const attacker = await ethers.deployContract("V4FeeSandwich", [v4.poolManager.target, hook.target]);
    const permit2 = new ethers.Contract(PERMIT2, ["function approve(address,address,uint160,uint48)"], deployer);

    const sqrtP = sqrtPriceX96For(TOKEN_LIQUIDITY, ETH_LIQUIDITY);
    const [lower, upper] = await v4.swapper.usableTicks(200);
    const liquidity = await v4.swapper.liquidityForAmounts(
      sqrtP,
      await v4.swapper.sqrtPriceAtTick(lower),
      await v4.swapper.sqrtPriceAtTick(upper),
      ETH_LIQUIDITY,
      TOKEN_LIQUIDITY
    );

    const byTax = {};
    for (const tax of TAXES) {
      const token = await ethers.deployContract("MockOwnedERC20", ["Fee", "FEE", E("100000000"), creator.address]);
      const key = poolKeyFor(token.target, { fee: Number(tax.total) * 100, tickSpacing: 200, hooks: hook.target });
      const keyArr = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
      const poolId = await v4.swapper.poolId(keyArr);

      // What the launcher does in one call: register, open the pool, mint the position to the hook.
      await token.connect(creator).transfer(launcher.address, TOKEN_LIQUIDITY);
      await token.connect(launcher).approve(PERMIT2, ethers.MaxUint256);
      await permit2.connect(launcher).approve(token.target, v4.positionManager.target, 2n ** 160n - 1n, 2n ** 48n - 1n);
      const tokenId = await v4.positionManager.nextTokenId();
      const rewardsSink = tax.rewards > 0n ? sink.target : ethers.ZeroAddress;
      const config = [
        token.target,
        marketing.address,
        rewardsSink,
        tax.marketing,
        tax.marketing,
        tax.rewards,
        tax.rewards,
        true,
        false,
        false,
      ];
      await hook.connect(launcher).register(keyArr, config, tokenId);
      await v4.poolManager.connect(launcher).initialize(keyArr, sqrtP);
      const mint = mintCalldata({
        key,
        tickLower: lower,
        tickUpper: upper,
        liquidity,
        amount0Max: ETH_LIQUIDITY,
        amount1Max: TOKEN_LIQUIDITY,
        recipient: hook.target,
      });
      await v4.positionManager.connect(launcher).modifyLiquidities(mint, FAR, { value: ETH_LIQUIDITY });

      await token.connect(creator).transfer(trader.address, E("10000000"));
      await token.connect(trader).approve(v4.swapper.target, ethers.MaxUint256);
      byTax[tax.total] = { ...tax, token, keyArr, poolId };
    }
    return { trader, keeper, mallory, creator, v4, hook, attacker, byTax };
  }

  /** The pool's two virtual reserves, L * sqrtP / 2^96 tokens and L * 2^96 / sqrtP ETH. */
  async function reserves(f, p) {
    const { sqrtPriceX96 } = await f.v4.stateView.getSlot0(p.poolId);
    const liquidity = await f.v4.stateView.getLiquidity(p.poolId);
    return { tokens: (liquidity * sqrtPriceX96) >> 96n, eth: (liquidity << 96n) / sqrtPriceX96 };
  }

  /** Everything the hook has to sell: what it has collected and what still waits in the position. */
  async function backlog(f, p) {
    const { tokenFees } = await f.hook.collect.staticCall(p.poolId);
    return (await f.hook.pendingTokens(p.poolId)) + tokenFees;
  }

  /** Ordinary trading: a holder sells `tokens` and the ETH the sale paid out buys tokens again. */
  async function roundTrip(f, p, tokens) {
    const swapper = f.v4.swapper.connect(f.trader);
    const eth = await swapper.swapExactIn.staticCall(p.keyArr, false, tokens, 0, f.trader.address);
    await swapper.swapExactIn(p.keyArr, false, tokens, 0, f.trader.address);
    if (eth > 0n) await swapper.swapExactIn(p.keyArr, true, eth, 0, f.trader.address, { value: eth });
  }

  /**
   * Trades until the token tax nobody has converted is worth `caps` conversions of a pool holding
   * `reservesHeld` times its reserve: the backlog a busy market leaves while no keeper runs.
   */
  async function tradeUntilBacklog(f, p, caps, reservesHeld = 1n) {
    for (;;) {
      const { tokens } = await reserves(f, p);
      if ((await backlog(f, p)) >= (tokens * reservesHeld * p.capBps * caps) / BPS) return;
      await roundTrip(f, p, tokens / 4n);
    }
  }

  /**
   * Trades until the unconverted token tax is `percent` of tax / (1 - tax) of the reserve: whole
   * round trips, then one cut to size. The reserve moves a little with every trade, so the target
   * is read again each time, and a millionth of it is close enough: the tax on a sale of a few wei
   * rounds away and would never close the gap.
   */
  async function tradeToBacklog(f, p, percent) {
    for (;;) {
      const { tokens } = await reserves(f, p);
      const target = (tokens * p.total * percent) / ((BPS - p.total) * 100n);
      const missing = target - (await backlog(f, p));
      if (missing <= target / 1_000_000n) return;
      const size = (missing * BPS) / p.total;
      await roundTrip(f, p, size < tokens / 4n ? size : tokens / 4n);
    }
  }

  async function fund(f, p, tokens, eth) {
    await p.token.connect(f.creator).transfer(f.attacker.target, tokens);
    await f.mallory.sendTransaction({ to: f.attacker.target, value: eth });
  }

  /** The cap the hook reads inside the attack: that of the pool as the opening sale leaves it. */
  async function capAfterSale(f, p, inventory) {
    const snapshot = await takeSnapshot();
    await f.attacker.run(p.keyArr, [{ kind: KIND.SellExactIn, amount: inventory }]);
    const cap = await f.hook.maxConvert(p.poolId);
    await snapshot.restore();
    return cap;
  }

  /** Collects, then reads what the recipients are owed and the token tax still to be sold. */
  async function recipients(f, p) {
    await f.hook.collect(p.poolId);
    const marketing = await f.hook.pendingMarketing(p.poolId);
    const rewards = await f.hook.pendingRewards(p.poolId);
    const platform = await f.hook.pendingPlatform();
    const eth = marketing + rewards + platform;
    expect(await ethers.provider.getBalance(f.hook.target)).to.equal(eth);
    return { marketing, rewards, platform, eth, tokens: await f.hook.pendingTokens(p.poolId) };
  }

  /**
   * The plan's simulation: a constant product pool that takes its fee from what is paid in, with
   * both reserves counted as 1. The attacker sells `inventory`, `windows` conversions each sell one
   * cap of the reserve they find, and the attacker buys its inventory back.
   * @returns the attacker's profit as a fraction of the pool's ETH reserve
   */
  function model(tax, inventory, windows) {
    const fee = Number(tax.total) / Number(BPS);
    const cap = Number(tax.capBps) / Number(BPS);
    let tokens = 1 + inventory * (1 - fee);
    const proceeds = 1 - 1 / tokens;
    for (let window = 0; window < windows; window++) tokens *= 1 + cap * (1 - fee);
    const cost = (1 / (tokens - inventory) - 1 / tokens) / (1 - fee);
    return proceeds - cost;
  }

  /**
   * Holds what the attacker made to the simulation, to a billionth of the pool's ETH reserve: integer
   * rounding is all that separates the two.
   * @returns what the attacker made, in percent of the pool's ETH reserve
   */
  function expectModelled(ethDelta, ethReserve, predicted) {
    const made = Number(ethDelta) / Number(ethReserve);
    expect(made).to.be.closeTo(predicted, 1e-9);
    return made * 100;
  }

  // ------------------------------------------------------------------ one transaction

  describe("in one transaction: sell, convert with no floor, buy back", function () {
    for (const tax of TAXES) {
      it(`at ${tax.total} bps the attacker loses whatever it brings, and the tax recipients gain`, async function () {
        const f = await loadFixture(pools);
        const p = f.byTax[tax.total];
        // The worst case for the pool: more token tax waiting than the largest attack lets the hook
        // sell, so every conversion below is a full cap.
        await tradeUntilBacklog(f, p, 1n, 4n);
        const pool = await reserves(f, p);
        const snapshot = await takeSnapshot();

        // Left alone, the conversion sells one cap of the reserve at the market's price.
        const quietCap = await f.hook.maxConvert(p.poolId);
        const quietly = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
        expect(quietly.tokensSold).to.equal(quietCap);
        await f.hook.connect(f.keeper).convert(p.poolId, 1, 0, FAR);
        const quiet = await recipients(f, p);
        await snapshot.restore();

        for (const [i, [num, den]] of INVENTORIES.entries()) {
          const inventory = (pool.tokens * num) / den;
          await fund(f, p, inventory, E("10"));
          const atExecution = await capAfterSale(f, p, inventory);
          const steps = [
            { kind: KIND.SellExactIn, amount: inventory },
            { kind: KIND.Convert, amount: 0 },
            { kind: KIND.BuyExactOut, amount: ALL },
          ];
          const result = await f.attacker.run.staticCall(p.keyArr, steps);
          await expect(f.attacker.run(p.keyArr, steps))
            .to.emit(f.attacker, "Ran")
            .withArgs(result.ethDelta, 0, result.tokensConverted, result.ethConverted);

          // The sale inflated the reserve and with it the cap, and the hook sold that much for less.
          expect(result.tokensConverted).to.equal(atExecution);
          expect(atExecution).to.be.greaterThan(quietCap);
          expect(result.ethConverted).to.be.lessThan(quietly.ethOut);

          // The attacker is flat in tokens and down in ETH, by what the plan's simulation says.
          expect(result.tokenDelta).to.equal(0n);
          expect(result.ethDelta).to.be.lessThan(0n);
          const made = expectModelled(result.ethDelta, pool.eth, model(tax, Number(num) / Number(den), 1));
          expect(made).to.be.closeTo(-tax.loss[i], 0.00005);

          // The two pool fees the attacker paid are tax: every recipient ends with more ETH than
          // after the quiet conversion, and more tokens are left to sell.
          const attacked = await recipients(f, p);
          expect(attacked.eth).to.be.greaterThan(quiet.eth);
          expect(attacked.platform).to.be.greaterThan(quiet.platform);
          if (tax.marketing > 0n) expect(attacked.marketing).to.be.greaterThan(quiet.marketing);
          if (tax.rewards > 0n) expect(attacked.rewards).to.be.greaterThan(quiet.rewards);
          expect(attacked.tokens).to.be.greaterThan(quiet.tokens);
          await snapshot.restore();
        }
      });
    }

    it("the other order, buying ahead of the conversion and selling after it, loses as well", async function () {
      const f = await loadFixture(pools);
      for (const tax of TAXES) {
        const p = f.byTax[tax.total];
        await tradeUntilBacklog(f, p, 1n);
        const pool = await reserves(f, p);
        const quietly = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
        await fund(f, p, 0n, E("25"));

        for (const [num, den] of INVENTORIES) {
          const steps = [
            { kind: KIND.BuyExactIn, amount: (pool.eth * num) / den },
            { kind: KIND.Convert, amount: 0 },
            { kind: KIND.SellExactIn, amount: ALL },
          ];
          const result = await f.attacker.run.staticCall(p.keyArr, steps);
          expect(result.tokenDelta).to.equal(0n);
          expect(result.ethDelta).to.be.lessThan(0n);
          // The purchase shrank the reserve and the cap, and the hook sold into the higher price.
          expect(result.tokensConverted).to.be.within(1n, quietly.tokensSold - 1n);
          expect(result.ethConverted * quietly.tokensSold).to.be.greaterThan(quietly.ethOut * result.tokensConverted);
        }
      }
    });
  });

  // ------------------------------------------------------------------ several windows

  describe("held open across windows, with a backlog to sell and half the reserve as inventory", function () {
    // The first window in which the attack pays (docs/fee-mode-plan.md, section 0): the cap of half
    // the tax breaks at 3 windows, the absolute cap of 1% later the higher the tax. `before` and `at`
    // are what closing makes one window earlier and in that window, in percent of the pool's ETH.
    const FIRST_PROFITABLE = {
      25: { window: 3, before: -0.0092, at: 0.0901 },
      100: { window: 3, before: -0.0144, at: 0.3909 },
      200: { window: 3, before: -0.0572, at: 0.7322 },
      325: { window: 4, before: -0.3384, at: 0.4399 },
      500: { window: 6, before: -0.322, at: 0.4302 },
      1000: { window: 12, before: -0.5221, at: 0.1635 },
    };

    for (const tax of TAXES) {
      const { window: documented, before, at } = FIRST_PROFITABLE[tax.total];

      it(`at ${tax.total} bps the attack first pays in window ${documented}`, async function () {
        const f = await loadFixture(pools);
        const p = f.byTax[tax.total];

        let simulated = 1;
        while (model(tax, 0.5, simulated) <= 0) simulated++;
        expect(simulated).to.equal(documented);

        // The precondition: enough unconverted token tax for a full cap in every window, of a pool
        // that holds one and a half times its reserve while the attack lasts.
        await tradeUntilBacklog(f, p, BigInt(documented + 1), 2n);
        const pool = await reserves(f, p);
        const inventory = pool.tokens / 2n;
        await fund(f, p, inventory, E("10"));

        // Window 1 opens the attack: the sale and the first conversion in one transaction.
        const firstCap = await capAfterSale(f, p, inventory);
        const opening = [
          { kind: KIND.SellExactIn, amount: inventory },
          { kind: KIND.Convert, amount: 0 },
        ];
        const opened = await f.attacker.run.staticCall(p.keyArr, opening);
        await f.attacker.run(p.keyArr, opening);
        expect(opened.tokensConverted).to.equal(firstCap);

        for (let window = 1; window <= documented; window++) {
          if (window > 1) {
            await time.increase(COOLDOWN);
            const cap = await f.hook.maxConvert(p.poolId);
            await expect(f.hook.connect(f.mallory).convert(p.poolId, 1, 0, FAR))
              .to.emit(f.hook, "Converted")
              .withArgs(p.poolId, f.mallory.address, cap, anyValue);
          }
          // What closing now would make: the ETH of the sale less the cost of buying it all back.
          const closing = await f.attacker.run.staticCall(p.keyArr, [{ kind: KIND.BuyExactOut, amount: inventory }]);
          expect(closing.tokenDelta).to.equal(inventory);
          const profit = opened.ethDelta + closing.ethDelta;
          const made = expectModelled(profit, pool.eth, model(tax, 0.5, window));
          if (window < documented) expect(profit).to.be.lessThan(0n);
          else expect(profit).to.be.greaterThan(0n);
          if (window === documented - 1) expect(made).to.be.closeTo(before, 0.00005);
          if (window === documented) expect(made).to.be.closeTo(at, 0.00005);
        }
      });
    }
  });

  // ------------------------------------------------------------------ the precondition

  describe("the backlog the attack needs", function () {
    /**
     * Opens the attack and keeps converting, one window after another, until the hook has nothing
     * left worth selling. Returns the best the attacker could have closed at along the way.
     */
    async function bestClose(f, p, inventory) {
      await fund(f, p, inventory, E("10"));
      const opening = [
        { kind: KIND.SellExactIn, amount: inventory },
        { kind: KIND.Convert, amount: 0 },
      ];
      const opened = await f.attacker.run.staticCall(p.keyArr, opening);
      await f.attacker.run(p.keyArr, opening);
      const dust = opened.tokensConverted / 1_000_000n;

      let best;
      for (;;) {
        const closing = await f.attacker.run.staticCall(p.keyArr, [{ kind: KIND.BuyExactOut, amount: inventory }]);
        const profit = opened.ethDelta + closing.ethDelta;
        if (best === undefined || profit > best) best = profit;
        if ((await backlog(f, p)) <= dust) return best;
        await time.increase(COOLDOWN);
        await f.hook.connect(f.mallory).convert(p.poolId, 1, 0, FAR);
      }
    }

    // The cap and the cooldown decide how long the attack takes. Whether it can pay at all is
    // decided by the backlog alone. The attacker pays the pool's fee on the way in and on the way
    // out, and gets back what the hook's sales move the price by; in the constant product model it
    // breaks even when the token tax nobody had converted is exactly tax / (1 - tax) of the reserve,
    // whatever the inventory and whatever the cap: 0.25%, 1.01%, 2.04%, 3.36%, 5.26% and 11.1%.
    for (const tax of TAXES) {
      it(`at ${tax.total} bps it is tax / (1 - tax) of the reserve, whatever is brought and however long it is held`, async function () {
        const f = await loadFixture(pools);
        const p = f.byTax[tax.total];

        for (const [percent, pays] of [
          [98n, false],
          [102n, true],
        ]) {
          await tradeToBacklog(f, p, percent);
          const pool = await reserves(f, p);
          const snapshot = await takeSnapshot();
          for (const [num, den] of INVENTORIES) {
            const best = await bestClose(f, p, (pool.tokens * num) / den);
            if (pays) expect(best).to.be.greaterThan(0n);
            else expect(best).to.be.lessThan(0n);
            await snapshot.restore();
          }
        }
      });
    }
  });

  // ------------------------------------------------------------------ the keeper

  describe("with a keeper converting every window", function () {
    const WINDOWS = 12;

    /** Twelve windows of ordinary trading, a fifth of the reserve sold and bought back in each. */
    async function trading(f, p, keeperRuns) {
      for (let window = 0; window < WINDOWS; window++) {
        const { tokens } = await reserves(f, p);
        await roundTrip(f, p, tokens / 5n);
        await time.increase(COOLDOWN);
        if (!keeperRuns) continue;

        // 0.65% of the reserve in token tax per window, against a cap of 1%.
        const cap = await f.hook.maxConvert(p.poolId);
        expect(await backlog(f, p)).to.be.lessThan(cap);
        // The keeper's pass: quote, then convert with 1% of slippage allowed.
        const quote = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
        await f.hook.connect(f.keeper).convert(p.poolId, quote.tokensSold, (quote.ethOut * 99n) / 100n, FAR);
        // All that waits after it is the pool fee of the conversion itself.
        expect(await backlog(f, p)).to.be.lessThan(cap / 20n);
      }
    }

    /** The multi-window attack with half the reserve; what closing would make after each window. */
    async function attack(f, p, windows) {
      // The attacker waits for a window to open: the keeper's last conversion may have just run.
      await time.increase(COOLDOWN);
      const pool = await reserves(f, p);
      const inventory = pool.tokens / 2n;
      await fund(f, p, inventory, E("10"));
      const opened = await f.attacker.run.staticCall(p.keyArr, [{ kind: KIND.SellExactIn, amount: inventory }]);
      await f.attacker.run(p.keyArr, [{ kind: KIND.SellExactIn, amount: inventory }]);
      const cap = await f.hook.maxConvert(p.poolId);

      const profits = [];
      let converted = 0n;
      for (let window = 1; window <= windows; window++) {
        if (window > 1) await time.increase(COOLDOWN);
        if ((await backlog(f, p)) > 0n) {
          const { tokensSold } = await f.hook.connect(f.mallory).convert.staticCall(p.poolId, 1, 0, FAR);
          await f.hook.connect(f.mallory).convert(p.poolId, 1, 0, FAR);
          converted += tokensSold;
        }
        const closing = await f.attacker.run.staticCall(p.keyArr, [{ kind: KIND.BuyExactOut, amount: inventory }]);
        profits.push(opened.ethDelta + closing.ethDelta);
      }
      return { profits, converted, cap, ethReserve: pool.eth };
    }

    it("the backlog stays under one cap, and the attack has nothing to work with", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[325n];
      const snapshot = await takeSnapshot();

      // The keeper is down: the same trading leaves seven caps of token tax, and the attack that
      // holds the price down across four windows pays, as documented.
      await trading(f, p, false);
      expect(await backlog(f, p)).to.be.greaterThan((await f.hook.maxConvert(p.poolId)) * 7n);
      const unguarded = await attack(f, p, 4);
      expect(unguarded.converted).to.be.greaterThan(unguarded.cap * 4n);
      for (const profit of unguarded.profits.slice(0, 3)) expect(profit).to.be.lessThan(0n);
      expect(unguarded.profits[3]).to.be.greaterThan(0n);
      await snapshot.restore();

      // The keeper runs: the only token tax there is to convert is what the attacker's own sale
      // paid, 1.625% of the reserve, a little over one cap of the pool it inflated. However long
      // the price is held down, the hook sells no more than that and the attack never pays.
      await trading(f, p, true);
      const guarded = await attack(f, p, 14);
      expect(guarded.converted).to.be.lessThan((guarded.cap * 5n) / 4n);
      for (const profit of guarded.profits) expect(profit).to.be.lessThan(0n);
      // The attack is left between its first and its second full window, at a loss of 1.8% of the
      // pool's ETH: the two pool fees it paid, less what one conversion gave back.
      const last = Number(guarded.profits[13]) / Number(guarded.ethReserve);
      expect(last).to.be.within(model(p, 0.5, 1), model(p, 0.5, 2));
      expect(last).to.be.closeTo(-0.0184, 0.0005);
      // From the fourth window on there is nothing left worth selling, and the loss no longer moves.
      expect(guarded.profits[13] - guarded.profits[3]).to.be.within(0n, guarded.ethReserve / 1_000_000n);
    });
  });
});
