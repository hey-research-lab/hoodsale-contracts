const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4Fee, feeTaxConfig, keyArray } = require("../v4/helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
// LiquidityAction enum
const Lock = 0, Burn = 1;
// TokenFactory.TokenType
const Standard = 0, Tax = 1, Rewards = 2;

// What each call cost when this suite was written, by kind of token. A Rewards token keeps a
// share ledger, so everything that moves it costs more.
//   finalize       the sale's finalize: register, open the pool, mint the position to the hook
//   collectFirst   the first collection of a pool, fees on both sides, every ledger still empty
//   collect        a later collection, fees on both sides
//   convertFirst   the first conversion of a pool that was never collected: what the keeper sends
//   convert        a later conversion, collecting on its way
//   flush          the first payout of a pool's shares
const BASELINE = {
  standard: { finalize: 1_052_600n, collectFirst: 235_300n, collect: 149_800n, convertFirst: 253_900n, convert: 202_500n, flush: 31_200n },
  tax: { finalize: 1_052_400n, collectFirst: 257_500n, collect: 154_900n, convertFirst: 276_600n, convert: 208_100n, flush: 40_900n },
  rewards: { finalize: 1_080_100n, collectFirst: 285_200n, collect: 165_500n, convertFirst: 305_900n, convert: 220_300n, flush: 76_100n },
};
const FLUSH_PLATFORM_BASELINE = 43_800n;
// How far over its baseline a call may go before the suite fails. The reservation below is the
// hard limit for finalize; this one is there so a regression is seen long before it gets close.
const HEADROOM_PERCENT = 10n;
// HoodSaleV4FeeHook.PUSH_GAS, which is private: the gas a flush gives the wallet or contract it pays
const PUSH_GAS = 100_000n;

// A quick launch finalizes itself inside someone's buy, so the gas a listing needs has to be known
// in advance: Presale.LAUNCH_BASE_GAS_V4 is what autoLaunchGas() reserves for a v4 one, whichever
// launcher the sale uses. Fee mode does more in that call than hook mode, it registers the
// position with the hook as well, and the reservation is older than fee mode: the sale's code is
// not deployed again for it. launch.test.js checks two cases against it; this suite measures
// every kind of token with both liquidity choices, and the calls the keeper pays for afterwards.
describe("V4 fee mode gas", function () {
  const KINDS = [
    ["standard", Standard, {}],
    ["tax", Tax, { marketingBps: 300 }],
    ["rewards", Rewards, { marketingBps: 100, rewardsBps: 200 }],
  ];

  async function platform() {
    return deployPlatformV4Fee();
  }

  /** A fee mode token of alice's and its sale, filled to the hard cap: ready to finalize. */
  async function readySale(ctx, tokenType, rates, liquidityAction) {
    const { feeLauncher, presaleFactory, weth, alice, bob, carol, marketing } = ctx;
    await feeLauncher.connect(alice).createToken(
      tokenType,
      {
        name: "Gas",
        symbol: "GAS",
        totalSupply: E("1000000"),
        rewardToken: tokenType === Rewards ? weth.target : ethers.ZeroAddress,
      },
      feeTaxConfig(marketing.address, rates),
      alice.address
    );
    const created = await feeLauncher.tokensOfCreator(alice.address);
    const tokenAddr = created[created.length - 1];
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);

    const start = BigInt(await time.latest()) + 1000n;
    const params = {
      token: tokenAddr,
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: E("5"),
      hardCap: E("10"),
      minContribution: E("0.1"),
      maxContribution: E("5"),
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    return { token, tokenAddr, presale };
  }

  const gasOf = async (tx) => (await (await tx).wait()).gasUsed;

  function expectWithin(measured, baseline, what) {
    expect(measured, `${what}: ${measured} gas against a baseline of ${baseline}`).to.be.lessThan(
      (baseline * (100n + HEADROOM_PERCENT)) / 100n
    );
  }

  // ------------------------------------------------------------------ finalize

  describe("finalize, against what a sale reserves for a v4 listing", function () {
    for (const [label, tokenType, rates] of KINDS) {
      for (const [actionLabel, liquidityAction] of [["burn", Burn], ["lock", Lock]]) {
        it(`${label}, ${actionLabel}`, async function () {
          const ctx = await loadFixture(platform);
          const { feeLauncher, feeHook, positionManager, alice } = ctx;
          const { tokenAddr, presale } = await readySale(ctx, tokenType, rates, liquidityAction);
          const reserved = await presale.LAUNCH_BASE_GAS_V4();
          expect(await presale.isV4Launch()).to.equal(true);
          expect(await presale.autoLaunchGas()).to.be.greaterThanOrEqual(reserved);

          // What counts is the smallest gas limit the call goes through on, which is more than
          // it ends up using: every nested call keeps 1/64 of the gas back. The estimate is that
          // limit. The call is then sent with exactly the reserved gas, intrinsic cost and all.
          const needed = await presale.connect(alice).finalize.estimateGas(0, 0);
          const used = await gasOf(presale.connect(alice).finalize(0, 0, { gasLimit: reserved }));
          const launch = await feeLauncher.launchOf(tokenAddr);
          expect(launch.done).to.equal(true);
          expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);

          const spare = ((reserved - needed) * 100n) / reserved;
          console.log(
            `      ${label}, ${actionLabel}: ${used} gas used, ${needed} needed, ${reserved} reserved, ${spare}% to spare`
          );
          expect(used).to.be.lessThanOrEqual(needed);
          expect(needed).to.be.lessThan(reserved);
          expectWithin(used, BASELINE[label].finalize, "finalize");
        });
      }
    }

    it("costs no more for a later launch than for the platform's first", async function () {
      const ctx = await loadFixture(platform);
      const first = await readySale(ctx, Rewards, KINDS[2][2], Lock);
      const firstGas = await gasOf(first.presale.connect(ctx.alice).finalize(0, 0));
      const second = await readySale(ctx, Rewards, KINDS[2][2], Lock);
      const secondGas = await gasOf(second.presale.connect(ctx.alice).finalize(0, 0));
      console.log(`      rewards, lock: ${firstGas} first, ${secondGas} second`);
      expect(secondGas).to.be.lessThanOrEqual(firstGas);
    });
  });

  // ------------------------------------------------------------------ the keeper's calls

  /** A launch of one kind that has traded both ways and was never collected. */
  async function launchedKind([, tokenType, rates]) {
    const ctx = await deployPlatformV4Fee();
    const { feeLauncher, swapper, dave } = ctx;
    const { token, tokenAddr, presale } = await readySale(ctx, tokenType, rates, Burn);
    await presale.connect(ctx.alice).finalize(0, 0);
    const key = keyArray(await feeLauncher.poolKeyOf(tokenAddr));
    const poolId = (await feeLauncher.launchOf(tokenAddr)).poolId;
    await token.connect(dave).approve(swapper.target, ethers.MaxUint256);
    const trade = async () => {
      await swapper.connect(dave).swapExactIn(key, true, E("1"), 0, dave.address, { value: E("1") });
      await swapper.connect(dave).swapExactIn(key, false, E("300"), 0, dave.address);
    };
    await trade();
    return { ...ctx, token, tokenAddr, poolId, trade };
  }
  // loadFixture tells fixtures apart by function, so each kind has one of its own.
  const launched = {
    standard: async function launchedStandard() {
      return launchedKind(KINDS[0]);
    },
    tax: async function launchedTax() {
      return launchedKind(KINDS[1]);
    },
    rewards: async function launchedRewards() {
      return launchedKind(KINDS[2]);
    },
  };

  describe("collect, convert and flush", function () {
    for (const [label] of KINDS) {
      it(`${label}: collecting and paying out`, async function () {
        const ctx = await loadFixture(launched[label]);
        const { feeHook, poolId, trade, dave } = ctx;

        const collectFirst = await gasOf(feeHook.connect(dave).collect(poolId));
        await trade();
        const collect = await gasOf(feeHook.connect(dave).collect(poolId));
        // Every share is paid on the first flush: a wallet that takes ETH, and for a Rewards
        // token the token itself.
        const flushTx = feeHook.connect(dave).flush(poolId);
        const paid = (await (await flushTx).wait()).logs.map((log) => feeHook.interface.parseLog(log)).filter(Boolean);
        expect(paid.length).to.equal({ standard: 0, tax: 1, rewards: 2 }[label]);
        for (const event of paid) expect(event.args.ok).to.equal(true);
        const flush = await gasOf(flushTx);

        console.log(`      ${label}: collect ${collectFirst} the first time, ${collect} after; flush ${flush}`);
        expectWithin(collectFirst, BASELINE[label].collectFirst, "first collect");
        expectWithin(collect, BASELINE[label].collect, "collect");
        expectWithin(flush, BASELINE[label].flush, "flush");
        expect(collect).to.be.lessThan(collectFirst);
      });

      it(`${label}: converting`, async function () {
        const ctx = await loadFixture(launched[label]);
        const { feeHook, poolId, trade, dave } = ctx;
        const far = (await time.latest()) + 100 * Number(DAY);

        // The keeper does not collect first: its conversion is the pool's first collection too.
        const convertFirst = await gasOf(feeHook.connect(dave).convert(poolId, 1, 0, far));
        await trade();
        await time.increase(301);
        const convert = await gasOf(feeHook.connect(dave).convert(poolId, 1, 0, far));

        console.log(`      ${label}: convert ${convertFirst} the first time, ${convert} after`);
        expectWithin(convertFirst, BASELINE[label].convertFirst, "first convert");
        expectWithin(convert, BASELINE[label].convert, "convert");
        expect(convert).to.be.lessThan(convertFirst);
      });
    }

    it("flushPlatform", async function () {
      const ctx = await loadFixture(launched.tax);
      const { feeHook, treasury, poolId, dave } = ctx;
      await feeHook.collect(poolId);
      const owed = await feeHook.pendingPlatform();
      const tx = feeHook.connect(dave).flushPlatform();
      await expect(tx).to.emit(feeHook, "PlatformFlushed").withArgs(owed, true);
      await expect(tx).to.changeEtherBalance(treasury, owed);
      const used = await gasOf(tx);
      console.log(`      flushPlatform: ${used}`);
      expectWithin(used, FLUSH_PLATFORM_BASELINE, "flushPlatform");
    });

    // A flush hands its recipient a fixed amount of gas and books the share again when that is
    // not enough. The two recipients the platform itself provides must never need more, or
    // their share would stay in the hook for good.
    it("the Treasury and a Rewards token take their share well inside a flush's gas", async function () {
      const ctx = await loadFixture(launched.rewards);
      const { feeHook, tokenAddr, deployer, dave } = ctx;
      const token = await ethers.getContractAt("RewardsTokenV4", tokenAddr);

      // The dearest case of each: the first ETH it ever receives.
      const treasury = await ethers.deployContract("Treasury", [deployer.address]);
      const treasuryGas = (await gasOf(dave.sendTransaction({ to: treasury.target, value: E("0.01") }))) - 21_000n;
      expect(await treasury.buybackReserve()).to.be.greaterThan(0);

      expect(await token.pendingRewardEth()).to.equal(0);
      await setBalance(feeHook.target, E("1"));
      const asHook = await ethers.getImpersonatedSigner(feeHook.target);
      const tokenGas = (await gasOf(asHook.sendTransaction({ to: token.target, value: E("0.01") }))) - 21_000n;
      expect(await token.pendingRewardEth()).to.equal(E("0.01"));

      console.log(`      receiving a share: Treasury ${treasuryGas}, Rewards token ${tokenGas}, of ${PUSH_GAS} given`);
      expect(treasuryGas).to.be.lessThan(PUSH_GAS / 2n);
      expect(tokenGas).to.be.lessThan(PUSH_GAS / 2n);
    });
  });
});
