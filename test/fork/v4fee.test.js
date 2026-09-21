// Rehearsal of the Uniswap v4 fee mode on a Robinhood Chain mainnet fork, on top of the LIVE
// platform: the real TokenFactory, PresaleFactory and PresaleCode, Treasury, QuickLaunch reward
// routes and hook mode launcher, and Uniswap's real PoolManager, PositionManager, Permit2,
// StateView, V4Quoter and Universal Router. scripts/deploy-v4-fee.js runs as the platform owner
// (impersonated on the fork, no key involved) down to TokenFactory.setDeployers, and then sales are
// created, filled and finalized the way the site does it.
//
// The offline suites (test/v4fee) run the same bytecode locally. What only a fork can show is that
// the deploy script works against the live state, that the live sale contract launches through the
// fee launcher, that Uniswap's own router and quoter trade a pool behind the gate hook exactly as
// the Uniswap app would, and that hook mode and V2 launches survive the new deployers.
//
// Run: npm run test:fork:v4fee
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("./helpers");
const V4 = require("../v4/helpers");
const { main: deployFeeMode } = require("../../scripts/deploy-v4-fee");

/** The live platform and the proof pool that was opened behind the gate hook on 2026-09-20. */
const LIVE_FILE = path.join(__dirname, "..", "..", "deployments", "robinhood.json");
const LIVE = require(LIVE_FILE);
const PROOF = require("../../deployments/fee-hook-proof.json");

const E = ethers.parseEther;
const DAY = 86400n;
const PLATFORM_BPS = 25n;
const Lock = 0, Burn = 1;
// TokenFactory.TokenType
const Standard = 0, Tax = 1, Rewards = 2;
const { ROBINHOOD } = H;

const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
];
const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle(((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
];
const PERMIT2_ABI = ["function approve(address token, address spender, uint160 amount, uint48 expiration)"];
const APPROVE_ABI = ["function approve(address spender, uint256 value) returns (bool)"];
const POOL_MANAGER_ABI = [
  "function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24 tick)",
];
const POSITION_MANAGER_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
];

// Universal Router command and v4 actions used below.
const CMD_V4_SWAP = "0x10";
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;
const KEY_TUPLE = "(address,address,uint24,int24,address)";
/** The widest range a pool of tick spacing 200 has, the one the launch position takes. */
const FULL_RANGE = [-887200, 887200];

const coder = ethers.AbiCoder.defaultAbiCoder();

/** The id Uniswap v4 gives a pool: the hash of its key. */
function poolIdOf(key) {
  return ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], key));
}

if (!process.env.FORK_URL) {
  describe.skip("Robinhood Chain fork (Uniswap v4 fee mode on the live platform)", function () {
    it("skipped: FORK_URL is not set, run `npm run test:fork:v4fee`", function () {});
  });
} else {
  describe("Robinhood Chain fork (Uniswap v4 fee mode on the live platform)", forkSuite);
}

function forkSuite() {
  let ctx;
  /** The Tax launch of section 2, which the rollback at the end trades once more. */
  let tax;
  /** The fee mode pool keys this run created, for the routing rule at the end. */
  const feeKeys = [];

  before(async function () {
    this.timeout(600000);
    await H.mineOne();
    const info = await H.forkInfo();
    expect(info.chainId).to.equal(4663);
    ctx = await liveOnFork();
    console.log(`      [fork] block ${info.forkBlockNumber}, platform owner ${ctx.owner.address}`);
  });

  after(function () {
    if (ctx) fs.rmSync(path.dirname(ctx.file), { recursive: true, force: true });
  });

  /** The live platform as the fork sees it, its owner and keeper impersonated, the users funded. */
  async function liveOnFork() {
    const [, alice, bob, carol, dave, marketing] = await ethers.getSigners();
    const tokenFactory = await ethers.getContractAt("TokenFactory", LIVE.tokenFactory);
    const presaleFactory = await ethers.getContractAt("PresaleFactory", LIVE.presaleFactory);
    const hookLauncher = await ethers.getContractAt("V4Launcher", LIVE.v4Launcher);

    // Whoever owns TokenFactory on chain is the wallet the deploy script has to be run by.
    const owner = await ethers.getImpersonatedSigner(await tokenFactory.owner());
    const keeper = await ethers.getImpersonatedSigner(await hookLauncher.keeper());
    await H.fundSigners([owner, keeper, alice, bob, carol, dave, marketing], E("100000"));

    // The script records what it deploys, so it works on a copy and the live record stays as it is.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hoodsale-v4fee-")), "robinhood.json");
    writeRecord(file, startingRecord());

    return {
      file,
      owner,
      keeper,
      alice,
      bob,
      carol,
      dave,
      marketing,
      tokenFactory,
      presaleFactory,
      hookLauncher,
      treasury: await ethers.getContractAt("Treasury", LIVE.treasury),
      lens: await ethers.getContractAt("HoodSaleLens", LIVE.lens),
      quickLaunch: await ethers.getContractAt("QuickLaunch", LIVE.quickLaunch),
      poolManager: new ethers.Contract(LIVE.v4PoolManager, POOL_MANAGER_ABI, ethers.provider),
      positionManager: new ethers.Contract(LIVE.v4PositionManager, POSITION_MANAGER_ABI, ethers.provider),
      stateView: new ethers.Contract(LIVE.v4StateView, STATE_VIEW_ABI, ethers.provider),
      quoter: new ethers.Contract(LIVE.v4Quoter, QUOTER_ABI, ethers.provider),
    };
  }

  /**
   * The record the rehearsal starts from: the live one without any fee mode key, so the script
   * deploys a fee mode of its own here even once the live record carries one.
   */
  function startingRecord() {
    return Object.fromEntries(Object.entries(LIVE).filter(([k]) => !k.startsWith("v4Fee")));
  }

  const writeRecord = (file, d) => fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");

  /** Runs the deploy script without its report; the lines are printed only when it fails. */
  async function runDeployScript() {
    const lines = [];
    const log = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      return await deployFeeMode({ file: ctx.file, signer: ctx.owner });
    } catch (e) {
      log(lines.join("\n"));
      throw e;
    } finally {
      console.log = log;
    }
  }

  const recorded = () => JSON.parse(fs.readFileSync(ctx.file, "utf8"));
  const deployersOf = async (tokenFactory) => [
    await tokenFactory.standardDeployer(),
    await tokenFactory.taxDeployer(),
    await tokenFactory.rewardsDeployer(),
  ];

  // ---------------------------------------------------------------- trade helpers

  /** Lets Uniswap's Universal Router pull a seller's tokens the way the Uniswap app arranges it, over Permit2. */
  async function approveRouter(signer, tokenAddr, amount) {
    await new ethers.Contract(tokenAddr, APPROVE_ABI, signer).approve(LIVE.permit2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(LIVE.permit2, PERMIT2_ABI, signer);
    await permit2.approve(tokenAddr, LIVE.v4UniversalRouter, amount, 2n ** 48n - 1n);
  }

  /**
   * One exact-input swap through Uniswap's Universal Router, encoded as the Uniswap app sends it:
   * the V4_SWAP command carrying SWAP_EXACT_IN_SINGLE, SETTLE_ALL and TAKE_ALL. `minOut` guards
   * both the swap and the take, so a quote passed here must be met to the wei.
   */
  async function routerSwap(signer, key, zeroForOne, amountIn, minOut = 0n) {
    const [currencyIn, currencyOut] = zeroForOne ? [key[0], key[1]] : [key[1], key[0]];
    const actions = ethers.solidityPacked(
      ["uint8", "uint8", "uint8"],
      [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]
    );
    const params = [
      coder.encode(
        [`(${KEY_TUPLE} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`],
        [[key, zeroForOne, amountIn, minOut, "0x"]]
      ),
      coder.encode(["address", "uint256"], [currencyIn, amountIn]),
      coder.encode(["address", "uint256"], [currencyOut, minOut]),
    ];
    const router = new ethers.Contract(LIVE.v4UniversalRouter, UNIVERSAL_ROUTER_ABI, signer);
    const tx = await router.execute(
      CMD_V4_SWAP,
      [coder.encode(["bytes", "bytes[]"], [actions, params])],
      await H.deadline(),
      { value: zeroForOne ? amountIn : 0n }
    );
    return tx.wait();
  }

  /** Buys through the Universal Router at the live quoter's price and returns what came out. */
  async function routerBuy(signer, key, amountIn) {
    const token = H.erc20At(key[1]);
    const [quoted] = await ctx.quoter.quoteExactInputSingle.staticCall([key, true, amountIn, "0x"]);
    const before = await token.balanceOf(signer.address);
    await routerSwap(signer, key, true, amountIn, quoted);
    const received = (await token.balanceOf(signer.address)) - before;
    return { quoted, received };
  }

  /** Sells through the Universal Router at the live quoter's price and returns the ETH that came out. */
  async function routerSell(signer, key, amountIn) {
    await approveRouter(signer, key[1], amountIn);
    const [quoted] = await ctx.quoter.quoteExactInputSingle.staticCall([key, false, amountIn, "0x"]);
    const before = await ethers.provider.getBalance(signer.address);
    const receipt = await routerSwap(signer, key, false, amountIn, quoted);
    const received = (await ethers.provider.getBalance(signer.address)) - before + receipt.fee;
    return { quoted, received };
  }

  // ---------------------------------------------------------------- sale helpers

  const specFor = (symbol, rewardToken = ethers.ZeroAddress) => ({
    name: `Fork ${symbol}`,
    symbol,
    totalSupply: E("1000000"),
    rewardToken,
  });

  /** Creates a token through one of the two launchers, owned by alice. */
  async function createThrough(launcher, tokenType, spec, config) {
    const { alice } = ctx;
    await launcher.connect(alice).createToken(tokenType, spec, config, alice.address);
    const created = await launcher.tokensOfCreator(alice.address);
    return created[created.length - 1];
  }

  /** A sale on the live PresaleFactory for a token alice owns, filled to its hard cap. */
  async function fillSale(tokenAddr, overrides = {}) {
    const { presaleFactory, alice, bob, carol } = ctx;
    const start = BigInt(await time.latest()) + 100n;
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
      ...overrides,
    };
    const token = new ethers.Contract(tokenAddr, APPROVE_ABI, alice);
    await token.approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
    // The live factory's fee, whatever the owner has set it to.
    await presaleFactory.connect(alice).createPresale(params, { value: await presaleFactory.creationFee() });
    const presale = await ethers.getContractAt(
      "Presale",
      await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n)
    );
    await time.increaseTo(start);
    await presale.connect(bob).contribute({ value: E("5") });
    await presale.connect(carol).contribute({ value: E("5") });
    return presale;
  }

  /** Finalizes a filled sale as its owner and hands the buyers their tokens. */
  async function finalize(presale) {
    const { alice, bob, carol } = ctx;
    const receipt = await (await presale.connect(alice).finalize(0, 0)).wait();
    await presale.connect(bob).claim();
    await presale.connect(carol).claim();
    return receipt;
  }

  /** What a v4 launch left on chain, read back from its launcher. */
  async function launchedThrough(launcher, tokenAddr) {
    const key = V4.keyArray(await launcher.poolKeyOf(tokenAddr));
    const launch = await launcher.launchOf(tokenAddr);
    return { tokenAddr, key, launch, poolId: launch.poolId };
  }

  /**
   * Turns a pool's fees into ETH the way the keeper does: reads what a collect would bring,
   * quotes the size the hook will sell on the live quoter and sends that quote, less one percent,
   * as the price floor. Returns what was collected and what the conversion brought.
   */
  async function convertWithFloor(poolId, key, caller) {
    const { feeHook, quoter } = ctx;
    const preview = await feeHook.collect.staticCall(poolId);
    const tokens = (await feeHook.pendingTokens(poolId)) + preview.tokenFees;
    const cap = await feeHook.maxConvert(poolId);
    const amount = tokens < cap ? tokens : cap;
    const [quoted] = await quoter.quoteExactInputSingle.staticCall([key, false, amount, "0x"]);
    await expect(feeHook.connect(caller).convert(poolId, amount, (quoted * 9900n) / 10_000n, await H.deadline()))
      .to.emit(feeHook, "Converted")
      .withArgs(poolId, caller.address, amount, quoted);
    return { ethFees: preview.ethFees, tokenFees: preview.tokenFees, tokensSold: amount, ethOut: quoted };
  }

  /** The revert payload of a call, so a hook's error can be found inside the PoolManager's wrapper. */
  async function revertDataOf(call) {
    try {
      await call;
    } catch (error) {
      return error.data ?? error.info?.error?.data ?? "";
    }
    return null;
  }

  // ---------------------------------------------------------------- 0. the proof pool

  describe("0. the proof pool that is live on mainnet", function () {
    it("Uniswap's Universal Router buys from a pool behind the gate hook, at the quoter's price", async function () {
      this.timeout(600000);
      const { stateView, dave } = ctx;
      const key = [ethers.ZeroAddress, PROOF.token, PROOF.feePips, 200, PROOF.hook];
      expect(poolIdOf(key)).to.equal(PROOF.poolId);
      expect(BigInt(PROOF.hook) & BigInt(V4.ALL_HOOK_MASK)).to.equal(BigInt(V4.FEE_HOOK_FLAGS));
      const slot0 = await H.withRetry(() => stateView.getSlot0(PROOF.poolId), { label: "proof pool" });
      expect(slot0.lpFee).to.equal(PROOF.feePips);
      expect(await stateView.getLiquidity(PROOF.poolId)).to.be.greaterThan(0);

      const { quoted, received } = await routerBuy(dave, key, E("0.0002"));
      expect(received).to.be.greaterThan(0);
      expect(received).to.equal(quoted);
      feeKeys.push(key);
    });
  });

  // ---------------------------------------------------------------- 1. the deploy script

  describe("1. scripts/deploy-v4-fee.js, run as the platform owner", function () {
    let liveDeployers;

    it("deploys and wires everything, and with SKIP_SET_DEPLOYERS leaves the platform as it was", async function () {
      this.timeout(1200000);
      const { tokenFactory, file, alice, marketing } = ctx;
      liveDeployers = await deployersOf(tokenFactory);
      expect(liveDeployers).to.deep.equal([LIVE.standardDeployer, LIVE.taxDeployer, LIVE.rewardsDeployer]);

      process.env.SKIP_SET_DEPLOYERS = "1";
      let result;
      try {
        result = await H.withSnapshotRetry(
          async () => {
            // A retry starts from the snapshot, where nothing recorded so far exists any more.
            writeRecord(file, startingRecord());
            return runDeployScript();
          },
          { label: "deploy-v4-fee (SKIP_SET_DEPLOYERS)" }
        );
      } finally {
        delete process.env.SKIP_SET_DEPLOYERS;
      }
      expect(result.sent).to.equal(false);
      expect(await deployersOf(tokenFactory)).to.deep.equal(liveDeployers);

      const d = recorded();
      for (const k of ["v4FeeLauncher", "v4FeeHook", "v4FeeHookSalt", "v4FeeLens", "v4FeeRouter", "v4FeeFromBlock"]) {
        expect(d[k], k).to.not.equal(undefined);
      }
      // The factory still names the deployers it had, and those are recorded under the old keys.
      expect([d.standardDeployer, d.taxDeployer, d.rewardsDeployer]).to.deep.equal(liveDeployers);

      ctx.feeLauncher = await ethers.getContractAt("V4FeeLauncher", d.v4FeeLauncher);
      ctx.feeHook = await ethers.getContractAt("HoodSaleV4FeeHook", d.v4FeeHook);
      ctx.v4FeeLens = await ethers.getContractAt("HoodSaleV4Lens", d.v4FeeLens);
      ctx.v4FeeRouter = await ethers.getContractAt("HoodSaleV4Router", d.v4FeeRouter);

      // Until setDeployers the factory hands the fee launcher a V2 token, which it refuses.
      await expect(
        ctx.feeLauncher
          .connect(alice)
          .createToken(Tax, specFor("EARLY"), V4.feeTaxConfig(marketing.address, { marketingBps: 300 }), alice.address)
      ).to.be.revertedWithCustomError(ctx.feeLauncher, "NotFeeToken");
    });

    it("binds the new contracts to the live ones", async function () {
      this.timeout(600000);
      const { feeLauncher, feeHook, v4FeeLens, v4FeeRouter, owner, keeper } = ctx;
      expect(BigInt(feeHook.target) & BigInt(V4.ALL_HOOK_MASK)).to.equal(0x2800n);
      expect(feeHook.target.toLowerCase().startsWith("0x91")).to.equal(false);
      expect(await feeHook.launcher()).to.equal(feeLauncher.target);
      expect(await feeHook.poolManager()).to.equal(ethers.getAddress(LIVE.v4PoolManager));
      expect(await feeHook.positionManager()).to.equal(ethers.getAddress(LIVE.v4PositionManager));
      expect(await feeHook.platformTreasury()).to.equal(LIVE.treasury);

      expect(await feeLauncher.owner()).to.equal(owner.address);
      expect(await feeLauncher.hook()).to.equal(feeHook.target);
      expect(await feeLauncher.lens()).to.equal(v4FeeLens.target);
      expect(await feeLauncher.keeper()).to.equal(keeper.address);
      expect(await feeLauncher.creationOpen()).to.equal(true);
      expect(await feeLauncher.tokenFactory()).to.equal(LIVE.tokenFactory);
      expect(await feeLauncher.presaleFactory()).to.equal(LIVE.presaleFactory);
      expect(await feeLauncher.treasury()).to.equal(LIVE.treasury);
      expect(await feeLauncher.permit2()).to.equal(LIVE.permit2);

      expect(await v4FeeLens.launcher()).to.equal(feeLauncher.target);
      expect(await v4FeeLens.hook()).to.equal(feeHook.target);
      expect(await v4FeeRouter.launcher()).to.equal(feeLauncher.target);
    });

    it("sends setDeployers last and records the generation it replaced as the rollback", async function () {
      this.timeout(1200000);
      const { tokenFactory, feeLauncher, file } = ctx;
      const inspected = recorded();
      const result = await H.withSnapshotRetry(
        async () => {
          writeRecord(file, inspected);
          return runDeployScript();
        },
        { label: "deploy-v4-fee" }
      );
      expect(result.sent).to.equal(true);

      const d = recorded();
      const feeDeployers = [d.v4FeeStandardDeployer, d.v4FeeTaxDeployer, d.v4FeeRewardsDeployer];
      expect(await deployersOf(tokenFactory)).to.deep.equal(feeDeployers);
      expect([d.standardDeployer, d.taxDeployer, d.rewardsDeployer]).to.deep.equal(feeDeployers);
      expect([d.previousStandardDeployer, d.previousTaxDeployer, d.previousRewardsDeployer]).to.deep.equal(liveDeployers);
      // What previous* held before, the generation older than v4, is kept and not overwritten.
      expect(d.deployersBeforeV4).to.deep.equal(
        LIVE.deployersBeforeV4 ?? {
          standard: LIVE.previousStandardDeployer,
          tax: LIVE.previousTaxDeployer,
          rewards: LIVE.previousRewardsDeployer,
        }
      );

      const live = await ethers.getContractAt("RewardsTokenDeployerV4", liveDeployers[2]);
      const rewards = await ethers.getContractAt("RewardsTokenDeployerFee", d.v4FeeRewardsDeployer);
      const names = ["StandardTokenDeployerFee", "TaxTokenDeployerFee", "RewardsTokenDeployerFee"];
      for (const [i, name] of names.entries()) {
        const c = await ethers.getContractAt(name, feeDeployers[i]);
        expect(await c.factory(), name).to.equal(LIVE.tokenFactory);
        expect(await c.launcher(), name).to.equal(LIVE.v4Launcher);
        expect(await c.feeLauncher(), name).to.equal(feeLauncher.target);
      }
      // No code holder is deployed again: the reward tokens are built from the very same code.
      expect(await rewards.rewardsTokenCode()).to.equal(await live.rewardsTokenCode());
      expect(await rewards.rewardsTokenCodeV4()).to.equal(await live.rewardsTokenCodeV4());
      expect(await rewards.v3Router()).to.equal(ROBINHOOD.v3.router);
      expect(await rewards.v3Quoter()).to.equal(ROBINHOOD.v3.quoter);
    });

    it("sends nothing when it is run once more", async function () {
      this.timeout(1200000);
      const { owner } = ctx;
      const nonce = await ethers.provider.getTransactionCount(owner.address);
      const before = recorded();
      const result = await runDeployScript();
      expect(result.sent).to.equal(false);
      expect(await ethers.provider.getTransactionCount(owner.address)).to.equal(nonce);
      expect(recorded()).to.deep.equal(before);
    });
  });

  // ---------------------------------------------------------------- 2. a Tax launch

  describe("2. a fee mode Tax launch, 3% to marketing", function () {
    const BUY = E("0.5");
    const SELL = E("200");
    const TOTAL = PLATFORM_BPS + 300n;

    it("the live sale contract binds the launch to the tax it was created with", async function () {
      this.timeout(600000);
      const { feeLauncher, alice, marketing } = ctx;
      const config = V4.feeTaxConfig(marketing.address, { marketingBps: 300 });
      const tokenAddr = await createThrough(feeLauncher, Tax, specFor("FTAX"), config);
      // A Lock sale, so the launch also shows what fee mode makes of a timed lock.
      const presale = await fillSale(tokenAddr, { liquidityAction: Lock });
      expect(await presale.isV4Launch()).to.equal(true);
      expect(await presale.v4Launcher()).to.equal(feeLauncher.target);
      expect(await presale.v4TermsHold()).to.equal(true);

      // The pool's fee follows the pending tax, so a changed tax is a changed pool: no listing.
      await feeLauncher.connect(alice).setTaxConfig(tokenAddr, V4.feeTaxConfig(marketing.address, { marketingBps: 400 }));
      expect((await feeLauncher.keyFor(tokenAddr)).fee).to.equal(42500);
      expect(await presale.v4TermsHold()).to.equal(false);
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWithCustomError(presale, "V4TermsBroken");
      await feeLauncher.connect(alice).setTaxConfig(tokenAddr, config);
      expect(await presale.v4TermsHold()).to.equal(true);

      tax = { tokenAddr, presale, token: await ethers.getContractAt("HoodSaleTokenV4", tokenAddr) };
    });

    it("opens a real Uniswap v4 pool whose fee is the tax, the position held by the hook for good", async function () {
      this.timeout(600000);
      const { feeLauncher, feeHook, stateView, positionManager } = ctx;
      const tx = await tax.presale.connect(ctx.alice).finalize(0, 0);
      await expect(tx).to.emit(feeLauncher, "LockTreatedAsForever").withArgs(tax.tokenAddr, tax.presale.target, 30n * DAY);
      await expect(tx).to.emit(feeHook, "LiquiditySeeded");
      const receipt = await tx.wait();
      await tax.presale.connect(ctx.bob).claim();
      await tax.presale.connect(ctx.carol).claim();
      Object.assign(tax, await launchedThrough(feeLauncher, tax.tokenAddr));
      const { key, launch, poolId } = tax;
      feeKeys.push(key);

      // The pool key: native ETH against the token, the tax as the fee, the gate hook.
      expect(key).to.deep.equal([ethers.ZeroAddress, tax.tokenAddr, Number(TOTAL) * 100, 200, feeHook.target]);
      expect(poolIdOf(key)).to.equal(poolId);
      expect(await feeHook.poolIdOf(tax.tokenAddr)).to.equal(poolId);

      const slot0 = await stateView.getSlot0(poolId);
      const price = (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * 10n ** 18n) >> 192n;
      expect(price).to.be.closeTo(E("800"), E("0.5"));
      expect(slot0.lpFee).to.equal(TOTAL * 100n);
      // Every fee figure below assumes Uniswap's protocol fee is off, as it is today.
      expect(slot0.protocolFee, "Uniswap's protocol fee is switched on").to.equal(0);

      // The launch position is the pool's whole liquidity, and Uniswap's own PositionManager
      // names the hook as its holder whichever of Lock and Burn the sale asked for.
      expect(launch.done).to.equal(true);
      expect(launch.burned).to.equal(true);
      expect(launch.lockId).to.equal(0);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);
      expect(await feeHook.positionIdOf(poolId)).to.equal(launch.tokenId);
      expect(await feeHook.seeded(poolId)).to.equal(true);
      tax.liquidity = await positionManager.getPositionLiquidity(launch.tokenId);
      expect(tax.liquidity).to.be.greaterThan(0);
      expect(await stateView.getLiquidity(poolId)).to.equal(tax.liquidity);

      // What the live sale keeps of it.
      expect(await tax.presale.v4PoolId()).to.equal(poolId);
      expect(await tax.presale.v4PositionId()).to.equal(launch.tokenId);
      expect(await tax.presale.lpLockId()).to.equal(0);
      expect(await tax.presale.v4TermsHold()).to.equal(true);
      // Nothing of the launch stays in the launcher.
      expect(await ethers.provider.getBalance(feeLauncher.target)).to.equal(0);
      expect(await tax.token.balanceOf(feeLauncher.target)).to.equal(0);
      console.log(`      finalize into a real v4 fee pool: ${receipt.gasUsed} gas`);
    });

    it("lets Uniswap's own Universal Router buy, for exactly what Uniswap's quoter said", async function () {
      this.timeout(600000);
      const { quoted, received } = await routerBuy(ctx.dave, tax.key, BUY);
      expect(received).to.be.greaterThan(0);
      expect(received).to.equal(quoted);
      // The tax is inside the quote: nothing left the trade on its way through a hook.
      expect(await ethers.provider.getBalance(ctx.feeHook.target)).to.equal(0);
    });

    it("lets Uniswap's own Universal Router sell over Permit2, for exactly what the quoter said", async function () {
      this.timeout(600000);
      const { quoted, received } = await routerSell(ctx.bob, tax.key, SELL);
      expect(received).to.be.greaterThan(0);
      expect(received).to.equal(quoted);
    });

    it("trades through the site's own fee mode router at the same price", async function () {
      this.timeout(600000);
      const { v4FeeRouter, quoter, dave } = ctx;
      const spend = E("0.1");
      const [quoted] = await quoter.quoteExactInputSingle.staticCall([tax.key, true, spend, "0x"]);
      const out = await v4FeeRouter
        .connect(dave)
        .buy.staticCall(tax.tokenAddr, 0, dave.address, await H.deadline(), { value: spend });
      expect(out).to.equal(quoted);
    });

    it("refuses a stranger's pool and a stranger's liquidity", async function () {
      this.timeout(600000);
      const { poolManager, positionManager, feeHook, stateView, dave } = ctx;
      const { key, poolId } = tax;
      const slot0 = await stateView.getSlot0(poolId);

      // The same token and hook at another fee would be a second pool with a tax of its own choosing.
      const other = [key[0], key[1], 10000, 200, key[4]];
      const refused = await revertDataOf(poolManager.connect(dave).initialize(other, slot0.sqrtPriceX96));
      expect(refused, "the pool was opened").to.be.a("string");
      expect(refused).to.include(feeHook.interface.getError("NotLauncher").selector.slice(2));

      // dave holds tokens from his buy and offers them through Uniswap's PositionManager.
      const tokens = await tax.token.balanceOf(dave.address);
      await tax.token.connect(dave).approve(LIVE.permit2, ethers.MaxUint256);
      const permit2 = new ethers.Contract(LIVE.permit2, PERMIT2_ABI, dave);
      await permit2.approve(tax.tokenAddr, LIVE.v4PositionManager, 2n ** 160n - 1n, 2n ** 48n - 1n);
      const near = (slot0.tick / 200n) * 200n;
      const closed = feeHook.interface.getError("LiquidityClosed").selector.slice(2);
      for (const [tickLower, tickUpper, recipient] of [
        [...FULL_RANGE, dave.address],
        [...FULL_RANGE, feeHook.target],
        [near - 200n, near + 200n, dave.address],
      ]) {
        const mint = V4.mintCalldata({
          key: { currency0: key[0], currency1: key[1], fee: key[2], tickSpacing: key[3], hooks: key[4] },
          tickLower,
          tickUpper,
          liquidity: 10n ** 15n,
          amount0Max: E("1"),
          amount1Max: tokens,
          recipient,
        });
        const data = await revertDataOf(
          positionManager.connect(dave).modifyLiquidities(mint, await H.deadline(), { value: E("1") })
        );
        expect(data, "the mint went through").to.be.a("string");
        expect(data).to.include(closed);
      }
      expect(await stateView.getLiquidity(poolId)).to.equal(tax.liquidity);
    });

    it("collects exactly the pool fee of both trades: ETH from the buy, tokens from the sell", async function () {
      this.timeout(600000);
      const { feeHook, positionManager, dave } = ctx;
      const { poolId, launch } = tax;
      const platformBefore = await feeHook.pendingPlatform();
      const preview = await feeHook.collect.staticCall(poolId);
      // Uniswap rounds the fee up per swap and the growth per unit of liquidity down.
      expect(preview.ethFees).to.be.closeTo((BUY * TOTAL) / 10_000n, 2n);
      expect(preview.tokenFees).to.be.closeTo((SELL * TOTAL) / 10_000n, 2n);

      await expect(feeHook.connect(dave).collect(poolId))
        .to.emit(feeHook, "FeesCollected")
        .withArgs(poolId, preview.ethFees, preview.tokenFees);
      const marketingShare = (preview.ethFees * 300n) / TOTAL;
      expect(await feeHook.pendingMarketing(poolId)).to.equal(marketingShare);
      expect(await feeHook.pendingRewards(poolId)).to.equal(0);
      expect((await feeHook.pendingPlatform()) - platformBefore).to.equal(preview.ethFees - marketingShare);
      expect(await feeHook.pendingTokens(poolId)).to.equal(preview.tokenFees);

      // Collecting takes the fees and nothing else.
      expect(await positionManager.getPositionLiquidity(launch.tokenId)).to.equal(tax.liquidity);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);
    });

    it("converts the token side in the same pool under a price floor from Uniswap's quoter", async function () {
      this.timeout(600000);
      const { feeHook, quoter, positionManager, dave } = ctx;
      const { poolId, key, launch } = tax;
      const pending = await feeHook.pendingTokens(poolId);
      expect(pending).to.be.lessThan(await feeHook.maxConvert(poolId));
      const [quoted] = await quoter.quoteExactInputSingle.staticCall([key, false, pending, "0x"]);

      // A floor one wei above what the pool pays is refused, and starts no cooldown.
      await expect(feeHook.connect(dave).convert(poolId, pending, quoted + 1n, await H.deadline()))
        .to.be.revertedWithCustomError(feeHook, "TooLittleReceived")
        .withArgs(quoted, quoted + 1n);

      const booked = (await feeHook.pendingMarketing(poolId)) + (await feeHook.pendingPlatform());
      const result = await convertWithFloor(poolId, key, dave);
      expect(result.tokensSold).to.equal(pending);
      expect(await feeHook.pendingTokens(poolId)).to.equal(0);
      expect(await tax.token.balanceOf(feeHook.target)).to.equal(0);
      // The proceeds are booked in the same ratio, and this being the hook's only pool so far,
      // the ledgers are its whole balance.
      const after = (await feeHook.pendingMarketing(poolId)) + (await feeHook.pendingPlatform());
      expect(after - booked).to.equal(result.ethOut);
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(after);

      await expect(feeHook.connect(dave).convert(poolId, 1, 0, await H.deadline())).to.be.revertedWithCustomError(
        feeHook,
        "CoolingDown"
      );
      // The conversion paid the pool's fee like any trade, and that comes back to the same position.
      const again = await feeHook.collect.staticCall(poolId);
      expect(again.tokenFees).to.be.closeTo((pending * TOTAL) / 10_000n, 2n);
      expect(await positionManager.getPositionLiquidity(launch.tokenId)).to.equal(tax.liquidity);
    });

    it("pays the marketing wallet and the real Treasury", async function () {
      this.timeout(600000);
      const { feeHook, treasury, marketing, dave } = ctx;
      const { poolId } = tax;
      const owedMarketing = await feeHook.pendingMarketing(poolId);
      const owedPlatform = await feeHook.pendingPlatform();
      expect(owedMarketing).to.be.greaterThan(0);
      expect(owedPlatform).to.be.greaterThan(0);

      await expect(feeHook.connect(dave).flush(poolId)).to.changeEtherBalance(marketing, owedMarketing);
      // The live Treasury books what it receives, and does so within the gas the hook pushes with.
      const reserveBefore = await treasury.buybackReserve();
      const balanceBefore = await ethers.provider.getBalance(treasury.target);
      await expect(feeHook.connect(dave).flushPlatform()).to.emit(feeHook, "PlatformFlushed").withArgs(owedPlatform, true);
      expect((await ethers.provider.getBalance(treasury.target)) - balanceBefore).to.equal(owedPlatform);
      expect(await treasury.buybackReserve()).to.be.greaterThan(reserveBefore);
      expect(await feeHook.pendingPlatform()).to.equal(0);
      expect(await ethers.provider.getBalance(feeHook.target)).to.equal(0);
    });

    it("reports the launch through the live platform lens", async function () {
      this.timeout(600000);
      const { lens, v4FeeLens } = ctx;
      expect(await lens.poolKind(tax.tokenAddr)).to.equal(1);
      const v = await lens.launchView(tax.presale.target);
      expect(v.poolKind).to.equal(1);
      expect(v.token).to.equal(tax.tokenAddr);
      expect(v.priceAvailable).to.equal(true);
      expect(v.buyTaxBps).to.equal(300);
      expect(v.sellTaxBps).to.equal(300);
      expect(v.liquidityWeth).to.be.greaterThan(0);
      const stats = await v4FeeLens.launchStats(tax.tokenAddr);
      expect(stats.priceAvailable).to.equal(true);
      expect(stats.positionBurned).to.equal(true);
      await lens.presaleView(tax.presale.target);
      console.log(`      lens price ${ethers.formatEther(v.currentPriceWei)} ETH, liquidity ${ethers.formatEther(v.liquidityWeth)} ETH`);
    });
  });

  // ---------------------------------------------------------------- 3. Rewards launches

  describe("3. fee mode Rewards launches, 1% to marketing and 2% to holders", function () {
    const TOTAL = PLATFORM_BPS + 100n + 200n;

    /** A Rewards launch that has traded both ways through Uniswap's router, its fees paid out. */
    async function tradedRewardsLaunch(symbol, rewardToken) {
      const { feeLauncher, feeHook, stateView, positionManager, marketing, bob, dave } = ctx;
      const config = V4.feeTaxConfig(marketing.address, { marketingBps: 100, rewardsBps: 200 });
      const tokenAddr = await createThrough(feeLauncher, Rewards, specFor(symbol, rewardToken), config);
      const token = await ethers.getContractAt("RewardsTokenV4", tokenAddr);
      // The one address the token takes reward ETH from is the fee hook.
      expect(await token.launcher()).to.equal(feeLauncher.target);
      expect(await token.hook()).to.equal(feeHook.target);
      expect(await token.rewardToken()).to.equal(rewardToken);

      const presale = await fillSale(tokenAddr);
      expect(await presale.v4TermsHold()).to.equal(true);
      // The live factory took the sale's own balance out of the rewards when it created it.
      expect(await token.isExcludedFromRewards(presale.target)).to.equal(true);
      await finalize(presale);

      const launched = await launchedThrough(feeLauncher, tokenAddr);
      const { key, poolId, launch } = launched;
      feeKeys.push(key);
      expect(key).to.deep.equal([ethers.ZeroAddress, tokenAddr, Number(TOTAL) * 100, 200, feeHook.target]);
      expect((await stateView.getSlot0(poolId)).lpFee).to.equal(TOTAL * 100n);
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(feeHook.target);
      expect((await feeHook.configOf(poolId)).rewardsSink).to.equal(tokenAddr);

      const bought = await routerBuy(dave, key, E("1"));
      expect(bought.received).to.equal(bought.quoted);
      const sold = await routerSell(bob, key, E("300"));
      expect(sold.received).to.equal(sold.quoted);

      // One keeper pass: collect and convert in one call, then pay out.
      const fees = await convertWithFloor(poolId, key, dave);
      expect(fees.ethFees).to.be.closeTo((E("1") * TOTAL) / 10_000n, 2n);
      expect(fees.tokenFees).to.be.closeTo((E("300") * TOTAL) / 10_000n, 2n);
      // Each booking is split on its own, so the holders' share is the sum of the two.
      const holdersShare = (fees.ethFees * 200n) / TOTAL + (fees.ethOut * 200n) / TOTAL;
      expect(await feeHook.pendingRewards(poolId)).to.equal(holdersShare);
      const pendingBefore = await token.pendingRewardEth();
      await expect(feeHook.connect(dave).flush(poolId)).to.changeEtherBalance(token, holdersShare);
      expect((await token.pendingRewardEth()) - pendingBefore).to.equal(holdersShare);
      expect(await feeHook.pendingRewards(poolId)).to.equal(0);

      return { ...launched, token, presale, holdersShare };
    }

    it("WETH rewards: the token receives its share and the keeper distributes it", async function () {
      this.timeout(900000);
      const { keeper, bob, dave } = ctx;
      const { token, holdersShare } = await tradedRewardsLaunch("FWETH", ROBINHOOD.weth);
      const weth = H.wethAt();

      // Nobody but the owner, the platform and the keeper turns the ETH into rewards.
      await expect(token.connect(dave).distributeRewards(0)).to.be.revertedWithCustomError(token, "NotAuthorized");
      // WETH is wrapped one for one, so the whole share is also the floor.
      await expect(token.connect(keeper).distributeRewards(holdersShare))
        .to.emit(token, "RewardsDistributed")
        .withArgs(holdersShare, holdersShare);
      expect(await token.pendingRewardEth()).to.equal(0);
      expect(await weth.balanceOf(token.target)).to.equal(holdersShare);

      const owed = await token.withdrawableRewardOf(bob.address);
      expect(owed).to.be.closeTo((holdersShare * (await token.sharesOf(bob.address))) / (await token.totalShares()), 1n);
      expect(owed).to.be.greaterThan(0);
      const before = await weth.balanceOf(bob.address);
      await token.connect(bob).claimRewards();
      expect((await weth.balanceOf(bob.address)) - before).to.equal(owed);
      console.log(`      ${ethers.formatEther(holdersShare)} WETH to the holders, bob claimed ${ethers.formatEther(owed)}`);
    });

    it("stock rewards: the share is swapped along the live V3 route and a holder claims real TSLA", async function () {
      this.timeout(900000);
      const { quickLaunch, keeper, carol } = ctx;
      // The route is the one the live QuickLaunch stores; the Fee deployer hands it to the token.
      const route = await quickLaunch.rewardRouteV3Of(ROBINHOOD.tsla);
      if (route === "0x" || !(await quickLaunch.isRewardRouteLive(ROBINHOOD.tsla))) {
        console.log("      skipped: the live QuickLaunch has no live V3 route for TSLA at this block");
        this.skip();
      }
      const { token, holdersShare } = await tradedRewardsLaunch("FTSLA", ROBINHOOD.tsla);
      expect((await token.rewardRouteV3()).toLowerCase()).to.equal(route.toLowerCase());
      expect(await token.v3Router()).to.equal(ROBINHOOD.v3.router);
      expect(await token.v3Quoter()).to.equal(ROBINHOOD.v3.quoter);

      // The keeper's floor: the real QuoterV2's answer for the whole share, less three percent.
      const quoter = await ethers.getContractAt("IQuoterV2", ROBINHOOD.v3.quoter);
      const [quoted] = await quoter.quoteExactInput.staticCall(route, holdersShare);
      expect(quoted).to.be.greaterThan(0);
      const floor = (quoted * 9700n) / 10_000n;
      await expect(token.connect(keeper).distributeRewards(ethers.MaxUint256)).to.be.reverted;

      const tsla = H.erc20At(ROBINHOOD.tsla);
      const before = await tsla.balanceOf(token.target);
      const receipt = await (await token.connect(keeper).distributeRewards(floor)).wait();
      const evt = H.findEvent(receipt, token.interface, "RewardsDistributed");
      expect(evt.args.ethSpent).to.equal(holdersShare);
      expect(evt.args.rewardsReceived).to.equal(quoted);
      expect((await tsla.balanceOf(token.target)) - before).to.equal(quoted);
      expect(await token.pendingRewardEth()).to.equal(0);

      const owed = await token.withdrawableRewardOf(carol.address);
      expect(owed).to.be.greaterThan(0);
      const holderBefore = await tsla.balanceOf(carol.address);
      await token.connect(carol).claimRewards();
      expect((await tsla.balanceOf(carol.address)) - holderBefore).to.equal(owed);
      console.log(`      ${ethers.formatEther(holdersShare)} ETH became ${ethers.formatEther(quoted)} TSLA, carol claimed ${ethers.formatEther(owed)}`);
    });
  });

  // ---------------------------------------------------------------- 4. the other modes

  describe("4. hook mode and V2, through the deployers that replaced theirs", function () {
    /** Whether a token answers `launcher()`, the question the fee launcher asks of what it created. */
    async function launcherNamedBy(tokenAddr) {
      const token = new ethers.Contract(tokenAddr, ["function launcher() view returns (address)"], ethers.provider);
      return token.launcher().catch(() => null);
    }

    it("creates all nine combinations of token type and mode", async function () {
      this.timeout(900000);
      const { tokenFactory, feeLauncher, feeHook, hookLauncher, alice, marketing } = ctx;
      const rates = { [Standard]: {}, [Tax]: { marketingBps: 200 }, [Rewards]: { marketingBps: 100, rewardsBps: 200 } };
      const reward = (kind) => (kind === Rewards ? ROBINHOOD.weth : ethers.ZeroAddress);

      for (const [mode, launcher, itsHook] of [["fee", feeLauncher, feeHook.target], ["hook", hookLauncher, LIVE.v4Hook]]) {
        for (const kind of [Standard, Tax, Rewards]) {
          const at = `${mode} mode, type ${kind}`;
          const config = V4.feeTaxConfig(marketing.address, rates[kind]);
          const tokenAddr = await createThrough(launcher, kind, specFor(`N${mode[0]}${kind}`, reward(kind)), config);
          const token = await ethers.getContractAt(kind === Rewards ? "RewardsTokenV4" : "HoodSaleTokenV4", tokenAddr);
          expect(await token.poolVersion(), at).to.equal(4);
          expect(await token.tokenType(), at).to.equal(kind);
          expect(await token.launcher(), at).to.equal(launcher.target);
          expect(await token.owner(), at).to.equal(alice.address);
          expect((await tokenFactory.infoOf(tokenAddr)).creator, at).to.equal(launcher.target);
          if (kind === Rewards) expect(await token.hook(), at).to.equal(itsHook);
          // The key a fee mode token will list with is known from the day it is created.
          if (mode === "fee") feeKeys.push(V4.keyArray(await feeLauncher.keyFor(tokenAddr)));
        }
      }

      // A wallet that goes to the factory itself gets the V2 token it always got.
      const v2 = [
        () => tokenFactory.connect(alice).createStandardToken("Fork N20", "N20", E("1000000")),
        () => tokenFactory.connect(alice).createTaxToken("Fork N21", "N21", E("1000000"), marketing.address, 200, 200),
        () =>
          tokenFactory
            .connect(alice)
            .createRewardsToken("Fork N22", "N22", E("1000000"), ROBINHOOD.weth, marketing.address, [200, 200, 100, 100]),
      ];
      for (const [kind, create] of v2.entries()) {
        await create();
        const created = await tokenFactory.tokensOfCreator(alice.address);
        const tokenAddr = created[created.length - 1];
        const info = await tokenFactory.infoOf(tokenAddr);
        expect(info.creator, `V2, type ${kind}`).to.equal(alice.address);
        expect(info.tokenType, `V2, type ${kind}`).to.equal(kind);
        expect(await launcherNamedBy(tokenAddr), `V2, type ${kind}`).to.equal(null);
        const token = await ethers.getContractAt("StandardToken", tokenAddr);
        expect(await token.mainPair(), `V2, type ${kind}`).to.not.equal(ethers.ZeroAddress);
      }
    });

    it("a hook mode launch still opens its pool on the live launcher and takes its tax in the hook", async function () {
      this.timeout(600000);
      const { hookLauncher, positionManager, stateView, marketing, dave } = ctx;
      const config = V4.taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 });
      const tokenAddr = await createThrough(hookLauncher, Tax, specFor("HOOK"), config);
      const presale = await fillSale(tokenAddr, { liquidityAction: Lock });
      expect(await presale.v4Launcher()).to.equal(LIVE.v4Launcher);
      await finalize(presale);

      const { key, launch, poolId } = await launchedThrough(hookLauncher, tokenAddr);
      expect(launch.done).to.equal(true);
      expect(key[4]).to.equal(LIVE.v4Hook);
      expect((await stateView.getSlot0(poolId)).lpFee).to.equal(key[2]);
      // A timed lock is still a timed lock here: the live locker holds the position.
      expect(await positionManager.ownerOf(launch.tokenId)).to.equal(LIVE.v4Locker);
      // The tax hook is what Uniswap's routing rule turns away, and why fee mode exists.
      expect(V4.isHooksPoolRoutable(key[4], key[2])).to.equal(false);

      const v4Router = await ethers.getContractAt("HoodSaleV4Router", LIVE.v4Router);
      const token = H.erc20At(tokenAddr);
      const spend = E("0.2");
      const hookBefore = await ethers.provider.getBalance(LIVE.v4Hook);
      const tokensBefore = await token.balanceOf(dave.address);
      await v4Router.connect(dave).buy(tokenAddr, 0, dave.address, await H.deadline(), { value: spend });
      expect(await token.balanceOf(dave.address)).to.be.greaterThan(tokensBefore);
      // 3% marketing plus the platform's 0.25%, taken by the hook out of the ETH paid in.
      expect((await ethers.provider.getBalance(LIVE.v4Hook)) - hookBefore).to.equal((spend * 325n) / 10_000n);
    });

    it("a V2 launch still lists on the real Uniswap V2 at the listing price", async function () {
      this.timeout(600000);
      const { tokenFactory, alice, marketing, dave } = ctx;
      await tokenFactory.connect(alice).createTaxToken("Fork V2", "FV2", E("1000000"), marketing.address, 300, 300);
      const created = await tokenFactory.tokensOfCreator(alice.address);
      const token = await ethers.getContractAt("TaxToken", created[created.length - 1]);
      expect(await launcherNamedBy(token.target)).to.equal(null);

      const presale = await fillSale(token.target);
      expect(await presale.isV4Launch()).to.equal(false);
      await finalize(presale);

      const pair = H.pairAt(await token.mainPair());
      const reserves = await H.reservesOf(pair, token.target);
      expect(reserves.weth).to.be.greaterThan(0);
      expect((reserves.token * 10n ** 18n) / reserves.weth).to.be.closeTo(E("800"), E("0.5"));
      // Burn: the pair's liquidity sits at the dead address.
      expect(await pair.balanceOf(H.DEAD)).to.be.greaterThan(0);

      const before = await token.balanceOf(dave.address);
      await H.routerAt(dave).swapExactETHForTokens(0, [ROBINHOOD.weth, token.target], dave.address, await H.deadline(), {
        value: E("0.2"),
      });
      expect(await token.balanceOf(dave.address)).to.be.greaterThan(before);
    });
  });

  // ---------------------------------------------------------------- 5. routing

  describe("5. Uniswap's routing rule", function () {
    it("accepts every fee mode pool key of this run without an allowlist entry", async function () {
      // The proof pool, the Tax launch, the Rewards launches (one less when TSLA has no route) and
      // the keys the three tokens of section 4 will list with: 0.25%, 2.25% and 3.25%.
      expect(feeKeys.length).to.be.greaterThanOrEqual(6);
      for (const key of feeKeys) {
        expect(BigInt(key[4]) & BigInt(V4.ALL_HOOK_MASK), key[1]).to.equal(BigInt(V4.FEE_HOOK_FLAGS));
        expect(V4.isHooksPoolRoutable(key[4], key[2]), key[1]).to.equal(true);
      }
      // The highest tax a fee mode pool can carry is still inside the rule.
      expect(V4.isHooksPoolRoutable(ctx.feeHook.target, 100000)).to.equal(true);
    });
  });

  // ---------------------------------------------------------------- 6. rollback

  describe("6. the rollback the script records", function () {
    it("setDeployers with the previous* addresses stops fee mode creation and nothing else", async function () {
      this.timeout(600000);
      const { tokenFactory, feeLauncher, feeHook, hookLauncher, owner, alice, marketing, dave } = ctx;
      const d = recorded();
      await tokenFactory
        .connect(owner)
        .setDeployers(d.previousStandardDeployer, d.previousTaxDeployer, d.previousRewardsDeployer);

      const config = V4.feeTaxConfig(marketing.address, { marketingBps: 300 });
      await expect(
        feeLauncher.connect(alice).createToken(Tax, specFor("LATE"), config, alice.address)
      ).to.be.revertedWithCustomError(feeLauncher, "NotFeeToken");
      const hookToken = await ethers.getContractAt(
        "HoodSaleTokenV4",
        await createThrough(hookLauncher, Tax, specFor("BACK"), config)
      );
      expect(await hookToken.launcher()).to.equal(LIVE.v4Launcher);

      // The fee mode pool that exists keeps trading on Uniswap and keeps paying its tax.
      const spend = E("0.1");
      const { quoted, received } = await routerBuy(dave, tax.key, spend);
      expect(received).to.equal(quoted);
      const preview = await feeHook.collect.staticCall(tax.poolId);
      expect(preview.ethFees).to.be.closeTo((spend * 325n) / 10_000n, 2n);
      await expect(feeHook.connect(dave).collect(tax.poolId)).to.emit(feeHook, "FeesCollected");
    });
  });
}
