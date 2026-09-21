const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4Fee } = require("../v4/helpers");

const E = ethers.parseEther;
const SUPPLY = E("1000000");
const PLATFORM_TAX_BPS = 25;
// TokenFactory.TokenType
const Standard = 0, Tax = 1, Rewards = 2;
const KINDS = [
  ["Standard", Standard, "standardDeployer"],
  ["Tax", Tax, "taxDeployer"],
  ["Rewards", Rewards, "rewardsDeployer"],
];

// The Fee generation of token deployers: the V4 generation with a second launcher recognised.
// launch.test.js drives them through the factory and the launchers. Here they are called the way
// TokenFactory calls them, from its address and with its arguments, so every branch can be given
// the same input in each generation and the outputs compared byte for byte.
describe("V4 fee mode token deployers", function () {
  async function platform() {
    const ctx = await deployPlatformV4Fee();
    const { tokenFactory, quickLaunch, v3Factory, weth } = ctx;

    // The first generation, which knows no launcher at all and only ever made V2 tokens. The
    // base fixture keeps its rewards deployer; the other two are deployed again.
    const v2Deployers = {
      standardDeployer: await ethers.deployContract("StandardTokenDeployer", [tokenFactory.target]),
      taxDeployer: await ethers.deployContract("TaxTokenDeployer", [tokenFactory.target]),
      rewardsDeployer: ctx.rewardsDeployer,
    };

    // A tokenized stock that trades against WETH on Uniswap V3, and the platform's route to it,
    // stored while the Fee generation is the one the factory names: QuickLaunch finds the V3
    // factory through the rewards deployer's v3Router().
    const stock = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E("1000000")]);
    await v3Factory.createPool(weth.target, stock.target, 3000);
    const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, stock.target, 3000));
    await weth.deposit({ value: E("50") });
    await weth.transfer(pool.target, E("50"));
    await stock.transfer(pool.target, E("345"));
    await pool.sync();
    const path = ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, stock.target]);
    expect(await tokenFactory.rewardsDeployer()).to.equal(ctx.feeDeployers.rewardsDeployer.target);
    await quickLaunch.setRewardTokenAllowed(stock.target, true);
    await quickLaunch.setRewardRouteV3(stock.target, path);

    return { ...ctx, v2Deployers, stock, path };
  }

  /** The factory's address as a sender, set up inside each test, after the fixture is loaded. */
  async function asFactory(ctx) {
    await setBalance(ctx.tokenFactory.target, E("10"));
    return ethers.getImpersonatedSigner(ctx.tokenFactory.target);
  }

  /** What TokenFactory passes to the deployer of a kind, for a given creator. */
  function argsFor(ctx, kind, creator, v2 = {}) {
    const { treasury, router, marketing, stock } = ctx;
    const common = [
      "Same",
      "SAME",
      SUPPLY,
      creator,
      v2.treasury ?? treasury.target,
      v2.router ?? router.target,
      v2.platformTaxBps ?? PLATFORM_TAX_BPS,
    ];
    if (kind === Standard) return common;
    if (kind === Tax) return [...common, v2.marketingWallet ?? marketing.address, 300, 500];
    // [rewardsBuy, rewardsSell, marketingBuy, marketingSell]
    return [...common, stock.target, v2.marketingWallet ?? marketing.address, [200, 300, 100, 150]];
  }

  /** Calls `deploy` as the factory and returns the token's address. */
  async function deployAs(factory, deployer, args) {
    const token = await deployer.connect(factory).deploy.staticCall(...args);
    await deployer.connect(factory).deploy(...args);
    expect(await ethers.provider.getCode(token)).to.not.equal("0x");
    return token;
  }

  const word = (address) => (address.target ?? address).slice(2).toLowerCase();
  const codeOf = async (address) => (await ethers.provider.getCode(address)).toLowerCase();

  /** A V2 token's code with the one immutable that follows from its own address blanked: its pair. */
  async function v2CodeOf(address) {
    const token = await ethers.getContractAt("StandardToken", address);
    const pair = await token.mainPair();
    expect(pair).to.not.equal(ethers.ZeroAddress);
    return (await codeOf(address)).replaceAll(word(pair), "0".repeat(40));
  }

  // ------------------------------------------------------------------ who may call

  it("only the factory may call deploy, on all three, whoever else asks and for whichever creator", async function () {
    const ctx = await loadFixture(platform);
    const { feeDeployers, launcher, feeLauncher, presaleFactory, quickLaunch, deployer, alice, keeper } = ctx;
    const callers = [alice, keeper, deployer];
    // The platform's own contracts are no exception, the launchers least of all: a token that
    // names a launcher comes out of the factory's registry or not at all.
    for (const contract of [launcher, feeLauncher, presaleFactory, quickLaunch]) {
      await setBalance(contract.target, E("10"));
      callers.push(await ethers.getImpersonatedSigner(contract.target));
    }
    for (const [label, kind, name] of KINDS) {
      for (const caller of callers) {
        for (const creator of [caller.address, feeLauncher.target, launcher.target]) {
          await expect(
            feeDeployers[name].connect(caller).deploy(...argsFor(ctx, kind, creator)),
            `${label}, ${caller.address}`
          ).to.be.revertedWith("only factory");
        }
      }
    }
  });

  // ------------------------------------------------------------------ the v4 branch

  it("a creator equal to either launcher gets the v4 token, bound to that launcher", async function () {
    const ctx = await loadFixture(platform);
    const { feeDeployers, tokenFactory, dexFactory, weth, stock, path, v3Router, v3Quoter, launcher, hook, feeLauncher, feeHook } = ctx;
    const factory = await asFactory(ctx);

    for (const [mode, itsLauncher, itsHook] of [["hook mode", launcher, hook], ["fee mode", feeLauncher, feeHook]]) {
      for (const [label, kind, name] of KINDS) {
        const at = `${label}, ${mode}`;
        const address = await deployAs(factory, feeDeployers[name], argsFor(ctx, kind, itsLauncher.target));
        const token = await ethers.getContractAt(kind === Rewards ? "RewardsTokenV4" : "HoodSaleTokenV4", address);
        expect(await token.poolVersion(), at).to.equal(4);
        expect(await token.launcher(), at).to.equal(itsLauncher.target);
        expect(await token.tokenFactory(), at).to.equal(tokenFactory.target);
        expect(await token.tokenType(), at).to.equal(kind);
        expect(await token.name(), at).to.equal("Same");
        expect(await token.symbol(), at).to.equal("SAME");
        // The launcher owns the token and the whole supply until it hands both to the creator.
        expect(await token.owner(), at).to.equal(itsLauncher.target);
        expect(await token.totalSupply(), at).to.equal(SUPPLY);
        expect(await token.balanceOf(itsLauncher.target), at).to.equal(SUPPLY);

        // Nothing of a V2 token: no pair was opened and no transfer tax exists.
        expect(await dexFactory.getPair(address, weth.target), at).to.equal(ethers.ZeroAddress);
        const asV2 = await ethers.getContractAt("TaxToken", address);
        await expect(asV2.mainPair(), at).to.be.reverted;
        await expect(asV2.platformTaxBps(), at).to.be.reverted;

        if (kind === Rewards) {
          // The one address that may fund the rewards is the hook of the launcher it names.
          expect(await token.hook(), at).to.equal(itsHook.target);
          expect(await token.rewardToken(), at).to.equal(stock.target);
          expect(await token.weth(), at).to.equal(weth.target);
          expect(await token.v3Router(), at).to.equal(v3Router.target);
          expect(await token.v3Quoter(), at).to.equal(v3Quoter.target);
          expect(await token.rewardRouteV3(), at).to.equal(path);
        }
      }
    }
  });

  it("makes that token byte for byte as the V4 generation does, from the same arguments", async function () {
    const ctx = await loadFixture(platform);
    const { feeDeployers, v4Deployers, launcher, hook, feeLauncher, feeHook, alice } = ctx;
    const factory = await asFactory(ctx);

    for (const [label, kind, name] of KINDS) {
      const args = argsFor(ctx, kind, launcher.target);
      const before = await codeOf(await deployAs(factory, v4Deployers[name], args));
      const after = await codeOf(await deployAs(factory, feeDeployers[name], args));
      expect(after, label).to.equal(before);

      // For the fee launcher it is that code again, naming the other launcher and its hook.
      const fee = await codeOf(await deployAs(factory, feeDeployers[name], argsFor(ctx, kind, feeLauncher.target)));
      expect(fee, label).to.not.equal(after);
      expect(fee.replaceAll(word(feeLauncher), word(launcher)).replaceAll(word(feeHook), word(hook)), label).to.equal(after);
      // The V4 generation has never heard of the fee launcher: there it is one more creator.
      const unknown = await deployAs(factory, v4Deployers[name], argsFor(ctx, kind, feeLauncher.target));
      expect(await (await ethers.getContractAt("StandardToken", unknown)).mainPair(), label).to.not.equal(ethers.ZeroAddress);
    }

    // What only a V2 token uses is not even read on this branch: values its constructor would
    // refuse go through, and the code that comes out is the same.
    const junk = { treasury: ethers.ZeroAddress, router: ethers.ZeroAddress, platformTaxBps: 9999, marketingWallet: ethers.ZeroAddress };
    for (const [label, kind, name] of KINDS.slice(0, 2)) {
      const plain = await codeOf(await deployAs(factory, feeDeployers[name], argsFor(ctx, kind, feeLauncher.target)));
      const odd = await codeOf(await deployAs(factory, feeDeployers[name], argsFor(ctx, kind, feeLauncher.target, junk)));
      expect(odd, label).to.equal(plain);
      await expect(
        feeDeployers[name].connect(factory).deploy(...argsFor(ctx, kind, alice.address, junk)),
        label
      ).to.be.revertedWith("zero addr");
    }
  });

  // ------------------------------------------------------------------ the V2 branch

  it("anyone else gets the V2 token of every earlier generation, byte for byte", async function () {
    const ctx = await loadFixture(platform);
    const { feeDeployers, v4Deployers, v2Deployers, tokenFactory, treasury, router, marketing, stock, path, quickLaunch, alice } = ctx;
    const factory = await asFactory(ctx);
    const artifacts = ["StandardToken", "TaxToken", "RewardsToken"];

    for (const [who, creator] of [["a wallet", alice.address], ["QuickLaunch", quickLaunch.target]]) {
      for (const [label, kind, name] of KINDS) {
        const at = `${label}, ${who}`;
        const args = argsFor(ctx, kind, creator);
        const fee = await deployAs(factory, feeDeployers[name], args);
        const v4 = await deployAs(factory, v4Deployers[name], args);
        const v2 = await deployAs(factory, v2Deployers[name], args);
        expect(await v2CodeOf(fee), at).to.equal(await v2CodeOf(v4));
        expect(await v2CodeOf(fee), at).to.equal(await v2CodeOf(v2));

        // The same token in what it stores, too.
        const token = await ethers.getContractAt(artifacts[kind], fee);
        expect(await token.owner(), at).to.equal(creator);
        expect(await token.balanceOf(creator), at).to.equal(SUPPLY);
        expect(await token.platformTreasury(), at).to.equal(treasury.target);
        expect(await token.tokenFactory(), at).to.equal(tokenFactory.target);
        expect(await token.router(), at).to.equal(router.target);
        expect(await token.platformTaxBps(), at).to.equal(PLATFORM_TAX_BPS);
        if (kind === Tax) {
          expect(await token.marketingWallet(), at).to.equal(marketing.address);
          expect(await token.buyTaxBps(), at).to.equal(300);
          expect(await token.sellTaxBps(), at).to.equal(500);
        }
        if (kind === Rewards) {
          expect(await token.rewardToken(), at).to.equal(stock.target);
          expect(await token.marketingWallet(), at).to.equal(marketing.address);
          expect(await token.rewardsBuyTaxBps(), at).to.equal(200);
          expect(await token.rewardsSellTaxBps(), at).to.equal(300);
          expect(await token.marketingBuyTaxBps(), at).to.equal(100);
          expect(await token.marketingSellTaxBps(), at).to.equal(150);
          expect(await token.rewardRouteV3(), at).to.equal(path);
        }
        // A V2 token answers neither v4 call, which is how the fee launcher tells them apart.
        const asV4 = await ethers.getContractAt("HoodSaleTokenV4", fee);
        await expect(asV4.poolVersion(), at).to.be.reverted;
        await expect(asV4.launcher(), at).to.be.reverted;
      }
    }
  });

  it("only the two launchers themselves count: their hooks, lenses and neighbours are ordinary creators", async function () {
    const ctx = await loadFixture(platform);
    const { feeDeployers, launcher, feeLauncher, hook, feeHook, v4FeeLens, v4FeeRouter, presaleFactory, tokenFactory } = ctx;
    const factory = await asFactory(ctx);
    const oneBitOff = (contract) => ethers.getAddress(ethers.toBeHex(BigInt(contract.target) ^ 1n, 20));
    const others = [hook, feeHook, v4FeeLens, v4FeeRouter, presaleFactory, tokenFactory].map((c) => c.target);
    others.push(oneBitOff(launcher), oneBitOff(feeLauncher));

    for (const creator of others) {
      const address = await deployAs(factory, feeDeployers.standardDeployer, argsFor(ctx, Standard, creator));
      const token = await ethers.getContractAt("StandardToken", address);
      expect(await token.mainPair(), creator).to.not.equal(ethers.ZeroAddress);
      expect(await token.owner(), creator).to.equal(creator);
      await expect((await ethers.getContractAt("HoodSaleTokenV4", address)).launcher(), creator).to.be.reverted;
    }
  });

  it("a quick launch, whose creator is the QuickLaunch contract, still lists the V2 rewards token", async function () {
    const ctx = await loadFixture(platform);
    const { v2Deployers, tokenFactory, presaleFactory, quickLaunch, stock, path, marketing, carol } = ctx;
    const q = {
      name: "Quick Yield",
      symbol: "QYLD",
      hardCap: E("1"),
      durationOption: 0,
      creatorSharePercent: 0,
      tokenType: Rewards,
      rewardToken: stock.target,
      taxWallet: marketing.address,
      buyTaxBps: 100,
      sellTaxBps: 100,
      rewardsBuyBps: 200,
      rewardsSellBps: 200,
      logoURI: "",
      description: "",
    };
    const value = await presaleFactory.quickCreationFee();
    const [tokenAddr] = await quickLaunch.connect(carol).launch.staticCall(q, { value });
    await quickLaunch.connect(carol).launch(q, { value });

    const token = await ethers.getContractAt("RewardsToken", tokenAddr);
    expect((await tokenFactory.infoOf(tokenAddr)).creator).to.equal(quickLaunch.target);
    expect(await token.rewardToken()).to.equal(stock.target);
    expect(await token.rewardRouteV3()).to.equal(path);
    // The code the first generation deploys for the same creator
    const reference = await deployAs(await asFactory(ctx), v2Deployers.rewardsDeployer, argsFor(ctx, Rewards, quickLaunch.target));
    expect(await v2CodeOf(tokenAddr)).to.equal(await v2CodeOf(reference));
  });

  // ------------------------------------------------------------------ construction

  it("refuses a missing launcher, the same launcher twice, and a missing code holder", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, launcher, feeLauncher, v3Router, v3Quoter, rewardsTokenCode, rewardsTokenCodeV4 } = ctx;
    const zero = ethers.ZeroAddress;
    const pairs = [
      [zero, zero, "zero launcher"],
      [zero, feeLauncher.target, "zero launcher"],
      [launcher.target, zero, "zero launcher"],
      [launcher.target, launcher.target, "same launcher"],
      [feeLauncher.target, feeLauncher.target, "same launcher"],
    ];
    const rewardsArgs = (code, codeV4, a, b) => [tokenFactory.target, v3Router.target, v3Quoter.target, code, codeV4, a, b];
    for (const [a, b, reason] of pairs) {
      await expect(ethers.deployContract("StandardTokenDeployerFee", [tokenFactory.target, a, b])).to.be.revertedWith(reason);
      await expect(ethers.deployContract("TaxTokenDeployerFee", [tokenFactory.target, a, b])).to.be.revertedWith(reason);
      await expect(
        ethers.deployContract("RewardsTokenDeployerFee", rewardsArgs(rewardsTokenCode.target, rewardsTokenCodeV4.target, a, b))
      ).to.be.revertedWith(reason);
    }
    // The two launchers the other way round are accepted: which is which is the deploy script's to check.
    await ethers.deployContract("StandardTokenDeployerFee", [tokenFactory.target, feeLauncher.target, launcher.target]);

    for (const [code, codeV4] of [[zero, rewardsTokenCodeV4.target], [rewardsTokenCode.target, zero], [zero, zero]]) {
      await expect(
        ethers.deployContract("RewardsTokenDeployerFee", rewardsArgs(code, codeV4, launcher.target, feeLauncher.target))
      ).to.be.revertedWith("zero code");
    }
  });

  it("keeps what it was given, the code holders and the V3 addresses included, with no way to change any of it", async function () {
    const ctx = await loadFixture(platform);
    const { feeDeployers, v4Deployers, tokenFactory, launcher, feeLauncher } = ctx;
    const { v3Router, v3Quoter, rewardsTokenCode, rewardsTokenCodeV4 } = ctx;
    const rewards = feeDeployers.rewardsDeployer;
    expect(await rewards.factory()).to.equal(tokenFactory.target);
    expect(await rewards.v3Router()).to.equal(v3Router.target);
    expect(await rewards.v3Quoter()).to.equal(v3Quoter.target);
    expect(await rewards.rewardsTokenCode()).to.equal(rewardsTokenCode.target);
    expect(await rewards.rewardsTokenCodeV4()).to.equal(rewardsTokenCodeV4.target);
    expect(await rewards.launcher()).to.equal(launcher.target);
    expect(await rewards.feeLauncher()).to.equal(feeLauncher.target);

    // No code holder was deployed again: the four middle values are the V4 generation's own.
    const live = v4Deployers.rewardsDeployer;
    for (const getter of ["v3Router", "v3Quoter", "rewardsTokenCode", "rewardsTokenCodeV4", "factory", "launcher"]) {
      expect(await rewards[getter](), getter).to.equal(await live[getter]());
    }

    // Every value is an immutable, and `deploy` is the only function that is not a read.
    const functionsOf = (contract) =>
      contract.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => `${f.name}${f.constant ? "" : "!"}`)
        .sort();
    const plain = ["deploy!", "factory", "feeLauncher", "launcher"];
    expect(functionsOf(feeDeployers.standardDeployer)).to.deep.equal(plain);
    expect(functionsOf(feeDeployers.taxDeployer)).to.deep.equal(plain);
    expect(functionsOf(rewards)).to.deep.equal(
      [...plain, "platformRouteV3For", "rewardsTokenCode", "rewardsTokenCodeV4", "v3Quoter", "v3Router"].sort()
    );
    for (const deployer of Object.values(feeDeployers)) {
      for (let slot = 0; slot < 4; slot++) {
        expect(await ethers.provider.getStorage(deployer.target, slot)).to.equal(ethers.ZeroHash);
      }
    }
  });

  // ------------------------------------------------------------------ the platform's V3 route

  it("platformRouteV3For answers as every earlier generation does", async function () {
    const ctx = await loadFixture(platform);
    const { feeDeployers, v4Deployers, v2Deployers, quickLaunch, weth, stock, path, hoodsale, alice } = ctx;
    const generations = [feeDeployers.rewardsDeployer, v4Deployers.rewardsDeployer, v2Deployers.rewardsDeployer];
    const expectAll = async (rewardToken, route) => {
      for (const deployer of generations) expect(await deployer.platformRouteV3For(rewardToken)).to.equal(route);
    };

    await expectAll(stock.target, path);
    // WETH needs no route, and nothing is stored for a token the platform has no route to.
    await expectAll(weth.target, "0x");
    await expectAll(hoodsale.target, "0x");
    await expectAll(alice.address, "0x");
    await expectAll(ethers.ZeroAddress, "0x");

    // It follows the store: a route taken away is gone for tokens created from then on.
    await quickLaunch.setRewardRouteV3(stock.target, "0x");
    await expectAll(stock.target, "0x");
    await quickLaunch.setRewardRouteV3(stock.target, path);
    await expectAll(stock.target, path);
  });

  it("platformRouteV3For is empty, never a revert, when a link of the chain to the store is missing", async function () {
    const ctx = await loadFixture(platform);
    const { deployer, tokenFactory, treasury, router, locker, quickLaunch, launcher, feeLauncher, stock, path, alice } = ctx;
    const { v3Router, v3Quoter, rewardsTokenCode, rewardsTokenCodeV4 } = ctx;
    const build = (factory, router3 = v3Router.target) =>
      ethers.deployContract("RewardsTokenDeployerFee", [
        factory,
        router3,
        v3Quoter.target,
        rewardsTokenCode.target,
        rewardsTokenCodeV4.target,
        launcher.target,
        feeLauncher.target,
      ]);
    const newFactory = () => ethers.deployContract("TokenFactory", [deployer.address, treasury.target, router.target]);

    // A chain with no Uniswap V3: there is no route to give, whatever is stored.
    expect(await (await build(tokenFactory.target, ethers.ZeroAddress)).platformRouteV3For(stock.target)).to.equal("0x");

    // A factory that has no presale factory yet
    const bare = await newFactory();
    expect(await (await build(bare.target)).platformRouteV3For(stock.target)).to.equal("0x");

    // A presale factory that is a wallet, or a contract that does not answer quickLaunch()
    for (const presaleFactory of [alice.address, treasury.target]) {
      const factory = await newFactory();
      await factory.setPresaleFactory(presaleFactory);
      expect(await (await build(factory.target)).platformRouteV3For(stock.target)).to.equal("0x");
    }

    // A presale factory with no QuickLaunch set, and one whose QuickLaunch is not a route store
    const factory = await newFactory();
    const presaleFactory = await ethers.deployContract("PresaleFactory", [
      deployer.address,
      treasury.target,
      factory.target,
      locker.target,
      router.target,
    ]);
    await factory.setPresaleFactory(presaleFactory.target);
    const rewards = await build(factory.target);
    expect(await rewards.platformRouteV3For(stock.target)).to.equal("0x");
    await presaleFactory.setQuickLaunch(treasury.target);
    expect(await rewards.platformRouteV3For(stock.target)).to.equal("0x");
    // And with the platform's store behind it, the route
    await presaleFactory.setQuickLaunch(quickLaunch.target);
    expect(await rewards.platformRouteV3For(stock.target)).to.equal(path);
  });
});
