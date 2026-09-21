const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  deployV4Core,
  poolKeyFor,
  sqrtPriceX96For,
  mintCalldata,
  isHooksPoolRoutable,
  deployFeeHook: deployFeeHookAt,
  PERMIT2,
  ALL_HOOK_MASK,
} = require("../v4/helpers");

const PLATFORM_BPS = 25n;
const FAR = 2n ** 40n;

describe("HoodSaleV4FeeHook", function () {
  // 2% to marketing and 1% to holders: with the platform's 0.25% the pool's fee is 3.25%.
  const M = 200n;
  const R = 100n;
  const TOTAL = PLATFORM_BPS + M + R;
  const TOKEN_LIQUIDITY = ethers.parseEther("500000");
  const ETH_LIQUIDITY = ethers.parseEther("10");

  /** The shared helper, which mines the way the deploy script does, with this suite's arguments. */
  async function deployFeeHook(signer, v4, launcher, treasury) {
    const { hook } = await deployFeeHookAt(signer, v4.poolManager.target, v4.positionManager.target, launcher, treasury);
    return hook;
  }

  function configFor(token, wallet, sink, { m = M, r = R, taxLocked = true, walletLocked = false } = {}) {
    return [token, wallet, sink, m, m, r, r, taxLocked, walletLocked, false];
  }

  /** `seats` puts contracts of a test's own choosing where the Treasury and the rewards sink are. */
  async function build(seats = {}) {
    const [deployer, alice, mallory, creator, marketing, launcher] = await ethers.getSigners();
    const v4 = await deployV4Core(deployer);
    const treasury = seats.treasury ?? (await ethers.deployContract("Treasury", [deployer.address]));
    const sink = seats.sink ?? (await ethers.deployContract("RewardsSinkMock"));
    const hook = await deployFeeHook(deployer, v4, launcher.address, treasury.target);
    const token = await ethers.deployContract("MockOwnedERC20", ["Fee", "FEE", ethers.parseEther("1000000"), creator.address]);
    const key = poolKeyFor(token.target, { fee: Number(TOTAL) * 100, tickSpacing: 200, hooks: hook.target });
    const keyArr = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
    const poolId = await v4.swapper.poolId(keyArr);
    const sqrtP = sqrtPriceX96For(TOKEN_LIQUIDITY, ETH_LIQUIDITY);
    const [lower, upper] = await v4.swapper.usableTicks(200);
    const liquidity = await v4.swapper.liquidityForAmounts(
      sqrtP,
      await v4.swapper.sqrtPriceAtTick(lower),
      await v4.swapper.sqrtPriceAtTick(upper),
      ETH_LIQUIDITY,
      TOKEN_LIQUIDITY
    );
    const permit2 = new ethers.Contract(PERMIT2, ["function approve(address,address,uint160,uint48)"], deployer);

    // The launcher holds the launch tokens; mallory holds some to try to add liquidity with.
    await token.connect(creator).transfer(launcher.address, TOKEN_LIQUIDITY);
    await token.connect(creator).transfer(mallory.address, ethers.parseEther("50000"));
    await token.connect(creator).transfer(alice.address, ethers.parseEther("50000"));
    for (const who of [launcher, mallory]) {
      await token.connect(who).approve(PERMIT2, ethers.MaxUint256);
      await permit2.connect(who).approve(token.target, v4.positionManager.target, 2n ** 160n - 1n, 2n ** 48n - 1n);
    }
    await token.connect(alice).approve(v4.swapper.target, ethers.MaxUint256);

    return { deployer, alice, mallory, creator, marketing, launcher, v4, treasury, sink, hook, token, key, keyArr, poolId, sqrtP, lower, upper, liquidity };
  }

  async function base() {
    return build();
  }

  /** What the launcher does in one call: declares the pool, opens it and mints the launch position to the hook. */
  async function launch(f, marketingWallet) {
    const { v4, hook, token, launcher, sink, key, keyArr, sqrtP, lower, upper, liquidity } = f;
    const tokenId = await v4.positionManager.nextTokenId();
    await hook.connect(launcher).register(keyArr, configFor(token.target, marketingWallet, sink.target), tokenId);
    await v4.poolManager.connect(launcher).initialize(keyArr, sqrtP);
    const mint = mintCalldata({ key, tickLower: lower, tickUpper: upper, liquidity, amount0Max: ETH_LIQUIDITY, amount1Max: TOKEN_LIQUIDITY, recipient: hook.target });
    await v4.positionManager.connect(launcher).modifyLiquidities(mint, FAR, { value: ETH_LIQUIDITY });
    return { ...f, tokenId };
  }

  async function launched() {
    const f = await base();
    return launch(f, f.marketing.address);
  }

  const buy = (f, eth) => f.v4.swapper.connect(f.alice).swapExactIn(f.keyArr, true, eth, 0, f.alice.address, { value: eth });
  const sell = (f, tokens) => f.v4.swapper.connect(f.alice).swapExactIn(f.keyArr, false, tokens, 0, f.alice.address);

  /** What the hook owes in all: the two shares of the pool and the platform's. */
  const ledgersOf = async (f) =>
    (await f.hook.pendingMarketing(f.poolId)) + (await f.hook.pendingRewards(f.poolId)) + (await f.hook.pendingPlatform());
  const balanceOf = (f) => ethers.provider.getBalance(f.hook.target);

  describe("address and routing", function () {
    it("sits at an address that declares the two gate permissions and nothing else", async function () {
      const { hook } = await loadFixture(base);
      expect(BigInt(hook.target) & BigInt(ALL_HOOK_MASK)).to.equal(0x2800n);
      const p = await hook.getHookPermissions();
      expect(p.beforeInitialize).to.equal(true);
      expect(p.beforeAddLiquidity).to.equal(true);
      expect([...p].filter(Boolean).length).to.equal(2);
    });

    it("passes Uniswap's routing rule without an allowlist entry, where the tax hook does not", async function () {
      const { hook } = await loadFixture(base);
      expect(isHooksPoolRoutable(hook.target, Number(TOTAL) * 100)).to.equal(true);
      expect(isHooksPoolRoutable(hook.target, 100000)).to.equal(true); // our own 10% tax cap, under Uniswap's 11%
      expect(isHooksPoolRoutable("0xd996Bb10EE4C780bD619bC9f3Fb22d62c4bDa0cc", 500)).to.equal(false);
    });

    it("has no owner and refuses ETH from anyone but the PoolManager", async function () {
      const { hook, alice } = await loadFixture(base);
      expect(hook.interface.fragments.some((x) => ["owner", "transferOwnership", "setTaxes", "lockTaxes"].includes(x.name))).to.equal(false);
      await expect(alice.sendTransaction({ to: hook.target, value: 1n })).to.be.revertedWithCustomError(hook, "NotPoolManager");
    });
  });

  describe("register", function () {
    it("only the launcher registers, once", async function () {
      const { hook, token, marketing, sink, keyArr, mallory, launcher } = await loadFixture(base);
      const cfg = configFor(token.target, marketing.address, sink.target);
      await expect(hook.connect(mallory).register(keyArr, cfg, 1)).to.be.revertedWithCustomError(hook, "NotLauncher");
      await expect(hook.connect(launcher).register(keyArr, cfg, 1)).to.emit(hook, "PoolRegistered");
      await expect(hook.connect(launcher).register(keyArr, cfg, 1)).to.be.revertedWithCustomError(hook, "AlreadyRegistered");
    });

    it("a token has one pool: the same token at another rate is refused", async function () {
      const { hook, token, marketing, sink, key, keyArr, launcher } = await loadFixture(base);
      await hook.connect(launcher).register(keyArr, configFor(token.target, marketing.address, sink.target), 1);
      const other = [key.currency0, key.currency1, 22500, key.tickSpacing, key.hooks];
      await expect(
        hook.connect(launcher).register(other, configFor(token.target, marketing.address, sink.target, { m: 100n }), 2)
      ).to.be.revertedWithCustomError(hook, "AlreadyRegistered");
      expect(await hook.poolIdOf(token.target)).to.equal(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], keyArr)));
    });

    it("the pool's fee must be exactly the tax, the same on buys and sells, and fixed", async function () {
      const { hook, token, marketing, sink, key, keyArr, launcher } = await loadFixture(base);
      const as = (h) => hook.connect(launcher).register(...h);
      const cfg = configFor(token.target, marketing.address, sink.target);
      const withKey = (patch) => { const k = { ...key, ...patch }; return [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]; };

      await expect(as([withKey({ fee: 32400 }), cfg, 1])).to.be.revertedWithCustomError(hook, "BadKey");
      await expect(as([withKey({ tickSpacing: 60 }), cfg, 1])).to.be.revertedWithCustomError(hook, "BadKey");
      await expect(as([withKey({ hooks: ethers.ZeroAddress }), cfg, 1])).to.be.revertedWithCustomError(hook, "BadKey");
      await expect(as([withKey({ currency1: marketing.address }), cfg, 1])).to.be.revertedWithCustomError(hook, "BadKey");
      await expect(as([keyArr, cfg, 0])).to.be.revertedWithCustomError(hook, "BadKey");

      const uneven = [token.target, marketing.address, sink.target, 200, 300, 100, 100, true, false, false];
      await expect(as([keyArr, uneven, 1])).to.be.revertedWithCustomError(hook, "UnequalRates");
      await expect(as([keyArr, configFor(token.target, marketing.address, sink.target, { taxLocked: false }), 1])).to.be.revertedWithCustomError(hook, "TaxNotFixed");
      await expect(as([withKey({ fee: 100100 }), configFor(token.target, marketing.address, sink.target, { m: 876n }), 1])).to.be.revertedWithCustomError(hook, "TaxTooHigh");
      await expect(as([keyArr, configFor(token.target, ethers.ZeroAddress, sink.target), 1])).to.be.revertedWithCustomError(hook, "ZeroWallet");
      await expect(as([keyArr, configFor(token.target, marketing.address, ethers.ZeroAddress), 1])).to.be.revertedWithCustomError(hook, "NoRewardsSink");

      // 9.75% of tax and the platform's 0.25% is the cap, a 10% pool fee
      await as([withKey({ fee: 100000 }), configFor(token.target, marketing.address, sink.target, { m: 875n }), 1]);
    });
  });

  describe("the gate", function () {
    it("nobody but the launcher opens a pool with this hook", async function () {
      const { hook, v4, token, marketing, sink, keyArr, sqrtP, mallory, launcher } = await loadFixture(base);
      await expect(v4.poolManager.connect(mallory).initialize(keyArr, sqrtP)).to.be.reverted;
      await expect(v4.poolManager.connect(launcher).initialize(keyArr, sqrtP)).to.be.reverted; // not registered yet
      await hook.connect(launcher).register(keyArr, configFor(token.target, marketing.address, sink.target), 1);
      await expect(v4.poolManager.connect(mallory).initialize(keyArr, sqrtP)).to.be.reverted;
      await v4.poolManager.connect(launcher).initialize(keyArr, sqrtP);
    });

    it("lets the launch position in once and holds it", async function () {
      const f = await loadFixture(launched);
      expect(await f.hook.seeded(f.poolId)).to.equal(true);
      expect(await f.hook.positionIdOf(f.poolId)).to.equal(f.tokenId);
      expect(await f.v4.positionManager.ownerOf(f.tokenId)).to.equal(f.hook.target);
      expect(await f.v4.positionManager.getPositionLiquidity(f.tokenId)).to.equal(f.liquidity);
    });

    it("refuses every later add: full range, narrow range, to any owner, and an increase", async function () {
      const f = await loadFixture(launched);
      const { v4, key, lower, upper, mallory, hook } = f;
      const add = (tickLower, tickUpper, recipient) =>
        v4.positionManager.connect(mallory).modifyLiquidities(
          mintCalldata({ key, tickLower, tickUpper, liquidity: 10n ** 15n, amount0Max: ethers.parseEther("1"), amount1Max: ethers.parseEther("50000"), recipient }),
          FAR,
          { value: ethers.parseEther("1") }
        );
      await expect(add(lower, upper, mallory.address)).to.be.reverted;
      await expect(add(lower, upper, hook.target)).to.be.reverted;
      await expect(add(108000, 108200, mallory.address)).to.be.reverted;
      await expect(add(-200, 200, mallory.address)).to.be.reverted;

      // INCREASE_LIQUIDITY (0x00) on the hook's own position
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const actions = ethers.solidityPacked(["uint8", "uint8"], [0x00, 0x0d]);
      const params = [
        coder.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [f.tokenId, 10n ** 15n, ethers.parseEther("1"), ethers.parseEther("50000"), "0x"]),
        coder.encode(["address", "address"], [key.currency0, key.currency1]),
      ];
      await expect(
        v4.positionManager.connect(mallory).modifyLiquidities(coder.encode(["bytes", "bytes[]"], [actions, params]), FAR, { value: ethers.parseEther("1") })
      ).to.be.reverted;
      expect(await v4.positionManager.getPositionLiquidity(f.tokenId)).to.equal(f.liquidity);
    });

    it("before the launch mint only the registered position fits, which is why the launcher mints in the same call", async function () {
      const f = await loadFixture(base);
      const { hook, v4, token, marketing, sink, key, keyArr, sqrtP, lower, upper, mallory, launcher } = f;
      const tokenId = await v4.positionManager.nextTokenId();
      await hook.connect(launcher).register(keyArr, configFor(token.target, marketing.address, sink.target), tokenId);
      await v4.poolManager.connect(launcher).initialize(keyArr, sqrtP);
      const narrow = mintCalldata({ key, tickLower: 108000, tickUpper: 108200, liquidity: 10n ** 15n, amount0Max: ethers.parseEther("1"), amount1Max: ethers.parseEther("50000"), recipient: mallory.address });
      await expect(v4.positionManager.connect(mallory).modifyLiquidities(narrow, FAR, { value: ethers.parseEther("1") })).to.be.reverted;
    });

    it("opens a pool in one call through a launcher contract", async function () {
      const [deployer, , , , marketing] = await ethers.getSigners();
      const v4 = await deployV4Core(deployer);
      const launcher = await ethers.deployContract("FeeHookProofLauncher", [v4.poolManager.target, v4.positionManager.target, PERMIT2]);
      const hook = await deployFeeHook(deployer, v4, launcher.target, deployer.address);
      await launcher.setHook(hook.target);
      const token = await ethers.deployContract("MockERC20", ["Fee", "FEE", 18, ethers.parseEther("1000000")]);
      await token.approve(launcher.target, TOKEN_LIQUIDITY);
      const tokenId = await v4.positionManager.nextTokenId();
      await expect(launcher.launch(token.target, TOKEN_LIQUIDITY, marketing.address, M, R, { value: ETH_LIQUIDITY })).to.emit(hook, "LiquiditySeeded");
      const poolId = await hook.poolIdOf(token.target);
      expect(await v4.positionManager.ownerOf(tokenId)).to.equal(hook.target);
      expect(await hook.seeded(poolId)).to.equal(true);
      expect(await hook.feeBps(poolId, true)).to.equal(TOTAL);
      expect(await ethers.provider.getBalance(launcher.target)).to.equal(0n);
      expect(await token.balanceOf(launcher.target)).to.equal(0n);
      const slot0 = await v4.stateView.getSlot0(poolId);
      expect(slot0.lpFee).to.equal(TOTAL * 100n);
    });
  });

  describe("collect", function () {
    it("anyone collects; a buy leaves ETH and a sell leaves tokens, the exact pool fee", async function () {
      const f = await loadFixture(launched);
      await buy(f, ethers.parseEther("1"));
      await sell(f, ethers.parseEther("20000"));

      const preview = await f.hook.collect.staticCall(f.poolId);
      expect(preview.ethFees).to.be.closeTo((ethers.parseEther("1") * TOTAL) / 10000n, 2n);
      expect(preview.tokenFees).to.be.closeTo((ethers.parseEther("20000") * TOTAL) / 10000n, 2n);

      await expect(f.hook.connect(f.mallory).collect(f.poolId)).to.emit(f.hook, "FeesCollected").withArgs(f.poolId, preview.ethFees, preview.tokenFees);
      expect(await f.hook.pendingTokens(f.poolId)).to.equal(preview.tokenFees);
      expect(await f.v4.positionManager.getPositionLiquidity(f.tokenId)).to.equal(f.liquidity);
      expect(await f.v4.positionManager.ownerOf(f.tokenId)).to.equal(f.hook.target);
    });

    it("books ETH in the ratio of the rates, dust to the platform, nothing unaccounted", async function () {
      const f = await loadFixture(launched);
      await buy(f, ethers.parseEther("1.2345"));
      const { ethFees } = await f.hook.collect.staticCall(f.poolId);
      await f.hook.collect(f.poolId);
      const pm = await f.hook.pendingMarketing(f.poolId);
      const pr = await f.hook.pendingRewards(f.poolId);
      const pp = await f.hook.pendingPlatform();
      expect(pm).to.equal((ethFees * M) / TOTAL);
      expect(pr).to.equal((ethFees * R) / TOTAL);
      expect(pm + pr + pp).to.equal(ethFees);
      expect(await ethers.provider.getBalance(f.hook.target)).to.equal(ethFees);
    });

    it("a Standard launch's 0.25% is all platform share", async function () {
      const f = await loadFixture(base);
      const { hook, v4, token, marketing, launcher, lower, upper, liquidity, sqrtP } = f;
      const key = poolKeyFor(token.target, { fee: 2500, tickSpacing: 200, hooks: hook.target });
      const keyArr = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
      const tokenId = await v4.positionManager.nextTokenId();
      await hook.connect(launcher).register(keyArr, configFor(token.target, marketing.address, ethers.ZeroAddress, { m: 0n, r: 0n }), tokenId);
      await v4.poolManager.connect(launcher).initialize(keyArr, sqrtP);
      await v4.positionManager.connect(launcher).modifyLiquidities(
        mintCalldata({ key, tickLower: lower, tickUpper: upper, liquidity, amount0Max: ETH_LIQUIDITY, amount1Max: TOKEN_LIQUIDITY, recipient: hook.target }),
        FAR,
        { value: ETH_LIQUIDITY }
      );
      const poolId = await v4.swapper.poolId(keyArr);
      await v4.swapper.connect(f.alice).swapExactIn(keyArr, true, ethers.parseEther("1"), 0, f.alice.address, { value: ethers.parseEther("1") });
      await hook.collect(poolId);
      expect(await hook.pendingMarketing(poolId)).to.equal(0n);
      expect(await hook.pendingPlatform()).to.be.closeTo(ethers.parseEther("0.0025"), 2n);
      expect(await hook.maxConvert(poolId)).to.be.closeTo((TOKEN_LIQUIDITY * 12n) / 10000n, TOKEN_LIQUIDITY / 1000n);
    });

    it("reverts for a pool that has no position yet", async function () {
      const f = await loadFixture(base);
      await expect(f.hook.collect(f.poolId)).to.be.revertedWithCustomError(f.hook, "NotSeeded");
    });
  });

  describe("convert", function () {
    it("sells the collected tokens for ETH in the same pool and books the proceeds", async function () {
      const f = await loadFixture(launched);
      await sell(f, ethers.parseEther("20000"));
      const tokenFees = (await f.hook.collect.staticCall(f.poolId)).tokenFees;
      const preview = await f.hook.connect(f.mallory).convert.staticCall(f.poolId, 1, 0, FAR);
      expect(preview.tokensSold).to.equal(tokenFees);

      await expect(f.hook.connect(f.mallory).convert(f.poolId, preview.tokensSold, preview.ethOut, FAR)).to.emit(f.hook, "Converted").withArgs(f.poolId, f.mallory.address, tokenFees, preview.ethOut);
      expect(await f.hook.pendingTokens(f.poolId)).to.equal(0n);
      expect(await f.token.balanceOf(f.hook.target)).to.equal(0n);
      const booked = (await f.hook.pendingMarketing(f.poolId)) + (await f.hook.pendingRewards(f.poolId)) + (await f.hook.pendingPlatform());
      expect(booked).to.equal(preview.ethOut);
      expect(await ethers.provider.getBalance(f.hook.target)).to.equal(preview.ethOut);

      // the conversion paid the pool's fee too, and that comes back to the same position
      const again = await f.hook.collect.staticCall(f.poolId);
      expect(again.tokenFees).to.be.closeTo((tokenFees * TOTAL) / 10000n, 2n);
      expect(await f.v4.positionManager.getPositionLiquidity(f.tokenId)).to.equal(f.liquidity);
    });

    it("sells at most 1% of the pool's token reserve per call, once per five minutes", async function () {
      const f = await loadFixture(launched);
      // a sale this large leaves more fee tokens than one conversion may sell
      await f.token.connect(f.creator).transfer(f.alice.address, ethers.parseEther("400000"));
      await sell(f, ethers.parseEther("400000"));
      await f.hook.collect(f.poolId);
      const pending = await f.hook.pendingTokens(f.poolId);
      const cap = await f.hook.maxConvert(f.poolId);
      expect(pending).to.be.gt(cap);

      const reserve = await f.token.balanceOf(f.v4.poolManager.target);
      expect(cap).to.be.closeTo(reserve / 100n, reserve / 5000n);

      await f.hook.convert(f.poolId, 1, 0, FAR);
      expect(await f.hook.pendingTokens(f.poolId)).to.equal(pending - cap);
      await expect(f.hook.convert(f.poolId, 1, 0, FAR)).to.be.revertedWithCustomError(f.hook, "CoolingDown");
      await time.increase(300);
      await f.hook.convert(f.poolId, 1, 0, FAR);
      expect(await f.hook.pendingTokens(f.poolId)).to.be.lt(pending - cap);
    });

    it("honours the caller's floor and deadline, and needs something to sell", async function () {
      const f = await loadFixture(launched);
      await expect(f.hook.convert(f.poolId, 1, 0, FAR)).to.be.revertedWithCustomError(f.hook, "NothingToConvert");
      await sell(f, ethers.parseEther("20000"));
      const { tokensSold, ethOut } = await f.hook.convert.staticCall(f.poolId, 1, 0, FAR);
      await expect(f.hook.convert(f.poolId, tokensSold, ethOut + 1n, FAR)).to.be.revertedWithCustomError(f.hook, "TooLittleReceived");
      await expect(f.hook.convert(f.poolId, 1, 0, 1)).to.be.revertedWithCustomError(f.hook, "Expired");
      // a failed conversion does not start the cooldown
      await f.hook.convert(f.poolId, tokensSold, ethOut, FAR);
    });

    it("the floor is a price: a quote for a small size does not pass a larger sale at a worse price", async function () {
      const f = await loadFixture(launched);
      await sell(f, ethers.parseEther("20000"));
      const quote = await f.hook.convert.staticCall(f.poolId, 1, 0, FAR);
      const floor = (quote.ethOut * 99n) / 100n;

      // a large sell lands before the conversion: more fee tokens to sell, at a much lower price
      await f.token.connect(f.creator).transfer(f.alice.address, ethers.parseEther("200000"));
      await sell(f, ethers.parseEther("200000"));
      const now = await f.hook.convert.staticCall(f.poolId, 1, 0, FAR);
      expect(now.tokensSold).to.be.gt(quote.tokensSold);
      expect(now.ethOut).to.be.gt(floor); // an absolute floor would have let it through
      await expect(f.hook.convert(f.poolId, quote.tokensSold, floor, FAR)).to.be.revertedWithCustomError(f.hook, "TooLittleReceived");

      // quoted again at the new price it goes through, and a zero size never does
      await expect(f.hook.convert(f.poolId, 0, 0, FAR)).to.be.revertedWithPanic(0x12);
      await f.hook.convert(f.poolId, now.tokensSold, (now.ethOut * 99n) / 100n, FAR);
    });

    it("the unlock callback answers only the PoolManager", async function () {
      const f = await loadFixture(launched);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [f.poolId, 1n]);
      await expect(f.hook.connect(f.mallory).unlockCallback(data)).to.be.revertedWithCustomError(f.hook, "NotPoolManager");
    });

    it("tokens sent to the hook by hand are never sold", async function () {
      const f = await loadFixture(launched);
      await f.token.connect(f.alice).transfer(f.hook.target, ethers.parseEther("1000"));
      await expect(f.hook.convert(f.poolId, 1, 0, FAR)).to.be.revertedWithCustomError(f.hook, "NothingToConvert");
    });
  });

  describe("paying out", function () {
    it("flush sends the marketing and rewards shares, flushPlatform the platform's", async function () {
      const f = await loadFixture(launched);
      await buy(f, ethers.parseEther("2"));
      await f.hook.collect(f.poolId);
      const pm = await f.hook.pendingMarketing(f.poolId);
      const pr = await f.hook.pendingRewards(f.poolId);
      const pp = await f.hook.pendingPlatform();

      await expect(f.hook.connect(f.mallory).flush(f.poolId)).to.changeEtherBalances([f.marketing, f.sink], [pm, pr]);
      await expect(f.hook.connect(f.mallory).flushPlatform()).to.changeEtherBalance(f.treasury, pp);
      expect(await ethers.provider.getBalance(f.hook.target)).to.equal(0n);
    });

    it("a wallet that refuses ETH only leaves its own share pending", async function () {
      const f = await loadFixture(launched);
      const rejecting = await ethers.deployContract("RejectingWallet");
      await f.hook.connect(f.creator).setMarketingWallet(f.poolId, rejecting.target);
      await buy(f, ethers.parseEther("2"));
      await f.hook.collect(f.poolId);
      const pm = await f.hook.pendingMarketing(f.poolId);
      const pr = await f.hook.pendingRewards(f.poolId);
      await expect(f.hook.flush(f.poolId)).to.changeEtherBalance(f.sink, pr);
      expect(await f.hook.pendingMarketing(f.poolId)).to.equal(pm);
      expect(await f.hook.pendingRewards(f.poolId)).to.equal(0n);
    });

    it("a wallet that burns all the gas it is given only leaves its own share pending, at a bounded cost to the caller", async function () {
      const f = await loadFixture(launched);
      const burning = await ethers.deployContract("GasBurningWallet");
      await f.hook.connect(f.creator).setMarketingWallet(f.poolId, burning.target);
      await buy(f, ethers.parseEther("2"));
      await f.hook.collect(f.poolId);
      const pm = await f.hook.pendingMarketing(f.poolId);
      const pr = await f.hook.pendingRewards(f.poolId);
      const pp = await f.hook.pendingPlatform();
      expect(pm).to.be.greaterThan(0n);

      // The caller sends far more gas than a flush needs. The push carries 100,000 of it and no
      // more, so that is all the wallet can burn; without the cap it would burn nearly all of it.
      const tx = await f.hook.connect(f.mallory).flush(f.poolId, { gasLimit: 5_000_000 });
      const receipt = await tx.wait();
      expect(receipt.gasUsed).to.be.greaterThan(100_000n);
      expect(receipt.gasUsed).to.be.lessThan(250_000n);
      await expect(tx).to.emit(f.hook, "Flushed").withArgs(f.poolId, burning.target, pm, false);
      await expect(tx).to.emit(f.hook, "Flushed").withArgs(f.poolId, f.sink.target, pr, true);
      await expect(tx).to.changeEtherBalances([burning, f.sink, f.hook], [0n, pr, -pr]);
      expect(await burning.counter()).to.equal(0n);

      expect(await f.hook.pendingMarketing(f.poolId)).to.equal(pm);
      expect(await f.hook.pendingRewards(f.poolId)).to.equal(0n);
      expect(await f.hook.pendingPlatform()).to.equal(pp);
      expect(await balanceOf(f)).to.equal(pm + pp);

      // Trading and collecting go on, and the share is still there when the owner names a wallet that takes it.
      await buy(f, ethers.parseEther("1"));
      await f.hook.collect(f.poolId);
      const owed = await f.hook.pendingMarketing(f.poolId);
      expect(owed).to.be.greaterThan(pm);
      await f.hook.connect(f.creator).setMarketingWallet(f.poolId, f.marketing.address);
      await expect(f.hook.flush(f.poolId)).to.changeEtherBalance(f.marketing, owed);
      expect(await f.hook.pendingMarketing(f.poolId)).to.equal(0n);
    });

    it("ETH forced onto the hook is never counted: no ledger sees it and no flush pays it out", async function () {
      const f = await loadFixture(launched);
      await buy(f, ethers.parseEther("2"));
      await f.hook.collect(f.poolId);
      const booked = await ledgersOf(f);
      expect(booked).to.be.greaterThan(0n);
      expect(await balanceOf(f)).to.equal(booked);

      // ETH can reach any address without its code running, through a self-destructing contract, so the hook's
      // receive cannot refuse it. The balance moves and the ledgers do not.
      const FORCED = ethers.parseEther("3");
      await setBalance(f.hook.target, booked + FORCED);
      expect(await ledgersOf(f)).to.equal(booked);

      // A collection books what the PoolManager paid in, not what the balance happens to be.
      await buy(f, ethers.parseEther("1"));
      const { ethFees } = await f.hook.collect.staticCall(f.poolId);
      expect(ethFees).to.be.closeTo((ethers.parseEther("1") * TOTAL) / 10000n, 2n);
      await f.hook.collect(f.poolId);
      expect(await ledgersOf(f)).to.equal(booked + ethFees);
      expect(await balanceOf(f)).to.equal(booked + ethFees + FORCED);

      // So do the proceeds of a conversion.
      await sell(f, ethers.parseEther("20000"));
      const { ethOut } = await f.hook.convert.staticCall(f.poolId, 1, 0, FAR);
      expect(ethOut).to.be.lessThan(FORCED);
      await f.hook.convert(f.poolId, 1, 0, FAR);
      expect(await ledgersOf(f)).to.equal(booked + ethFees + ethOut);
      expect(await balanceOf(f)).to.equal(booked + ethFees + ethOut + FORCED);

      // Paying out sends the ledgers and not a wei more.
      const pm = await f.hook.pendingMarketing(f.poolId);
      const pr = await f.hook.pendingRewards(f.poolId);
      const pp = await f.hook.pendingPlatform();
      await expect(f.hook.flush(f.poolId)).to.changeEtherBalances([f.marketing, f.sink, f.hook], [pm, pr, -(pm + pr)]);
      await expect(f.hook.flushPlatform()).to.changeEtherBalances([f.treasury, f.hook], [pp, -pp]);
      expect(await ledgersOf(f)).to.equal(0n);
      expect(await balanceOf(f)).to.equal(FORCED);

      // With nothing booked, nothing moves: the forced ETH stays where it was put, for good.
      await expect(f.hook.flush(f.poolId)).to.changeEtherBalances([f.marketing, f.sink, f.hook], [0n, 0n, 0n]);
      await expect(f.hook.flushPlatform()).to.changeEtherBalances([f.treasury, f.hook], [0n, 0n]);
      expect(await balanceOf(f)).to.equal(FORCED);
    });
  });

  // Section 4 of the plan rests a payout on two things: the ledger is zeroed before the push and
  // restored if it fails, and collect, convert, flush and flushPlatform share one reentrancy guard.
  // The wallet here calls all four from inside the payment it is given and records what came back.
  describe("a recipient that calls back in while it is paid", function () {
    const SEATS = ["wallet", "sink", "treasury"];
    // A contract recipient needs the gas the push offers; an estimate can settle for less, because
    // a push that runs dry does not fail the flush.
    const GAS = { gasLimit: 1_000_000 };

    /**
     * The launched pool with a re-entering wallet in each paid seat: the marketing wallet, the
     * rewards sink and the Treasury. A wallet only calls back once a test has aimed it at the hook,
     * so each test has one seat misbehave and the other two just take their money. The pool has
     * ETH booked, tokens waiting for a conversion and fees of both kinds still in the position,
     * so every one of the four calls would do something if it got in.
     */
    async function reentering() {
      const seats = {};
      for (const seat of SEATS) seats[seat] = await ethers.deployContract("ReenteringWallet");
      const f = await launch(await build(seats), seats.wallet.target);
      await buy(f, ethers.parseEther("2"));
      await sell(f, ethers.parseEther("20000"));
      await f.hook.collect(f.poolId);
      await buy(f, ethers.parseEther("1"));
      await sell(f, ethers.parseEther("10000"));
      return { ...f, wallet: seats.wallet };
    }

    async function stateOf(f) {
      const waiting = await f.hook.collect.staticCall(f.poolId);
      return {
        marketing: await f.hook.pendingMarketing(f.poolId),
        rewards: await f.hook.pendingRewards(f.poolId),
        platform: await f.hook.pendingPlatform(),
        tokens: await f.hook.pendingTokens(f.poolId),
        lastConvertAt: await f.hook.lastConvertAt(f.poolId),
        waitingEth: waiting.ethFees,
        waitingTokens: waiting.tokenFees,
        balance: await balanceOf(f),
      };
    }

    /** The guard stopped every one of the four calls the wallet made from inside its payment. */
    function expectAllRefused(f, record, payments) {
      const guard = f.hook.interface.getError("ReentrancyGuardReentrantCall").selector;
      expect(record.count).to.equal(payments);
      expect([record.collectOk, record.convertOk, record.flushOk, record.flushPlatformOk]).to.deep.equal([false, false, false, false]);
      expect([record.collectAnswer, record.convertAnswer, record.flushAnswer, record.flushPlatformAnswer]).to.deep.equal([guard, guard, guard, guard]);
    }

    for (const seat of ["wallet", "sink"]) {
      const label = seat === "wallet" ? "the marketing wallet" : "the rewards sink";
      it(`${label}: all four calls are refused, the flush pays both shares, and nothing else moves`, async function () {
        const f = await loadFixture(reentering);
        await f[seat].aim(f.hook.target, f.poolId);
        const before = await stateOf(f);
        expect(before.marketing + before.rewards + before.platform).to.equal(before.balance);
        expect(before.tokens).to.be.greaterThan(0n);
        expect(before.waitingEth).to.be.greaterThan(0n);

        const tx = await f.hook.connect(f.mallory).flush(f.poolId, GAS);
        await expect(tx).to.emit(f.hook, "Flushed").withArgs(f.poolId, f.wallet.target, before.marketing, true);
        await expect(tx).to.emit(f.hook, "Flushed").withArgs(f.poolId, f.sink.target, before.rewards, true);
        await expect(tx).to.changeEtherBalances(
          [f.wallet, f.sink, f.treasury, f.hook],
          [before.marketing, before.rewards, 0n, -(before.marketing + before.rewards)]
        );
        expectAllRefused(f, await f[seat].last(), 1n);

        // The flush did what a flush does and the four calls from inside it did nothing: the
        // platform's share was not sent, no fees were collected and no tokens were sold.
        expect(await stateOf(f)).to.deep.equal({
          ...before,
          marketing: 0n,
          rewards: 0n,
          balance: before.platform,
        });
      });
    }

    it("the Treasury: all four calls are refused, flushPlatform pays the platform's share, and nothing else moves", async function () {
      const f = await loadFixture(reentering);
      await f.treasury.aim(f.hook.target, f.poolId);
      const before = await stateOf(f);
      expect(before.marketing + before.rewards + before.platform).to.equal(before.balance);

      const tx = await f.hook.connect(f.mallory).flushPlatform(GAS);
      await expect(tx).to.emit(f.hook, "PlatformFlushed").withArgs(before.platform, true);
      await expect(tx).to.changeEtherBalances([f.treasury, f.wallet, f.sink, f.hook], [before.platform, 0n, 0n, -before.platform]);
      expectAllRefused(f, await f.treasury.last(), 1n);

      expect(await stateOf(f)).to.deep.equal({
        ...before,
        platform: 0n,
        balance: before.marketing + before.rewards,
      });
    });

    it("every seat at once, paid twice: each payment is refused again, and the ledgers still add up to the balance", async function () {
      const f = await loadFixture(reentering);
      for (const seat of SEATS) await f[seat].aim(f.hook.target, f.poolId);

      for (const payments of [1n, 2n]) {
        const before = await stateOf(f);
        await expect(f.hook.flush(f.poolId, GAS)).to.changeEtherBalances([f.wallet, f.sink], [before.marketing, before.rewards]);
        await expect(f.hook.flushPlatform(GAS)).to.changeEtherBalance(f.treasury, before.platform);
        for (const seat of SEATS) expectAllRefused(f, await f[seat].last(), payments);
        expect(await ledgersOf(f)).to.equal(0n);
        expect(await balanceOf(f)).to.equal(0n);

        // What the wallets were refused is done from outside, which books the next round of payments.
        await f.hook.collect(f.poolId);
        expect(await ledgersOf(f)).to.equal(before.waitingEth);
        expect(await balanceOf(f)).to.equal(before.waitingEth);
        await buy(f, ethers.parseEther("1"));
      }
    });

    it("the same four calls go through from the same wallet when the hook is not in the middle of one", async function () {
      const f = await loadFixture(reentering);
      await f.wallet.aim(f.hook.target, f.poolId);
      const before = await stateOf(f);

      // The wallet calls collect, convert, flush and flushPlatform one after the other, from
      // outside any payout. Its flush pays the wallet itself, and that payment calls back in.
      await f.wallet.attempt();
      const direct = await f.wallet.direct();
      expect(direct.count).to.equal(1n);
      expect([direct.collectOk, direct.convertOk, direct.flushOk, direct.flushPlatformOk]).to.deep.equal([true, true, true, true]);
      expectAllRefused(f, await f.wallet.last(), 1n);

      // So the refusals above are the guard's doing and not badly made calls: here the fees were
      // collected, the tokens sold and every share paid.
      const after = await stateOf(f);
      expect(after.lastConvertAt).to.be.greaterThan(before.lastConvertAt);
      expect(after.tokens).to.equal(0n);
      expect(after.waitingEth).to.equal(0n);
      expect(after.marketing + after.rewards + after.platform).to.equal(0n);
      expect(after.balance).to.equal(0n);
      expect(await ethers.provider.getBalance(f.wallet.target)).to.be.greaterThan(before.marketing);
      expect(await ethers.provider.getBalance(f.treasury.target)).to.be.greaterThan(before.platform);
    });
  });

  describe("creator controls", function () {
    it("the token's owner moves the marketing wallet until it is locked; the tax cannot move at all", async function () {
      const f = await loadFixture(launched);
      await expect(f.hook.connect(f.mallory).setMarketingWallet(f.poolId, f.mallory.address)).to.be.revertedWithCustomError(f.hook, "NotTokenOwner");
      await expect(f.hook.connect(f.creator).setMarketingWallet(f.poolId, ethers.ZeroAddress)).to.be.revertedWithCustomError(f.hook, "ZeroWallet");
      await f.hook.connect(f.creator).setMarketingWallet(f.poolId, f.alice.address);
      expect((await f.hook.configOf(f.poolId)).marketingWallet).to.equal(f.alice.address);
      await f.hook.connect(f.creator).lockMarketingWallet(f.poolId);
      await expect(f.hook.connect(f.creator).setMarketingWallet(f.poolId, f.creator.address)).to.be.revertedWithCustomError(f.hook, "SettingLocked");

      const cfg = await f.hook.configOfToken(f.token.target);
      expect(cfg.taxLocked).to.equal(true);
      expect(await f.hook.feeBps(f.poolId, true)).to.equal(TOTAL);
      expect(await f.hook.feeBps(f.poolId, false)).to.equal(TOTAL);
    });
  });
});
