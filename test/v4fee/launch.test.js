const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
  deployPlatformV4Fee,
  deployFeeHook,
  feeTaxConfig,
  taxConfig,
  keyArray,
  mintCalldata,
  PERMIT2,
} = require("../v4/helpers");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const PLATFORM_BPS = 25n;
// LiquidityAction enum
const Lock = 0, Burn = 1;
// TokenFactory.TokenType
const Standard = 0, Tax = 1, Rewards = 2;

describe("V4 fee mode launch", function () {
  async function platform() {
    const ctx = await deployPlatformV4Fee();
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
      liquidityAction: Burn,
      lockDuration: 30n * DAY,
      launchTime: 0,
      whitelistEnabled: false,
    };
    return ctx;
  }

  const specFor = (ctx, tokenType, spec = {}) => ({
    name: "Pump",
    symbol: "PUMP",
    totalSupply: E("1000000"),
    rewardToken: tokenType === Rewards ? ctx.weth.target : ethers.ZeroAddress,
    ...spec,
  });

  /** Creates a fee mode token owned by alice. `rates` is one rate per share, in bps. */
  async function createToken(ctx, tokenType = Standard, rates = {}, spec = {}) {
    const { feeLauncher, alice, marketing } = ctx;
    await feeLauncher
      .connect(alice)
      .createToken(tokenType, specFor(ctx, tokenType, spec), feeTaxConfig(marketing.address, rates), alice.address);
    const created = await feeLauncher.tokensOfCreator(alice.address);
    return created[created.length - 1];
  }

  /** Creates a sale for any platform token alice owns. */
  async function createSale(ctx, tokenAddr, overrides = {}) {
    const { presaleFactory, alice } = ctx;
    const params = { ...ctx.baseParams, token: tokenAddr, ...overrides };
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
    await token.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    await presaleFactory.connect(alice).createPresale(params, { value: FEE });
    const n = await presaleFactory.allPresalesLength();
    const presale = await ethers.getContractAt("Presale", await presaleFactory.allPresales(n - 1n));
    return { presale, params };
  }

  /** Runs a sale up to the point where it can be finalized: the hard cap is reached. */
  async function fillSale(ctx, tokenAddr, overrides = {}) {
    const { presale, params } = await createSale(ctx, tokenAddr, overrides);
    await time.increaseTo(params.startTime);
    await presale.connect(ctx.bob).contribute({ value: E("5") });
    await presale.connect(ctx.carol).contribute({ value: E("5") });
    return { presale, params };
  }

  async function launchThrough(ctx, tokenAddr, overrides = {}) {
    const { presale, params } = await fillSale(ctx, tokenAddr, overrides);
    await presale.connect(ctx.alice).finalize(0, 0);
    return { presale, params };
  }

  /** A Tax launch that is trading: 3% to marketing, so the pool's fee is 3.25%. */
  async function launchedTax() {
    const ctx = await platform();
    const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
    const { presale } = await launchThrough(ctx, tokenAddr);
    const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
    const key = keyArray(await ctx.feeLauncher.poolKeyOf(tokenAddr));
    const launch = await ctx.feeLauncher.launchOf(tokenAddr);
    return { ...ctx, tokenAddr, token, presale, key, launch, poolId: launch.poolId };
  }

  /** A Rewards launch that is trading: 1% marketing, 2% holders paid in WETH, 3.25% in all. */
  async function launchedRewards() {
    const ctx = await platform();
    const tokenAddr = await createToken(ctx, Rewards, { marketingBps: 100, rewardsBps: 200 });
    const { presale } = await launchThrough(ctx, tokenAddr);
    await presale.connect(ctx.bob).claim();
    await presale.connect(ctx.carol).claim();
    const token = await ethers.getContractAt("RewardsTokenV4", tokenAddr);
    const key = keyArray(await ctx.feeLauncher.poolKeyOf(tokenAddr));
    const launch = await ctx.feeLauncher.launchOf(tokenAddr);
    return { ...ctx, tokenAddr, token, presale, key, launch, poolId: launch.poolId };
  }

  const buy = (ctx, key, who, eth) => ctx.swapper.connect(who).swapExactIn(key, true, eth, 0, who.address, { value: eth });
  const deadline = async () => (await time.latest()) + 600;

  /** The revert payload of a call, so a hook's error can be found inside the PoolManager's wrapper. */
  async function revertDataOf(call) {
    try {
      await call;
    } catch (error) {
      return error.data ?? error.info?.error?.data ?? "";
    }
    return null;
  }

  async function expectGateClosed(ctx, call) {
    const data = await revertDataOf(call);
    expect(data, "the call went through").to.be.a("string");
    expect(data).to.include(ctx.feeHook.interface.getError("LiquidityClosed").selector.slice(2));
  }

  // ------------------------------------------------------------------ creation

  describe("creating the token", function () {
    it("creates the three kinds as plain v4 tokens that name the fee launcher", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, feeLauncher, feeHook, launcher, alice, marketing, weth } = ctx;
      const kinds = [
        [Standard, {}, "HoodSaleTokenV4"],
        [Tax, { marketingBps: 300 }, "HoodSaleTokenV4"],
        [Rewards, { marketingBps: 100, rewardsBps: 200 }, "RewardsTokenV4"],
      ];

      for (const [tokenType, rates, artifact] of kinds) {
        const cfg = feeTaxConfig(marketing.address, rates);
        const tx = feeLauncher.connect(alice).createToken(tokenType, specFor(ctx, tokenType), cfg, alice.address);
        await expect(tx).to.emit(feeLauncher, "V4TokenCreated").withArgs(anyValue, alice.address, alice.address, tokenType);
        await expect(tx).to.emit(feeLauncher, "TaxConfigUpdated");
        const created = await feeLauncher.tokensOfCreator(alice.address);
        const tokenAddr = created[created.length - 1];
        const token = await ethers.getContractAt(artifact, tokenAddr);

        // The platform's registry lists it like any other token, created by the fee launcher.
        expect(await tokenFactory.isPlatformToken(tokenAddr)).to.equal(true);
        expect((await tokenFactory.infoOf(tokenAddr)).creator).to.equal(feeLauncher.target);
        expect(await token.poolVersion()).to.equal(4);
        expect(await token.launcher()).to.equal(feeLauncher.target);
        expect(await token.tokenType()).to.equal(tokenType);
        expect(await token.owner()).to.equal(alice.address);
        expect(await token.balanceOf(alice.address)).to.equal(E("1000000"));
        expect(await token.balanceOf(feeLauncher.target)).to.equal(0);

        expect(await feeLauncher.creatorOf(tokenAddr)).to.equal(alice.address);
        expect(await feeLauncher.isV4Token(tokenAddr)).to.equal(true);
        expect(await launcher.isV4Token(tokenAddr)).to.equal(false);
        const pending = await feeLauncher.pendingConfig(tokenAddr);
        expect(pending.marketingWallet).to.equal(marketing.address);
        expect(pending.marketingBuyBps).to.equal(pending.marketingSellBps).and.to.equal(rates.marketingBps ?? 0);
        expect(pending.rewardsBuyBps).to.equal(pending.rewardsSellBps).and.to.equal(rates.rewardsBps ?? 0);
        expect(pending.taxLocked).to.equal(true);

        // The pool key is the tax: the platform's 0.25% plus both shares, in hundredths of a bip.
        const key = await feeLauncher.keyFor(tokenAddr);
        const total = PLATFORM_BPS + BigInt(rates.marketingBps ?? 0) + BigInt(rates.rewardsBps ?? 0);
        expect(key.currency0).to.equal(ethers.ZeroAddress);
        expect(key.currency1).to.equal(tokenAddr);
        expect(key.fee).to.equal(total * 100n);
        expect(key.tickSpacing).to.equal(200);
        expect(key.hooks).to.equal(feeHook.target);

        if (tokenType === Rewards) {
          // The only address the token takes reward ETH from is the fee hook.
          expect(await token.hook()).to.equal(feeHook.target);
          expect(await token.rewardToken()).to.equal(weth.target);
        }
      }
      expect(await feeLauncher.tokenCount()).to.equal(3);
      expect(await feeLauncher.locker()).to.equal(ethers.ZeroAddress);
    });

    it("refuses every tax a pool fee cannot express", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, alice, marketing } = ctx;
      const create = (tokenType, cfg, owner = alice.address) =>
        feeLauncher.connect(alice).createToken(tokenType, specFor(ctx, tokenType), cfg, owner);
      const cfg = (rates) => feeTaxConfig(marketing.address, rates);

      await expect(create(3, cfg())).to.be.revertedWithCustomError(feeLauncher, "BadTokenType");
      await expect(create(Tax, feeTaxConfig(ethers.ZeroAddress, { marketingBps: 300 }))).to.be.revertedWithCustomError(
        feeLauncher,
        "ZeroWallet"
      );
      await expect(create(Tax, cfg({ marketingBps: 300 }), ethers.ZeroAddress)).to.be.revertedWith("zero owner");

      // One pool, one fee: a share cannot cost more on a sell than on a buy.
      await expect(
        create(Tax, taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500, taxLocked: true }))
      ).to.be.revertedWithCustomError(feeLauncher, "UnequalRates");
      await expect(
        create(Rewards, taxConfig(marketing.address, { rewardsBuyBps: 100, rewardsSellBps: 200, taxLocked: true }))
      ).to.be.revertedWithCustomError(feeLauncher, "UnequalRates");

      // The pool's fee never changes, so a tax that claims it still can is refused.
      await expect(
        create(Tax, taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 300, taxLocked: false }))
      ).to.be.revertedWithCustomError(feeLauncher, "TaxNotFixed");
      await expect(create(Standard, taxConfig(marketing.address))).to.be.revertedWithCustomError(
        feeLauncher,
        "TaxNotFixed"
      );

      // 10% in all, the platform's 0.25% included.
      await expect(create(Tax, cfg({ marketingBps: 976 }))).to.be.revertedWithCustomError(feeLauncher, "TaxTooHigh");
      await expect(create(Rewards, cfg({ marketingBps: 500, rewardsBps: 476 }))).to.be.revertedWithCustomError(
        feeLauncher,
        "TaxTooHigh"
      );

      // The shares must fit the kind of token.
      await expect(create(Standard, cfg({ marketingBps: 100 }))).to.be.revertedWithCustomError(feeLauncher, "BadShares");
      await expect(create(Standard, cfg({ rewardsBps: 100 }))).to.be.revertedWithCustomError(feeLauncher, "BadShares");
      await expect(create(Tax, cfg({ marketingBps: 100, rewardsBps: 100 }))).to.be.revertedWithCustomError(
        feeLauncher,
        "BadShares"
      );
      await expect(create(Rewards, cfg({ marketingBps: 100 }))).to.be.revertedWithCustomError(feeLauncher, "BadShares");

      // Exactly the cap is fine, and gives the highest fee a pool of this launcher can have.
      await create(Tax, cfg({ marketingBps: 975 }));
      const created = await feeLauncher.tokensOfCreator(alice.address);
      expect((await feeLauncher.keyFor(created[0])).fee).to.equal(100000);
      expect(await feeLauncher.tokenCount()).to.equal(1);
    });

    it("needs its hook and its lens first, takes a hook once, and only one built for it", async function () {
      const ctx = await loadFixture(platform);
      const { deployer, feeHook, tokenFactory, presaleFactory, treasury, poolManager, positionManager, stateView, alice, marketing } = ctx;
      const fresh = await ethers.deployContract("V4FeeLauncher", [
        deployer.address,
        poolManager.target,
        positionManager.target,
        PERMIT2,
        tokenFactory.target,
        presaleFactory.target,
        treasury.target,
      ]);
      const create = () =>
        fresh.connect(alice).createToken(Standard, specFor(ctx, Standard), feeTaxConfig(marketing.address), alice.address);
      expect(await fresh.creationOpen()).to.equal(true);
      await expect(create()).to.be.revertedWithCustomError(fresh, "HookNotSet");
      // A lens fixes its hook when it is built, so none can be set before the hook is.
      const earlyLens = await ethers.deployContract("HoodSaleV4Lens", [fresh.target, stateView.target]);
      await expect(fresh.setLens(earlyLens.target)).to.be.revertedWithCustomError(fresh, "HookNotSet");

      // A hook that names another launcher, or that pays another Treasury, is not this launcher's.
      await expect(fresh.connect(alice).setHook(feeHook.target)).to.be.revertedWithCustomError(fresh, "OwnableUnauthorizedAccount");
      await expect(fresh.setHook(feeHook.target)).to.be.revertedWithCustomError(fresh, "HookMismatch");
      const stranger = await deployFeeHook(deployer, poolManager.target, positionManager.target, fresh.target, alice.address);
      await expect(fresh.setHook(stranger.hook.target)).to.be.revertedWithCustomError(fresh, "HookMismatch");

      const own = await deployFeeHook(deployer, poolManager.target, positionManager.target, fresh.target, treasury.target);
      await expect(fresh.setHook(own.hook.target)).to.emit(fresh, "HookSet").withArgs(own.hook.target);
      await expect(fresh.setHook(own.hook.target)).to.be.revertedWithCustomError(fresh, "HookAlreadySet");

      // Without a lens the platform lens would read a fee mode token as a V2 token.
      await expect(create()).to.be.revertedWithCustomError(fresh, "LensNotSet");
      await expect(fresh.setLens(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "BadLens");
      await expect(fresh.setLens(alice.address)).to.be.revertedWithCustomError(fresh, "BadLens");
      await expect(fresh.connect(alice).setLens(feeHook.target)).to.be.revertedWithCustomError(fresh, "OwnableUnauthorizedAccount");
      // A lens built before the hook was set reads no hook, and the other launchers' lenses read
      // other launches: either would answer nothing for every token of this launcher.
      await expect(fresh.setLens(earlyLens.target)).to.be.revertedWithCustomError(fresh, "BadLens");
      await expect(fresh.setLens(ctx.v4FeeLens.target)).to.be.revertedWithCustomError(fresh, "BadLens");
      await expect(fresh.setLens(ctx.v4Lens.target)).to.be.revertedWithCustomError(fresh, "BadLens");
      const freshLens = await ethers.deployContract("HoodSaleV4Lens", [fresh.target, stateView.target]);
      await expect(fresh.setLens(freshLens.target)).to.emit(fresh, "LensSet").withArgs(freshLens.target);

      // The factory's deployers do not know this launcher, so what they hand back is a V2 token.
      await expect(create()).to.be.revertedWithCustomError(fresh, "NotFeeToken");
    });

    it("can be closed to new tokens by the owner, which never stops a launch", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, positionManager, alice, marketing } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const { presale } = await fillSale(ctx, tokenAddr);

      await expect(feeLauncher.connect(alice).setCreationOpen(false)).to.be.revertedWithCustomError(
        feeLauncher,
        "OwnableUnauthorizedAccount"
      );
      await expect(feeLauncher.setCreationOpen(false)).to.emit(feeLauncher, "CreationOpenSet").withArgs(false);
      await expect(
        feeLauncher.connect(alice).createToken(Standard, specFor(ctx, Standard), feeTaxConfig(marketing.address), alice.address)
      ).to.be.revertedWithCustomError(feeLauncher, "CreationClosed");

      // The sale that was already running lists all the same, and its tax can still be corrected.
      await presale.connect(alice).finalize(0, 0);
      const launch = await feeLauncher.launchOf(tokenAddr);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);

      await feeLauncher.setCreationOpen(true);
      await createToken(ctx, Standard);
    });

    it("refuses the token when the factory's deployers do not know this launcher", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, feeLauncher, launcher, feeDeployers, v4Deployers, alice, marketing } = ctx;
      // The rollback the plan keeps at hand: the V4 generation, which knows the hook mode launcher only.
      await tokenFactory.setDeployers(
        v4Deployers.standardDeployer.target,
        v4Deployers.taxDeployer.target,
        v4Deployers.rewardsDeployer.target
      );
      for (const [tokenType, rates] of [[Standard, {}], [Tax, { marketingBps: 300 }], [Rewards, { rewardsBps: 200 }]]) {
        await expect(
          feeLauncher
            .connect(alice)
            .createToken(tokenType, specFor(ctx, tokenType), feeTaxConfig(marketing.address, rates), alice.address)
        ).to.be.revertedWithCustomError(feeLauncher, "NotFeeToken");
      }
      expect(await feeLauncher.tokenCount()).to.equal(0);
      // Hook mode is what that generation was made for.
      await launcher
        .connect(alice)
        .createToken(Standard, specFor(ctx, Standard), taxConfig(marketing.address, { taxLocked: true }), alice.address);

      await tokenFactory.setDeployers(
        feeDeployers.standardDeployer.target,
        feeDeployers.taxDeployer.target,
        feeDeployers.rewardsDeployer.target
      );
      await createToken(ctx, Standard);
    });

    it("refuses a rewards token that another hook would fund", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, feeLauncher, feeDeployers, hook, alice, marketing } = ctx;
      // A deployer that binds the token to the tax hook, which will never pay a fee mode pool's share.
      const misbound = await ethers.deployContract("MisboundRewardsDeployer", [hook.target]);
      await tokenFactory.setDeployers(feeDeployers.standardDeployer.target, feeDeployers.taxDeployer.target, misbound.target);
      await expect(
        feeLauncher
          .connect(alice)
          .createToken(Rewards, specFor(ctx, Rewards), feeTaxConfig(marketing.address, { rewardsBps: 200 }), alice.address)
      ).to.be.revertedWithCustomError(feeLauncher, "HookNotFunder");
    });

    it("the deployers name both launchers and refuse a zero or a repeated one", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, launcher, feeLauncher, feeDeployers, v3Router, v3Quoter, rewardsTokenCode, rewardsTokenCodeV4, alice } = ctx;
      for (const deployer of Object.values(feeDeployers)) {
        expect(await deployer.factory()).to.equal(tokenFactory.target);
        expect(await deployer.launcher()).to.equal(launcher.target);
        expect(await deployer.feeLauncher()).to.equal(feeLauncher.target);
      }
      await expect(
        feeDeployers.standardDeployer.connect(alice).deploy("X", "X", 1, feeLauncher.target, alice.address, alice.address, 25)
      ).to.be.revertedWith("only factory");

      const zero = ethers.ZeroAddress;
      for (const name of ["StandardTokenDeployerFee", "TaxTokenDeployerFee"]) {
        await expect(ethers.deployContract(name, [tokenFactory.target, zero, feeLauncher.target])).to.be.revertedWith("zero launcher");
        await expect(ethers.deployContract(name, [tokenFactory.target, launcher.target, zero])).to.be.revertedWith("zero launcher");
        await expect(ethers.deployContract(name, [tokenFactory.target, launcher.target, launcher.target])).to.be.revertedWith("same launcher");
      }
      const rewardsArgs = (a, b) => [tokenFactory.target, v3Router.target, v3Quoter.target, rewardsTokenCode.target, rewardsTokenCodeV4.target, a, b];
      await expect(ethers.deployContract("RewardsTokenDeployerFee", rewardsArgs(zero, feeLauncher.target))).to.be.revertedWith("zero launcher");
      await expect(ethers.deployContract("RewardsTokenDeployerFee", rewardsArgs(launcher.target, zero))).to.be.revertedWith("zero launcher");
      await expect(ethers.deployContract("RewardsTokenDeployerFee", rewardsArgs(feeLauncher.target, feeLauncher.target))).to.be.revertedWith("same launcher");
    });
  });

  // ------------------------------------------------------------------ setTaxConfig

  describe("correcting the tax before the pool opens", function () {
    it("is the token owner's alone, keeps every creation rule, and moves the pool's fee with it", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, launcher, weth, alice, bob, marketing, dave } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const next = feeTaxConfig(dave.address, { marketingBps: 500, walletLocked: true });

      await expect(feeLauncher.connect(bob).setTaxConfig(tokenAddr, next)).to.be.revertedWithCustomError(feeLauncher, "NotTokenOwner");
      await expect(feeLauncher.connect(alice).setTaxConfig(weth.target, next)).to.be.revertedWithCustomError(feeLauncher, "NoPendingConfig");

      // A hook mode token has its tax on the other launcher; this one has never heard of it.
      await launcher.connect(alice).createToken(Tax, specFor(ctx, Tax), taxConfig(marketing.address, { marketingBuyBps: 300 }), alice.address);
      const [hookModeToken] = await launcher.tokensOfCreator(alice.address);
      await expect(feeLauncher.connect(alice).setTaxConfig(hookModeToken, next)).to.be.revertedWithCustomError(feeLauncher, "NoPendingConfig");

      // The kind of token is read from the token, so a Tax token still cannot take a holders' share.
      const set = (cfg) => feeLauncher.connect(alice).setTaxConfig(tokenAddr, cfg);
      await expect(set(feeTaxConfig(marketing.address, { marketingBps: 300, rewardsBps: 100 }))).to.be.revertedWithCustomError(feeLauncher, "BadShares");
      await expect(set(taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 300 }))).to.be.revertedWithCustomError(feeLauncher, "TaxNotFixed");
      await expect(set(taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 400, taxLocked: true }))).to.be.revertedWithCustomError(feeLauncher, "UnequalRates");
      await expect(set(feeTaxConfig(marketing.address, { marketingBps: 976 }))).to.be.revertedWithCustomError(feeLauncher, "TaxTooHigh");
      await expect(set(feeTaxConfig(ethers.ZeroAddress, { marketingBps: 300 }))).to.be.revertedWithCustomError(feeLauncher, "ZeroWallet");

      expect((await feeLauncher.keyFor(tokenAddr)).fee).to.equal(32500);
      await expect(set(next)).to.emit(feeLauncher, "TaxConfigUpdated").withArgs(tokenAddr, anyValue);
      const pending = await feeLauncher.pendingConfig(tokenAddr);
      expect(pending.marketingWallet).to.equal(dave.address);
      expect(pending.marketingBuyBps).to.equal(500);
      expect(pending.marketingSellBps).to.equal(500);
      expect(pending.walletLocked).to.equal(true);
      expect((await feeLauncher.keyFor(tokenAddr)).fee).to.equal(52500);
    });

    it("a Rewards token must keep a holders' share, a Standard token must keep none", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, alice, marketing } = ctx;
      const rewardsToken = await createToken(ctx, Rewards, { rewardsBps: 200 });
      const standardToken = await createToken(ctx, Standard);
      await expect(
        feeLauncher.connect(alice).setTaxConfig(rewardsToken, feeTaxConfig(marketing.address, { marketingBps: 200 }))
      ).to.be.revertedWithCustomError(feeLauncher, "BadShares");
      await expect(
        feeLauncher.connect(alice).setTaxConfig(standardToken, feeTaxConfig(marketing.address, { marketingBps: 1 }))
      ).to.be.revertedWithCustomError(feeLauncher, "BadShares");
      await feeLauncher.connect(alice).setTaxConfig(rewardsToken, feeTaxConfig(marketing.address, { marketingBps: 200, rewardsBps: 100 }));
    });

    it("ends when the pool opens: the fee is the pool's and nobody can change it", async function () {
      const { feeLauncher, feeHook, tokenAddr, alice, marketing } = await loadFixture(launchedTax);
      await expect(
        feeLauncher.connect(alice).setTaxConfig(tokenAddr, feeTaxConfig(marketing.address, { marketingBps: 100 }))
      ).to.be.revertedWithCustomError(feeLauncher, "AlreadyLaunched");
      expect(feeHook.interface.fragments.some((f) => f.name === "setTaxes" || f.name === "lockTaxes")).to.equal(false);
    });
  });

  // ------------------------------------------------------------------ launch

  describe("finalizing into a fee mode pool", function () {
    it("opens the pool at the listing price, with the tax as its fee and the position held by the hook", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, stateView, swapper, positionManager, positionLocker, marketing, bob } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const { presale } = await fillSale(ctx, tokenAddr, { liquidityAction: Burn });
      expect(await presale.isV4Launch()).to.equal(true);
      expect(await presale.v4Launcher()).to.equal(feeLauncher.target);

      const tokenId = await positionManager.nextTokenId();
      const tx = presale.connect(ctx.alice).finalize(0, 0);
      await expect(tx).to.emit(feeLauncher, "Launched");
      await expect(tx).to.emit(feeHook, "PoolRegistered");
      await expect(tx).to.emit(feeHook, "LiquiditySeeded");
      await expect(tx).to.not.emit(feeLauncher, "LockTreatedAsForever");

      const launch = await feeLauncher.launchOf(tokenAddr);
      expect(launch.done).to.equal(true);
      expect(launch.tokenId).to.equal(tokenId);
      // Nothing is locked for a while and nothing is sent to the burn address: there is no lock
      // to look up, which is what `burned` tells the lens, and the holder is the hook.
      expect(launch.burned).to.equal(true);
      expect(launch.lockId).to.equal(0);
      expect(await presale.v4PoolId()).to.equal(launch.poolId);
      expect(await presale.v4PositionId()).to.equal(tokenId);
      expect(await presale.lpLockId()).to.equal(0);
      expect(await presale.lpAmount()).to.equal(await positionManager.getPositionLiquidity(tokenId));

      // The position, the whole liquidity of the pool, belongs to the hook.
      expect(await positionManager.ownerOf(tokenId)).to.equal(feeHook.target);
      expect(await positionManager.balanceOf(positionLocker.target)).to.equal(0);
      expect(await feeHook.positionIdOf(launch.poolId)).to.equal(tokenId);
      expect(await feeHook.seeded(launch.poolId)).to.equal(true);
      expect(await stateView.getLiquidity(launch.poolId)).to.equal(await positionManager.getPositionLiquidity(tokenId));

      // The pool's own fee is the tax: 0.25% platform plus 3% marketing, and it is a static fee.
      const key = keyArray(await feeLauncher.poolKeyOf(tokenAddr));
      expect(await swapper.poolId(key)).to.equal(launch.poolId);
      expect(key).to.deep.equal(keyArray(await feeLauncher.keyFor(tokenAddr)));
      expect(key[2]).to.equal(32500);
      expect(key[4]).to.equal(feeHook.target);
      const slot0 = await stateView.getSlot0(launch.poolId);
      expect(slot0.lpFee).to.equal(32500);
      expect(slot0.protocolFee).to.equal(0);
      expect(await feeHook.feeBps(launch.poolId, true)).to.equal(325);
      expect(await feeHook.feeBps(launch.poolId, false)).to.equal(325);

      // 10 ETH raised, 10% platform fee, 60% of the rest to liquidity: 5.4 ETH at 800 tokens/ETH.
      const price = (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * 10n ** 18n) >> 192n;
      expect(price).to.be.closeTo(E("800"), E("0.01"));

      const cfg = await feeHook.configOf(launch.poolId);
      expect(cfg.token).to.equal(tokenAddr);
      expect(cfg.marketingWallet).to.equal(marketing.address);
      expect(cfg.rewardsSink).to.equal(ethers.ZeroAddress);
      expect(cfg.marketingBuyBps).to.equal(300);
      expect(cfg.marketingSellBps).to.equal(300);
      expect(cfg.taxLocked).to.equal(true);

      // Buyers claim exactly as in every other sale, and no transfer tax takes a bite.
      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
      await presale.connect(bob).claim();
      expect(await token.balanceOf(bob.address)).to.equal(E("5000"));
    });

    it("caps the supply where Uniswap's int128 accounting can never overflow, and lists at any price under it", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, stateView, positionManager, alice, bob, marketing } = ctx;
      const MAX = 10n ** 36n;
      expect(await feeLauncher.MAX_TOTAL_SUPPLY()).to.equal(MAX);
      await expect(
        feeLauncher
          .connect(alice)
          .createToken(Standard, specFor(ctx, Standard, { totalSupply: MAX + 1n }), feeTaxConfig(marketing.address), alice.address)
      ).to.be.revertedWithCustomError(feeLauncher, "SupplyTooLarge");

      // The largest supply at a listing rate far above 2^64 tokens per ETH, where the plain
      // price formula would overflow: the sale still finalizes and the pool still trades.
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 }, { totalSupply: MAX });
      const listingRate = 5n * 10n ** 34n;
      expect(listingRate).to.be.gt(2n ** 64n * 10n ** 18n / 10n ** 18n);
      const { presale } = await fillSale(ctx, tokenAddr, { presaleRate: 6n * 10n ** 34n, listingRate });
      await presale.connect(alice).finalize(0, 0);

      const launch = await feeLauncher.launchOf(tokenAddr);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);
      const slot0 = await stateView.getSlot0(launch.poolId);
      // sqrtPriceX96 squared over 2^192 is tokens per ETH, in wei per wei
      const rate = (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * 10n ** 18n) >> 192n;
      expect(rate).to.be.closeTo(listingRate, listingRate / 10n ** 6n);

      const key = keyArray(await feeLauncher.poolKeyOf(tokenAddr));
      await buy(ctx, key, bob, E("1"));
      const fees = await feeHook.collect.staticCall(launch.poolId);
      expect(fees.ethFees).to.be.closeTo((E("1") * 325n) / 10000n, 2n);
      await feeHook.collect(launch.poolId);
    });

    it("treats a Lock sale the same, forever, and says so", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, positionManager, positionLocker, alice } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const { presale, params } = await fillSale(ctx, tokenAddr, { liquidityAction: Lock, lockDuration: 45n * DAY });

      await expect(presale.connect(alice).finalize(0, 0))
        .to.emit(feeLauncher, "LockTreatedAsForever")
        .withArgs(tokenAddr, presale.target, params.lockDuration);

      const launch = await feeLauncher.launchOf(tokenAddr);
      expect(launch.burned).to.equal(true);
      expect(launch.lockId).to.equal(0);
      expect(await presale.lpLockId()).to.equal(0);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);
      // The timed locker never sees a fee mode position, so nothing ever unlocks to the sale owner.
      expect(await positionLocker.isLauncher(feeLauncher.target)).to.equal(false);
      expect(await positionLocker.lockCount()).to.equal(0);
      expect((await positionLocker.lockOfToken(launch.tokenId)).exists).to.equal(false);
      expect(await positionManager.balanceOf(positionLocker.target)).to.equal(0);
      await time.increase(46n * DAY);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);
    });

    it("refunds what the position did not need to the sale, and keeps nothing", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, poolManager, positionManager, treasury, alice } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
      const { presale } = await fillSale(ctx, tokenAddr);
      const eth = (who) => ethers.provider.getBalance(who.target ?? who.address);

      const before = {
        poolEth: await eth(poolManager),
        poolTokens: await token.balanceOf(poolManager.target),
        saleTokens: await token.balanceOf(presale.target),
        aliceEth: await eth(alice),
        aliceTokens: await token.balanceOf(alice.address),
        treasuryEth: await eth(treasury),
      };
      const receipt = await (await presale.connect(alice).finalize(0, 0)).wait();
      const finalized = receipt.logs
        .filter((log) => log.address === presale.target)
        .map((log) => presale.interface.parseLog(log))
        .find((log) => log?.name === "Finalized");
      const [platformFee, liquidityEth, liquidityTokens] = finalized.args;

      // What the pool took is what the position needed, a little under what the sale offered.
      const ethUsed = (await eth(poolManager)) - before.poolEth;
      const tokensUsed = (await token.balanceOf(poolManager.target)) - before.poolTokens;
      expect(ethUsed).to.be.lessThanOrEqual(liquidityEth);
      expect(tokensUsed).to.be.lessThanOrEqual(liquidityTokens);
      const dustEth = liquidityEth - ethUsed;
      const dustTokens = liquidityTokens - tokensUsed;
      expect(dustEth + dustTokens).to.be.greaterThan(0);
      expect(dustEth).to.be.lessThan(10n ** 9n);
      expect(dustTokens).to.be.lessThan(10n ** 12n);

      // The dust went back to the sale, which passed it on with the rest of what it owed the owner.
      for (const holder of [feeLauncher, feeHook, positionManager]) {
        expect(await eth(holder)).to.equal(0);
        expect(await token.balanceOf(holder.target)).to.equal(0);
      }
      const raised = E("10");
      const tokensForClaims = E("10000");
      expect(await eth(presale)).to.equal(0);
      expect(await token.balanceOf(presale.target)).to.equal(tokensForClaims);
      expect((await eth(treasury)) - before.treasuryEth).to.equal(platformFee);
      expect((await eth(alice)) - before.aliceEth + receipt.fee).to.equal(raised - platformFee - ethUsed);
      expect((await token.balanceOf(alice.address)) - before.aliceTokens).to.equal(
        before.saleTokens - tokensUsed - tokensForClaims
      );
    });

    // A quick launch finalizes itself inside someone's buy, with the gas Presale reserves for a
    // v4 listing. Fee mode does more in that call than hook mode: it registers the position too.
    it("finalizes inside the gas a sale reserves for a v4 listing", async function () {
      const cases = [
        ["standard, burn", Standard, {}, Burn],
        ["rewards, lock", Rewards, { marketingBps: 100, rewardsBps: 200 }, Lock],
      ];
      for (const [label, tokenType, rates, liquidityAction] of cases) {
        const ctx = await loadFixture(platform);
        const tokenAddr = await createToken(ctx, tokenType, rates);
        const { presale } = await fillSale(ctx, tokenAddr, { liquidityAction });
        const receipt = await (await presale.connect(ctx.alice).finalize(0, 0)).wait();
        const reserved = await presale.LAUNCH_BASE_GAS_V4();
        console.log(`      ${label}: ${receipt.gasUsed} gas used, ${reserved} reserved`);
        expect(receipt.gasUsed).to.be.lessThan(reserved);
      }
    });

    it("charges the tax as the pool's fee once the launch is trading, and pays it out", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, key, poolId, treasury, marketing, dave, launch, positionManager } = ctx;
      const liquidity = await positionManager.getPositionLiquidity(launch.tokenId);
      const spend = E("0.5");
      await buy(ctx, key, dave, spend);

      // Nothing reaches the hook during the swap: the fee sits in the position until collected.
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(0);
      const { ethFees, tokenFees } = await feeHook.collect.staticCall(poolId);
      expect(ethFees).to.be.closeTo((spend * 325n) / 10_000n, 2n);
      expect(tokenFees).to.equal(0);

      await feeHook.connect(dave).collect(poolId);
      expect(await feeHook.pendingMarketing(poolId)).to.equal((ethFees * 300n) / 325n);
      expect(await feeHook.pendingRewards(poolId)).to.equal(0);
      expect(await feeHook.pendingPlatform()).to.equal(ethFees - (ethFees * 300n) / 325n);

      await expect(feeHook.flush(poolId)).to.changeEtherBalance(marketing, (ethFees * 300n) / 325n);
      const reserveBefore = await treasury.buybackReserve();
      await feeHook.flushPlatform();
      expect(await treasury.buybackReserve()).to.be.greaterThan(reserveBefore);
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(0);
      // Collecting never touches the principal.
      expect(await positionManager.getPositionLiquidity(launch.tokenId)).to.equal(liquidity);
    });
  });

  describe("who may launch", function () {
    it("only a sale of the platform's factory, for its own token, once", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, launcher, poolManager, alice, marketing } = ctx;
      const tokenA = await createToken(ctx, Tax, { marketingBps: 300 });
      const tokenB = await createToken(ctx, Standard, {}, { name: "Other", symbol: "OTH" });
      await launcher.connect(alice).createToken(Standard, specFor(ctx, Standard), taxConfig(marketing.address, { taxLocked: true }), alice.address);
      const [hookModeToken] = await launcher.tokensOfCreator(alice.address);

      const later = { startTime: ctx.baseParams.startTime + DAY, endTime: ctx.baseParams.endTime + DAY };
      const { presale: saleB } = await createSale(ctx, tokenB, later);
      const { presale: hookModeSale } = await createSale(ctx, hookModeToken, later);
      const { presale: saleA } = await fillSale(ctx, tokenA);
      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenA);

      // A wallet is not a sale.
      await expect(
        feeLauncher.connect(alice).launch(tokenA, E("1"), Burn, 0, alice.address, { value: E("1") })
      ).to.be.revertedWithCustomError(feeLauncher, "NotPresale");

      // The sale contracts themselves, driven by hand. A real sale only ever asks for its own
      // token, so the other answers are reached by sending from a sale's address.
      const asSale = async (presale) => {
        await ethers.provider.send("hardhat_setBalance", [presale.target, "0x" + E("20").toString(16)]);
        return ethers.getImpersonatedSigner(presale.target);
      };
      const signerB = await asSale(saleB);
      await expect(
        feeLauncher.connect(signerB).launch(tokenA, E("1"), Burn, 0, alice.address, { value: E("1") })
      ).to.be.revertedWithCustomError(feeLauncher, "TokenMismatch");
      const hookModeSigner = await asSale(hookModeSale);
      await expect(
        feeLauncher.connect(hookModeSigner).launch(hookModeToken, E("1"), Burn, 0, alice.address, { value: E("1") })
      ).to.be.revertedWithCustomError(feeLauncher, "NoPendingConfig");

      const signerA = await asSale(saleA);
      await expect(
        feeLauncher.connect(signerA).launch(tokenA, 0, Burn, 0, alice.address, { value: E("1") })
      ).to.be.revertedWith("zero liquidity");
      await expect(feeLauncher.connect(signerA).launch(tokenA, E("1"), Burn, 0, alice.address)).to.be.revertedWith("zero liquidity");

      // Launching by hand shows the refund where it lands: the sale gets back, from the
      // launcher's own address, exactly what the pool did not take.
      const tokens = E("4321.123456789");
      const ethSent = E("5.4321");
      await token.connect(signerA).approve(feeLauncher.target, tokens);
      const saleEth = await ethers.provider.getBalance(saleA.target);
      const saleTokens = await token.balanceOf(saleA.target);
      const poolEth = await ethers.provider.getBalance(poolManager.target);
      const poolTokens = await token.balanceOf(poolManager.target);
      const receipt = await (
        await feeLauncher.connect(signerA).launch(tokenA, tokens, Lock, 30n * DAY, alice.address, { value: ethSent })
      ).wait();
      const ethUsed = (await ethers.provider.getBalance(poolManager.target)) - poolEth;
      const tokensUsed = (await token.balanceOf(poolManager.target)) - poolTokens;
      expect(ethUsed).to.be.lessThanOrEqual(ethSent);
      expect(tokensUsed).to.be.lessThanOrEqual(tokens);
      expect(ethSent - ethUsed + (tokens - tokensUsed)).to.be.greaterThan(0);
      expect(saleEth - (await ethers.provider.getBalance(saleA.target)) - receipt.fee).to.equal(ethUsed);
      expect(saleTokens - (await token.balanceOf(saleA.target))).to.equal(tokensUsed);
      expect(await ethers.provider.getBalance(feeLauncher.target)).to.equal(0);
      expect(await token.balanceOf(feeLauncher.target)).to.equal(0);
      expect(await token.balanceOf(feeHook.target)).to.equal(0);

      // Once is all: not by hand again, and not by the sale's own finalize either.
      await expect(
        feeLauncher.connect(signerA).launch(tokenA, E("1"), Burn, 0, alice.address, { value: E("1") })
      ).to.be.revertedWithCustomError(feeLauncher, "AlreadyLaunched");
      expect(await saleA.v4TermsHold()).to.equal(true);
      await expect(saleA.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(feeLauncher, "AlreadyLaunched");
    });
  });

  // The pool's fee is a pure function of the tax on the launcher, and until the pool opens the
  // token's owner can still change that tax. The sale keeps a hash of the tax it was created with
  // and lists only with that same tax, so the fee tier buyers were shown is the one they get.
  describe("holding the owner to the sale's tax", function () {
    it("hashes the 224 bytes pendingConfig answers with, which are zeros for a token the launcher does not know", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, launcher, alice, marketing } = ctx;
      // The raw answer, as a sale's constructor reads it: it takes 224 bytes and nothing else.
      const rawConfig = (token) =>
        ethers.provider.call({ to: feeLauncher.target, data: feeLauncher.interface.encodeFunctionData("pendingConfig", [token]) });
      const sizeOf = (hex) => (hex.length - 2) / 2;
      const sevenWords = (values) =>
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint16", "uint16", "uint16", "uint16", "bool", "bool"], values);

      const tokenAddr = await createToken(ctx, Rewards, { marketingBps: 100, rewardsBps: 200 });
      const known = await rawConfig(tokenAddr);
      expect(sizeOf(known)).to.equal(224);
      expect(known).to.equal(sevenWords([marketing.address, 100, 100, 200, 200, true, false]));

      // An address nobody has used, the zero address, a wallet, a platform contract and a token of
      // the other launcher: seven zero words each time, never a shorter answer and never a revert.
      await launcher
        .connect(alice)
        .createToken(Standard, specFor(ctx, Standard), taxConfig(marketing.address, { taxLocked: true }), alice.address);
      const [hookModeToken] = await launcher.tokensOfCreator(alice.address);
      const zeros = "0x" + "00".repeat(224);
      for (const unknown of [ethers.Wallet.createRandom().address, ethers.ZeroAddress, alice.address, feeHook.target, hookModeToken]) {
        expect(await rawConfig(unknown), unknown).to.equal(zeros);
        expect(await feeLauncher.isV4Token(unknown), unknown).to.equal(false);
      }

      // A sale reads the answer again when it lists, and the pool opening does not change it.
      const { presale } = await launchThrough(ctx, tokenAddr);
      expect(await rawConfig(tokenAddr)).to.equal(known);
      expect(await presale.v4TermsHash()).to.equal(ethers.keccak256(known));
    });

    it("holds for a fee mode sale of every kind of token", async function () {
      const ctx = await loadFixture(platform);
      const kinds = [[Standard, {}], [Tax, { marketingBps: 300 }], [Rewards, { marketingBps: 100, rewardsBps: 200 }]];
      let shift = 0n;
      for (const [tokenType, rates] of kinds) {
        const tokenAddr = await createToken(ctx, tokenType, rates);
        const { presale } = await createSale(ctx, tokenAddr, {
          startTime: ctx.baseParams.startTime + shift,
          endTime: ctx.baseParams.endTime + shift,
        });
        expect(await presale.isV4Launch()).to.equal(true);
        expect(await presale.v4Launcher()).to.equal(ctx.feeLauncher.target);
        expect(await presale.v4TermsHash()).to.not.equal(ethers.ZeroHash);
        expect(await presale.v4TermsHold()).to.equal(true);
        shift += 10n;
      }
    });

    it("refuses to list once the owner has changed the tax, and lists when it is put back", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, stateView, alice, marketing, dave } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const { presale } = await fillSale(ctx, tokenAddr);
      expect(await presale.v4TermsHold()).to.equal(true);

      // A higher rate would be a different, dearer pool than the one the buyers were shown.
      await feeLauncher.connect(alice).setTaxConfig(tokenAddr, feeTaxConfig(marketing.address, { marketingBps: 900 }));
      expect(await presale.v4TermsHold()).to.equal(false);
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");

      // Moving the wallet, or locking it, alone is refused as well.
      await feeLauncher.connect(alice).setTaxConfig(tokenAddr, feeTaxConfig(dave.address, { marketingBps: 300 }));
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");
      await feeLauncher.connect(alice).setTaxConfig(tokenAddr, feeTaxConfig(marketing.address, { marketingBps: 300, walletLocked: true }));
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");
      expect((await feeLauncher.launchOf(tokenAddr)).done).to.equal(false);

      await feeLauncher.connect(alice).setTaxConfig(tokenAddr, feeTaxConfig(marketing.address, { marketingBps: 300 }));
      expect(await presale.v4TermsHold()).to.equal(true);
      await presale.connect(alice).finalize(0, 0);
      const launch = await feeLauncher.launchOf(tokenAddr);
      expect((await stateView.getSlot0(launch.poolId)).lpFee).to.equal(32500);
      const cfg = await feeHook.configOfToken(tokenAddr);
      expect(cfg.marketingWallet).to.equal(marketing.address);
      expect(cfg.marketingBuyBps).to.equal(300);
      expect(cfg.walletLocked).to.equal(false);
    });

    it("leaves the buyers their refund when the owner never puts the tax back", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, alice, bob, marketing } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const { presale, params } = await fillSale(ctx, tokenAddr);
      await feeLauncher.connect(alice).setTaxConfig(tokenAddr, feeTaxConfig(marketing.address, { marketingBps: 975 }));
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");

      await time.increaseTo(params.endTime + 14n * DAY + 1n);
      const before = await ethers.provider.getBalance(bob.address);
      await presale.connect(bob).claimRefund();
      expect(await ethers.provider.getBalance(bob.address)).to.be.greaterThan(before + E("4.99"));
    });
  });

  // ------------------------------------------------------------------ rewards

  describe("a Rewards token in fee mode", function () {
    it("is funded by the fee hook's flush and distributes to holders, from buys and from sells", async function () {
      const ctx = await loadFixture(launchedRewards);
      const { feeHook, swapper, token, key, poolId, keeper, weth, marketing, bob, carol, dave } = ctx;
      expect(await token.hook()).to.equal(feeHook.target);
      expect((await feeHook.configOf(poolId)).rewardsSink).to.equal(token.target);

      const spend = E("1");
      await buy(ctx, key, dave, spend);
      const { ethFees } = await feeHook.collect.staticCall(poolId);
      expect(ethFees).to.be.closeTo((spend * 325n) / 10_000n, 2n);
      await feeHook.collect(poolId);
      const holdersShare = (ethFees * 200n) / 325n;
      expect(await feeHook.pendingRewards(poolId)).to.equal(holdersShare);
      expect(await token.pendingRewardEth()).to.equal(0);

      // Anyone flushes; the token takes the ETH because it comes from its hook.
      await expect(feeHook.connect(dave).flush(poolId)).to.changeEtherBalances(
        [token, marketing, feeHook],
        [holdersShare, (ethFees * 100n) / 325n, -(holdersShare + (ethFees * 100n) / 325n)]
      );
      expect(await token.pendingRewardEth()).to.equal(holdersShare);
      expect(await feeHook.pendingRewards(poolId)).to.equal(0);

      // The reward token is WETH, so the ETH is simply wrapped. The keeper named by the fee
      // launcher runs it.
      await token.connect(keeper).distributeRewards(0);
      expect(await token.pendingRewardEth()).to.equal(0);
      expect(await token.totalRewardsDistributed()).to.equal(holdersShare);
      const bobOwed = await token.withdrawableRewardOf(bob.address);
      expect(bobOwed).to.be.greaterThan(0);
      expect(await token.withdrawableRewardOf(carol.address)).to.equal(bobOwed);
      await token.connect(bob).claimRewards();
      expect(await weth.balanceOf(bob.address)).to.equal(bobOwed);

      // A sell pays its tax in tokens. The hook sells them for ETH, and that ETH is split the same way.
      await token.connect(dave).approve(swapper.target, ethers.MaxUint256);
      await swapper.connect(dave).swapExactIn(key, false, E("400"), 0, dave.address);
      const preview = await feeHook.connect(carol).convert.staticCall(poolId, 1, 0, await deadline());
      expect(preview.tokensSold).to.be.closeTo((E("400") * 325n) / 10_000n, 2n);
      await feeHook.connect(carol).convert(poolId, preview.tokensSold, preview.ethOut, await deadline());
      expect(await feeHook.pendingRewards(poolId)).to.equal((preview.ethOut * 200n) / 325n);
      await feeHook.flush(poolId);
      expect(await token.pendingRewardEth()).to.equal((preview.ethOut * 200n) / 325n);
      await token.connect(keeper).distributeRewardsPartly((preview.ethOut * 200n) / 325n, 0);
      expect(await token.withdrawableRewardOf(carol.address)).to.be.greaterThan(bobOwed);
    });

    it("takes reward ETH from the fee hook only", async function () {
      const { token, hook, alice } = await loadFixture(launchedRewards);
      await expect(alice.sendTransaction({ to: token.target, value: E("1") })).to.be.revertedWithCustomError(token, "NotHook");
      // Not from the hook mode hook either, which funds the other launcher's tokens.
      await ethers.provider.send("hardhat_setBalance", [hook.target, "0x" + E("2").toString(16)]);
      const taxHook = await ethers.getImpersonatedSigner(hook.target);
      await expect(taxHook.sendTransaction({ to: token.target, value: E("1") })).to.be.revertedWithCustomError(token, "NotHook");
    });

    it("never pays holder rewards to the fee hook, the PoolManager or the platform's contracts", async function () {
      const ctx = await loadFixture(launchedRewards);
      const { feeHook, feeLauncher, poolManager, positionManager, treasury, presale, swapper, token, key, poolId, keeper, alice, bob, carol, dave } = ctx;

      for (const account of [feeHook, poolManager, positionManager, feeLauncher, treasury]) {
        expect(await token.isAlwaysExcluded(account.target)).to.equal(true);
        expect(await token.isExcludedFromRewards(account.target)).to.equal(true);
        await expect(token.connect(alice).setExcludedFromRewards(account.target, false)).to.be.revertedWithCustomError(token, "AlwaysExcluded");
      }
      // The factory took the sale contract out when the sale was created: it found the presale
      // factory through the fee launcher, as it does through the hook mode launcher.
      expect(await token.isExcludedFromRewards(presale.target)).to.equal(true);

      // After a sell the hook holds tokens, its uncollected tax, and the PoolManager holds the pool's.
      await buy(ctx, key, dave, E("1"));
      await token.connect(dave).approve(swapper.target, ethers.MaxUint256);
      await swapper.connect(dave).swapExactIn(key, false, E("500"), 0, dave.address);
      await feeHook.collect(poolId);
      expect(await token.balanceOf(feeHook.target)).to.be.greaterThan(0);
      expect(await token.balanceOf(poolManager.target)).to.be.greaterThan(0);
      expect(await token.sharesOf(feeHook.target)).to.equal(0);
      expect(await token.sharesOf(poolManager.target)).to.equal(0);

      // Every share belongs to a wallet that can claim.
      let held = 0n;
      for (const holder of [alice, bob, carol, dave]) held += await token.balanceOf(holder.address);
      expect(await token.totalShares()).to.equal(held);

      await feeHook.flush(poolId);
      await token.connect(keeper).distributeRewards(0);
      expect(await token.withdrawableRewardOf(feeHook.target)).to.equal(0);
      expect(await token.withdrawableRewardOf(poolManager.target)).to.equal(0);
      let owed = 0n;
      for (const holder of [alice, bob, carol, dave]) owed += await token.withdrawableRewardOf(holder.address);
      expect(owed).to.be.closeTo(await token.totalRewardsDistributed(), 4n);
    });
  });

  // ------------------------------------------------------------------ lens and router

  describe("the second lens", function () {
    it("reads the fee launcher and the fee hook through the unchanged lens contract", async function () {
      const { v4FeeLens, v4Lens, feeLauncher, feeHook, positionManager, tokenAddr } = await loadFixture(launchedTax);
      expect(await v4FeeLens.launcher()).to.equal(feeLauncher.target);
      expect(await v4FeeLens.hook()).to.equal(feeHook.target);
      expect(await v4FeeLens.positionManager()).to.equal(positionManager.target);
      expect(await v4FeeLens.locker()).to.equal(ethers.ZeroAddress);
      expect(await feeLauncher.lens()).to.equal(v4FeeLens.target);
      expect(await v4FeeLens.isV4Token(tokenAddr)).to.equal(true);
      // The hook mode lens reads the other launcher and has nothing on this token.
      expect(await v4Lens.isV4Token(tokenAddr)).to.equal(false);
    });

    it("describes the pool, the position and the tax in one call", async function () {
      const ctx = await loadFixture(launchedTax);
      const { v4FeeLens, feeHook, tokenAddr, launch, key, poolId, marketing, dave } = ctx;
      await buy(ctx, key, dave, E("1"));
      await feeHook.collect(poolId);

      const v = await v4FeeLens.v4LaunchView(tokenAddr);
      expect(v.poolId).to.equal(launch.poolId);
      expect(v.hookAddress).to.equal(feeHook.target);
      expect(v.lpFee).to.equal(32500);
      expect(v.tickSpacing).to.equal(200);
      expect(v.priceAvailable).to.equal(true);
      expect(v.positionId).to.equal(launch.tokenId);
      expect(v.positionLiquidity).to.equal(v.poolLiquidity);
      // No lock to read: the holder is the hook, for good.
      expect(v.positionHolder).to.equal(feeHook.target);
      expect(v.positionBurned).to.equal(true);
      expect(v.lockId).to.equal(0);
      expect(v.unlockTime).to.equal(0);
      expect(v.platformTaxBps).to.equal(25);
      expect(v.marketingBuyBps).to.equal(300);
      expect(v.marketingSellBps).to.equal(300);
      expect(v.rewardsBuyBps).to.equal(0);
      expect(v.marketingWallet).to.equal(marketing.address);
      expect(v.taxLocked).to.equal(true);
      expect(v.pendingMarketing).to.equal(await feeHook.pendingMarketing(poolId));
      expect(v.pendingMarketing).to.be.greaterThan(0);

      const stats = await v4FeeLens.launchStats(tokenAddr);
      expect(stats.priceAvailable).to.equal(true);
      expect(stats.positionBurned).to.equal(true);
      expect(stats.reserveWeth).to.equal(v.reserveWeth);
      // The launch's 5.4 ETH plus the buy, less the 3.25% that went to fees instead of the reserves.
      expect(stats.reserveWeth).to.be.closeTo(E("5.4") + (E("1") * 9675n) / 10_000n, E("0.001"));
      expect(await v4FeeLens.creatorTaxes(tokenAddr)).to.deep.equal([300n, 300n]);
    });

    it("feeds the platform lens, which reports a fee mode launch like any other", async function () {
      const ctx = await loadFixture(launchedTax);
      const { lens, presale, tokenAddr, key, dave } = ctx;
      expect(await lens.poolKind(tokenAddr)).to.equal(1);
      const v = await lens.launchView(presale.target);
      expect(v.poolKind).to.equal(1);
      expect(v.token).to.equal(tokenAddr);
      expect(v.priceAvailable).to.equal(true);
      expect(v.listingPriceWei).to.equal((10n ** 18n * 10n ** 18n) / E("800"));
      expect(v.currentPriceWei).to.be.closeTo(v.listingPriceWei, v.listingPriceWei / 1000n);
      expect(v.multiplierX18).to.be.closeTo(E("1"), E("0.01"));
      expect(v.liquidityWeth).to.be.closeTo(E("5.4"), E("0.02"));
      expect(v.buyTaxBps).to.equal(300);
      expect(v.sellTaxBps).to.equal(300);

      await buy(ctx, key, dave, E("1"));
      const after = await lens.launchView(presale.target);
      expect(after.currentPriceWei).to.be.greaterThan(v.currentPriceWei);
      expect(after.liquidityWeth).to.be.greaterThan(v.liquidityWeth);
      await lens.presaleView(presale.target);
      await lens.presaleMomentum(presale.target, 0);
    });

    it("keeps the platform lens's batch views whole with fee mode sales among the others, before and after they launch", async function () {
      const ctx = await loadFixture(platform);
      const { lens, launcher, tokenFactory, presaleFactory, alice, bob, carol, marketing } = ctx;
      const Upcoming = 0n, Ended = 2n, Finalized = 5n;
      const ALL = 0xff;
      const plain = (result) => result.toArray(true);

      // Five sales side by side. Three are fee mode: one will launch, one fills and waits, one has
      // not opened yet. The other two are a hook mode sale and a V2 sale, which launch as well.
      const feeTax = await createToken(ctx, Tax, { marketingBps: 300 });
      const feeRewards = await createToken(ctx, Rewards, { marketingBps: 100, rewardsBps: 200 });
      const feeStandard = await createToken(ctx, Standard);
      await launcher
        .connect(alice)
        .createToken(Tax, specFor(ctx, Tax), taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 }), alice.address);
      const [hookMode] = await launcher.tokensOfCreator(alice.address);
      await tokenFactory.connect(alice).createStandardToken("Old", "OLD", E("1000000"));
      const v2 = (await tokenFactory.tokensOfCreator(alice.address)).at(-1);

      const later = { startTime: ctx.baseParams.startTime + 2n * DAY, endTime: ctx.baseParams.endTime + 2n * DAY };
      const sales = [];
      for (const [tokenAddr, overrides] of [[feeTax, {}], [feeRewards, {}], [feeStandard, later], [hookMode, {}], [v2, {}]]) {
        sales.push((await createSale(ctx, tokenAddr, overrides)).presale);
      }
      const [taxSale, rewardsSale, , hookSale, v2Sale] = sales;
      await time.increaseTo(ctx.baseParams.startTime);
      for (const sale of [taxSale, rewardsSale, hookSale, v2Sale]) {
        await sale.connect(bob).contribute({ value: E("5") });
        await sale.connect(carol).contribute({ value: E("5") });
      }
      for (const sale of [taxSale, hookSale, v2Sale]) await sale.connect(alice).finalize(0, 0);
      expect(await presaleFactory.allPresalesLength()).to.equal(5);

      /** Every batch view, checked row by row against the single view of the same sale. */
      async function expectWhole(statuses, launchedNewestFirst) {
        const [views, total] = await lens.presaleViews(0, 10, ALL);
        expect(total).to.equal(5);
        expect(views.map((v) => v.presale)).to.deep.equal(sales.map((sale) => sale.target));
        expect(views.map((v) => v.status)).to.deep.equal(statuses);
        expect(views.map((v) => v.poolKind)).to.deep.equal([1n, 1n, 1n, 1n, 0n]);
        for (const [i, sale] of sales.entries()) expect(plain(views[i])).to.deep.equal(plain(await lens.presaleView(sale.target)));

        const [launches, totalFinalized] = await lens.launchViews(0, 10);
        expect(totalFinalized).to.equal(launchedNewestFirst.length);
        expect(launches.map((v) => v.presale)).to.deep.equal(launchedNewestFirst.map((sale) => sale.target));
        for (const [i, sale] of launchedNewestFirst.entries()) {
          expect(launches[i].priceAvailable, sale.target).to.equal(true);
          expect(plain(launches[i])).to.deep.equal(plain(await lens.launchView(sale.target)));
        }

        const [momentum, momentumTotal] = await lens.momentumViews(0, 10, 0);
        expect(momentumTotal).to.equal(5);
        expect(momentum.map((m) => m.poolKind)).to.deep.equal([1n, 1n, 1n, 1n, 0n]);
        expect(momentum.map((m) => m.priceAvailable)).to.deep.equal(statuses.map((status) => status === Finalized));
        for (const [i, sale] of sales.entries()) expect(plain(momentum[i])).to.deep.equal(plain(await lens.presaleMomentum(sale.target, 0)));
      }

      await expectWhole([Finalized, Ended, Upcoming, Finalized, Finalized], [v2Sale, hookSale, taxSale]);

      // The fee mode launch reads like the others: its one rate on both sides, its price and its liquidity.
      const [launches] = await lens.launchViews(0, 10);
      const feeLaunch = launches[2];
      expect(feeLaunch.token).to.equal(feeTax);
      expect([feeLaunch.buyTaxBps, feeLaunch.sellTaxBps]).to.deep.equal([300n, 300n]);
      expect([launches[1].buyTaxBps, launches[1].sellTaxBps]).to.deep.equal([300n, 500n]);
      expect(feeLaunch.lpBurned).to.equal(true);
      expect(feeLaunch.liquidityWeth).to.be.closeTo(E("5.4"), E("0.02"));
      expect(feeLaunch.multiplierX18).to.be.closeTo(E("1"), E("0.01"));

      // The filter and the paging see fee mode sales like any other row.
      const [finalized, filteredTotal] = await lens.presaleViews(0, 10, Number(Finalized));
      expect(filteredTotal).to.equal(5);
      expect(finalized.map((v) => v.presale)).to.deep.equal([taxSale.target, hookSale.target, v2Sale.target]);
      const [page] = await lens.presaleViews(1, 2, ALL);
      expect(page.map((v) => v.token)).to.deep.equal([feeRewards, feeStandard]);
      const [second] = await lens.launchViews(1, 1);
      expect(second.map((v) => v.presale)).to.deep.equal([hookSale.target]);
      const [tail] = await lens.momentumViews(3, 10, 0);
      expect(tail.map((m) => m.presale)).to.deep.equal([hookSale.target, v2Sale.target]);

      // The waiting fee mode sale lists, and every view follows it.
      await rewardsSale.connect(alice).finalize(0, 0);
      await expectWhole([Finalized, Finalized, Upcoming, Finalized, Finalized], [v2Sale, hookSale, rewardsSale, taxSale]);
    });

    it("answers with nothing, and never reverts, for a token that has not launched", async function () {
      const ctx = await loadFixture(platform);
      const { v4FeeLens, lens } = ctx;
      const tokenAddr = await createToken(ctx, Rewards, { marketingBps: 100, rewardsBps: 200 });
      const { presale } = await fillSale(ctx, tokenAddr);

      expect(await v4FeeLens.isV4Token(tokenAddr)).to.equal(false);
      const stats = await v4FeeLens.launchStats(tokenAddr);
      expect(stats.priceAvailable).to.equal(false);
      // Before the pool opens the rates are read from the launcher's pending tax, not from here.
      expect(await v4FeeLens.creatorTaxes(tokenAddr)).to.deep.equal([0n, 0n]);
      const v = await v4FeeLens.v4LaunchView(tokenAddr);
      expect(v.token).to.equal(tokenAddr);
      expect(v.poolId).to.equal(ethers.ZeroHash);

      expect(await lens.poolKind(tokenAddr)).to.equal(1);
      const launchView = await lens.launchView(presale.target);
      expect(launchView.poolKind).to.equal(1);
      expect(launchView.priceAvailable).to.equal(false);
      await lens.presaleView(presale.target);
      await lens.presaleMomentum(presale.target, 0);
    });
  });

  describe("the second router", function () {
    it("buys and sells a fee mode launch in its own pool, where the pool takes the tax", async function () {
      const { v4FeeRouter, feeHook, feeLauncher, token, tokenAddr, poolId, dave, carol } = await loadFixture(launchedTax);
      expect(await v4FeeRouter.launcher()).to.equal(feeLauncher.target);

      const spend = E("1");
      const before = await ethers.provider.getBalance(dave.address);
      const receipt = await (await v4FeeRouter.connect(dave).buy(tokenAddr, 0, dave.address, await deadline(), { value: spend })).wait();
      expect(before - (await ethers.provider.getBalance(dave.address)) - receipt.fee).to.equal(spend);
      const bought = await token.balanceOf(dave.address);
      expect(bought).to.be.greaterThan(0);
      let fees = await feeHook.collect.staticCall(poolId);
      expect(fees.ethFees).to.be.closeTo((spend * 325n) / 10_000n, 2n);

      await token.connect(dave).approve(v4FeeRouter.target, bought);
      const carolBefore = await ethers.provider.getBalance(carol.address);
      await v4FeeRouter.connect(dave).sell(tokenAddr, bought, 0, carol.address, await deadline());
      expect((await ethers.provider.getBalance(carol.address)) - carolBefore).to.be.greaterThan(0);
      fees = await feeHook.collect.staticCall(poolId);
      expect(fees.tokenFees).to.be.closeTo((bought * 325n) / 10_000n, 2n);

      expect(await ethers.provider.getBalance(v4FeeRouter.target)).to.equal(0);
      expect(await token.balanceOf(v4FeeRouter.target)).to.equal(0);
    });

    it("executes at the price Uniswap's own quoter gives, tax included", async function () {
      const { v4FeeRouter, quoter, key, tokenAddr, dave } = await loadFixture(launchedTax);
      const spend = E("1");
      const quoted = await quoter.quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne: true, exactAmount: spend, hookData: "0x" });
      const out = await v4FeeRouter.connect(dave).buy.staticCall(tokenAddr, 0, dave.address, await deadline(), { value: spend });
      expect(out).to.equal(quoted[0]);
      await expect(
        v4FeeRouter.connect(dave).buy(tokenAddr, out + 1n, dave.address, await deadline(), { value: spend })
      ).to.be.revertedWithCustomError(v4FeeRouter, "TooLittleReceived");
    });

    it("trades only its own launcher's tokens, as the hook mode router trades only its own", async function () {
      const ctx = await loadFixture(launchedTax);
      const { v4FeeRouter, v4Router, launcher, tokenAddr, alice, marketing, dave } = ctx;
      await expect(
        v4Router.connect(dave).buy(tokenAddr, 0, dave.address, await deadline(), { value: E("1") })
      ).to.be.revertedWithCustomError(v4Router, "NotLaunched");

      await launcher.connect(alice).createToken(Standard, specFor(ctx, Standard), taxConfig(marketing.address, { taxLocked: true }), alice.address);
      const [hookModeToken] = await launcher.tokensOfCreator(alice.address);
      await expect(
        v4FeeRouter.connect(dave).buy(hookModeToken, 0, dave.address, await deadline(), { value: E("1") })
      ).to.be.revertedWithCustomError(v4FeeRouter, "NotLaunched");
    });

    it("each router refuses a token the other launcher has launched, to buy and to sell", async function () {
      const ctx = await loadFixture(launchedTax);
      const { v4FeeRouter, v4Router, launcher, feeLauncher, token, tokenAddr, alice, marketing, dave } = ctx;

      // A hook mode launch beside the fee mode one, both trading. An unlaunched token would be
      // refused by either router whatever its mode, so only a launched one shows the routers apart.
      await launcher
        .connect(alice)
        .createToken(Tax, specFor(ctx, Tax), taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 }), alice.address);
      const [hookModeAddr] = await launcher.tokensOfCreator(alice.address);
      const hookModeToken = await ethers.getContractAt("HoodSaleTokenV4", hookModeAddr);
      const start = BigInt(await time.latest()) + 100n;
      await launchThrough(ctx, hookModeAddr, { startTime: start, endTime: start + DAY });
      expect((await launcher.launchOf(hookModeAddr)).done).to.equal(true);
      expect((await feeLauncher.launchOf(hookModeAddr)).done).to.equal(false);
      expect((await feeLauncher.launchOf(tokenAddr)).done).to.equal(true);
      expect((await launcher.launchOf(tokenAddr)).done).to.equal(false);

      // Each router trades its own launcher's token, which gives dave something to sell.
      const spend = E("1");
      await v4Router.connect(dave).buy(hookModeAddr, 0, dave.address, await deadline(), { value: spend });
      await v4FeeRouter.connect(dave).buy(tokenAddr, 0, dave.address, await deadline(), { value: spend });
      const hookModeHeld = await hookModeToken.balanceOf(dave.address);
      const feeModeHeld = await token.balanceOf(dave.address);
      expect(hookModeHeld).to.be.greaterThan(0);
      expect(feeModeHeld).to.be.greaterThan(0);

      // The fee router and a launched hook mode token.
      await hookModeToken.connect(dave).approve(v4FeeRouter.target, hookModeHeld);
      await expect(
        v4FeeRouter.connect(dave).buy(hookModeAddr, 0, dave.address, await deadline(), { value: spend })
      ).to.be.revertedWithCustomError(v4FeeRouter, "NotLaunched");
      await expect(
        v4FeeRouter.connect(dave).sell(hookModeAddr, hookModeHeld, 0, dave.address, await deadline())
      ).to.be.revertedWithCustomError(v4FeeRouter, "NotLaunched");

      // The hook mode router and a launched fee mode token.
      await token.connect(dave).approve(v4Router.target, feeModeHeld);
      await expect(
        v4Router.connect(dave).buy(tokenAddr, 0, dave.address, await deadline(), { value: spend })
      ).to.be.revertedWithCustomError(v4Router, "NotLaunched");
      await expect(
        v4Router.connect(dave).sell(tokenAddr, feeModeHeld, 0, dave.address, await deadline())
      ).to.be.revertedWithCustomError(v4Router, "NotLaunched");

      // Nothing was taken by a refusal, and the right router still sells both.
      expect(await hookModeToken.balanceOf(dave.address)).to.equal(hookModeHeld);
      expect(await token.balanceOf(dave.address)).to.equal(feeModeHeld);
      await hookModeToken.connect(dave).approve(v4Router.target, hookModeHeld);
      await v4Router.connect(dave).sell(hookModeAddr, hookModeHeld, 0, dave.address, await deadline());
      await token.connect(dave).approve(v4FeeRouter.target, feeModeHeld);
      await v4FeeRouter.connect(dave).sell(tokenAddr, feeModeHeld, 0, dave.address, await deadline());
      for (const router of [v4Router, v4FeeRouter]) {
        expect(await ethers.provider.getBalance(router.target)).to.equal(0);
        expect(await token.balanceOf(router.target)).to.equal(0);
        expect(await hookModeToken.balanceOf(router.target)).to.equal(0);
      }
    });
  });

  // ------------------------------------------------------------------ the gate, through the platform

  describe("the pool's gate, from outside", function () {
    it("nobody opens a token's fee mode pool ahead of its sale", async function () {
      const ctx = await loadFixture(platform);
      const { feeLauncher, feeHook, poolManager, stateView, dave } = ctx;
      const tokenAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const { presale } = await fillSale(ctx, tokenAddr);
      const key = keyArray(await feeLauncher.keyFor(tokenAddr));

      // The key is public before the launch. Opening it at a hostile price would break the sale.
      const data = await revertDataOf(poolManager.connect(dave).initialize.staticCall(key, 2n ** 96n));
      expect(data).to.include(feeHook.interface.getError("NotLauncher").selector.slice(2));

      await presale.connect(ctx.alice).finalize(0, 0);
      const launch = await feeLauncher.launchOf(tokenAddr);
      const slot0 = await stateView.getSlot0(launch.poolId);
      expect((slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * 10n ** 18n) >> 192n).to.be.closeTo(E("800"), E("0.01"));
      await expect(poolManager.connect(dave).initialize(key, 2n ** 96n)).to.be.reverted;
    });

    it("no liquidity gets in beside the launch position, through the PositionManager or around it", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, poolManager, positionManager, stateView, swapper, token, tokenAddr, key, poolId, launch, dave } = ctx;
      await buy(ctx, key, dave, E("2"));
      const liquidity = await stateView.getLiquidity(poolId);
      const [lower, upper] = await swapper.usableTicks(200);
      const tick = (await stateView.getSlot0(poolId)).tick;
      const near = (tick / 200n) * 200n;

      // Through the PositionManager: full range, and a narrow range around the price where a
      // small position would take most of the tax.
      await token.connect(dave).approve(PERMIT2, ethers.MaxUint256);
      const permit2 = new ethers.Contract(PERMIT2, ["function approve(address,address,uint160,uint48)"], dave);
      await permit2.approve(tokenAddr, positionManager.target, 2n ** 160n - 1n, 2n ** 48n - 1n);
      const keyObject = { currency0: key[0], currency1: key[1], fee: key[2], tickSpacing: key[3], hooks: key[4] };
      const mint = async (tickLower, tickUpper, recipient) =>
        positionManager.connect(dave).modifyLiquidities.staticCall(
          mintCalldata({ key: keyObject, tickLower, tickUpper, liquidity: 10n ** 15n, amount0Max: E("1"), amount1Max: E("1000"), recipient }),
          await deadline(),
          { value: E("1") }
        );
      await expectGateClosed(ctx, mint(lower, upper, dave.address));
      await expectGateClosed(ctx, mint(lower, upper, feeHook.target));
      await expectGateClosed(ctx, mint(near - 200n, near + 400n, dave.address));

      // Around it: straight on the PoolManager, even with the launch position's own salt.
      const direct = await ethers.deployContract("V4TestLiquidity", [poolManager.target]);
      await token.connect(dave).approve(direct.target, ethers.MaxUint256);
      const salt = ethers.zeroPadValue(ethers.toBeHex(launch.tokenId), 32);
      for (const [tickLower, tickUpper, s] of [[lower, upper, salt], [lower, upper, ethers.ZeroHash], [near - 200n, near + 400n, salt]]) {
        await expectGateClosed(ctx, direct.connect(dave).addLiquidity.staticCall(key, tickLower, tickUpper, 10n ** 15n, s, { value: E("1") }));
      }
      expect(await stateView.getLiquidity(poolId)).to.equal(liquidity);
      expect(await positionManager.getPositionLiquidity(launch.tokenId)).to.equal(liquidity);

      // The same helper does add liquidity where no hook stands in the way: a second, hookless
      // pool for the same token, which anyone may open and where trades pay no tax.
      const open = [ethers.ZeroAddress, tokenAddr, 3000, 60, ethers.ZeroAddress];
      await poolManager.connect(dave).initialize(open, (await stateView.getSlot0(poolId)).sqrtPriceX96);
      const [openLower, openUpper] = await swapper.usableTicks(60);
      await direct.connect(dave).addLiquidity(open, openLower, openUpper, 10n ** 15n, ethers.ZeroHash, { value: E("1") });
      expect(await stateView.getLiquidity(await swapper.poolId(open))).to.equal(10n ** 15n);
    });

    it("a donation to the pool ends up in the launch position's fees, and so in the tax", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, poolManager, key, poolId, dave } = ctx;
      const direct = await ethers.deployContract("V4TestLiquidity", [poolManager.target]);
      await direct.connect(dave).donate(key, E("0.01"), 0, { value: E("0.01") });
      const { ethFees } = await feeHook.collect.staticCall(poolId);
      expect(ethFees).to.be.closeTo(E("0.01"), 2n);
    });

    it("a sandwich around one conversion costs the attacker money", async function () {
      const ctx = await loadFixture(launchedTax);
      const { feeHook, poolManager, swapper, token, key, poolId, dave } = ctx;
      // A backlog of token tax larger than one conversion may sell.
      await buy(ctx, key, dave, E("5"));
      await token.connect(dave).approve(swapper.target, ethers.MaxUint256);
      await swapper.connect(dave).swapExactIn(key, false, E("1400"), 0, dave.address);
      await feeHook.collect(poolId);
      expect(await feeHook.pendingTokens(poolId)).to.be.greaterThan(await feeHook.maxConvert(poolId));

      const attacker = await ethers.deployContract("V4FeeSandwich", [poolManager.target, feeHook.target]);
      await dave.sendTransaction({ to: attacker.target, value: E("5") });
      await token.connect(dave).transfer(attacker.target, E("500"));
      // V4FeeSandwich.Kind; ALL closes the position the earlier steps opened.
      const KIND = { SellExactIn: 0, BuyExactIn: 1, SellExactOut: 2, BuyExactOut: 3, Convert: 4 };
      const steps = [
        { kind: KIND.SellExactIn, amount: E("500") },
        { kind: KIND.Convert, amount: 0 },
        { kind: KIND.BuyExactOut, amount: await attacker.ALL() },
      ];
      const result = await attacker.run.staticCall(key, steps);
      expect(result.tokensConverted).to.be.greaterThan(0);
      expect(result.ethConverted).to.be.greaterThan(0);
      expect(result.tokenDelta).to.equal(0);
      expect(result.ethDelta).to.be.lessThan(0);
      await expect(attacker.run(key, steps))
        .to.emit(attacker, "Ran")
        .withArgs(result.ethDelta, 0, result.tokensConverted, result.ethConverted);
    });
  });

  // ------------------------------------------------------------------ the other modes

  describe("the other launch paths, after setDeployers", function () {
    it("still launches a hook mode token through V4Launcher, taxed by its hook and locked by the locker", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, hook, feeLauncher, feeHook, v4Router, positionLocker, positionManager, stateView, swapper, alice, marketing, dave } = ctx;
      await launcher
        .connect(alice)
        .createToken(Tax, specFor(ctx, Tax), taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 }), alice.address);
      const [tokenAddr] = await launcher.tokensOfCreator(alice.address);
      const token = await ethers.getContractAt("HoodSaleTokenV4", tokenAddr);
      expect(await token.launcher()).to.equal(launcher.target);
      expect(await feeLauncher.isV4Token(tokenAddr)).to.equal(false);

      const { presale } = await launchThrough(ctx, tokenAddr, { liquidityAction: Lock });
      expect(await presale.v4Launcher()).to.equal(launcher.target);
      const launch = await launcher.launchOf(tokenAddr);
      expect(launch.burned).to.equal(false);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(positionLocker.target);
      expect((await positionLocker.locks(launch.lockId)).owner).to.equal(alice.address);
      expect(await presale.lpLockId()).to.equal(launch.lockId);

      const key = keyArray(await launcher.poolKeyOf(tokenAddr));
      expect(key[4]).to.equal(hook.target);
      expect((await stateView.getSlot0(launch.poolId)).lpFee).to.equal(await hook.LP_FEE());
      const spend = E("0.5");
      await swapper.connect(dave).swapExactIn(key, true, spend, 0, dave.address, { value: spend });
      expect(await ethers.provider.getBalance(hook.target)).to.equal((spend * 325n) / 10_000n);
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(0);
      await v4Router.connect(dave).buy(tokenAddr, 0, dave.address, await deadline(), { value: spend });
    });

    it("makes the same v4 token code whichever generation and whichever launcher asked", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, launcher, hook, feeLauncher, feeHook, feeDeployers, v4Deployers, alice, marketing } = ctx;
      const word = (contract) => contract.target.slice(2).toLowerCase();
      const codeOf = async (address) => (await ethers.provider.getCode(address)).toLowerCase();
      const hookModeToken = async (tokenType, cfg) => {
        await launcher.connect(alice).createToken(tokenType, specFor(ctx, tokenType), taxConfig(marketing.address, cfg), alice.address);
        const created = await launcher.tokensOfCreator(alice.address);
        return created[created.length - 1];
      };

      for (const [tokenType, hookCfg, feeRates] of [
        [Tax, { marketingBuyBps: 300, marketingSellBps: 300 }, { marketingBps: 300 }],
        [Rewards, { rewardsBuyBps: 200, rewardsSellBps: 200 }, { rewardsBps: 200 }],
      ]) {
        await tokenFactory.setDeployers(v4Deployers.standardDeployer.target, v4Deployers.taxDeployer.target, v4Deployers.rewardsDeployer.target);
        const before = await codeOf(await hookModeToken(tokenType, hookCfg));
        await tokenFactory.setDeployers(feeDeployers.standardDeployer.target, feeDeployers.taxDeployer.target, feeDeployers.rewardsDeployer.target);
        const after = await codeOf(await hookModeToken(tokenType, hookCfg));
        // Byte for byte what the V4 generation deployed for hook mode.
        expect(after).to.equal(before);

        // A fee mode token is that code with the other launcher, and its hook, as immutables.
        const fee = await codeOf(await createToken(ctx, tokenType, feeRates));
        expect(fee).to.not.equal(after);
        expect(fee.replaceAll(word(feeLauncher), word(launcher)).replaceAll(word(feeHook), word(hook))).to.equal(after);
      }
    });

    it("still gives a hook mode Rewards token the tax hook as its funder", async function () {
      const ctx = await loadFixture(platform);
      const { launcher, hook, alice, marketing } = ctx;
      await launcher
        .connect(alice)
        .createToken(Rewards, specFor(ctx, Rewards), taxConfig(marketing.address, { rewardsBuyBps: 200, rewardsSellBps: 300 }), alice.address);
      const [tokenAddr] = await launcher.tokensOfCreator(alice.address);
      const token = await ethers.getContractAt("RewardsTokenV4", tokenAddr);
      expect(await token.launcher()).to.equal(launcher.target);
      expect(await token.hook()).to.equal(hook.target);
    });

    it("still creates the three V2 tokens for a wallet and lists a V2 sale on the V2 router", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, lens, locker, weth, alice, marketing } = ctx;
      await tokenFactory.connect(alice).createStandardToken("Old", "OLD", E("1000000"));
      await tokenFactory.connect(alice).createTaxToken("Old Tax", "OTAX", E("1000000"), marketing.address, 300, 500);
      await tokenFactory.connect(alice).createRewardsToken("Old Yield", "OYLD", E("1000000"), weth.target, marketing.address, [200, 300, 100, 100]);
      const created = await tokenFactory.tokensOfCreator(alice.address);
      expect(created.length).to.equal(3);
      for (const addr of created) {
        // A V2 token opens its own pair, taxes transfers, and answers neither v4 call.
        const v2 = await ethers.getContractAt("StandardToken", addr);
        expect(await v2.mainPair()).to.not.equal(ethers.ZeroAddress);
        expect(await v2.platformTaxBps()).to.equal(25);
        const asV4 = await ethers.getContractAt("HoodSaleTokenV4", addr);
        await expect(asV4.poolVersion()).to.be.reverted;
        await expect(asV4.launcher()).to.be.reverted;
        expect(await lens.poolKind(addr)).to.equal(0);
      }

      const { presale } = await launchThrough(ctx, created[0], { liquidityAction: Lock });
      expect(await presale.isV4Launch()).to.equal(false);
      expect(await presale.v4TermsHash()).to.equal(ethers.ZeroHash);
      expect(await presale.lpAmount()).to.be.greaterThan(0);
      const pair = await (await ethers.getContractAt("StandardToken", created[0])).mainPair();
      const lock = await locker.locks(await presale.lpLockId());
      expect(lock.token).to.equal(pair);
      expect(lock.owner).to.equal(alice.address);
      const v = await lens.launchView(presale.target);
      expect(v.poolKind).to.equal(0);
      expect(v.priceAvailable).to.equal(true);
    });
  });

  // The plan's rollback is one call: TokenFactory.setDeployers with the V4 generation. It stops new
  // fee mode tokens and must stop nothing else, least of all a sale that buyers are already in.
  describe("after the deployers are rolled back", function () {
    it("a sale opened before the rollback lists after it, and a token made before it can still open a sale and list", async function () {
      const ctx = await loadFixture(platform);
      const { tokenFactory, feeLauncher, feeHook, v4FeeRouter, v4Deployers, positionManager, stateView, alice, bob, marketing, dave } = ctx;

      // Before the rollback: a Tax token whose sale is filled and waiting, and a Rewards token with no sale yet.
      const taxAddr = await createToken(ctx, Tax, { marketingBps: 300 });
      const rewardsAddr = await createToken(ctx, Rewards, { marketingBps: 100, rewardsBps: 200 });
      const { presale: openSale } = await fillSale(ctx, taxAddr);

      await tokenFactory.setDeployers(
        v4Deployers.standardDeployer.target,
        v4Deployers.taxDeployer.target,
        v4Deployers.rewardsDeployer.target
      );
      await expect(
        feeLauncher.connect(alice).createToken(Tax, specFor(ctx, Tax), feeTaxConfig(marketing.address, { marketingBps: 300 }), alice.address)
      ).to.be.revertedWithCustomError(feeLauncher, "NotFeeToken");

      // The open sale still holds its terms and lists in fee mode, the position with the hook.
      expect(await openSale.v4TermsHold()).to.equal(true);
      await expect(openSale.connect(alice).finalize(0, 0)).to.emit(feeLauncher, "Launched");
      const taxLaunch = await feeLauncher.launchOf(taxAddr);
      expect(taxLaunch.done).to.equal(true);
      expect(await openSale.v4PoolId()).to.equal(taxLaunch.poolId);
      expect(await positionManager.ownerOf(taxLaunch.tokenId)).to.equal(feeHook.target);
      expect((await stateView.getSlot0(taxLaunch.poolId)).lpFee).to.equal(32500);
      await expect(openSale.connect(bob).claim()).to.changeTokenBalance(
        await ethers.getContractAt("HoodSaleTokenV4", taxAddr),
        bob,
        E("5000")
      );

      // The token made before the rollback opens its sale after it, and that sale lists too.
      const start = BigInt(await time.latest()) + 100n;
      const { presale: lateSale } = await fillSale(ctx, rewardsAddr, { startTime: start, endTime: start + DAY });
      expect(await lateSale.v4Launcher()).to.equal(feeLauncher.target);
      await expect(lateSale.connect(alice).finalize(0, 0)).to.emit(feeLauncher, "Launched");
      const rewardsLaunch = await feeLauncher.launchOf(rewardsAddr);
      expect(await positionManager.ownerOf(rewardsLaunch.tokenId)).to.equal(feeHook.target);
      expect((await stateView.getSlot0(rewardsLaunch.poolId)).lpFee).to.equal(32500);

      // Both pools trade, charge their tax and pay it out, as if nothing had been rolled back.
      const spend = E("1");
      for (const [tokenAddr, launch] of [[taxAddr, taxLaunch], [rewardsAddr, rewardsLaunch]]) {
        await v4FeeRouter.connect(dave).buy(tokenAddr, 0, dave.address, await deadline(), { value: spend });
        const fees = await feeHook.collect.staticCall(launch.poolId);
        expect(fees.ethFees, tokenAddr).to.be.closeTo((spend * 325n) / 10_000n, 2n);
        await feeHook.collect(launch.poolId);
      }
      const taxShare = await feeHook.pendingMarketing(taxLaunch.poolId);
      expect(taxShare).to.be.closeTo((spend * 300n) / 10_000n, 2n);
      await expect(feeHook.flush(taxLaunch.poolId)).to.changeEtherBalance(marketing, taxShare);
      const holdersShare = await feeHook.pendingRewards(rewardsLaunch.poolId);
      expect(holdersShare).to.be.closeTo((spend * 200n) / 10_000n, 2n);
      await expect(feeHook.flush(rewardsLaunch.poolId)).to.changeEtherBalance(rewardsAddr, holdersShare);
    });
  });

  describe("size", function () {
    it("every new contract fits the 24,576 byte limit", async function () {
      const hre = require("hardhat");
      for (const name of ["V4FeeLauncher", "HoodSaleV4FeeHook", "StandardTokenDeployerFee", "TaxTokenDeployerFee", "RewardsTokenDeployerFee"]) {
        const artifact = await hre.artifacts.readArtifact(name);
        const size = (artifact.deployedBytecode.length - 2) / 2;
        expect(size, name).to.be.lessThan(24576);
      }
    });
  });
});
