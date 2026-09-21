const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  deployPlatformV4Fee,
  feeTaxConfig,
  keyArray,
  mintCalldata,
  plantCode,
  ACTIONS,
  PERMIT2,
  ETH,
} = require("../v4/helpers");

// Uniswap's own test contracts, deployed from the artifacts the npm packages ship, like the v4
// set itself (see test/v4/helpers.js). This project compiles none of them.
const LIQUIDITY_ROUTER = require("@uniswap/v4-core/out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json");
const SWAP_ROUTER = require("@uniswap/v4-core/out/PoolSwapTest.sol/PoolSwapTest.json");
const SUBSCRIBER = require("@uniswap/v4-periphery/foundry-out/MockSubscriber.sol/MockSubscriber.json");
const POSM_CALLING_HOOK = require("@uniswap/v4-periphery/foundry-out/HookModifyLiquidities.sol/HookModifyLiquidities.json");

const E = ethers.parseEther;
const FEE = E("0.1");
const DAY = 86400n;
const Burn = 1;
const Tax = 1;
const MAX128 = 2n ** 128n - 1n;
// Actions.sol, the two test/v4/helpers.js does not list
const INCREASE_LIQUIDITY = 0x00;
const INCREASE_LIQUIDITY_FROM_DELTAS = 0x04;
// TickMath.MIN_SQRT_PRICE + 1, the limit of a swap that pays currency0
const MIN_PRICE_LIMIT = 4295128740n;

const coder = ethers.AbiCoder.defaultAbiCoder();
const selectorOf = (signature) => ethers.id(signature).slice(2, 10);

// The launch position of a fee mode pool is the whole liquidity of the pool and the source of the
// whole tax, and the hook is meant to hold it for good. launch.test.js shows the pool's gate from
// outside; this suite goes after the position itself, through every door the PositionManager, the
// PoolManager and the hook have, as every account that has any standing on the platform.
describe("V4 fee mode, the position held forever", function () {
  /** A Tax launch that is trading, its position owed fees on both sides. */
  async function launched() {
    const ctx = await deployPlatformV4Fee();
    const { feeLauncher, feeHook, presaleFactory, positionManager, stateView, swapper, alice, bob, carol, dave, marketing } = ctx;
    // The fixture's deployer owns everything. The fee launcher gets an owner of its own here, so
    // the launcher's owner and the platform's owner are two accounts to try.
    const [launcherOwner, mallory] = (await ethers.getSigners()).slice(7);
    await feeLauncher.transferOwnership(launcherOwner.address);

    await feeLauncher.connect(alice).createToken(
      Tax,
      { name: "Pump", symbol: "PUMP", totalSupply: E("1000000"), rewardToken: ethers.ZeroAddress },
      feeTaxConfig(marketing.address, { marketingBps: 300 }),
      alice.address
    );
    const [tokenAddr] = await feeLauncher.tokensOfCreator(alice.address);
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
      liquidityAction: Burn,
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
    await presale.connect(alice).finalize(0, 0);

    const key = keyArray(await feeLauncher.poolKeyOf(tokenAddr));
    const launch = await feeLauncher.launchOf(tokenAddr);
    // A buy and a sell, so there is something to take on both sides of the position.
    await swapper.connect(dave).swapExactIn(key, true, E("1"), 0, dave.address, { value: E("1") });
    await token.connect(dave).approve(swapper.target, ethers.MaxUint256);
    await swapper.connect(dave).swapExactIn(key, false, E("300"), 0, dave.address);

    const [lower, upper] = await swapper.usableTicks(200);
    const liquidity = await positionManager.getPositionLiquidity(launch.tokenId);
    expect(liquidity).to.be.greaterThan(0);
    expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);
    expect(await stateView.getLiquidity(launch.poolId)).to.equal(liquidity);
    return {
      ...ctx,
      launcherOwner,
      mallory,
      token,
      tokenAddr,
      presale,
      key,
      poolId: launch.poolId,
      tokenId: launch.tokenId,
      salt: ethers.zeroPadValue(ethers.toBeHex(launch.tokenId), 32),
      lower,
      upper,
      liquidity,
    };
  }

  /**
   * The same launch, plus a position mallory owns in a second, hookless pool of the same token.
   * Whatever is refused on the hook's position is shown to work on hers, so a refusal is never
   * just a badly encoded call.
   */
  async function launchedWithControl() {
    const ctx = await launched();
    const { poolManager, positionManager, stateView, swapper, token, tokenAddr, poolId, alice, mallory } = ctx;
    await token.connect(alice).transfer(mallory.address, E("50000"));
    await token.connect(mallory).approve(PERMIT2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(PERMIT2, ["function approve(address,address,uint160,uint48)"], mallory);
    await permit2.approve(tokenAddr, positionManager.target, 2n ** 160n - 1n, 2n ** 48n - 1n);

    const openKey = [ETH, tokenAddr, 3000, 60, ethers.ZeroAddress];
    await poolManager.connect(mallory).initialize(openKey, (await stateView.getSlot0(poolId)).sqrtPriceX96);
    const [openLower, openUpper] = await swapper.usableTicks(60);
    const ownId = await positionManager.nextTokenId();
    await positionManager.connect(mallory).modifyLiquidities(
      mintCalldata({
        key: { currency0: ETH, currency1: tokenAddr, fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress },
        tickLower: openLower,
        tickUpper: openUpper,
        liquidity: 10n ** 16n,
        amount0Max: E("1"),
        amount1Max: E("1000"),
        recipient: mallory.address,
      }),
      await deadline(),
      { value: E("1") }
    );
    expect(await positionManager.ownerOf(ownId)).to.equal(mallory.address);
    return { ...ctx, openKey, openLower, openUpper, ownId };
  }

  const deadline = async () => (await time.latest()) + 600;

  /**
   * Every account with any standing on the platform, none of which the position may depend on,
   * and two of the platform's own contracts, driven from their addresses. The list is built
   * inside each test, after the fixture is loaded, because it sets up the impersonation.
   */
  async function rolesOf(ctx) {
    const roles = [
      ["a stranger", ctx.mallory],
      ["the token's owner, who ran the sale", ctx.alice],
      ["the marketing wallet", ctx.marketing],
      ["the launcher's owner", ctx.launcherOwner],
      ["the keeper", ctx.keeper],
      ["the platform's owner", ctx.deployer],
    ];
    for (const [label, contract] of [["the fee launcher itself", ctx.feeLauncher], ["the sale", ctx.presale]]) {
      await setBalance(contract.target, E("10"));
      roles.push([label, await ethers.getImpersonatedSigner(contract.target)]);
    }
    return roles;
  }

  /** The accounts of `rolesOf` that hold a key and can sign. */
  const signersOf = (ctx) => [ctx.mallory, ctx.alice, ctx.marketing, ctx.launcherOwner, ctx.keeper, ctx.deployer];

  async function expectUntouched(ctx, label = "", held = 1) {
    const { positionManager, stateView, feeHook, tokenId, poolId, liquidity } = ctx;
    expect(await positionManager.ownerOf(tokenId), label).to.equal(feeHook.target);
    expect(await positionManager.balanceOf(feeHook.target), label).to.equal(held);
    expect(await positionManager.getPositionLiquidity(tokenId), label).to.equal(liquidity);
    expect(await stateView.getLiquidity(poolId), label).to.equal(liquidity);
    expect(await positionManager.getApproved(tokenId), label).to.equal(ethers.ZeroAddress);
    expect(await positionManager.subscriber(tokenId), label).to.equal(ethers.ZeroAddress);
  }

  /** The revert payload of a call, so an error can be found inside the PoolManager's wrapper. */
  async function revertDataOf(call) {
    try {
      await call;
    } catch (error) {
      return error.data ?? error.info?.error?.data ?? "";
    }
    return null;
  }

  // One PositionManager batch, kept in both shapes: `unlockData` for modifyLiquidities and the
  // pair for modifyLiquiditiesWithoutUnlock.
  function plan(actions, params) {
    const packed = ethers.solidityPacked(actions.map(() => "uint8"), actions);
    return { actions: packed, params, unlockData: coder.encode(["bytes", "bytes[]"], [packed, params]) };
  }
  // Token id, liquidity, the two amount limits, hook data; burning and increasing from open
  // deltas take the same without the liquidity.
  const LIQUIDITY_PARAMS = ["uint256", "uint256", "uint128", "uint128", "bytes"];
  const NO_LIQUIDITY_PARAMS = ["uint256", "uint128", "uint128", "bytes"];
  const pairOf = ([currency0, currency1]) => coder.encode(["address", "address"], [currency0, currency1]);
  const takePair = ([currency0, currency1], to) => coder.encode(["address", "address", "address"], [currency0, currency1, to]);
  const decrease = (id, amount, key, to) =>
    plan(
      [ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR],
      [coder.encode(LIQUIDITY_PARAMS, [id, amount, 0, 0, "0x"]), takePair(key, to)]
    );
  const burn = (id, key, to) =>
    plan([ACTIONS.BURN_POSITION, ACTIONS.TAKE_PAIR], [coder.encode(NO_LIQUIDITY_PARAMS, [id, 0, 0, "0x"]), takePair(key, to)]);
  const increase = (id, amount, key) =>
    plan(
      [INCREASE_LIQUIDITY, ACTIONS.SETTLE_PAIR],
      [coder.encode(LIQUIDITY_PARAMS, [id, amount, MAX128, MAX128, "0x"]), pairOf(key)]
    );
  const increaseFromDeltas = (id) =>
    plan([INCREASE_LIQUIDITY_FROM_DELTAS], [coder.encode(NO_LIQUIDITY_PARAMS, [id, MAX128, MAX128, "0x"])]);

  /** Every change of the hook's position a caller could ask the PositionManager for. */
  function plansAgainst(ctx, to) {
    const { tokenId, liquidity, key } = ctx;
    return [
      ["burn", burn(tokenId, key, to), 0n],
      ["decrease by all", decrease(tokenId, liquidity, key, to), 0n],
      ["decrease by a little", decrease(tokenId, 1n, key, to), 0n],
      // A change of zero moves no liquidity, but it pays the position's fees to the caller.
      ["decrease by zero", decrease(tokenId, 0n, key, to), 0n],
      ["increase", increase(tokenId, 10n ** 15n, key), E("1")],
      ["increase by zero", increase(tokenId, 0n, key), 0n],
      ["increase from deltas", increaseFromDeltas(tokenId), 0n],
    ];
  }

  // ------------------------------------------------------------------ the PositionManager

  describe("the PositionManager, asked by everyone", function () {
    it("moves the position for nobody", async function () {
      const ctx = await loadFixture(launched);
      const { positionManager, feeHook, tokenId } = ctx;
      for (const [label, who] of await rolesOf(ctx)) {
        const posm = positionManager.connect(who);
        await expect(posm.transferFrom(feeHook.target, who.address, tokenId), label).to.be.revertedWith("NOT_AUTHORIZED");
        await expect(
          posm["safeTransferFrom(address,address,uint256)"](feeHook.target, who.address, tokenId),
          label
        ).to.be.revertedWith("NOT_AUTHORIZED");
        await expect(
          posm["safeTransferFrom(address,address,uint256,bytes)"](feeHook.target, who.address, tokenId, "0x"),
          label
        ).to.be.revertedWith("NOT_AUTHORIZED");
        // Naming oneself as the holder is no better.
        await expect(posm.transferFrom(who.address, who.address, tokenId), label).to.be.revertedWith("WRONG_FROM");
        await expectUntouched(ctx, label);
      }
    });

    it("approves nobody over it, and an operator approval covers only the caller's own positions", async function () {
      const ctx = await loadFixture(launched);
      const { positionManager, feeHook, tokenId, dave } = ctx;
      for (const [label, who] of await rolesOf(ctx)) {
        const posm = positionManager.connect(who);
        await expect(posm.approve(who.address, tokenId), label).to.be.revertedWithCustomError(positionManager, "Unauthorized");
        await expect(posm.approve(dave.address, tokenId), label).to.be.revertedWithCustomError(positionManager, "Unauthorized");

        // setApprovalForAll has nothing to refuse: it speaks for the caller's positions only.
        await posm.setApprovalForAll(dave.address, true);
        await posm.setApprovalForAll(who.address, true);
        expect(await positionManager.isApprovedForAll(who.address, dave.address), label).to.equal(true);
        expect(await positionManager.isApprovedForAll(feeHook.target, dave.address), label).to.equal(false);
        expect(await positionManager.isApprovedForAll(feeHook.target, who.address), label).to.equal(false);
        await expect(posm.transferFrom(feeHook.target, who.address, tokenId), label).to.be.revertedWith("NOT_AUTHORIZED");
        await expectUntouched(ctx, label);
      }
      await expect(
        positionManager.connect(dave).transferFrom(feeHook.target, dave.address, tokenId)
      ).to.be.revertedWith("NOT_AUTHORIZED");
    });

    // A position held by a contract can only be approved by signature if the contract answers
    // ERC-1271. The hook has no isValidSignature and no fallback, so the check itself reverts.
    it("takes no signature for it: permit and permitForAll, signed by every account", async function () {
      const ctx = await loadFixture(launchedWithControl);
      const { positionManager, feeHook, tokenId, ownId, mallory, carol } = ctx;
      const PERMIT = "permit(address,uint256,uint256,uint256,bytes)";
      const domain = {
        name: await positionManager.name(),
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: positionManager.target,
      };
      expect(ethers.TypedDataEncoder.hashDomain(domain)).to.equal(await positionManager.DOMAIN_SEPARATOR());
      const permitTypes = {
        Permit: [
          { name: "spender", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const permitForAllTypes = {
        PermitForAll: [
          { name: "operator", type: "address" },
          { name: "approved", type: "bool" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const until = BigInt(await deadline());
      const roles = await rolesOf(ctx);

      let nonce = 1n;
      for (const signer of signersOf(ctx)) {
        const spender = signer.address;
        const forOne = await signer.signTypedData(domain, permitTypes, { spender, tokenId, nonce, deadline: until });
        const forAll = await signer.signTypedData(domain, permitForAllTypes, { operator: spender, approved: true, nonce, deadline: until });
        // Anyone may hand a signature in, the signer or somebody else.
        for (const [label, who] of roles) {
          const posm = positionManager.connect(who);
          await expect(posm[PERMIT](spender, tokenId, until, nonce, forOne), label).to.be.revertedWithoutReason();
          await expect(posm.permitForAll(feeHook.target, spender, true, until, nonce, forAll), label).to.be.revertedWithoutReason();
        }
        // The short form of a signature and no signature at all go the same way.
        const compact = ethers.Signature.from(forOne).compactSerialized;
        await expect(positionManager.connect(signer)[PERMIT](spender, tokenId, until, nonce, compact)).to.be.revertedWithoutReason();
        await expect(positionManager.connect(signer)[PERMIT](spender, tokenId, until, nonce, "0x")).to.be.revertedWithoutReason();
        expect(await positionManager.isApprovedForAll(feeHook.target, spender)).to.equal(false);
        await expectUntouched(ctx, spender);

        // The same signature, given for the signer's own account, is taken. It is not the
        // signature that is wrong, and it still says nothing about the hook's position.
        await positionManager.connect(mallory).permitForAll(spender, spender, true, until, nonce, forAll);
        expect(await positionManager.isApprovedForAll(spender, spender)).to.equal(true);
        await expect(
          positionManager.connect(signer).transferFrom(feeHook.target, spender, tokenId)
        ).to.be.revertedWith("NOT_AUTHORIZED");
        nonce += 1n;
      }

      // And a permit of this very shape does approve a spender, on a position a wallet holds.
      const own = await mallory.signTypedData(domain, permitTypes, { spender: carol.address, tokenId: ownId, nonce, deadline: until });
      await positionManager.connect(carol)[PERMIT](carol.address, ownId, until, nonce, own);
      expect(await positionManager.getApproved(ownId)).to.equal(carol.address);
      await expectUntouched(ctx);
    });

    it("changes its liquidity for nobody: burn, decrease and increase, in a batch or without the unlock", async function () {
      const ctx = await loadFixture(launched);
      const { positionManager } = ctx;
      for (const [label, who] of await rolesOf(ctx)) {
        const posm = positionManager.connect(who);
        for (const [name, p, value] of plansAgainst(ctx, who.address)) {
          await expect(posm.modifyLiquidities(p.unlockData, await deadline(), { value }), `${label}, ${name}`)
            .to.be.revertedWithCustomError(positionManager, "NotApproved")
            .withArgs(who.address);
          await expect(posm.modifyLiquiditiesWithoutUnlock(p.actions, p.params, { value }), `${label}, ${name}, no unlock`)
            .to.be.revertedWithCustomError(positionManager, "NotApproved")
            .withArgs(who.address);
        }
        // All of it in one multicall changes nothing about who is asking.
        const calls = plansAgainst(ctx, who.address).map(([, p]) =>
          positionManager.interface.encodeFunctionData("modifyLiquiditiesWithoutUnlock", [p.actions, p.params])
        );
        await expect(posm.multicall(calls), label).to.be.revertedWithCustomError(positionManager, "NotApproved").withArgs(who.address);
        await expectUntouched(ctx, label);
      }
    });

    // A subscriber is told of every change of a position, and one that reverts would make every
    // collection revert with it. Only the holder of a position can name one.
    it("subscribes nobody to it", async function () {
      const ctx = await loadFixture(launchedWithControl);
      const { positionManager, tokenId, ownId, mallory } = ctx;
      const subscriber = await new ethers.ContractFactory(SUBSCRIBER.abi, SUBSCRIBER.bytecode.object, mallory).deploy(
        positionManager.target
      );
      for (const [label, who] of await rolesOf(ctx)) {
        const posm = positionManager.connect(who);
        await expect(posm.subscribe(tokenId, subscriber.target, "0x"), label)
          .to.be.revertedWithCustomError(positionManager, "NotApproved")
          .withArgs(who.address);
        await expect(posm.unsubscribe(tokenId), label)
          .to.be.revertedWithCustomError(positionManager, "NotApproved")
          .withArgs(who.address);
        await expectUntouched(ctx, label);
      }
      expect(await subscriber.notifySubscribeCount()).to.equal(0);
      // The subscriber is a working one: the holder of a position can name it.
      await positionManager.connect(mallory).subscribe(ownId, subscriber.target, "0x");
      expect(await positionManager.subscriber(ownId)).to.equal(subscriber.target);
      expect(await subscriber.notifySubscribeCount()).to.equal(1);
    });

    // The hook has no onERC721Received, so nothing can be sent to it the safe way. A plain
    // transfer cannot be refused by anyone; what arrives that way is not the launch position of
    // any pool, is never counted, and is held as firmly as the launch position is.
    it("a position sent to the hook by hand changes nothing and never comes back", async function () {
      const ctx = await loadFixture(launchedWithControl);
      const { positionManager, feeHook, swapper, openKey, ownId, poolId, key, mallory, dave } = ctx;
      const posm = positionManager.connect(mallory);
      await expect(posm["safeTransferFrom(address,address,uint256)"](mallory.address, feeHook.target, ownId)).to.be.reverted;
      await expect(
        posm["safeTransferFrom(address,address,uint256,bytes)"](mallory.address, feeHook.target, ownId, "0x")
      ).to.be.reverted;
      expect(await positionManager.ownerOf(ownId)).to.equal(mallory.address);

      await posm.transferFrom(mallory.address, feeHook.target, ownId);
      expect(await positionManager.ownerOf(ownId)).to.equal(feeHook.target);
      await expectUntouched(ctx, "after the stray position", 2);
      expect(await feeHook.positionIdOf(poolId)).to.equal(ctx.tokenId);

      // The pool it belongs to earns fees, and none of them is the hook's to collect: a
      // collection asks for the launch position and nothing else.
      const owed = await feeHook.collect.staticCall(poolId);
      await swapper.connect(dave).swapExactIn(openKey, true, E("0.01"), 0, dave.address, { value: E("0.01") });
      const owedAfter = await feeHook.collect.staticCall(poolId);
      expect(owedAfter.ethFees).to.equal(owed.ethFees);
      expect(owedAfter.tokenFees).to.equal(owed.tokenFees);
      await expect(feeHook.collect(poolId)).to.changeEtherBalance(feeHook, owed.ethFees);
      expect(await positionManager.getPositionLiquidity(ownId)).to.equal(10n ** 16n);

      // Its former owner has no more say over it than over the launch position.
      await expect(posm.transferFrom(feeHook.target, mallory.address, ownId)).to.be.revertedWith("NOT_AUTHORIZED");
      await expect(posm.modifyLiquidities(decrease(ownId, 10n ** 16n, openKey, mallory.address).unlockData, await deadline()))
        .to.be.revertedWithCustomError(positionManager, "NotApproved")
        .withArgs(mallory.address);
      await expect(posm.modifyLiquidities(decrease(ctx.tokenId, 1n, key, mallory.address).unlockData, await deadline()))
        .to.be.revertedWithCustomError(positionManager, "NotApproved")
        .withArgs(mallory.address);
      await expectUntouched(ctx, "at the end", 2);
    });

    // Every refusal above rests on one fact: the PositionManager obeys the holder, and the holder
    // is the hook. Asked from the hook's address the same batches would go through, which is why
    // the last section of this suite pins down what the hook's code can ask for.
    it("would obey the hook alone, whose gate still refuses an increase", async function () {
      const ctx = await loadFixture(launched);
      const { positionManager, feeHook, tokenId, liquidity, key } = ctx;
      const asHook = positionManager.connect(await ethers.getImpersonatedSigner(feeHook.target));
      // Static calls: nothing of this is ever sent.
      await asHook.modifyLiquidities.staticCall(decrease(tokenId, liquidity, key, feeHook.target).unlockData, await deadline());
      await asHook.modifyLiquidities.staticCall(burn(tokenId, key, feeHook.target).unlockData, await deadline());
      await asHook.transferFrom.staticCall(feeHook.target, ctx.mallory.address, tokenId);

      const data = await revertDataOf(
        asHook.modifyLiquidities.staticCall(increase(tokenId, 10n ** 15n, key).unlockData, await deadline())
      );
      expect(data, "the increase went through").to.be.a("string");
      expect(data).to.include(feeHook.interface.getError("LiquidityClosed").selector.slice(2));
      await expectUntouched(ctx);
    });

    // modifyLiquiditiesWithoutUnlock exists for contracts that already hold the PoolManager's
    // lock, a hook in the middle of a swap for one. Uniswap ships such a hook for its own tests:
    // it hands whatever batch the swapper passes to the PositionManager. Here it guards a second
    // pool, and a swap there is used to reach for the launch position while the PoolManager is
    // unlocked.
    it("refuses a batch sent from inside another pool's swap", async function () {
      const ctx = await loadFixture(launched);
      const { poolManager, positionManager, swapper, token, tokenAddr, tokenId, liquidity, key, alice, mallory } = ctx;

      // An address whose only permission bit is BEFORE_SWAP, carrying Uniswap's hook.
      const swapHook = new ethers.Contract("0x00000000000000000000000000000000beef0080", POSM_CALLING_HOOK.abi, mallory);
      await plantCode(swapHook.target, POSM_CALLING_HOOK.deployedBytecode.object);
      await swapHook.setAddresses(positionManager.target, PERMIT2);

      // The hook approves the pool's currencies as ERC-20s, so the second pool is token against token.
      const other = await ethers.deployContract("MockERC20", ["Other", "OTH", 18, E("1000000")], mallory);
      await token.connect(alice).transfer(mallory.address, E("50000"));
      const pair = [tokenAddr, other.target].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const otherKey = [pair[0], pair[1], 3000, 60, swapHook.target];
      await poolManager.connect(mallory).initialize(otherKey, 2n ** 96n);

      const swapRouter = await new ethers.ContractFactory(SWAP_ROUTER.abi, SWAP_ROUTER.bytecode.object, mallory).deploy(
        poolManager.target
      );
      const permit2 = new ethers.Contract(PERMIT2, ["function approve(address,address,uint160,uint48)"], mallory);
      for (const erc20 of [token, other]) {
        await erc20.connect(mallory).approve(PERMIT2, ethers.MaxUint256);
        await permit2.approve(erc20.target, positionManager.target, 2n ** 160n - 1n, 2n ** 48n - 1n);
        await erc20.connect(mallory).approve(swapRouter.target, ethers.MaxUint256);
      }
      const [otherLower, otherUpper] = await swapper.usableTicks(60);
      const ownId = await positionManager.nextTokenId();
      await positionManager.connect(mallory).modifyLiquidities(
        mintCalldata({
          key: { currency0: pair[0], currency1: pair[1], fee: 3000, tickSpacing: 60, hooks: swapHook.target },
          tickLower: otherLower,
          tickUpper: otherUpper,
          liquidity: E("100"),
          amount0Max: E("1000"),
          amount1Max: E("1000"),
          recipient: mallory.address,
        }),
        await deadline()
      );
      const swapWith = (p) =>
        swapRouter.swap(
          otherKey,
          { zeroForOne: true, amountSpecified: -(10n ** 15n), sqrtPriceLimitX96: MIN_PRICE_LIMIT },
          { takeClaims: false, settleUsingBurn: false },
          coder.encode(["bytes", "bytes[]"], [p.actions, p.params])
        );

      // The route is real: on a position that approves the swap hook, the batch inside the swap
      // takes liquidity out.
      await positionManager.connect(mallory).approve(swapHook.target, ownId);
      await swapWith(decrease(ownId, E("40"), pair, mallory.address));
      expect(await positionManager.getPositionLiquidity(ownId)).to.equal(E("60"));

      // On the launch position the same route ends where every other one did.
      const notApproved = positionManager.interface.getError("NotApproved").selector.slice(2);
      const asked = swapHook.target.slice(2).toLowerCase().padStart(64, "0");
      const reaches = [
        decrease(tokenId, liquidity, key, mallory.address),
        decrease(tokenId, 0n, key, mallory.address),
        burn(tokenId, key, mallory.address),
      ];
      for (const p of reaches) {
        const data = await revertDataOf(swapWith(p));
        expect(data, "the swap went through").to.be.a("string");
        expect(data).to.include(notApproved + asked);
      }
      await expectUntouched(ctx);
    });
  });

  // ------------------------------------------------------------------ the PoolManager

  describe("the PoolManager, asked directly", function () {
    // Inside the PoolManager a position belongs to whoever called modifyLiquidity, and the launch
    // position was put there by the PositionManager. The same ticks and the same salt from any
    // other caller name an empty position of that caller's own.
    it("has nothing under the hook's salt for any other caller, to take out, to poke or to add to", async function () {
      const ctx = await loadFixture(launchedWithControl);
      const { poolManager, stateView, swapper, feeHook, token, key, salt, lower, upper, liquidity, mallory } = ctx;
      const { openKey, openLower, openUpper } = ctx;
      const router = await new ethers.ContractFactory(LIQUIDITY_ROUTER.abi, LIQUIDITY_ROUTER.bytecode.object, mallory).deploy(
        poolManager.target
      );
      const MODIFY = "modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)";
      const range = (liquidityDelta, s = salt) => ({ tickLower: lower, tickUpper: upper, liquidityDelta, salt: s });

      for (const [label, who] of await rolesOf(ctx)) {
        const direct = router.connect(who);
        for (const delta of [-liquidity, -1n]) {
          const data = await revertDataOf(direct[MODIFY].staticCall(key, range(delta), "0x"));
          expect(data, `${label}, ${delta}`).to.be.a("string");
          expect(data).to.include(selectorOf("SafeCastOverflow()"));
        }
        // A change of zero is how fees are collected.
        const poked = await revertDataOf(direct[MODIFY].staticCall(key, range(0n), "0x"));
        expect(poked, label).to.be.a("string");
        expect(poked).to.include(selectorOf("CannotUpdateEmptyPosition()"));
        // And an add meets the gate, with the launch position's salt or without.
        for (const s of [salt, ethers.ZeroHash]) {
          const added = await revertDataOf(direct[MODIFY].staticCall(key, range(10n ** 15n, s), "0x", { value: E("1") }));
          expect(added, label).to.be.a("string");
          expect(added).to.include(feeHook.interface.getError("LiquidityClosed").selector.slice(2));
        }
        // Sent for real, the largest of them fails all the same.
        await expect(direct[MODIFY](key, range(-liquidity), "0x"), label).to.be.reverted;
        await expectUntouched(ctx, label);
      }

      // The same router does take out what it put in itself, where no gate stands: the refusals
      // above are about whose position it is.
      const openId = await swapper.poolId(openKey);
      const before = await stateView.getLiquidity(openId);
      await token.connect(mallory).approve(router.target, ethers.MaxUint256);
      const openRange = (liquidityDelta) => ({ tickLower: openLower, tickUpper: openUpper, liquidityDelta, salt });
      await router[MODIFY](openKey, openRange(10n ** 15n), "0x", { value: E("1") });
      expect(await stateView.getLiquidity(openId)).to.equal(before + 10n ** 15n);
      await router[MODIFY](openKey, openRange(-(10n ** 15n)), "0x");
      expect(await stateView.getLiquidity(openId)).to.equal(before);
    });
  });

  // ------------------------------------------------------------------ the hook

  /** A zero of any ABI type, for calling a function whose arguments do not matter. */
  function zeroOf(type) {
    if (type.baseType === "tuple") return type.components.map(zeroOf);
    if (type.baseType === "array") return [];
    if (type.type === "address") return ethers.ZeroAddress;
    if (type.type === "bool") return false;
    if (type.type === "bytes") return "0x";
    if (type.type === "string") return "";
    if (type.type.startsWith("bytes")) return ethers.zeroPadValue("0x", Number(type.type.slice(5)));
    return 0;
  }

  const HOOK_ENTRY_POINTS = [
    "beforeInitialize(address,(address,address,uint24,int24,address),uint160)",
    "afterInitialize(address,(address,address,uint24,int24,address),uint160,int24)",
    "beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)",
    "afterAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)",
    "beforeRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)",
    "afterRemoveLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),int256,int256,bytes)",
    "beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)",
    "afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)",
    "beforeDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)",
    "afterDonate(address,(address,address,uint24,int24,address),uint256,uint256,bytes)",
  ];
  // Everything that can change the hook's state or make it call out. An addition fails the suite,
  // and whoever adds it has to say here why the position still cannot move.
  const STATE_CHANGING = [
    "register((address,address,uint24,int24,address),(address,address,address,uint16,uint16,uint16,uint16,bool,bool,bool),uint256)",
    "collect(bytes32)",
    "convert(bytes32,uint256,uint256,uint256)",
    "flush(bytes32)",
    "flushPlatform()",
    "setMarketingWallet(bytes32,address)",
    "lockMarketingWallet(bytes32)",
    "unlockCallback(bytes)",
    ...HOOK_ENTRY_POINTS,
  ];
  const READ_ONLY = [
    "BPS()",
    "CONVERT_COOLDOWN()",
    "MAX_CONVERT_BPS()",
    "MAX_TOTAL_TAX_BPS()",
    "PLATFORM_TAX_BPS()",
    "TICK_SPACING()",
    "configOf(bytes32)",
    "configOfToken(address)",
    "feeBps(bytes32,bool)",
    "getHookPermissions()",
    "lastConvertAt(bytes32)",
    "launcher()",
    "maxConvert(bytes32)",
    "nextConvertAt(bytes32)",
    "pendingMarketing(bytes32)",
    "pendingPlatform()",
    "pendingRewards(bytes32)",
    "pendingTokens(bytes32)",
    "platformTreasury()",
    "poolIdOf(address)",
    "poolKeyOf(bytes32)",
    "poolManager()",
    "positionIdOf(bytes32)",
    "positionManager()",
    "seeded(bytes32)",
  ];

  describe("the hook, asked by everyone", function () {
    it("answers its callback and its hook entry points to the PoolManager alone", async function () {
      const ctx = await loadFixture(launched);
      const { feeHook, poolManager, positionManager, poolId, key, salt, lower, upper, liquidity } = ctx;
      const entryPoints = HOOK_ENTRY_POINTS.map((signature) => feeHook.interface.getFunction(signature));
      const sellAll = coder.encode(["bytes32", "uint256"], [poolId, liquidity]);

      for (const [label, who] of await rolesOf(ctx)) {
        const hook = feeHook.connect(who);
        await expect(hook.unlockCallback(sellAll), label).to.be.revertedWithCustomError(feeHook, "NotPoolManager");
        for (const fn of entryPoints) {
          await expect(hook[fn.format("sighash")](...fn.inputs.map(zeroOf)), `${label}, ${fn.name}`).to.be.revertedWithCustomError(
            feeHook,
            "NotPoolManager"
          );
        }
        await expectUntouched(ctx, label);
      }

      // From the PoolManager's own address, outside any unlock: the callback can swap nothing, the
      // gate stays shut even for the PositionManager with the launch position's salt, and the
      // eight entry points the hook has no permission bit for do nothing at all.
      await setBalance(poolManager.target, (await ethers.provider.getBalance(poolManager.target)) + E("10"));
      const asManager = feeHook.connect(await ethers.getImpersonatedSigner(poolManager.target));
      await expect(asManager.unlockCallback(sellAll)).to.be.revertedWithCustomError(poolManager, "ManagerLocked");
      await expect(
        asManager.beforeAddLiquidity(positionManager.target, key, [lower, upper, 10n ** 15n, salt], "0x")
      ).to.be.revertedWithCustomError(feeHook, "LiquidityClosed");
      await expect(asManager.beforeInitialize(ctx.mallory.address, key, 2n ** 96n)).to.be.revertedWithCustomError(feeHook, "NotLauncher");
      for (const fn of entryPoints.filter((f) => !["beforeInitialize", "beforeAddLiquidity"].includes(f.name))) {
        await expect(asManager[fn.format("sighash")](...fn.inputs.map(zeroOf)), fn.name).to.be.revertedWithCustomError(
          feeHook,
          "HookNotImplemented"
        );
      }
      await expectUntouched(ctx);
    });

    // The one paid seat a stranger can take is the marketing wallet, which the token's owner
    // names: the rewards sink is the platform's own token code and the Treasury the platform's own
    // contract. fee-hook.test.js puts a wallet like this one in all three seats; here it takes the
    // seat it could really have, on a launch made through the platform.
    it("pays a marketing wallet that calls back into every guarded function: the wallet gets its share and nothing else moves", async function () {
      const ctx = await loadFixture(launched);
      const { feeHook, swapper, key, poolId, alice, dave, mallory, treasury } = ctx;
      const wallet = await ethers.deployContract("ReenteringWallet");
      await feeHook.connect(alice).setMarketingWallet(poolId, wallet.target);
      await wallet.aim(feeHook.target, poolId);

      // The fixture's trades, collected, are ETH on the books and tokens to convert. Two more
      // trades leave fees in the position, so each of the wallet's four calls has something to take.
      await feeHook.collect(poolId);
      await swapper.connect(dave).swapExactIn(key, true, E("0.5"), 0, dave.address, { value: E("0.5") });
      await swapper.connect(dave).swapExactIn(key, false, E("200"), 0, dave.address);
      const share = await feeHook.pendingMarketing(poolId);
      const platform = await feeHook.pendingPlatform();
      const tokens = await feeHook.pendingTokens(poolId);
      const waiting = await feeHook.collect.staticCall(poolId);
      for (const amount of [share, platform, tokens, waiting.ethFees, waiting.tokenFees]) expect(amount).to.be.greaterThan(0);
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(share + platform);

      // Sent with gas to spare: the push offers the wallet 100,000 gas only if the call has it.
      const flush = await feeHook.connect(mallory).flush(poolId, { gasLimit: 1_000_000 });
      await expect(flush).to.emit(feeHook, "Flushed").withArgs(poolId, wallet.target, share, true);
      await expect(flush).to.changeEtherBalances([wallet, treasury, feeHook], [share, 0n, -share]);

      // collect, convert, flush and flushPlatform, each tried from inside the payment, each stopped by the guard.
      const guard = feeHook.interface.getError("ReentrancyGuardReentrantCall").selector;
      const last = await wallet.last();
      expect(last.count).to.equal(1);
      expect([last.collectOk, last.convertOk, last.flushOk, last.flushPlatformOk]).to.deep.equal([false, false, false, false]);
      expect([last.collectAnswer, last.convertAnswer, last.flushAnswer, last.flushPlatformAnswer]).to.deep.equal([guard, guard, guard, guard]);

      // The books are as they were but for the share that was paid, and they still match the balance.
      expect(await feeHook.pendingMarketing(poolId)).to.equal(0);
      expect(await feeHook.pendingPlatform()).to.equal(platform);
      expect(await feeHook.pendingTokens(poolId)).to.equal(tokens);
      expect(await feeHook.lastConvertAt(poolId)).to.equal(0);
      expect((await feeHook.collect.staticCall(poolId)).toArray()).to.deep.equal(waiting.toArray());
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(platform);
      await expectUntouched(ctx);
    });

    // A long run of every state-changing function of the hook, called by every account in a
    // random order between trades, with the position checked after each step. The draw is
    // seeded, so a failure repeats.
    it("keeps the position through a random run of every function by every account", async function () {
      const ctx = await loadFixture(launched);
      const { feeHook, swapper, token, tokenAddr, key, poolId, tokenId, dave, mallory, marketing } = ctx;
      const roles = await rolesOf(ctx);
      await token.connect(ctx.alice).transfer(dave.address, E("20000"));
      let seed = 0x5eed1e55;
      const draw = (n) => {
        // mulberry32
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) % n;
      };

      // A second token of the fee launcher, not launched: the one thing `register` could still take.
      await ctx.feeLauncher.connect(ctx.alice).createToken(
        Tax,
        { name: "Next", symbol: "NEXT", totalSupply: E("1000000"), rewardToken: ethers.ZeroAddress },
        feeTaxConfig(marketing.address, { marketingBps: 300 }),
        ctx.alice.address
      );
      const nextToken = (await ctx.feeLauncher.tokensOfCreator(ctx.alice.address))[1];
      const nextKey = keyArray(await ctx.feeLauncher.keyFor(nextToken));
      const nextConfig = [nextToken, marketing.address, ethers.ZeroAddress, 300, 300, 0, 0, true, false, false];
      const config = [tokenAddr, mallory.address, ethers.ZeroAddress, 300, 300, 0, 0, true, false, false];

      const steps = {
        collect: (hook) => hook.collect(poolId),
        convert: async (hook) => hook.convert(poolId, 1, 0, await deadline()),
        flush: (hook) => hook.flush(poolId),
        flushPlatform: (hook) => hook.flushPlatform(),
        setMarketingWallet: (hook, who) => hook.setMarketingWallet(poolId, who.address),
        lockMarketingWallet: (hook) => hook.lockMarketingWallet(poolId),
        // The launch position's id, offered again: for the pool that has it and for a fresh one.
        register: (hook) => (draw(2) ? hook.register(key, config, tokenId) : hook.register(nextKey, nextConfig, tokenId)),
        unlockCallback: (hook) => hook.unlockCallback(coder.encode(["bytes32", "uint256"], [poolId, 1n])),
        entryPoint: (hook) => {
          const fn = feeHook.interface.getFunction(HOOK_ENTRY_POINTS[draw(HOOK_ENTRY_POINTS.length)]);
          return hook[fn.format("sighash")](...fn.inputs.map(zeroOf));
        },
      };
      const names = Object.keys(steps);
      const went = Object.fromEntries(names.map((name) => [name, 0]));

      for (let i = 0; i < 250; i++) {
        // Trades keep both sides of the position earning, and time lets a conversion come due.
        if (draw(3) === 0) await swapper.connect(dave).swapExactIn(key, true, E("0.2"), 0, dave.address, { value: E("0.2") });
        if (draw(3) === 0) await swapper.connect(dave).swapExactIn(key, false, E("150"), 0, dave.address);
        if (draw(4) === 0) await time.increase(301);

        const [label, who] = roles[draw(roles.length)];
        const name = names[draw(names.length)];
        try {
          await steps[name](feeHook.connect(who), who);
          went[name] += 1;
        } catch (error) {
          // Most draws are refused: the wrong caller, a cooldown, nothing to sell. Only a revert
          // is an acceptable failure, though.
          expect(error.message, `${label}, ${name}`).to.match(/revert/);
        }
        await expectUntouched(ctx, `step ${i}: ${label}, ${name}`);
      }

      console.log(`      calls that went through: ${names.map((name) => `${name} ${went[name]}`).join(", ")}`);
      // The run did reach the functions that move money, not only their refusals.
      for (const name of ["collect", "convert", "flush", "flushPlatform", "setMarketingWallet"]) {
        expect(went[name], name).to.be.greaterThan(0);
      }
      expect(went.unlockCallback + went.entryPoint).to.equal(0);
      expect(await token.balanceOf(feeHook.target)).to.equal(await feeHook.pendingTokens(poolId));
    });
  });

  // ------------------------------------------------------------------ what the hook can do at all

  describe("what the hook's code can do", function () {
    it("has exactly the expected functions, none of them payable, and no fallback", async function () {
      const hre = require("hardhat");
      const { abi } = await hre.artifacts.readArtifact("HoodSaleV4FeeHook");
      const functions = new ethers.Interface(abi).fragments.filter((f) => f.type === "function");
      const changing = functions.filter((f) => !f.constant).map((f) => f.format("sighash"));
      const reading = functions.filter((f) => f.constant).map((f) => f.format("sighash"));
      expect([...changing].sort()).to.deep.equal([...STATE_CHANGING].sort());
      expect([...reading].sort()).to.deep.equal([...READ_ONLY].sort());
      expect(functions.filter((f) => f.payable)).to.deep.equal([]);

      // ETH comes in through `receive`, from the PoolManager only, and there is no fallback that
      // could answer a call the list above does not have.
      expect(abi.filter((entry) => entry.type === "fallback")).to.deep.equal([]);
      expect(abi.filter((entry) => entry.type === "receive").length).to.equal(1);
    });

    it("has no owner, no upgrade path, and answers neither a signature check nor an NFT callback", async function () {
      const ctx = await loadFixture(launched);
      const { feeHook, mallory } = ctx;
      const absent = [
        "owner()",
        "pendingOwner()",
        "transferOwnership(address)",
        "renounceOwnership()",
        "acceptOwnership()",
        "admin()",
        "implementation()",
        "proxiableUUID()",
        "upgradeTo(address)",
        "upgradeToAndCall(address,bytes)",
        "changeAdmin(address)",
        "initialize()",
        "setTaxes(bytes32,uint16,uint16,uint16,uint16)",
        "lockTaxes(bytes32)",
        "multicall(bytes[])",
        // ERC-1271: what a permit on the position would ask the holder
        "isValidSignature(bytes32,bytes)",
        "onERC721Received(address,address,uint256,bytes)",
        "supportsInterface(bytes4)",
      ];
      for (const signature of absent) {
        const data = "0x" + selectorOf(signature) + "00".repeat(32 * 6);
        // No function and no fallback: the call reverts with nothing, whoever sends it.
        for (const [label, who] of await rolesOf(ctx)) {
          expect(await revertDataOf(who.call({ to: feeHook.target, data })), `${signature}, ${label}`).to.equal("0x");
        }
      }
      // Data too short to be a selector is no way in either.
      expect(await revertDataOf(mallory.call({ to: feeHook.target, data: "0x00" }))).to.equal("0x");

      // Not a proxy: the slots an upgradeable contract keeps its implementation, admin and
      // beacon in (EIP-1967), the older UUPS slot and the upgradeable Ownable's slot are empty.
      const slots = {
        implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
        beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
        proxiable: ethers.id("PROXIABLE"),
        ownableUpgradeable: "0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300",
      };
      expect(slots.implementation).to.equal(ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.implementation")) - 1n, 32));
      expect(slots.admin).to.equal(ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.admin")) - 1n, 32));
      expect(slots.beacon).to.equal(ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.beacon")) - 1n, 32));
      for (const [name, slot] of Object.entries(slots)) {
        expect(await ethers.provider.getStorage(feeHook.target, slot), name).to.equal(ethers.ZeroHash);
      }
      await expectUntouched(ctx);
    });

    /**
     * Counts the opcodes of a contract's runtime code: a straight walk from the first byte that
     * skips what a PUSH carries, which is data (the immutables are there), and stops at the
     * compiler's metadata, whose length is the last two bytes of the code.
     */
    function opcodesOf(code) {
      const bytes = ethers.getBytes(code);
      const end = bytes.length - 2 - ((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]);
      const found = new Map();
      for (let pc = 0; pc < end; pc++) {
        const op = bytes[pc];
        found.set(op, [...(found.get(op) ?? []), pc]);
        if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
      }
      return found;
    }

    const OPCODES = { CREATE: 0xf0, CALL: 0xf1, CALLCODE: 0xf2, DELEGATECALL: 0xf4, CREATE2: 0xf5, STATICCALL: 0xfa, SELFDESTRUCT: 0xff };

    it("runs no DELEGATECALL and no SELFDESTRUCT, and creates no contract", async function () {
      const { feeHook, positionManager } = await loadFixture(launched);

      // The walk tells code from data: the same bytes count as an opcode, inside a PUSH they do
      // not, and in the metadata they do not.
      expect(opcodesOf("0x33ff0000").has(OPCODES.SELFDESTRUCT)).to.equal(true);
      expect(opcodesOf("0x5bf40000").has(OPCODES.DELEGATECALL)).to.equal(true);
      expect(opcodesOf("0x60ff61f4ff7f" + "f4".repeat(32) + "0000").has(OPCODES.SELFDESTRUCT)).to.equal(false);
      expect(opcodesOf("0x60ff61f4ff7f" + "f4".repeat(32) + "0000").has(OPCODES.DELEGATECALL)).to.equal(false);
      expect(opcodesOf("0x00" + "fff4" + "0002").has(OPCODES.SELFDESTRUCT)).to.equal(false);
      // And it finds the opcode in real code that has it: the PositionManager's multicall.
      expect(opcodesOf(await ethers.provider.getCode(positionManager.target)).has(OPCODES.DELEGATECALL)).to.equal(true);

      // The code that runs at the hook's address, immutables filled in.
      const ops = opcodesOf(await ethers.provider.getCode(feeHook.target));
      for (const name of ["DELEGATECALL", "CALLCODE", "SELFDESTRUCT", "CREATE", "CREATE2"]) {
        expect(ops.get(OPCODES[name]) ?? [], `${name} at`).to.deep.equal([]);
      }
      // It does call out, which is what the ABI list above is about.
      expect(ops.has(OPCODES.CALL)).to.equal(true);
      expect(ops.has(OPCODES.STATICCALL)).to.equal(true);
    });
  });
});
