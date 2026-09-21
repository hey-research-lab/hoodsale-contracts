const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, takeSnapshot } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { deployV4Core, deployFeeHook, poolKeyFor, sqrtPriceX96For, mintCalldata, PERMIT2 } = require("../v4/helpers");

const E = ethers.parseEther;
const FAR = 2n ** 40n;
const BPS = 10_000n;
const PIPS = 1_000_000n;
const PLATFORM_BPS = 25n;
const COOLDOWN = 300;
// V4FeeSandwich.Kind
const KIND = { SellExactIn: 0, BuyExactIn: 1, SellExactOut: 2, BuyExactOut: 3, Convert: 4 };

// The economics of a fee mode conversion with their numbers asserted (docs/fee-mode-plan.md, sections
// 4 and 9). A wallet stands in for the launcher, as in fee-hook.test.js: the numbers live in the hook
// and the PoolManager, and one hook can then hold a pool at every tax.
describe("V4 fee mode conversion economics", function () {
  const TOKEN_LIQUIDITY = E("500000");
  const ETH_LIQUIDITY = E("10");

  /** One pool per total tax, in bps. `capBps` is what one conversion may sell, in bps of the reserve. */
  const TAXES = [
    { total: 25n, marketing: 0n, rewards: 0n, capBps: 12n }, // a Standard launch
    { total: 100n, marketing: 75n, rewards: 0n, capBps: 50n }, // a Tax launch
    { total: 200n, marketing: 100n, rewards: 75n, capBps: 100n },
    { total: 325n, marketing: 200n, rewards: 100n, capBps: 100n }, // the plan's reference pool
    { total: 500n, marketing: 300n, rewards: 175n, capBps: 100n },
    { total: 1000n, marketing: 600n, rewards: 375n, capBps: 100n }, // the most a launch may charge
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
    const donor = await ethers.deployContract("V4TestLiquidity", [v4.poolManager.target]);
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
      await token.connect(trader).approve(donor.target, ethers.MaxUint256);
      byTax[tax.total] = { ...tax, token, keyArr, poolId, tokenId };
    }
    return { deployer, trader, keeper, mallory, creator, marketing, v4, hook, donor, attacker, liquidity, byTax };
  }

  const sell = (f, p, tokens) => f.v4.swapper.connect(f.trader).swapExactIn(p.keyArr, false, tokens, 0, f.trader.address);
  const buy = (f, p, eth) =>
    f.v4.swapper.connect(f.trader).swapExactIn(p.keyArr, true, eth, 0, f.trader.address, { value: eth });

  /** A holder sells and the price comes back: the ETH the sale paid out buys tokens again. */
  async function roundTrip(f, p, tokens) {
    const eth = await f.v4.swapper.connect(f.trader).swapExactIn.staticCall(p.keyArr, false, tokens, 0, f.trader.address);
    await sell(f, p, tokens);
    await buy(f, p, eth);
  }

  /** L * sqrtP / 2^96: the tokens a full range position holds at the pool's price. */
  async function tokenReserve(f, p) {
    const { sqrtPriceX96 } = await f.v4.stateView.getSlot0(p.poolId);
    return ((await f.v4.stateView.getLiquidity(p.poolId)) * sqrtPriceX96) >> 96n;
  }

  /** Everything the hook has to sell: what it has collected and what still waits in the position. */
  async function backlog(f, p) {
    const { tokenFees } = await f.hook.collect.staticCall(p.poolId);
    return (await f.hook.pendingTokens(p.poolId)) + tokenFees;
  }

  /** How the hook splits an ETH amount: the two shares round down, the platform takes the rest. */
  function split(p, amount) {
    const marketing = (amount * p.marketing) / p.total;
    const rewards = (amount * p.rewards) / p.total;
    return { marketing, rewards, platform: amount - marketing - rewards };
  }

  const min = (a, b) => (a < b ? a : b);

  // ------------------------------------------------------------------ accrual

  describe("the fee a trade leaves in the position", function () {
    // A Standard launch, the plan's reference pool, a round 5% and the most a launch may charge.
    const RATES = [25n, 325n, 500n, 1000n];

    /** Collects, and returns what the position had earned since the last collection. */
    async function collected(f, p) {
      const fees = await f.hook.collect.staticCall(p.poolId);
      await f.hook.collect(p.poolId);
      return fees;
    }

    it("is the pool's fee on what the trader pays in, exact-input or exact-output, buying or selling, at every tax", async function () {
      const f = await loadFixture(pools);
      const { swapper } = f.v4;
      const who = f.trader.address;

      for (const total of RATES) {
        const p = f.byTax[total];
        const label = `${total} bps`;
        const feeOn = (paidIn) => (paidIn * total) / BPS;

        // Exact input, the shape every other test trades in: ETH on a buy, tokens on a sell.
        await buy(f, p, E("1"));
        let fees = await collected(f, p);
        expect(fees.ethFees, label).to.be.closeTo(feeOn(E("1")), 2n);
        expect(fees.tokenFees, label).to.equal(0n);
        await sell(f, p, E("20000"));
        fees = await collected(f, p);
        expect(fees.tokenFees, label).to.be.closeTo(feeOn(E("20000")), 2n);
        expect(fees.ethFees, label).to.equal(0n);

        // Exact output, buying: the trader names the tokens and the pool names the ETH. The fee is
        // charged on that ETH, the gross amount paid in, at the same rate.
        const tokensOut = E("20000");
        const ethPaid = await swapper.connect(f.trader).swapExactOut.staticCall(p.keyArr, true, tokensOut, E("5"), who, { value: E("5") });
        const bought = swapper.connect(f.trader).swapExactOut(p.keyArr, true, tokensOut, E("5"), who, { value: E("5") });
        await expect(bought).to.changeEtherBalance(f.trader, -ethPaid);
        await expect(bought).to.changeTokenBalance(p.token, f.trader, tokensOut);
        fees = await collected(f, p);
        expect(fees.ethFees, label).to.be.closeTo(feeOn(ethPaid), 2n);
        expect(fees.tokenFees, label).to.equal(0n);

        // Exact output, selling: the trader names the ETH and the pool names the tokens.
        const ethOut = E("0.5");
        const tokensPaid = await swapper.connect(f.trader).swapExactOut.staticCall(p.keyArr, false, ethOut, E("100000"), who);
        const sold = swapper.connect(f.trader).swapExactOut(p.keyArr, false, ethOut, E("100000"), who);
        await expect(sold).to.changeTokenBalance(p.token, f.trader, -tokensPaid);
        await expect(sold).to.changeEtherBalance(f.trader, ethOut);
        fees = await collected(f, p);
        expect(fees.tokenFees, label).to.be.closeTo(feeOn(tokensPaid), 2n);
        expect(fees.ethFees, label).to.equal(0n);

        // Nothing but fees was taken: the position is whole, and what it earned is on the hook's books.
        expect(await f.v4.positionManager.getPositionLiquidity(p.tokenId), label).to.equal(f.liquidity);
        expect(await f.hook.pendingTokens(p.poolId), label).to.be.closeTo(feeOn(E("20000")) + feeOn(tokensPaid), 4n);
      }

      // Every wei of ETH the four pools collected is booked, and nothing else is on the hook.
      let ledgers = await f.hook.pendingPlatform();
      for (const total of RATES) {
        const p = f.byTax[total];
        ledgers += (await f.hook.pendingMarketing(p.poolId)) + (await f.hook.pendingRewards(p.poolId));
      }
      expect(await ethers.provider.getBalance(f.hook.target)).to.equal(ledgers);
    });
  });

  // ------------------------------------------------------------------ the cap

  describe("the cap of one conversion", function () {
    it("is min(total / 2, 100) bps of the virtual token reserve, at every tax", async function () {
      const f = await loadFixture(pools);
      expect(await f.hook.MAX_CONVERT_BPS()).to.equal(100n);

      for (const tax of TAXES) {
        const p = f.byTax[tax.total];
        // 12, 50 and 100 bps: half of 25 rounds down, and from a 2% tax on the 1% ceiling decides
        expect(min(tax.total / 2n, 100n)).to.equal(tax.capBps);
        expect(await f.hook.feeBps(p.poolId, true)).to.equal(tax.total);

        // A full range position holds what the launch paid in, to a few hundred wei.
        const reserve = await tokenReserve(f, p);
        expect(reserve).to.be.closeTo(TOKEN_LIQUIDITY, 1000n);
        expect(reserve).to.be.closeTo(await p.token.balanceOf(f.v4.poolManager.target), 1000n);

        const cap = await f.hook.maxConvert(p.poolId);
        expect(cap).to.equal((reserve * tax.capBps) / BPS);
        // 600, 2,500 and 5,000 tokens of the 500,000 in the pool
        expect(cap).to.be.closeTo((TOKEN_LIQUIDITY * tax.capBps) / BPS, 1n);
      }
      expect(await f.hook.maxConvert(ethers.ZeroHash)).to.equal(0n);
    });

    it("moves with the pool, and is read when the conversion runs, inside the same transaction", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[325n];
      const expected = async () => ((await tokenReserve(f, p)) * p.capBps) / BPS;

      // More token tax than one conversion may sell, so the cap decides the size. Of the 400,000
      // tokens sold, all but the 3.25% joined the reserve: a sale raises the cap, a purchase lowers it.
      await sell(f, p, E("400000"));
      const afterSale = await f.hook.maxConvert(p.poolId);
      expect(afterSale).to.equal(await expected());
      expect(afterSale).to.be.closeTo((E("887000") * p.capBps) / BPS, E("1"));
      await buy(f, p, E("1"));
      const quoted = await f.hook.maxConvert(p.poolId);
      expect(quoted).to.equal(await expected());
      expect(quoted).to.be.lessThan(afterSale);
      expect(await backlog(f, p)).to.be.greaterThan((quoted * 3n) / 2n);

      // A sale in the same transaction, ahead of the conversion: the hook sells the cap of the pool
      // as that sale left it, not the cap anyone read before.
      const inventory = E("300000");
      await p.token.connect(f.creator).transfer(f.attacker.target, inventory);
      const opening = { kind: KIND.SellExactIn, amount: inventory };
      const snapshot = await takeSnapshot();
      await f.attacker.run(p.keyArr, [opening]);
      const atExecution = await f.hook.maxConvert(p.poolId);
      expect(atExecution).to.equal(await expected());
      await snapshot.restore();

      const steps = [opening, { kind: KIND.Convert, amount: 0 }];
      const result = await f.attacker.run.staticCall(p.keyArr, steps);
      expect(result.tokensConverted).to.equal(atExecution);
      expect(atExecution).to.be.greaterThan((quoted * 13n) / 10n);
      await expect(f.attacker.run(p.keyArr, steps))
        .to.emit(f.hook, "Converted")
        .withArgs(p.poolId, f.attacker.target, atExecution, result.ethConverted);
    });
  });

  // ------------------------------------------------------------------ the pace

  describe("a backlog", function () {
    it("drains one cap per 300 s window and not a second sooner, the remainder in the last", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[325n];
      // A large holder sells and the price comes back: 19,500 tokens of tax, a little under four caps.
      await roundTrip(f, p, E("600000"));
      const start = await backlog(f, p);
      expect(start).to.be.closeTo(E("19500"), 2n);
      const firstCap = await f.hook.maxConvert(p.poolId);
      expect(start).to.be.greaterThan(firstCap * 3n);
      expect(start).to.be.lessThan(firstCap * 4n);

      const sold = [];
      let at = (await time.latest()) + 60;
      for (let window = 1; window <= 4; window++) {
        const waiting = await backlog(f, p);
        const cap = await f.hook.maxConvert(p.poolId);
        const amount = min(waiting, cap);

        await time.setNextBlockTimestamp(at);
        await expect(f.hook.connect(f.keeper).convert(p.poolId, 1, 0, FAR))
          .to.emit(f.hook, "Converted")
          .withArgs(p.poolId, f.keeper.address, amount, anyValue);
        sold.push({ amount, cap });
        expect(await f.hook.lastConvertAt(p.poolId)).to.equal(at);
        expect(await f.hook.nextConvertAt(p.poolId)).to.equal(at + COOLDOWN);

        // What was sold left the backlog; the pool fee the sale paid came back into it.
        const recycled = (amount * p.total) / BPS;
        expect(await backlog(f, p)).to.be.closeTo(waiting - amount + recycled, 2n);

        // The last second of the window, mined: there is plenty left to sell and nobody may sell it.
        await time.setNextBlockTimestamp(at + COOLDOWN - 1);
        await expect(
          f.hook.connect(f.mallory).convert(p.poolId, 1, 0, FAR, { gasLimit: 1_000_000 })
        ).to.be.revertedWithCustomError(f.hook, "CoolingDown");
        expect(await time.latest()).to.equal(at + COOLDOWN - 1);
        at += COOLDOWN;
      }

      // Three full caps, each of a reserve the last conversion made a little larger, then the rest.
      for (const { amount, cap } of sold.slice(0, 3)) expect(amount).to.equal(cap);
      expect(sold[1].cap).to.be.greaterThan(sold[0].cap);
      expect(sold[2].cap).to.be.greaterThan(sold[1].cap);
      expect(sold[3].amount).to.be.lessThan(sold[3].cap);
      // All that waits now is the pool fee of the last conversion.
      expect(await backlog(f, p)).to.be.closeTo((sold[3].amount * p.total) / BPS, 2n);
      expect(await p.token.balanceOf(f.hook.target)).to.equal(await f.hook.pendingTokens(p.poolId));
    });

    it("a failed conversion does not start the window, and a pool's window is its own", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[325n];
      const other = f.byTax[500n];
      await sell(f, p, E("20000"));
      await sell(f, other, E("20000"));

      const quote = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
      await expect(f.hook.convert(p.poolId, quote.tokensSold, quote.ethOut + 1n, FAR))
        .to.be.revertedWithCustomError(f.hook, "TooLittleReceived")
        .withArgs(quote.ethOut, quote.ethOut + 1n);
      expect(await f.hook.lastConvertAt(p.poolId)).to.equal(0n);

      await f.hook.convert(p.poolId, quote.tokensSold, quote.ethOut, FAR);
      await expect(f.hook.convert(p.poolId, 1, 0, FAR)).to.be.revertedWithCustomError(f.hook, "CoolingDown");
      await f.hook.convert(other.poolId, 1, 0, FAR);
    });
  });

  // ------------------------------------------------------------------ the price floor

  describe("the price floor", function () {
    /** A pool with 650 tokens of tax waiting, less than one cap, so a conversion sells all of it. */
    async function waiting() {
      const f = await pools();
      const p = f.byTax[325n];
      await sell(f, p, E("20000"));
      const quote = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
      return { ...f, p, sold: quote.tokensSold, out: quote.ethOut };
    }

    /** ceil(minEthOut * tokensSold / quotedTokens), what the hook holds a conversion to. */
    const floorFor = (quotedTokens, minEthOut, sold) => (minEthOut * sold + quotedTokens - 1n) / quotedTokens;

    /** The conversion goes through when it pays the floor and reverts naming both numbers when not. */
    async function expectHeldTo(f, quotedTokens, minEthOut) {
      const floor = floorFor(quotedTokens, minEthOut, f.sold);
      const call = f.hook.convert.staticCall(f.p.poolId, quotedTokens, minEthOut, FAR);
      if (f.out >= floor) {
        expect((await call).ethOut).to.equal(f.out);
      } else {
        await expect(call).to.be.revertedWithCustomError(f.hook, "TooLittleReceived").withArgs(f.out, floor);
      }
      return f.out >= floor;
    }

    it("is a price: scaled to the size really sold, rounded up", async function () {
      const f = await loadFixture(waiting);
      const { sold, out } = f;
      expect(sold).to.be.closeTo(E("650"), 2n);
      expect(sold).to.be.lessThan(await f.hook.maxConvert(f.p.poolId));

      // Quoted at the size sold, the floor is the amount itself.
      expect(await expectHeldTo(f, sold, out)).to.equal(true);
      expect(await expectHeldTo(f, sold, out + 1n)).to.equal(false);

      // Quoted at three times the size: a third of a wei over the price is a whole wei over the floor.
      expect(await expectHeldTo(f, sold * 3n, out * 3n)).to.equal(true);
      expect(await expectHeldTo(f, sold * 3n, out * 3n - 2n)).to.equal(true);
      expect(await expectHeldTo(f, sold * 3n, out * 3n + 1n)).to.equal(false);

      // Quoted at a seventh of the size, where the scaling multiplies.
      const seventh = sold / 7n;
      const atPrice = (out * seventh) / sold;
      expect(await expectHeldTo(f, seventh, atPrice)).to.equal(true);
      expect(await expectHeldTo(f, seventh, atPrice + 1n)).to.equal(false);

      // Sizes and prices around the real one, the same in every run.
      let held = 0;
      for (let i = 0; i < 24; i++) {
        const hash = BigInt(ethers.solidityPackedKeccak256(["string", "uint256"], ["floor", i]));
        const quotedTokens = (hash % (sold * 4n)) + 1n;
        // from 2% under the pool's price to 2% over it
        const price = 9800n + ((hash >> 128n) % 401n);
        const minEthOut = (out * quotedTokens * price) / (sold * BPS);
        if (await expectHeldTo(f, quotedTokens, minEthOut)) held++;
      }
      expect(held).to.be.within(6, 18);
    });

    it("rounds at 1 wei sizes: (1, 0) is no floor, and a floor of any size is never rounded away", async function () {
      const f = await loadFixture(waiting);
      const { sold } = f;
      expect(await expectHeldTo(f, 1n, 0n)).to.equal(true);
      expect(await expectHeldTo(f, sold, 0n)).to.equal(true);
      // 1 wei of ETH for 1 wei of token is a price no pool pays: the floor is the number of tokens sold.
      expect(floorFor(1n, 1n, sold)).to.equal(sold);
      expect(await expectHeldTo(f, 1n, 1n)).to.equal(false);
      // 1 wei of ETH for a size far beyond the sale still asks for 1 wei.
      expect(floorFor(10n ** 30n, 1n, sold)).to.equal(1n);
      expect(await expectHeldTo(f, 10n ** 30n, 1n)).to.equal(true);
      expect(await expectHeldTo(f, ethers.MaxUint256, 1n)).to.equal(true);
      expect(floorFor(ethers.MaxUint256, ethers.MaxUint256, sold)).to.equal(sold);
      expect(await expectHeldTo(f, ethers.MaxUint256, ethers.MaxUint256)).to.equal(false);
    });

    it("holds a conversion of 1 wei, and one that pays 1 wei, to the floor as well", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[325n];
      // Of 2 wei donated to the pool's liquidity the position collects 1; sold, it pays no ETH at all.
      await f.donor.connect(f.trader).donate(p.keyArr, 0, 2n);
      expect((await f.hook.collect.staticCall(p.poolId)).tokenFees).to.equal(1n);
      for (const quotedTokens of [1n, 10n ** 30n, ethers.MaxUint256]) {
        await expect(f.hook.convert.staticCall(p.poolId, quotedTokens, 1n, FAR))
          .to.be.revertedWithCustomError(f.hook, "TooLittleReceived")
          .withArgs(0n, 1n);
      }
      await expect(f.hook.connect(f.keeper).convert(p.poolId, 1, 0, FAR))
        .to.emit(f.hook, "Converted")
        .withArgs(p.poolId, f.keeper.address, 1n, 0n);
      expect(await f.hook.pendingTokens(p.poolId)).to.equal(0n);
      expect(await ethers.provider.getBalance(f.hook.target)).to.equal(0n);

      // 60,000 wei of tokens are worth a little over 1 wei of ETH at 50,000 tokens to the ETH.
      await time.increase(COOLDOWN);
      await f.donor.connect(f.trader).donate(p.keyArr, 0, 60_000n);
      const { tokensSold: sold, ethOut: out } = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
      expect(out).to.equal(1n);
      const tiny = { ...f, p, sold, out };
      expect(await expectHeldTo(tiny, sold, 1n)).to.equal(true);
      expect(await expectHeldTo(tiny, sold, 2n)).to.equal(false);
      // One and a half wei is a floor of 2, not of 1.
      expect(floorFor(sold * 2n, 3n, sold)).to.equal(2n);
      expect(await expectHeldTo(tiny, sold * 2n, 3n)).to.equal(false);
      expect(await expectHeldTo(tiny, sold * 2n, 2n)).to.equal(true);
    });

    it("fails closed on a zero size and on a floor too large to scale", async function () {
      const f = await loadFixture(waiting);
      const { p, sold, out } = f;
      const waitingBefore = await backlog(f, p);

      // Division by zero, whatever the floor.
      await expect(f.hook.convert(p.poolId, 0, 0, FAR)).to.be.revertedWithPanic(0x12);
      await expect(f.hook.convert(p.poolId, 0, 1, FAR)).to.be.revertedWithPanic(0x12);
      await expect(f.hook.convert(p.poolId, 0, ethers.MaxUint256, FAR)).to.be.revertedWithPanic(0x12);
      // minEthOut * tokensSold / quotedTokens does not fit 256 bits.
      await expect(f.hook.convert(p.poolId, 1, ethers.MaxUint256, FAR)).to.be.revertedWithPanic(0x11);
      await expect(f.hook.convert(p.poolId, 2, ethers.MaxUint256, FAR)).to.be.revertedWithPanic(0x11);
      await expect(f.hook.convert(p.poolId, sold - 1n, ethers.MaxUint256, FAR)).to.be.revertedWithPanic(0x11);
      // The largest floor that does fit is a floor like any other, and no pool pays it.
      await expect(f.hook.convert(p.poolId, sold, ethers.MaxUint256, FAR))
        .to.be.revertedWithCustomError(f.hook, "TooLittleReceived")
        .withArgs(out, ethers.MaxUint256);

      // Nothing moved and no window started: the same conversion, honestly quoted, goes through.
      expect(await f.hook.lastConvertAt(p.poolId)).to.equal(0n);
      expect(await f.hook.pendingTokens(p.poolId)).to.equal(0n);
      expect(await backlog(f, p)).to.equal(waitingBefore);
      await expect(f.hook.convert(p.poolId, sold, out, FAR))
        .to.emit(f.hook, "Converted")
        .withArgs(p.poolId, f.deployer.address, sold, out);
    });
  });

  // ------------------------------------------------------------------ the conversion's own fee

  describe("the pool fee a conversion pays", function () {
    it("comes back to the same position, all of it, at every tax", async function () {
      const f = await loadFixture(pools);
      for (const tax of TAXES) {
        const p = f.byTax[tax.total];
        await sell(f, p, E("30000"));
        await f.hook.collect(p.poolId);
        const pending = await f.hook.pendingTokens(p.poolId);
        expect(pending).to.be.closeTo((E("30000") * tax.total) / BPS, 2n);

        const reserveBefore = await tokenReserve(f, p);
        const heldBefore = await p.token.balanceOf(f.v4.poolManager.target);
        const quote = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
        expect(quote.tokensSold).to.equal(pending);
        const shares = split(p, quote.ethOut);
        await expect(f.hook.connect(f.keeper).convert(p.poolId, quote.tokensSold, quote.ethOut, FAR))
          .to.emit(f.hook, "FeeBooked")
          .withArgs(p.poolId, shares.platform, shares.marketing, shares.rewards);

        // The sale paid the pool's fee in tokens, like any sale, and the position has it to collect.
        const fee = (pending * tax.total) / BPS;
        const recycled = await f.hook.collect.staticCall(p.poolId);
        expect(recycled.tokenFees).to.be.closeTo(fee, 1n);
        expect(recycled.ethFees).to.equal(0n);
        // Every token sold is in the pool: the fee as fees, the rest as reserve. Nothing went elsewhere.
        expect((await p.token.balanceOf(f.v4.poolManager.target)) - heldBefore).to.equal(pending);
        expect((await tokenReserve(f, p)) - reserveBefore).to.be.closeTo(pending - fee, 2n);
        expect(await f.v4.poolManager.protocolFeesAccrued(p.token.target)).to.equal(0n);
        // The launch position is the pool's whole liquidity, so there is nobody to share the fee with.
        expect(await f.v4.stateView.getLiquidity(p.poolId)).to.equal(f.liquidity);
        expect(await f.v4.positionManager.getPositionLiquidity(p.tokenId)).to.equal(f.liquidity);

        // The next window sells exactly what came back.
        await time.increase(COOLDOWN);
        await expect(f.hook.convert(p.poolId, 1, 0, FAR))
          .to.emit(f.hook, "Converted")
          .withArgs(p.poolId, f.deployer.address, recycled.tokenFees, anyValue);
      }
    });

    it("converted to the end, a backlog leaks at most a wei per conversion", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[1000n]; // a tenth of every conversion comes back, the longest tail
      await sell(f, p, E("30000"));
      await f.hook.collect(p.poolId);
      const start = await f.hook.pendingTokens(p.poolId);
      expect(start).to.be.closeTo(E("3000"), 2n);
      const reserveBefore = await tokenReserve(f, p);
      const heldBefore = await p.token.balanceOf(f.v4.poolManager.target);

      let conversions = 0;
      let sold = 0n;
      for (;;) {
        const waiting = await backlog(f, p);
        if (waiting === 0n) break;
        await expect(f.hook.convert(p.poolId, 1, 0, FAR))
          .to.emit(f.hook, "Converted")
          .withArgs(p.poolId, f.deployer.address, waiting, anyValue);
        sold += waiting;
        conversions++;
        await time.increase(COOLDOWN);
      }
      await expect(f.hook.convert(p.poolId, 1, 0, FAR)).to.be.revertedWithCustomError(f.hook, "NothingToConvert");

      // 3,000 tokens, then a tenth of that, and so on down to a wei: 3,333.33 in all, in 22 sales.
      expect(conversions).to.equal(22);
      expect(sold).to.be.closeTo((start * 10n) / 9n, BigInt(conversions));
      // The hook holds no token, and the pool holds every one it sold net of what came back.
      expect(await p.token.balanceOf(f.hook.target)).to.equal(0n);
      expect((await p.token.balanceOf(f.v4.poolManager.target)) - heldBefore).to.equal(start);
      expect((await tokenReserve(f, p)) - reserveBefore).to.be.closeTo(start, 2n * BigInt(conversions));
    });
  });

  // ------------------------------------------------------------------ the split

  describe("the split", function () {
    /** Amounts that look random and are the same in every run: a hash cut to sizes from wei to ETH. */
    function amountFor(i) {
      const hash = BigInt(ethers.solidityPackedKeccak256(["string", "uint256"], ["split", i]));
      return (hash % 10n ** BigInt(1 + (i % 19))) + 2n;
    }

    it("books every amount in the ratio of the rates, with at most 2 wei of dust, all to the platform", async function () {
      const f = await loadFixture(pools);
      const expected = { platform: 0n };
      const dustSeen = new Set();
      let bookings = 0;

      for (const total of [25n, 100n, 325n, 1000n]) {
        const p = f.byTax[total];
        expected[total] = { marketing: 0n, rewards: 0n };
        const edges = [2n, 3n, 4n, total - 1n, total, total + 1n, 2n * total + 1n, BPS, E("1") + 1n];
        const amounts = edges.concat(Array.from({ length: 38 }, (_, i) => amountFor(i + Number(total))));

        for (const amount of amounts) {
          // A donation to the pool's liquidity is fees to its only position: ETH of a chosen size.
          await f.donor.connect(f.trader).donate(p.keyArr, amount, 0, { value: amount });
          const { ethFees } = await f.hook.collect.staticCall(p.poolId);
          expect(amount - ethFees).to.be.within(0n, 1n);

          const shares = split(p, ethFees);
          await expect(f.hook.connect(f.keeper).collect(p.poolId))
            .to.emit(f.hook, "FeeBooked")
            .withArgs(p.poolId, shares.platform, shares.marketing, shares.rewards);

          // Both shares round down, so the platform is over its exact 25 / total by 0, 1 or 2 wei.
          const dust = shares.platform - (ethFees * PLATFORM_BPS) / total;
          expect(dust).to.be.within(0n, 2n);
          if (p.rewards === 0n) expect(dust).to.be.within(0n, 1n);
          if (p.marketing === 0n) expect(shares.platform).to.equal(ethFees);
          dustSeen.add(dust);

          expected[total].marketing += shares.marketing;
          expected[total].rewards += shares.rewards;
          expected.platform += shares.platform;
          bookings++;
        }
        expect(await f.hook.pendingMarketing(p.poolId)).to.equal(expected[total].marketing);
        expect(await f.hook.pendingRewards(p.poolId)).to.equal(expected[total].rewards);
      }

      expect(bookings).to.equal(188);
      expect([...dustSeen].sort()).to.deep.equal([0n, 1n, 2n]);
      // No wei is unaccounted: the ledgers add up to the hook's balance.
      expect(await f.hook.pendingPlatform()).to.equal(expected.platform);
      const ledgers = [25n, 100n, 325n, 1000n].reduce(
        (sum, total) => sum + expected[total].marketing + expected[total].rewards,
        expected.platform
      );
      expect(await ethers.provider.getBalance(f.hook.target)).to.equal(ledgers);
    });

    it("books 1 wei to the platform and the proceeds of a conversion like any other amount", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[325n];
      await f.donor.connect(f.trader).donate(p.keyArr, 2n, 0, { value: 2n });
      await expect(f.hook.collect(p.poolId)).to.emit(f.hook, "FeeBooked").withArgs(p.poolId, 1n, 0n, 0n);

      await sell(f, p, E("12345.678901234567890123"));
      const quote = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
      const shares = split(p, quote.ethOut);
      expect(shares.marketing).to.equal((quote.ethOut * 200n) / 325n);
      expect(shares.rewards).to.equal((quote.ethOut * 100n) / 325n);
      await expect(f.hook.convert(p.poolId, 1, 0, FAR))
        .to.emit(f.hook, "FeeBooked")
        .withArgs(p.poolId, shares.platform, shares.marketing, shares.rewards);
      expect(await f.hook.pendingMarketing(p.poolId)).to.equal(shares.marketing);
      expect(await f.hook.pendingRewards(p.poolId)).to.equal(shares.rewards);
      expect(await f.hook.pendingPlatform()).to.equal(shares.platform + 1n);
    });
  });

  // ------------------------------------------------------------------ Uniswap's protocol fee

  describe("with Uniswap's protocol fee switched on", function () {
    const LP_FEE = 32_500n;
    const PROTOCOL_FEE = 1_000n; // 0.1% in each direction, the most the PoolManager accepts
    // v4 core ProtocolFeeLibrary.calculateSwapFee: the protocol fee first, the pool's fee on the rest
    const SWAP_FEE = PROTOCOL_FEE + LP_FEE - (PROTOCOL_FEE * LP_FEE) / PIPS;
    const POSITION_FEE = SWAP_FEE - PROTOCOL_FEE;

    it("the trader pays slightly more, the position earns slightly less, and the split holds", async function () {
      const f = await loadFixture(pools);
      const p = f.byTax[325n];
      const { poolManager, stateView, swapper } = f.v4;
      expect(SWAP_FEE).to.equal(33_468n);
      expect(POSITION_FEE).to.equal(32_468n);

      const spend = E("1");
      const sale = E("20000");
      const trade = async () => {
        const tokensOut = await swapper.connect(f.trader).swapExactIn.staticCall(p.keyArr, true, spend, 0, f.trader.address, {
          value: spend,
        });
        await buy(f, p, spend);
        await sell(f, p, sale);
        return { tokensOut, ...(await f.hook.collect.staticCall(p.poolId)).toObject() };
      };

      const snapshot = await takeSnapshot();
      const plain = await trade();
      expect(plain.ethFees).to.be.closeTo((spend * LP_FEE) / PIPS, 2n);
      expect(plain.tokenFees).to.be.closeTo((sale * LP_FEE) / PIPS, 2n);
      await snapshot.restore();

      // The PoolManager's owner names a controller and the controller sets a pool's protocol fee.
      expect(await poolManager.owner()).to.equal(f.deployer.address);
      await poolManager.setProtocolFeeController(f.deployer.address);
      await poolManager.setProtocolFee(p.keyArr, PROTOCOL_FEE | (PROTOCOL_FEE << 12n));
      await expect(poolManager.setProtocolFee(p.keyArr, PROTOCOL_FEE + 1n))
        .to.be.revertedWithCustomError(poolManager, "ProtocolFeeTooLarge")
        .withArgs(PROTOCOL_FEE + 1n);
      const slot0 = await stateView.getSlot0(p.poolId);
      expect(slot0.protocolFee).to.equal(PROTOCOL_FEE | (PROTOCOL_FEE << 12n));
      expect(slot0.lpFee).to.equal(LP_FEE);
      // The cap of a conversion is a share of the reserve and knows nothing of this fee.
      expect(await f.hook.maxConvert(p.poolId)).to.equal(((await tokenReserve(f, p)) * p.capBps) / BPS);

      const taxed = await trade();
      const protocolEth = await poolManager.protocolFeesAccrued(ethers.ZeroAddress);
      const protocolTokens = await poolManager.protocolFeesAccrued(p.token.target);

      // 3.3468% instead of 3.25% leaves the trader: 0.1% of it to Uniswap, 3.2468% to the position.
      expect(protocolEth).to.equal((spend * PROTOCOL_FEE) / PIPS);
      expect(protocolTokens).to.equal((sale * PROTOCOL_FEE) / PIPS);
      expect(taxed.ethFees).to.be.closeTo((spend * POSITION_FEE) / PIPS, 2n);
      expect(taxed.tokenFees).to.be.closeTo((sale * POSITION_FEE) / PIPS, 2n);
      expect(taxed.ethFees + protocolEth).to.be.closeTo((spend * SWAP_FEE) / PIPS, 2n);
      expect(taxed.ethFees).to.be.lessThan(plain.ethFees);
      expect(taxed.tokenFees).to.be.lessThan(plain.tokenFees);
      expect(taxed.tokensOut).to.be.lessThan(plain.tokensOut);

      // What the position did earn is split in the same ratio as ever.
      const shares = split(p, taxed.ethFees);
      expect(shares.marketing).to.equal((taxed.ethFees * 200n) / 325n);
      expect(shares.rewards).to.equal((taxed.ethFees * 100n) / 325n);
      await expect(f.hook.collect(p.poolId))
        .to.emit(f.hook, "FeeBooked")
        .withArgs(p.poolId, shares.platform, shares.marketing, shares.rewards);

      // A conversion is a trade too: Uniswap's 0.1% of what it sells is the one part that does not
      // come back to the position.
      const pending = await f.hook.pendingTokens(p.poolId);
      expect(pending).to.equal(taxed.tokenFees);
      const quote = await f.hook.convert.staticCall(p.poolId, 1, 0, FAR);
      const proceeds = split(p, quote.ethOut);
      await expect(f.hook.convert(p.poolId, quote.tokensSold, quote.ethOut, FAR))
        .to.emit(f.hook, "FeeBooked")
        .withArgs(p.poolId, proceeds.platform, proceeds.marketing, proceeds.rewards);
      expect(quote.tokensSold).to.equal(pending);
      const leaked = (await poolManager.protocolFeesAccrued(p.token.target)) - protocolTokens;
      expect(leaked).to.equal((pending * PROTOCOL_FEE) / PIPS);
      const recycled = await f.hook.collect.staticCall(p.poolId);
      expect(recycled.tokenFees).to.be.closeTo((pending * POSITION_FEE) / PIPS, 2n);
      expect(recycled.tokenFees + leaked).to.be.closeTo((pending * SWAP_FEE) / PIPS, 2n);

      // The ledgers still add up to the hook's balance.
      const ledgers =
        (await f.hook.pendingMarketing(p.poolId)) + (await f.hook.pendingRewards(p.poolId)) + (await f.hook.pendingPlatform());
      expect(ledgers).to.equal(taxed.ethFees + quote.ethOut);
      expect(await ethers.provider.getBalance(f.hook.target)).to.equal(ledgers);
    });
  });
});
