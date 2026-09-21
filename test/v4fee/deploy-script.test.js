const { expect } = require("chai");
const hre = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatformV4, feeTaxConfig, taxConfig, PERMIT2 } = require("../v4/helpers");
const { main } = require("../../scripts/deploy-v4-fee");

const { ethers } = hre;
const E = ethers.parseEther;
// TokenFactory.TokenType
const Standard = 0, Tax = 1, Rewards = 2;
// What one complete run sends: the launcher, the hook, setHook, the lens, setLens, the router,
// setKeeper, the three deployers and TokenFactory.setDeployers
const SENDS_OF_A_FULL_RUN = 11;
const ENV = [
  "SKIP_SET_DEPLOYERS", "SKIP_DEPLOYERS", "CLOSE_CREATION", "OPEN_CREATION", "DEPLOYMENTS_FILE",
  "V4_FEE_LAUNCHER", "V4_FEE_HOOK", "V4_FEE_LENS", "V4_FEE_ROUTER",
  "V4_FEE_STANDARD_DEPLOYER", "V4_FEE_TAX_DEPLOYER", "V4_FEE_REWARDS_DEPLOYER",
];

// scripts/deploy-v4-fee.js itself, run in-process on the hook mode platform with a deployments
// file of its own. The fixture deployPlatformV4Fee wires fee mode with its own code and the fork
// suite needs FORK_URL, so this is where the script's paths are pinned offline: the inspection
// run, the full run, the rerun, setDeployers sent by hand, the environment overrides, a stale
// record, the creation brake, and a run that dies at any of its transactions.
describe("scripts/deploy-v4-fee.js", function () {
  this.timeout(600000);

  let dir;
  const saved = {};
  before(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-v4-fee-"));
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  after(function () {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // The platform as it stands on mainnet before fee mode: hook mode live, the factory on the V4
  // generation, and previous* of mixed generations (V2 only Standard and Tax deployers, and a V4
  // rewards deployer that scripts/deploy-v4-fixes.js replaced with a later one).
  async function platform() {
    const ctx = await deployPlatformV4();
    const { tokenFactory, v3Router, v3Quoter, rewardsTokenCode, rewardsTokenCodeV4, launcher } = ctx;
    const oldStandard = await ethers.deployContract("StandardTokenDeployer", [tokenFactory.target]);
    const oldTax = await ethers.deployContract("TaxTokenDeployer", [tokenFactory.target]);
    const supersededRewards = await ethers.deployContract("RewardsTokenDeployerV4", [
      tokenFactory.target, v3Router.target, v3Quoter.target, rewardsTokenCode.target, rewardsTokenCodeV4.target, launcher.target,
    ]);
    const v4Generation = [ctx.v4Deployers.standardDeployer.target, ctx.v4Deployers.taxDeployer.target, ctx.v4Deployers.rewardsDeployer.target];
    const record = {
      network: "hardhat",
      router: ctx.router.target,
      treasury: ctx.treasury.target,
      tokenFactory: tokenFactory.target,
      presaleFactory: ctx.presaleFactory.target,
      v4PoolManager: ctx.poolManager.target,
      v4PositionManager: ctx.positionManager.target,
      v4StateView: ctx.stateView.target,
      v4Quoter: ctx.quoter.target,
      permit2: PERMIT2,
      v4Launcher: launcher.target,
      v4Hook: ctx.hook.target,
      standardDeployer: v4Generation[0],
      taxDeployer: v4Generation[1],
      rewardsDeployer: v4Generation[2],
      previousStandardDeployer: oldStandard.target,
      previousTaxDeployer: oldTax.target,
      previousRewardsDeployer: supersededRewards.target,
    };
    return { ...ctx, record, v4Generation, beforeV4: [oldStandard.target, oldTax.target, supersededRewards.target] };
  }

  let files = 0;
  const writeRecord = (record) => {
    const file = path.join(dir, `record-${++files}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    return file;
  };
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const deployersOf = async (tokenFactory) => [
    await tokenFactory.standardDeployer(),
    await tokenFactory.taxDeployer(),
    await tokenFactory.rewardsDeployer(),
  ];
  const recordedDeployers = (d) => [d.standardDeployer, d.taxDeployer, d.rewardsDeployer];
  const recordedPrevious = (d) => [d.previousStandardDeployer, d.previousTaxDeployer, d.previousRewardsDeployer];
  const recordedFee = (d) => [d.v4FeeStandardDeployer, d.v4FeeTaxDeployer, d.v4FeeRewardsDeployer];

  /**
   * One run of the script with `env` set for its duration. Its report is kept, not printed; what
   * it sent is counted by the deployer's nonce, since every transaction of the script is its own.
   */
  async function run(ctx, file, env = {}) {
    const lines = [];
    const log = console.log;
    const nonce = await ethers.provider.getTransactionCount(ctx.deployer.address);
    Object.assign(process.env, env);
    console.log = (...args) => lines.push(args.join(" "));
    const out = { lines };
    try {
      out.result = await main({ file, signer: ctx.deployer, retryDelayMs: 1 });
    } catch (e) {
      out.error = e;
    } finally {
      console.log = log;
      for (const k of Object.keys(env)) delete process.env[k];
    }
    out.sends = (await ethers.provider.getTransactionCount(ctx.deployer.address)) - nonce;
    out.text = lines.join("\n");
    return out;
  }
  /** A run that has to go through; its report is shown when it does not. */
  async function runOk(ctx, file, env) {
    const out = await run(ctx, file, env);
    if (out.error) {
      console.log(out.text);
      throw out.error;
    }
    return out;
  }

  const spec = (symbol, rewardToken = ethers.ZeroAddress) => ({ name: `Script ${symbol}`, symbol, totalSupply: E("1000000"), rewardToken });
  const feeConfigs = (wallet) => [
    [Standard, feeTaxConfig(wallet)],
    [Tax, feeTaxConfig(wallet, { marketingBps: 300 })],
    [Rewards, feeTaxConfig(wallet, { marketingBps: 100, rewardsBps: 200 })],
  ];

  it("with SKIP_SET_DEPLOYERS deploys and wires everything, leaves TokenFactory alone and records the rollback target", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, alice, marketing, record, v4Generation, beforeV4 } = ctx;
    const file = writeRecord(record);
    const out = await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });
    expect(out.result.sent).to.equal(false);
    expect(out.sends).to.equal(SENDS_OF_A_FULL_RUN - 1);
    expect(await deployersOf(tokenFactory)).to.deep.equal(v4Generation);

    const d = read(file);
    for (const k of ["v4FeeLauncher", "v4FeeHook", "v4FeeHookSalt", "v4FeeLens", "v4FeeRouter", "v4FeeFromBlock", "v4FeeStandardDeployer", "v4FeeTaxDeployer", "v4FeeRewardsDeployer"]) {
      expect(d[k], k).to.not.equal(undefined);
    }
    expect(BigInt(d.v4FeeHook) & 0x3fffn).to.equal(0x2800n);
    // The factory's deployers stay under their keys, and they are already the rollback target:
    // whoever sends setDeployers afterwards, the record names the generation it replaces.
    expect(recordedDeployers(d)).to.deep.equal(v4Generation);
    expect(recordedPrevious(d)).to.deep.equal(v4Generation);
    // What previous* named before is kept as the plan wrote it, each with what it really is
    expect(d.deployersBeforeV4).to.deep.equal({ standard: beforeV4[0], tax: beforeV4[1], rewards: beforeV4[2] });
    expect(d.deployersBeforeV4Generation.standard).to.match(/^V2 only/);
    expect(d.deployersBeforeV4Generation.tax).to.match(/^V2 only/);
    expect(d.deployersBeforeV4Generation.rewards).to.match(/^V4 generation, superseded/).and.include(record.v4Launcher);

    // The exact call for the owner, the rollback, and the warning about the open brake
    const data = tokenFactory.interface.encodeFunctionData("setDeployers", recordedFee(d));
    expect(out.text).to.include(`data:  ${data}`);
    expect(out.text).to.include(`setDeployers(${v4Generation.join(", ")})   (the rollback`);
    expect(out.text).to.match(/WARNING: the moment setDeployers lands, V4FeeLauncher\.createToken is open to every caller/);
    expect(out.text).to.include("CLOSE_CREATION=1");
    expect(out.text).to.not.match(/^\s*FAIL/m);

    // Until setDeployers the factory hands the fee launcher a V2 token, which it refuses
    const feeLauncher = await ethers.getContractAt("V4FeeLauncher", d.v4FeeLauncher);
    await expect(
      feeLauncher.connect(alice).createToken(Tax, spec("EARLY"), feeTaxConfig(marketing.address, { marketingBps: 300 }), alice.address)
    ).to.be.revertedWithCustomError(feeLauncher, "NotFeeToken");
  });

  it("refuses SKIP_DEPLOYERS and a bad creation flag before anything is deployed or sent", async function () {
    const ctx = await loadFixture(platform);
    const file = writeRecord(ctx.record);
    const untouched = fs.readFileSync(file, "utf8");
    for (const [env, message] of [
      // the name scripts/deploy-v4.js reads and the plan once used: never read as nothing
      [{ SKIP_DEPLOYERS: "1" }, /SKIP_DEPLOYERS is the name scripts\/deploy-v4\.js reads; this script reads SKIP_SET_DEPLOYERS=1/],
      // opening creation is the unsafe direction, so only 1 means it
      [{ OPEN_CREATION: "true" }, /OPEN_CREATION is "true": set it to 1/],
      [{ OPEN_CREATION: "1", CLOSE_CREATION: "1" }, /both set/],
      [{ OPEN_CREATION: "1", SKIP_SET_DEPLOYERS: "1" }, /cannot go with SKIP_SET_DEPLOYERS/],
    ]) {
      const out = await run(ctx, file, env);
      expect(out.error, JSON.stringify(env)).to.be.an("error");
      expect(out.error.message).to.match(message);
      expect(out.sends, JSON.stringify(env)).to.equal(0);
      expect(out.lines, JSON.stringify(env)).to.deep.equal([]);
    }
    expect(fs.readFileSync(file, "utf8")).to.equal(untouched);
    expect(await deployersOf(ctx.tokenFactory)).to.deep.equal(ctx.v4Generation);
  });

  it("the run after the inspection sends one transaction, setDeployers, and a rerun sends none", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, launcher, deployer, alice, marketing, weth, record, v4Generation, beforeV4 } = ctx;
    const file = writeRecord(record);
    await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });

    const out = await runOk(ctx, file);
    expect(out.result.sent).to.equal(true);
    expect(out.sends).to.equal(1);
    const d = read(file);
    expect(await deployersOf(tokenFactory)).to.deep.equal(recordedFee(d));
    expect(recordedDeployers(d)).to.deep.equal(recordedFee(d));
    expect(recordedPrevious(d)).to.deep.equal(v4Generation);
    expect(d.deployersBeforeV4).to.deep.equal({ standard: beforeV4[0], tax: beforeV4[1], rewards: beforeV4[2] });
    expect(out.text).to.not.match(/^\s*FAIL/m);
    // The closing list names everything the site release needs, the deployer rows first of all
    expect(out.text).to.include(`rollback: setDeployers(${v4Generation.join(", ")})`);
    expect(out.text).to.include(`data:  ${tokenFactory.interface.encodeFunctionData("setDeployers", v4Generation)}`);
    expect(out.text).to.include(`standardDeployer '${d.v4FeeStandardDeployer}'   row name StandardTokenDeployerFee`);
    expect(out.text).to.include(`fromBlock ${d.v4FeeFromBlock}n`);
    expect(out.text).to.include("OFFLINE_TEST_COUNT");
    expect(out.text).to.include("docs/FEE-MODE-RELEASE.md");
    // Creation is open by default, and the run says what that means and how to close it
    const feeLauncher = await ethers.getContractAt("V4FeeLauncher", d.v4FeeLauncher);
    expect(await feeLauncher.creationOpen()).to.equal(true);
    expect(out.text).to.include(`data:  ${feeLauncher.interface.encodeFunctionData("setCreationOpen", [false])}`);
    expect(out.text).to.include(`data:  ${feeLauncher.interface.encodeFunctionData("setCreationOpen", [true])}`);

    // All nine combinations of token type and creator come out of the one factory
    for (const [tokenType, cfg] of feeConfigs(marketing.address)) {
      await feeLauncher.connect(alice).createToken(tokenType, spec(`FEE${tokenType}`, weth.target), cfg, alice.address);
      await launcher.connect(alice).createToken(tokenType, spec(`HOOK${tokenType}`, weth.target), { ...cfg, taxLocked: false }, alice.address);
    }
    await tokenFactory.connect(alice).createStandardToken("Script V2 S", "V2S", E("1000"));
    await tokenFactory.connect(alice).createTaxToken("Script V2 T", "V2T", E("1000"), marketing.address, 100, 100);
    await tokenFactory.connect(alice).createRewardsToken("Script V2 R", "V2R", E("1000"), weth.target, marketing.address, [100, 100, 100, 100]);
    const feeTokens = await feeLauncher.tokensOfCreator(alice.address);
    const hookTokens = await launcher.tokensOfCreator(alice.address);
    expect(feeTokens.length).to.equal(3);
    expect(hookTokens.length).to.equal(3);
    for (const [tokens, its] of [[feeTokens, feeLauncher.target], [hookTokens, launcher.target]]) {
      for (const t of tokens) expect(await (await ethers.getContractAt("HoodSaleTokenV4", t)).launcher()).to.equal(its);
    }

    // A rerun finds every step in place, sends nothing and leaves the record as it is
    const recordBefore = fs.readFileSync(file, "utf8");
    const again = await runOk(ctx, file);
    expect(again.result.sent).to.equal(false);
    expect(again.sends).to.equal(0);
    expect(fs.readFileSync(file, "utf8")).to.equal(recordBefore);
    expect(again.text).to.include(`rollback: setDeployers(${v4Generation.join(", ")})`);

    // The rollback the record names: fee mode creation stops, hook mode and V2 go on
    await tokenFactory.connect(deployer).setDeployers(...recordedPrevious(d));
    await expect(
      feeLauncher.connect(alice).createToken(Tax, spec("ROLLED"), feeTaxConfig(marketing.address, { marketingBps: 300 }), alice.address)
    ).to.be.revertedWithCustomError(feeLauncher, "NotFeeToken");
    await launcher.connect(alice).createToken(Tax, spec("HOOKR"), taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 300 }), alice.address);
    expect((await launcher.tokensOfCreator(alice.address)).length).to.equal(4);
  });

  it("one run from nothing sends the eleven transactions and ends on the Fee deployers", async function () {
    const ctx = await loadFixture(platform);
    const file = writeRecord(ctx.record);
    const out = await runOk(ctx, file);
    expect(out.result.sent).to.equal(true);
    expect(out.sends).to.equal(SENDS_OF_A_FULL_RUN);
    const d = read(file);
    expect(await deployersOf(ctx.tokenFactory)).to.deep.equal(recordedFee(d));
    expect(recordedPrevious(d)).to.deep.equal(ctx.v4Generation);
  });

  it("keeps the rollback target when the owner sends setDeployers by hand after the inspection run", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, launcher, deployer, alice, marketing, record, v4Generation } = ctx;
    const file = writeRecord(record);
    const first = await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });

    // Exactly the call the script printed, sent as raw data the way a wallet would
    const data = first.lines.find((l) => l.startsWith("  data:  0x")).slice("  data:  ".length);
    await (await deployer.sendTransaction({ to: tokenFactory.target, data })).wait();

    const out = await runOk(ctx, file);
    expect(out.result.sent).to.equal(false);
    expect(out.sends).to.equal(0);
    const d = read(file);
    expect(await deployersOf(tokenFactory)).to.deep.equal(recordedFee(d));
    expect(recordedDeployers(d)).to.deep.equal(recordedFee(d));
    // The V4 generation is still in the record, where the rollback is read from, and printed
    expect(recordedPrevious(d)).to.deep.equal(v4Generation);
    expect(out.text).to.include(`rollback: setDeployers(${v4Generation.join(", ")})`);

    await tokenFactory.connect(deployer).setDeployers(...recordedPrevious(d));
    await launcher.connect(alice).createToken(Tax, spec("HAND"), taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 300 }), alice.address);
    const [token] = await launcher.tokensOfCreator(alice.address);
    // a hook mode token, not the V2 token a deployer from before v4 would have handed the launcher
    expect(await (await ethers.getContractAt("HoodSaleTokenV4", token)).launcher()).to.equal(launcher.target);
  });

  it("repairs a record whose previous* keys never got the V4 generation, and says so when it cannot", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, deployer, record, v4Generation, beforeV4 } = ctx;
    const file = writeRecord(record);
    await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });
    // The record an earlier version of the script left after the inspection run: previous* still
    // names what it named before, and only standard/tax/rewardsDeployer name the V4 generation
    const stale = { ...read(file), previousStandardDeployer: beforeV4[0], previousTaxDeployer: beforeV4[1], previousRewardsDeployer: beforeV4[2] };
    delete stale.deployersBeforeV4;
    delete stale.deployersBeforeV4Generation;
    fs.writeFileSync(file, JSON.stringify(stale, null, 2));
    await tokenFactory.connect(deployer).setDeployers(...recordedFee(stale));

    const out = await runOk(ctx, file);
    expect(out.sends).to.equal(0);
    const d = read(file);
    expect(recordedDeployers(d)).to.deep.equal(recordedFee(d));
    expect(recordedPrevious(d)).to.deep.equal(v4Generation);
    expect(d.deployersBeforeV4).to.deep.equal({ standard: beforeV4[0], tax: beforeV4[1], rewards: beforeV4[2] });
    expect(out.text).to.match(/recorded now, from the deployers the record still named/);

    // Nothing in the record names the V4 generation any more: the run warns and still checks
    const lost = { ...d, previousStandardDeployer: beforeV4[0], previousTaxDeployer: beforeV4[1], previousRewardsDeployer: beforeV4[2] };
    fs.writeFileSync(file, JSON.stringify(lost, null, 2));
    const warned = await runOk(ctx, file);
    expect(warned.sends).to.equal(0);
    expect(warned.text).to.match(/WARNING: the record names no rollback target/);
    // and it does not pass deployers from before v4 off as one
    expect(warned.text).to.match(/WARNING: no rollback call can be printed/);
    expect(warned.text).to.not.include(`setDeployers(${beforeV4.join(", ")})`);
    expect(recordedPrevious(read(file))).to.deep.equal(beforeV4);
  });

  it("does not record a factory that names a mix of generations as the rollback target", async function () {
    let ctx = await loadFixture(platform);
    let file = writeRecord(ctx.record);
    await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });
    // A setDeployers sent by hand with one Fee deployer among the V4 generation
    let mix = [read(file).v4FeeStandardDeployer, ctx.v4Generation[1], ctx.v4Generation[2]];
    await ctx.tokenFactory.connect(ctx.deployer).setDeployers(...mix);

    let out = await runOk(ctx, file);
    expect(out.result.sent).to.equal(true);
    expect(out.sends).to.equal(1);
    expect(out.text).to.match(/WARNING: TokenFactory's three deployers are not all of the V4 generation/);
    expect(out.text).to.include("is left as it is, and it names the V4 generation");
    let d = read(file);
    expect(await deployersOf(ctx.tokenFactory)).to.deep.equal(recordedFee(d));
    // What the inspection run recorded is still the rollback target, and still what is printed
    expect(recordedPrevious(d)).to.deep.equal(ctx.v4Generation);
    expect(out.text).to.include(`call:  setDeployers(${ctx.v4Generation.join(", ")})`);
    expect(out.text).to.not.include(`rollback: setDeployers(${mix.join(", ")})`);

    // The same on a record that never named the V4 generation: the mix is not passed off as one
    ctx = await loadFixture(platform);
    file = writeRecord(ctx.record);
    mix = [ctx.beforeV4[0], ctx.v4Generation[1], ctx.v4Generation[2]];
    await ctx.tokenFactory.connect(ctx.deployer).setDeployers(...mix);
    out = await runOk(ctx, file);
    expect(out.result.sent).to.equal(true);
    expect(out.text).to.match(/WARNING: TokenFactory's three deployers are not all of the V4 generation/);
    expect(out.text).to.match(/WARNING: no rollback call can be printed/);
    expect(out.text).to.not.include("call:  setDeployers(");
    d = read(file);
    expect(recordedPrevious(d)).to.deep.equal(ctx.beforeV4);
    expect(d.deployersBeforeV4).to.equal(undefined);
    expect(await deployersOf(ctx.tokenFactory)).to.deep.equal(recordedFee(d));
  });

  it("stops before setDeployers when the deployer overrides are swapped, and records neither", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, alice, marketing, record, v4Generation } = ctx;
    const file = writeRecord(record);
    await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });
    const inspected = fs.readFileSync(file, "utf8");
    const d = read(file);

    // Both answer factory(), launcher() and feeLauncher(): only a simulated creation tells them apart
    const out = await run(ctx, file, { V4_FEE_STANDARD_DEPLOYER: d.v4FeeTaxDeployer, V4_FEE_TAX_DEPLOYER: d.v4FeeStandardDeployer });
    expect(out.error).to.be.an("error");
    expect(out.error.message).to.equal("wiring check failed");
    expect(out.sends).to.equal(0);
    expect(out.text).to.match(/FAIL standard deployer builds its token for the fee launcher, asked as TokenFactory \(.+\)/);
    expect(out.text).to.match(/FAIL tax deployer builds its token for a wallet, asked as TokenFactory \(.+\)/);
    expect(out.text).to.match(/ok {3}rewards deployer builds its token for the hook mode launcher/);
    expect(out.text).to.not.include("TokenFactory: deployers set to");
    // The platform is as it was, and so is the record: a rerun without the variables is sound
    expect(await deployersOf(tokenFactory)).to.deep.equal(v4Generation);
    expect(fs.readFileSync(file, "utf8")).to.equal(inspected);
    await tokenFactory.connect(alice).createStandardToken("Still V2 S", "SV2S", E("1000"));
    await tokenFactory.connect(alice).createTaxToken("Still V2 T", "SV2T", E("1000"), marketing.address, 100, 100);

    const sound = await runOk(ctx, file);
    expect(sound.sends).to.equal(1);
    expect(await deployersOf(tokenFactory)).to.deep.equal(recordedFee(d));
  });

  it("reuses what the environment names, and writes it down only after the wiring check has passed", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, record, v4Generation, hook, v4Lens, v4Router } = ctx;
    const first = writeRecord(record);
    await runOk(ctx, first, { SKIP_SET_DEPLOYERS: "1" });
    const d = read(first);
    const env = {
      V4_FEE_LAUNCHER: d.v4FeeLauncher,
      V4_FEE_HOOK: d.v4FeeHook,
      V4_FEE_LENS: d.v4FeeLens,
      V4_FEE_ROUTER: d.v4FeeRouter,
      V4_FEE_STANDARD_DEPLOYER: d.v4FeeStandardDeployer,
      V4_FEE_TAX_DEPLOYER: d.v4FeeTaxDeployer,
      V4_FEE_REWARDS_DEPLOYER: d.v4FeeRewardsDeployer,
    };

    // A record that knows nothing of fee mode, and every contract named through the environment
    const file = writeRecord(record);
    const out = await runOk(ctx, file, { ...env, SKIP_SET_DEPLOYERS: "1" });
    expect(out.sends).to.equal(0);
    const reused = read(file);
    for (const k of ["v4FeeLauncher", "v4FeeHook", "v4FeeLens", "v4FeeRouter", "v4FeeStandardDeployer", "v4FeeTaxDeployer", "v4FeeRewardsDeployer"]) {
      expect(reused[k], k).to.equal(d[k]);
    }

    // One wrong name at a time: the run stops, sends nothing and writes nothing
    for (const [override, message] of [
      [{ V4_FEE_LAUNCHER: "0x1234" }, /V4_FEE_LAUNCHER is not an address/],
      [{ V4_FEE_LAUNCHER: "0x00000000000000000000000000000000000000A1" }, /V4_FEE_LAUNCHER has no code at .*remove it to deploy a fresh V4FeeLauncher/],
      [{ V4_FEE_HOOK: hook.target }, /does not carry the permission bits 0x2800/],
      [{ V4_FEE_LENS: v4Lens.target }, /reads another launcher or hook/],
      [{ V4_FEE_ROUTER: v4Router.target }, /trades another launcher's pools/],
      [{ V4_FEE_REWARDS_DEPLOYER: v4Generation[2] }, /wiring check failed/],
    ]) {
      const blank = writeRecord(record);
      const untouched = fs.readFileSync(blank, "utf8");
      const refused = await run(ctx, blank, { ...env, ...override, SKIP_SET_DEPLOYERS: "1" });
      expect(refused.error, JSON.stringify(override)).to.be.an("error");
      expect(refused.error.message, JSON.stringify(override)).to.match(message);
      expect(refused.sends, JSON.stringify(override)).to.equal(0);
      expect(fs.readFileSync(blank, "utf8"), JSON.stringify(override)).to.equal(untouched);
    }
    expect(await deployersOf(tokenFactory)).to.deep.equal(v4Generation);
  });

  it("stops on a recorded address that has no code, naming the key to remove", async function () {
    const ctx = await loadFixture(platform);
    const gone = "0x00000000000000000000000000000000000000B2";
    for (const [key, what] of [
      ["v4FeeLauncher", "V4FeeLauncher"],
      ["v4FeeRouter", "HoodSaleV4Router \\(fee mode\\)"],
      ["v4FeeTaxDeployer", "TaxTokenDeployerFee"],
    ]) {
      const snapshot = await hre.network.provider.send("evm_snapshot");
      const file = writeRecord(ctx.record);
      if (key !== "v4FeeLauncher") await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });
      fs.writeFileSync(file, JSON.stringify({ ...read(file), [key]: gone }, null, 2));
      const out = await run(ctx, file);
      expect(out.error, key).to.be.an("error");
      expect(out.error.message).to.match(new RegExp(`${key} in ${path.basename(file)} has no code at ${gone}: remove it to deploy a fresh ${what}`));
      expect(out.sends, key).to.equal(0);
      expect(await deployersOf(ctx.tokenFactory)).to.deep.equal(ctx.v4Generation);
      await hre.network.provider.send("evm_revert", [snapshot]);
    }
  });

  it("closes creation before setDeployers on request, passes its final check with the brake on, and opens it last", async function () {
    const ctx = await loadFixture(platform);
    const { tokenFactory, alice, marketing, record } = ctx;
    const file = writeRecord(record);
    await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });
    const d = read(file);
    const feeLauncher = await ethers.getContractAt("V4FeeLauncher", d.v4FeeLauncher);
    const create = () => feeLauncher.connect(alice).createToken(Tax, spec("BRAKE"), feeTaxConfig(marketing.address, { marketingBps: 300 }), alice.address);

    // setCreationOpen(false), then setDeployers: no block in which a stranger can create
    const closed = await runOk(ctx, file, { CLOSE_CREATION: "1" });
    expect(closed.result.sent).to.equal(true);
    expect(closed.sends).to.equal(2);
    expect(closed.text.indexOf("creation closed (CLOSE_CREATION)")).to.be.greaterThan(-1).and.lessThan(closed.text.indexOf("TokenFactory: deployers set to"));
    expect(await feeLauncher.creationOpen()).to.equal(false);
    expect(await deployersOf(tokenFactory)).to.deep.equal(recordedFee(d));
    await expect(create()).to.be.revertedWithCustomError(feeLauncher, "CreationClosed");
    // A closed launcher is reported as closed, never as a failure of the deployment
    expect(closed.text).to.not.match(/^\s*FAIL/m);
    expect(closed.text).to.match(/note fee launcher creation is closed, so its three creations were not simulated/);
    expect(closed.text).to.match(/ok {3}hook mode launcher can still create a Rewards token/);
    expect(closed.text).to.include(`data:  ${feeLauncher.interface.encodeFunctionData("setCreationOpen", [true])}`);

    // A plain rerun leaves the brake where the owner put it
    const rerun = await runOk(ctx, file);
    expect(rerun.sends).to.equal(0);
    expect(await feeLauncher.creationOpen()).to.equal(false);

    // The release's last step: one transaction, then the three creations are simulated for real
    const opened = await runOk(ctx, file, { OPEN_CREATION: "1" });
    expect(opened.sends).to.equal(1);
    expect(opened.result.sent).to.equal(false);
    expect(await feeLauncher.creationOpen()).to.equal(true);
    for (const name of ["Standard", "Tax", "Rewards"]) expect(opened.text).to.match(new RegExp(`ok {3}fee launcher can create a ${name} token`));
    await create();
    expect((await feeLauncher.tokensOfCreator(alice.address)).length).to.equal(1);

    // And the brake again, by the same script, once fee mode is live
    const braked = await runOk(ctx, file, { CLOSE_CREATION: "1" });
    expect(braked.sends).to.equal(1);
    expect(await feeLauncher.creationOpen()).to.equal(false);
  });

  it("tries a dropped read again, and when a check does fail says why and where the run stands", async function () {
    const ctx = await loadFixture(platform);
    const { record, v4Generation } = ctx;
    const file = writeRecord(record);
    await runOk(ctx, file, { SKIP_SET_DEPLOYERS: "1" });
    const d = read(file);
    const feeLauncher = await ethers.getContractAt("V4FeeLauncher", d.v4FeeLauncher);
    const createToken = feeLauncher.interface.getFunction("createToken").selector;

    // Every simulated creation on the fee launcher is dropped by the RPC `drops` times
    const provider = hre.network.provider;
    const realSend = provider.send.bind(provider);
    const failing = (drops) => {
      const seen = new Map();
      provider.send = async (method, params) => {
        const call = method === "eth_call" ? params[0] : null;
        if (call && String(call.to).toLowerCase() === d.v4FeeLauncher.toLowerCase() && String(call.data).startsWith(createToken)) {
          const n = (seen.get(call.data) || 0) + 1;
          seen.set(call.data, n);
          if (n <= drops) throw new Error("socket hang up");
        }
        return realSend(method, params);
      };
    };
    const snapshot = await hre.network.provider.send("evm_snapshot");
    let out;
    try {
      failing(2);
      out = await runOk(ctx, file);
    } finally {
      provider.send = realSend;
    }
    expect(out.result.sent).to.equal(true);
    expect(out.text).to.not.match(/^\s*FAIL/m);
    expect(out.text).to.match(/ok {3}fee launcher can create a Tax token/);
    await hre.network.provider.send("evm_revert", [snapshot]);

    // A read that never comes back is a FAIL with its reason, after the step that cannot be undone:
    // the message says that setDeployers has landed, what a rerun does, and the rollback call
    try {
      failing(99);
      out = await run(ctx, file);
    } finally {
      provider.send = realSend;
    }
    expect(out.sends).to.equal(1);
    expect(out.text).to.match(/FAIL fee launcher can create a Standard token \(socket hang up\)/);
    expect(out.text).to.match(/ok {3}hook mode launcher can still create a Standard token/);
    expect(out.error.message).to.match(/^token creation check failed/);
    expect(out.error.message).to.include("TokenFactory.setDeployers has landed and is recorded; running this script again repeats only the checks");
    expect(out.error.message).to.include(`setDeployers(${v4Generation.join(", ")})`);
    expect(out.error.message).to.include("Fee mode creation is open: CLOSE_CREATION=1 with this script closes it");
    expect(recordedDeployers(read(file))).to.deep.equal(recordedFee(d));
    // and the rerun does repeat only the checks
    const rerun = await runOk(ctx, file);
    expect(rerun.sends).to.equal(0);
    expect(rerun.text).to.not.match(/^\s*FAIL/m);
  });

  it("is started again after dying at any of its transactions, and never loses the rollback target", async function () {
    // Fourteen cases of three runs each: about a minute alone, several in the whole suite
    this.timeout(1800000);
    const ctx = await loadFixture(platform);
    const { tokenFactory, deployer, record, v4Generation } = ctx;
    const realSend = deployer.sendTransaction.bind(deployer);
    // Dying before a transaction is sent, at each of the eleven; and right after it is mined, where
    // that leaves something on chain the record does not know: the launcher, the hook, setDeployers
    const cases = [];
    for (let k = 1; k <= SENDS_OF_A_FULL_RUN; k++) cases.push(["before", k]);
    for (const k of [1, 2, SENDS_OF_A_FULL_RUN]) cases.push(["after", k]);

    for (const [when, k] of cases) {
      const label = `dies ${when} transaction ${k}`;
      const snapshot = await hre.network.provider.send("evm_snapshot");
      const file = writeRecord(record);
      let n = 0;
      deployer.sendTransaction = async (tx) => {
        n++;
        if (n === k && when === "before") throw new Error(`injected: ${label}`);
        const sent = await realSend(tx);
        if (n === k && when === "after") {
          await sent.wait();
          throw new Error(`injected: ${label}`);
        }
        return sent;
      };
      let first;
      try {
        first = await run(ctx, file);
      } finally {
        deployer.sendTransaction = realSend;
      }
      expect(first.error, label).to.be.an("error");
      expect(first.error.message, label).to.include(`injected: ${label}`);
      const landed = when === "after" && k === SENDS_OF_A_FULL_RUN;
      // Until setDeployers has landed the platform is exactly as it was
      if (!landed) expect(await deployersOf(tokenFactory), label).to.deep.equal(v4Generation);
      // and once it may have, the record already names what it replaced
      if (k === SENDS_OF_A_FULL_RUN) expect(recordedPrevious(read(file)), label).to.deep.equal(v4Generation);

      const second = await runOk(ctx, file);
      const d = read(file);
      expect(second.result.sent, label).to.equal(!landed);
      expect(await deployersOf(tokenFactory), label).to.deep.equal(recordedFee(d));
      expect(recordedDeployers(d), label).to.deep.equal(recordedFee(d));
      expect(recordedPrevious(d), label).to.deep.equal(v4Generation);
      expect(d.v4FeeFromBlock, label).to.be.a("number");
      // Nothing is deployed twice, except a launcher whose address was lost with the run that made
      // it: the hook is found again at its mined address, setDeployers is found in place
      const total = first.sends + second.sends;
      expect(total, label).to.equal(SENDS_OF_A_FULL_RUN + (when === "after" && k === 1 ? 1 : 0));
      const third = await runOk(ctx, file);
      expect(third.sends, label).to.equal(0);
      await hre.network.provider.send("evm_revert", [snapshot]);
    }
  });
});
