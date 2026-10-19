const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4, taxConfig, keyArray, DEAD } = require("./helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
// LiquidityAction enum
const Lock = 0, Burn = 1;
// TokenFactory.TokenType
const Standard = 0, Tax = 1, Rewards = 2;

describe("V4 launch", function () {
  async function platform() {
    const ctx = await deployPlatformV4();
    const now = BigInt(await time.latest());
    const start = now + 1000n;
    ctx.baseParams = {
      presaleRate: E("1000"),
      listingRate: E("800"),
      softCap: E("5"),
      hardCap: E("10"),
      minContribution: E("0.1"),
      maxContribution: E("5"),
      startTime: start,
      endTime: start + DAY,
      liquidityBps: 6000,
      liquidityAction: Lock,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    return ctx;
  }

  /**
   * Creates a v4 token owned by alice. A Standard token is locked tax-free, as the site creates it;
   * a sale refuses to launch one that is not.
   */
  async function createToken(ctx, tokenType = Standard, cfgOverrides = {}, spec = {}) {
    const { launcher, alice, marketing } = ctx;
    const tokenSpec = {
      name: "Pump",
      symbol: "PUMP",
      totalSupply: E("1000000"),
      rewardToken: ethers.ZeroAddress,
      ...spec,
    };
    await launcher
      .connect(alice)
      .createToken(
        tokenType,
        tokenSpec,
        taxConfig(marketing.address, {
          ...(tokenType === Standard ? { taxLocked: true, walletLocked: true } : {}),
          ...cfgOverrides,
        }),
        alice.address
      );
    const created = await launcher.tokensOfCreator(alice.address);
    return created[created.length - 1];
  }

  /** Runs a full sale on a v4 token up to the point where it can be finalized. */
  async function fillSale(ctx, tokenAddr, overrides = {}) {
    const { presaleFactory, alice, bob, carol } = ctx;
    const params = { ...ctx.baseParams, token: tokenAddr, ...overrides };
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
    const required = await presaleFactory.requiredTokensFor(params);
    await token.connect(alice).approve(presaleFactory.target, required);
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const n = await presaleFactory.allPresalesLength();
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(n - 1n));

    await time.increaseTo(params.startTime);
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    return { presale, params };
  }

  /** Runs a full sale on a v4 token and finalizes it. */
  async function launchThrough(ctx, tokenAddr, overrides = {}) {
    const { presale, params } = await fillSale(ctx, tokenAddr, overrides);
    await presale.connect(ctx.alice).finalize(0, 0);
    return { presale, params };
  }

  describe("creating the token", function () {
    it("registers a plain, tax-free token in the platform's own factory", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, launcher, alice } = ctx;
      const tokenAddr = await createToken(ctx);
      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);

      // The registry the site reads is the same one, so a v4 launch shows up like any other.
      expect(await tokenFactory.isPlatformToken(tokenAddr)).to.equal(true);
      const info = await tokenFactory.infoOf(tokenAddr);
      expect(info.creator).to.equal(launcher.target);
      expect(info.name).to.equal("Pump");

      // The creator ends up with the supply and the ownership.
      expect(await token.owner()).to.equal(alice.address);
      expect(await token.balanceOf(alice.address)).to.equal(E("1000000"));
      expect(await token.poolVersion()).to.equal(4);
      expect(await launcher.creatorOf(tokenAddr)).to.equal(alice.address);
    });

    it("still deploys the V2 token when the creator is not the launcher", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, alice } = ctx;
      await tokenFactory.connect(alice).createStandardToken("Old", "OLD", E("1000"));
      const addr = await tokenFactory.allTokens(0);
      const token = await ethers.getContractAt("StandardToken", addr);
      // A V2 token taxes transfers and opens its own pair, and answers no poolVersion call.
      expect(await token.mainPair()).to.not.equal(ethers.ZeroAddress);
      expect(await token.platformTaxBps()).to.equal(25);
      await expect(
        (await ethers.getContractAt("HoodSaleTokenV4", addr)).poolVersion()
      ).to.be.reverted;
    });

    it("refuses a tax over the cap", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, alice, marketing } = ctx;
      const spec = { name: "X", symbol: "X", totalSupply: E("1000"), rewardToken: ethers.ZeroAddress };
      await expect(
        launcher.connect(alice).createToken(Tax, spec, taxConfig(marketing.address, { marketingBuyBps: 1000 }), alice.address)
      ).to.be.revertedWithCustomError(launcher, "TaxTooHigh");
    });
  });

  describe("finalizing into a v4 pool", function () {
    it("opens the pool at the listing price with the whole launch liquidity", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, stateView, swapper, hook } = ctx;
      const tokenAddr = await createToken(ctx);
      const { presale } = await launchThrough(ctx, tokenAddr);

      const launch = await launcher.launchOf(tokenAddr);
      expect(launch.done).to.equal(true);
      expect(await presale.v4PoolId()).to.equal(launch.poolId);
      expect(await presale.isV4Launch()).to.equal(true);

      // 10 ETH raised, 10% platform fee, 60% of the rest to liquidity: 5.4 ETH at 800 tokens/ETH.
      const key = keyArray(await launcher.poolKeyOf(tokenAddr));
      const poolId = await swapper.poolId(key);
      expect(poolId).to.equal(launch.poolId);
      const slot0 = await stateView.getSlot0(poolId);
      // The pool price is tokens per ETH; at the listing rate that is 800.
      const price = (slot0[0] * slot0[0] * 10n ** 18n) >> 192n;
      expect(price).to.be.closeTo(E("800"), E("0.01"));
      expect(await stateView.getLiquidity(poolId)).to.be.greaterThan(0);
      expect((await hook.configOf(poolId)).token).to.equal(tokenAddr);
    });

    it("locks the position for the sale owner when the sale locks liquidity", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, positionLocker, positionManager, alice } = ctx;
      const tokenAddr = await createToken(ctx);
      const { presale } = await launchThrough(ctx, tokenAddr, { liquidityAction: Lock });

      const launch = await launcher.launchOf(tokenAddr);
      expect(launch.burned).to.equal(false);
      // The lock is provable from outside: the locker owns the position.
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(positionLocker.target);
      const info = await positionLocker.locks(launch.lockId);
      expect(info.owner).to.equal(alice.address);
      expect(info.tokenId).to.equal(launch.tokenId);
      expect(await presale.lpLockId()).to.equal(launch.lockId);
      expect(await presale.v4PositionId()).to.equal(launch.tokenId);
    });

    it("burns the position when the sale burns liquidity", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, positionManager } = ctx;
      const tokenAddr = await createToken(ctx);
      await launchThrough(ctx, tokenAddr, { liquidityAction: Burn });

      const launch = await launcher.launchOf(tokenAddr);
      expect(launch.burned).to.equal(true);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(DEAD);
    });

    it("leaves nothing behind in the launcher", async function () {
      const ctx = await loadFixture(platform);
      const { launcher } = ctx;
      const tokenAddr = await createToken(ctx);
      await launchThrough(ctx, tokenAddr);
      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
      expect(await ethers.provider.getBalance(launcher.target)).to.equal(0);
      expect(await token.balanceOf(launcher.target)).to.equal(0);
    });

    it("pays out and lets participants claim exactly as a V2 sale does", async function () {
      const ctx = await loadFixture(platform);
      const { bob } = ctx;
      const tokenAddr = await createToken(ctx);
      const { presale } = await launchThrough(ctx, tokenAddr);
      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);

      await presale.connect(bob).claim();
      // 5 ETH at 1000 tokens per ETH, and no transfer tax takes a bite out of it.
      expect(await token.balanceOf(bob.address)).to.equal(E("5000"));
    });

    it("charges the pool's tax once the launch is trading", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, hook, swapper, treasury, alice, marketing } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBuyBps: 300, marketingSellBps: 500 });
      await launchThrough(ctx, tokenAddr);

      const key = keyArray(await launcher.poolKeyOf(tokenAddr));
      const poolId = (await launcher.launchOf(tokenAddr)).poolId;
      const spend = E("0.5");
      await swapper.connect(alice).swapExactIn(key, true, spend, 0, alice.address, { value: spend });

      // 0.25% platform plus 3% marketing on a buy.
      const fee = (spend * 325n) / 10_000n;
      expect(await ethers.provider.getBalance(hook.target)).to.equal(fee);
      const marketingBefore = await ethers.provider.getBalance(marketing.address);
      await hook.flush(poolId);
      await hook.flushPlatform();
      expect((await ethers.provider.getBalance(marketing.address)) - marketingBefore).to.equal((fee * 300n) / 325n);
      expect(await treasury.buybackReserve()).to.be.greaterThan(0);
    });

    it("cannot be launched twice, or by a sale for another token", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, alice } = ctx;
      const tokenAddr = await createToken(ctx);
      await launchThrough(ctx, tokenAddr);
      // The sale contract is finalized, so a second launch has to come from somewhere else; a
      // wallet cannot call the launcher at all.
      await expect(
        launcher.connect(alice).launch(tokenAddr, E("1"), Lock, 0, alice.address, { value: E("1") })
      ).to.be.revertedWithCustomError(launcher, "NotPresale");
    });
  });

  // Until the pool opens, the tax lives on the launcher and the token's owner can still change it
  // there. The review found an owner could advertise a locked tax during the sale, then unlock it
  // or move the wallet just before finalizing. The sale now keeps a hash of the tax it was created
  // with and opens the pool only with that same tax.
  describe("holding the owner to the sale's tax", function () {
    const LOCKED_TAX = { marketingBuyBps: 300, marketingSellBps: 500, taxLocked: true, walletLocked: true };

    it("refuses to launch once the owner has changed the tax, and launches when it is put back", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, alice, marketing, dave } = ctx;
      const tokenAddr = await createToken(ctx, Tax, LOCKED_TAX);
      const { presale } = await fillSale(ctx, tokenAddr);
      expect(await presale.v4TermsHold()).to.equal(true);

      await launcher.connect(alice).setTaxConfig(tokenAddr, taxConfig(marketing.address, { marketingBuyBps: 900, marketingSellBps: 900 }));
      expect(await presale.v4TermsHold()).to.equal(false);
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");

      // Moving the wallet alone is refused as well.
      await launcher.connect(alice).setTaxConfig(tokenAddr, taxConfig(dave.address, LOCKED_TAX));
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");

      await launcher.connect(alice).setTaxConfig(tokenAddr, taxConfig(marketing.address, LOCKED_TAX));
      await presale.connect(alice).finalize(0, 0);
      const cfg = await ctx.hook.configOfToken(tokenAddr);
      expect(cfg.taxLocked).to.equal(true);
      expect(cfg.marketingWallet).to.equal(marketing.address);
      expect(cfg.marketingBuyBps).to.equal(300);
    });

    it("never launches a Standard token that could start charging a tax", async function () {
      const ctx = await loadFixture(platform);
      const { bob } = ctx;
      // Tax-free but left unlocked: the owner could add a tax once the pool is open.
      const tokenAddr = await createToken(ctx, Standard, { taxLocked: false });
      const { presale, params } = await fillSale(ctx, tokenAddr);
      expect(await presale.v4TermsHold()).to.equal(false);
      await expect(presale.connect(ctx.alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");

      // Nobody can launch it, so the buyers get their ETH back when the finalize window closes.
      await time.increaseTo(params.endTime + 14n * DAY + 1n);
      const before = await ethers.provider.getBalance(bob.address);
      await presale.connect(bob).claimRefund();
      expect(await ethers.provider.getBalance(bob.address)).to.be.greaterThan(before + E("4.99"));
    });

    it("never launches a Standard token with a tax, even a locked one", async function () {
      const ctx = await loadFixture(platform);
      const tokenAddr = await createToken(ctx, Standard, { marketingSellBps: 200 });
      const { presale } = await fillSale(ctx, tokenAddr);
      await expect(presale.connect(ctx.alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");
    });

    it("gives a rewards share only to a Rewards token, which has holders to pay", async function () {
      const ctx = await loadFixture(platform);
      const tokenAddr = await createToken(ctx, Tax, { rewardsBuyBps: 100, taxLocked: true });
      const { presale } = await fillSale(ctx, tokenAddr);
      await expect(presale.connect(ctx.alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");
    });

    it("records the tax on a v4 sale and nothing on a V2 sale", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, alice } = ctx;
      const { presale: v4Sale } = await fillSale(ctx, await createToken(ctx));
      expect(await v4Sale.v4TermsHash()).to.not.equal(ethers.ZeroHash);

      const v2Token = await tokenFactory.connect(alice).createStandardToken.staticCall("Old", "OLD", E("1000000"));
      await tokenFactory.connect(alice).createStandardToken("Old", "OLD", E("1000000"));
      const { presale: v2Sale } = await fillSale(ctx, v2Token, { startTime: ctx.baseParams.startTime + DAY, endTime: ctx.baseParams.endTime + DAY });
      expect(await v2Sale.isV4Launch()).to.equal(false);
      expect(await v2Sale.v4TermsHash()).to.equal(ethers.ZeroHash);
    });
  });

  describe("the locked position", function () {
    it("can be unlocked by its owner once the time is up, and not before", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, positionLocker, positionManager, alice, bob } = ctx;
      const tokenAddr = await createToken(ctx);
      await launchThrough(ctx, tokenAddr, { liquidityAction: Lock });
      const launch = await launcher.launchOf(tokenAddr);

      await expect(positionLocker.connect(alice).unlock(launch.lockId)).to.be.revertedWithCustomError(
        positionLocker,
        "StillLocked"
      );
      await time.increase(31n * DAY);
      await expect(positionLocker.connect(bob).unlock(launch.lockId)).to.be.revertedWithCustomError(
        positionLocker,
        "NotLockOwner"
      );
      await positionLocker.connect(alice).unlock(launch.lockId);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(alice.address);
    });

    it("is listed once for its owner after it is handed back", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, positionLocker, alice, bob } = ctx;
      const tokenAddr = await createToken(ctx);
      await launchThrough(ctx, tokenAddr, { liquidityAction: Lock });
      const { lockId } = await launcher.launchOf(tokenAddr);

      await positionLocker.connect(alice).transferLockOwnership(lockId, bob.address);
      await positionLocker.connect(bob).transferLockOwnership(lockId, alice.address);
      await positionLocker.connect(alice).transferLockOwnership(lockId, alice.address);
      expect(await positionLocker.locksOfOwner(alice.address)).to.deep.equal([lockId]);
      expect(await positionLocker.locksOfOwner(bob.address)).to.deep.equal([]);
    });

    it("pays its LP fees to the lock owner without touching the principal", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, positionLocker, positionManager, swapper, alice, bob } = ctx;
      const tokenAddr = await createToken(ctx);
      await launchThrough(ctx, tokenAddr, { liquidityAction: Lock });
      const launch = await launcher.launchOf(tokenAddr);
      const key = keyArray(await launcher.poolKeyOf(tokenAddr));

      const liquidityBefore = await positionManager.getPositionLiquidity(launch.tokenId);
      const spend = E("1");
      await swapper.connect(bob).swapExactIn(key, true, spend, 0, bob.address, { value: spend });

      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
      const tokensBefore = await token.balanceOf(alice.address);
      await positionLocker.connect(alice).collectFees(launch.lockId);
      // The 0.05% pool fee on the buy arrives as ETH, and the principal is untouched.
      expect(await token.balanceOf(alice.address)).to.be.greaterThanOrEqual(tokensBefore);
      expect(await positionManager.getPositionLiquidity(launch.tokenId)).to.equal(liquidityBefore);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(positionLocker.target);
    });
  });
});
