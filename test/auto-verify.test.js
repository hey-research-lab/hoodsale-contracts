const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { deployPlatform } = require("./helpers");
const { reconstructConstructorArgs, FQN } = require("../scripts/lib/constructorArgs");
const sourcify = require("../scripts/lib/sourcify");
const { verifyOne, sourcifyApplies, STATUS } = require("../scripts/verify-contract");
const { createWatcher } = require("../scripts/auto-verify");
const { createVerificationWatcher } = require("../scripts/launch-keeper");

const E = (n) => ethers.parseEther(String(n));
const SOLC = "0.8.26+commit.8a97fa7a";

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hoodsale-${name}-`));
}

function norm(v) {
  if (typeof v === "bigint" || typeof v === "number") return v.toString();
  if (typeof v === "string") return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(norm);
  return v;
}

/**
 * A Sourcify v2 look-alike: records every submission, answers 202 + a completed job, 409 for a
 * contract it already verified, 404 for unknown contracts, and whatever `failNext` holds for the
 * next POST (for the retry tests).
 */
function startMockSourcify() {
  const state = { submissions: [], polls: [], statusCalls: [], jobs: new Map(), verified: new Map(), failNext: [], jobRounds: 0, nextJobError: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const url = new URL(req.url, "http://mock");
      let m;
      if (req.method === "POST" && (m = url.pathname.match(/^\/v2\/verify\/(\d+)\/(0x[0-9a-fA-F]{40})$/))) {
        const chainId = Number(m[1]);
        const address = m[2];
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return send(400, { customCode: "invalid_json", message: "body is not JSON" });
        }
        state.submissions.push({ chainId, address, body: parsed, contentType: req.headers["content-type"] });
        const fail = state.failNext.shift();
        if (fail) return send(fail.status, fail.body || { customCode: "internal_error", message: "boom" });
        if (state.verified.get(`${chainId}:${address.toLowerCase()}`) === "exact_match") {
          return send(409, { customCode: "already_verified", message: "The contract is already verified" });
        }
        const id = `job-${state.jobs.size + 1}`;
        state.jobs.set(id, {
          chainId,
          address,
          remaining: state.jobRounds,
          error: state.nextJobError,
          result: { match: "exact_match", runtimeMatch: "exact_match", creationMatch: null },
        });
        state.nextJobError = null;
        return send(202, { verificationId: id });
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/v2\/verify\/([^/]+)$/))) {
        state.polls.push(m[1]);
        const job = state.jobs.get(m[1]);
        if (!job) return send(404, { customCode: "job_not_found", message: "no such job" });
        if (job.remaining > 0) {
          job.remaining--;
          return send(200, { verificationId: m[1], isJobCompleted: false });
        }
        if (job.error) return send(200, { verificationId: m[1], isJobCompleted: true, error: job.error });
        state.verified.set(`${job.chainId}:${job.address.toLowerCase()}`, job.result.match);
        return send(200, { verificationId: m[1], isJobCompleted: true, contract: { chainId: String(job.chainId), address: job.address, ...job.result } });
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/v2\/contract\/(\d+)\/(0x[0-9a-fA-F]{40})$/))) {
        state.statusCalls.push(m[2]);
        const match = state.verified.get(`${m[1]}:${m[2].toLowerCase()}`);
        if (!match) return send(404, { customCode: "contract_not_verified", message: "not verified" });
        return send(200, { chainId: m[1], address: m[2], match, runtimeMatch: match, creationMatch: null });
      }
      send(404, { customCode: "not_found", message: "unknown route" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** Builds the QuickLaunch.launch call from the ABI, so the test survives new parameters. */
async function launchQuick(env, creator, name, symbol) {
  const fn = env.quickLaunch.interface.getFunction("launch");
  const valueFor = (input) => {
    if (input.name === "name") return name;
    if (input.name === "symbol") return symbol;
    if (input.name === "hardCap") return E(1);
    if (input.type === "tuple") return Object.fromEntries(input.components.map((c) => [c.name, valueFor(c)]));
    if (/^u?int/.test(input.type)) return 0;
    if (input.type === "string") return "";
    if (input.type === "bool") return false;
    if (input.type === "address") return ethers.ZeroAddress;
    throw new Error(`unexpected launch input ${input.name} ${input.type}`);
  };
  const args = fn.inputs.map(valueFor);
  const fee = await env.presaleFactory.quickCreationFee();
  const tx = await env.quickLaunch.connect(creator).launch(...args, { value: fee });
  const receipt = await tx.wait();
  const ev = receipt.logs
    .map((l) => {
      try {
        return env.quickLaunch.interface.parseLog(l);
      } catch (e) {
        return null;
      }
    })
    .find((e) => e && e.name === "QuickLaunched");
  return { token: ev.args.token, presale: ev.args.presale, txHash: tx.hash, blockNumber: receipt.blockNumber };
}

async function fixture() {
  const env = await deployPlatform();
  const { tokenFactory, presaleFactory, treasury, locker, router, hoodsale, metadataRegistry, lens, quickLaunch, weth } = env;
  const { alice, bob, carol, dave, marketing } = env;

  const txs = {};
  txs.standard = await (await tokenFactory.connect(alice).createStandardToken("Watch One", "WT1", E("1000000"))).wait();
  txs.tax = await (await tokenFactory.connect(bob).createTaxToken("Watch Two", "WT2", E("2000000"), carol.address, 200, 300)).wait();
  txs.rewards = await (
    await tokenFactory.connect(carol).createRewardsToken("Watch Three", "WT3", E("3000000"), weth.target, dave.address, [100, 200, 50, 60])
  ).wait();
  const [standardAddr, taxAddr, rewardsAddr] = await Promise.all([0, 1, 2].map((i) => tokenFactory.allTokens(i)));
  const quick = await launchQuick(env, dave, "Quick Four", "QK4");

  // A normal presale on the standard token
  const std = await ethers.getContractAt("StandardToken", standardAddr);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const params = {
    token: standardAddr, presaleRate: E("1000"), listingRate: E("800"), softCap: E("2"), hardCap: E("8"),
    minContribution: E("0.5"), maxContribution: E("4"), startTime: now + 100, endTime: now + 1000,
    liquidityBps: 6000, liquidityAction: 1, lockDuration: 0, launchTime: 0, whitelistEnabled: false,
  };
  await std.connect(alice).approve(presaleFactory.target, await presaleFactory.requiredTokensFor(params));
  await presaleFactory.connect(alice).createPresale(params, { value: E("0.1") });
  const presaleAddr = await presaleFactory.allPresales((await presaleFactory.allPresalesLength()) - 1n);

  const deployments = {
    network: "hardhat",
    router: router.target,
    treasury: treasury.target,
    locker: locker.target,
    tokenFactory: tokenFactory.target,
    presaleFactory: presaleFactory.target,
    hoodsale: hoodsale.target,
    metadataRegistry: metadataRegistry.target,
    lens: lens.target,
    quickLaunch: quickLaunch.target,
    marketingWallet: marketing.address,
  };
  const tokens = {
    [standardAddr]: { contract: FQN.StandardToken, txHash: txs.standard.hash },
    [taxAddr]: { contract: FQN.TaxToken, txHash: txs.tax.hash },
    [rewardsAddr]: { contract: FQN.RewardsToken, txHash: txs.rewards.hash },
    [quick.token]: { contract: FQN.StandardToken, txHash: quick.txHash },
  };
  return { ...env, deployments, tokens, standardAddr, taxAddr, rewardsAddr, quick, presaleAddr, chainId: Number((await ethers.provider.getNetwork()).chainId) };
}

/**
 * The platform with the Uniswap v4 mode: a v4 Standard, Tax and Rewards token created through the
 * V4Launcher (they reach the watcher through the factory's TokenCreated like any other), and a V2
 * token the same dual-mode deployer builds for an ordinary creator.
 */
async function v4Fixture() {
  const { deployPlatformV4, taxConfig } = require("./v4/helpers");
  const env = await deployPlatformV4();
  const { launcher, tokenFactory, presaleFactory, treasury, locker, router, quickLaunch, weth, alice, bob, carol, marketing } = env;

  const tokens = {};
  const create = async (signer, tokenType, spec, cfg, contract) => {
    const tx = await launcher
      .connect(signer)
      .createToken(tokenType, { rewardToken: ethers.ZeroAddress, ...spec }, taxConfig(marketing.address, cfg), signer.address);
    await tx.wait();
    const created = await launcher.tokensOfCreator(signer.address);
    tokens[created[created.length - 1]] = { contract, txHash: tx.hash };
  };
  await create(alice, 0, { name: "Watch V4 One", symbol: "WV1", totalSupply: E("1000000") }, { taxLocked: true, walletLocked: true }, FQN.HoodSaleTokenV4);
  await create(bob, 1, { name: "Watch V4 Two", symbol: "WV2", totalSupply: E("2000000") }, { marketingBuyBps: 200, marketingSellBps: 300 }, FQN.HoodSaleTokenV4);
  await create(
    carol, 2, { name: "Watch V4 Three", symbol: "WV3", totalSupply: E("3000000"), rewardToken: weth.target },
    { rewardsBuyBps: 100, rewardsSellBps: 200 }, FQN.RewardsTokenV4
  );
  const v2 = await (await tokenFactory.connect(alice).createStandardToken("Watch V2", "WV0", E("4000000"))).wait();
  tokens[await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n)] = { contract: FQN.StandardToken, txHash: v2.hash };

  const deployments = {
    network: "hardhat",
    router: router.target,
    treasury: treasury.target,
    locker: locker.target,
    tokenFactory: tokenFactory.target,
    presaleFactory: presaleFactory.target,
    quickLaunch: quickLaunch.target,
    v4Launcher: launcher.target,
  };
  return { ...env, deployments, tokens, chainId: Number((await ethers.provider.getNetwork()).chainId) };
}

/**
 * The platform with both Uniswap v4 modes on one TokenFactory: a Standard, a Tax and a Rewards
 * token created through the V4FeeLauncher, a hook mode token through the V4Launcher and a V2 token,
 * all built by the same Fee deployers and all reaching the watcher through the same TokenCreated.
 */
async function feeFixture() {
  const { deployPlatformV4Fee, taxConfig, feeTaxConfig } = require("./v4/helpers");
  const env = await deployPlatformV4Fee();
  const { launcher, feeLauncher, tokenFactory, presaleFactory, treasury, locker, router, quickLaunch, weth, alice, bob, carol, dave, marketing } = env;

  const tokens = {};
  const create = async (through, signer, tokenType, spec, cfg, contract) => {
    const tx = await through.connect(signer).createToken(tokenType, { rewardToken: ethers.ZeroAddress, ...spec }, cfg, signer.address);
    await tx.wait();
    const created = await through.tokensOfCreator(signer.address);
    tokens[created[created.length - 1]] = { contract, txHash: tx.hash, launcher: through.target };
  };
  await create(feeLauncher, alice, 0, { name: "Watch Fee One", symbol: "WF1", totalSupply: E("1000000") }, feeTaxConfig(marketing.address), FQN.HoodSaleTokenV4);
  await create(feeLauncher, bob, 1, { name: "Watch Fee Two", symbol: "WF2", totalSupply: E("2000000") }, feeTaxConfig(marketing.address, { marketingBps: 300 }), FQN.HoodSaleTokenV4);
  await create(
    feeLauncher, carol, 2, { name: "Watch Fee Three", symbol: "WF3", totalSupply: E("3000000"), rewardToken: weth.target },
    feeTaxConfig(marketing.address, { marketingBps: 100, rewardsBps: 200 }), FQN.RewardsTokenV4
  );
  await create(launcher, dave, 1, { name: "Watch Hook", symbol: "WH1", totalSupply: E("4000000") }, taxConfig(marketing.address, { marketingBuyBps: 200, marketingSellBps: 300 }), FQN.HoodSaleTokenV4);
  const v2 = await (await tokenFactory.connect(alice).createStandardToken("Watch V2", "WV0", E("5000000"))).wait();
  tokens[await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n)] = { contract: FQN.StandardToken, txHash: v2.hash, launcher: null };

  const deployments = {
    network: "hardhat",
    router: router.target,
    treasury: treasury.target,
    locker: locker.target,
    tokenFactory: tokenFactory.target,
    presaleFactory: presaleFactory.target,
    quickLaunch: quickLaunch.target,
    v4Launcher: launcher.target,
    v4FeeLauncher: feeLauncher.target,
  };
  return { ...env, deployments, tokens, chainId: Number((await ethers.provider.getNetwork()).chainId) };
}

describe("Sourcify verification", function () {
  let mock;
  let savedUrl;
  before(async function () {
    mock = await startMockSourcify();
    savedUrl = process.env.SOURCIFY_URL;
    process.env.SOURCIFY_URL = mock.url;
  });
  after(function () {
    if (savedUrl === undefined) delete process.env.SOURCIFY_URL;
    else process.env.SOURCIFY_URL = savedUrl;
    mock.server.close();
  });
  beforeEach(function () {
    mock.state.submissions.length = 0;
    mock.state.polls.length = 0;
    mock.state.statusCalls.length = 0;
    mock.state.jobs.clear();
    mock.state.verified.clear();
    mock.state.failNext.length = 0;
    mock.state.jobRounds = 0;
    mock.state.nextJobError = null;
  });

  describe("client (lib/sourcify.js)", function () {
    const addr = "0x1111111111111111111111111111111111111111";
    const pkg = { stdJsonInput: { language: "Solidity", sources: {}, settings: {} }, compilerVersion: `v${SOLC}`, contractIdentifier: "contracts/X.sol:X" };

    it("submits, polls and reports the status; the compiler version loses its v prefix", async function () {
      const sub = await sourcify.submitStandardJson({ chainId: 4663, address: addr, ...pkg, creationTransactionHash: "0xabc" });
      expect(sub.verificationId).to.equal("job-1");
      expect(sub.alreadyVerified).to.equal(false);
      const s = mock.state.submissions[0];
      expect(s.chainId).to.equal(4663);
      expect(s.contentType).to.match(/application\/json/);
      expect(s.body.compilerVersion).to.equal(SOLC);
      expect(s.body.contractIdentifier).to.equal("contracts/X.sol:X");
      expect(s.body.creationTransactionHash).to.equal("0xabc");
      expect(s.body.stdJsonInput).to.deep.equal(pkg.stdJsonInput);

      mock.state.jobs.get("job-1").remaining = 2; // two "still running" answers first
      const job = await sourcify.pollJob("job-1", { intervalMs: 1 });
      expect(job.match).to.equal("exact_match");
      expect(job.runtimeMatch).to.equal("exact_match");
      expect(job.creationMatch).to.equal(null);
      expect(mock.state.polls.filter((p) => p === "job-1")).to.have.length(3);

      const status = await sourcify.getContractStatus(4663, addr);
      expect(status.verified).to.equal(true);
      expect(status.match).to.equal("exact_match");
      const unknown = await sourcify.getContractStatus(4663, "0x2222222222222222222222222222222222222222");
      expect(unknown.verified).to.equal(false);
      expect(unknown.match).to.equal(null);

      // second submission: 409 is success
      const again = await sourcify.submitStandardJson({ chainId: 4663, address: addr, ...pkg });
      expect(again.alreadyVerified).to.equal(true);
      const whole = await sourcify.verifyStandardJson({ chainId: 4663, address: addr, ...pkg });
      expect(whole.status).to.equal("already-verified");
      expect(whole.url).to.equal(`https://repo.sourcify.dev/4663/${addr}`);
    });

    it("turns HTTP 500 into a retryable error and HTTP 400 into a final one", async function () {
      mock.state.failNext.push({ status: 500 });
      let err;
      try {
        await sourcify.submitStandardJson({ chainId: 4663, address: addr, ...pkg });
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(sourcify.SourcifyError);
      expect(err.httpStatus).to.equal(500);
      expect(err.retryable).to.equal(true);
      expect(err.customCode).to.equal("internal_error");

      mock.state.failNext.push({ status: 400, body: { customCode: "invalid_address", message: "bad address" } });
      err = null;
      try {
        await sourcify.submitStandardJson({ chainId: 4663, address: addr, ...pkg });
      } catch (e) {
        err = e;
      }
      expect(err.code).to.equal("rejected");
      expect(err.retryable).to.equal(false);
      expect(err.message).to.match(/invalid_address/);
    });

    it("reports a failed job and a completed job without a match as errors", async function () {
      mock.state.nextJobError = { customCode: "no_match", message: "bytecode does not match" };
      const sub = await sourcify.submitStandardJson({ chainId: 4663, address: addr, ...pkg });
      let err;
      try {
        await sourcify.pollJob(sub.verificationId, { intervalMs: 1 });
      } catch (e) {
        err = e;
      }
      expect(err.code).to.equal("job-failed");
      expect(err.customCode).to.equal("no_match");
      expect(err.retryable).to.equal(false);
      expect(sourcify.bestMatch({ match: null, runtimeMatch: "match", creationMatch: null })).to.equal("match");
      expect(sourcify.bestMatch({ match: null, runtimeMatch: "exact_match", creationMatch: null })).to.equal("exact_match");
      expect(sourcify.bestMatch({})).to.equal(null);
    });

    it("reports an unreachable server as a retryable network error", async function () {
      let err;
      try {
        await sourcify.getContractStatus(4663, addr, { url: "http://127.0.0.1:1", timeoutMs: 2000 });
      } catch (e) {
        err = e;
      }
      expect(err.code).to.equal("network");
      expect(err.retryable).to.equal(true);
    });

    it("knows which chains it serves and where the sources end up", function () {
      const saved = process.env.SOURCIFY_URL;
      delete process.env.SOURCIFY_URL;
      try {
        expect(sourcify.supportsChain(4663)).to.equal(true);
        expect(sourcify.supportsChain(46630)).to.equal(true);
        expect(sourcify.supportsChain(31337)).to.equal(false);
        expect(sourcify.supportsChain(31337, { chains: [31337] })).to.equal(true);
        expect(sourcify.supportsChain(31337, { url: "http://127.0.0.1:9" })).to.equal(true);
        expect(sourcifyApplies(31337, {}).applies).to.equal(false);
        expect(sourcifyApplies(4663, {}).applies).to.equal(true);
        expect(sourcifyApplies(4663, { sourcify: false }).reason).to.match(/SOURCIFY=0/);
      } finally {
        process.env.SOURCIFY_URL = saved;
      }
      expect(sourcify.supportsChain(31337)).to.equal(true); // custom server accepts every chain
      expect(sourcify.repoUrl(4663, addr)).to.equal(`https://repo.sourcify.dev/4663/${addr}`);
      expect(sourcify.normalizeCompilerVersion("v0.8.26+commit.8a97fa7a")).to.equal(SOLC);
    });
  });

  describe("verifyOne: Sourcify first, Blockscout second", function () {
    it("verifies a factory token with the package built from build-info", async function () {
      const { deployments, taxAddr, tokens, chainId } = await loadFixture(fixture);
      const lines = [];
      const r = await verifyOne(hre, { address: taxAddr }, { deployments, log: (l) => lines.push(l) });
      expect(r.status).to.equal(STATUS.VERIFIED);
      expect(r.target).to.equal("sourcify");
      expect(r.match).to.equal("exact_match");
      expect(r.sourcifyUrl).to.equal(`https://repo.sourcify.dev/${chainId}/${taxAddr}`);
      expect(r.message).to.match(/verified on Sourcify \(exact_match, creation match not available/);

      const buildInfo = await hre.artifacts.getBuildInfo(FQN.TaxToken);
      expect(mock.state.submissions).to.have.length(1);
      const s = mock.state.submissions[0];
      expect(s.chainId).to.equal(chainId);
      expect(s.address).to.equal(taxAddr);
      expect(s.body.contractIdentifier).to.equal(FQN.TaxToken);
      expect(s.body.compilerVersion).to.equal(buildInfo.solcLongVersion);
      expect(s.body.compilerVersion).to.equal(SOLC);
      expect(s.body.creationTransactionHash).to.equal(tokens[taxAddr].txHash);
      expect(s.body.stdJsonInput.settings).to.deep.equal(buildInfo.input.settings);
      const sources = Object.keys(s.body.stdJsonInput.sources);
      expect(sources).to.include("contracts/tokens/TaxToken.sol");
      expect(sources).to.not.include("contracts/Presale.sol");
      expect(sources).to.not.include("contracts/QuickLaunch.sol");
    });

    it("treats an already verified contract as success without a new submission", async function () {
      const { deployments, standardAddr } = await loadFixture(fixture);
      const first = await verifyOne(hre, { address: standardAddr }, { deployments, log: () => {} });
      expect(first.status).to.equal(STATUS.VERIFIED);
      const second = await verifyOne(hre, { address: standardAddr }, { deployments, log: () => {} });
      expect(second.status).to.equal(STATUS.ALREADY);
      expect(second.target).to.equal("sourcify");
      expect(second.sourcifyUrl).to.match(/repo\.sourcify\.dev/);
      expect(mock.state.submissions).to.have.length(1);
      // the server answering 409 (status check skipped) is success as well
      mock.state.statusCalls.length = 0;
      const third = await verifyOne(hre, { address: standardAddr }, { deployments, log: () => {}, sourcifyOptions: {} });
      expect(third.status).to.equal(STATUS.ALREADY);
    });

    it("keeps a Sourcify HTTP 500 retryable when Blockscout is not reachable, without a manual package", async function () {
      const { deployments, rewardsAddr } = await loadFixture(fixture);
      mock.state.failNext.push({ status: 500 });
      const out = tmpDir("no-package");
      const r = await verifyOne(hre, { address: rewardsAddr }, { deployments, outDir: out, log: () => {} });
      expect(r.status).to.equal(STATUS.FAILED);
      expect(r.retryable).to.equal(true);
      expect(r.message).to.match(/sourcify: .*HTTP 500/);
      expect(r.message).to.match(/blockscout: unsupported network/);
      expect(r.contract).to.equal(FQN.RewardsToken);
      expect(fs.readdirSync(out)).to.deep.equal([]);
    });

    it("falls back to the plain Blockscout behaviour when Sourcify is off", async function () {
      const { deployments, standardAddr } = await loadFixture(fixture);
      const r = await verifyOne(hre, { address: standardAddr }, { deployments, sourcify: false, log: () => {} });
      expect(r.status).to.equal(STATUS.UNSUPPORTED); // hardhat has no explorer
      expect(mock.state.submissions).to.have.length(0);
    });

    it("prints the Sourcify submission in DRY_RUN without touching the server", async function () {
      const { deployments, standardAddr } = await loadFixture(fixture);
      const lines = [];
      const r = await verifyOne(hre, { address: standardAddr }, { deployments, dryRun: true, log: (l) => lines.push(l) });
      expect(r.status).to.equal(STATUS.DRY_RUN);
      const text = lines.join("\n");
      expect(text).to.match(/sourcify:\s+POST .*\/v2\/verify\/31337\//);
      expect(text).to.include(`compilerVersion: "${SOLC}"`);
      expect(mock.state.submissions).to.have.length(0);
    });
  });

  describe("tokens created inside a factory call (QuickLaunch)", function () {
    it("reconstructs the exact constructor arguments from the creation receipt", async function () {
      const { deployments, quick, quickLaunch, treasury, tokenFactory, router } = await loadFixture(fixture);
      const r = await reconstructConstructorArgs(ethers.provider, quick.token, { deployments });
      expect(r.contract).to.equal(FQN.StandardToken);
      const supply = await quickLaunch.TOTAL_SUPPLY();
      expect(norm(r.args)).to.deep.equal(norm(["Quick Four", "QK4", supply, quickLaunch.target, treasury.target, tokenFactory.target, router.target, 25]));
      expect(r.meta.sources.totalSupply).to.equal("creation-receipt");
      expect(r.meta.warnings).to.deep.equal([]);
      expect(r.meta.creation.transactionHash).to.equal(quick.txHash);
      // the encoded arguments decode back to the same values
      const artifact = await hre.artifacts.readArtifact(FQN.StandardToken);
      const types = artifact.abi.find((f) => f.type === "constructor").inputs;
      const encoded = new ethers.Interface(artifact.abi).encodeDeploy(r.args);
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, encoded);
      expect(norm(Array.from(decoded))).to.deep.equal(norm(r.args));
      // the receipt path also works when the creation block is passed in (as the watcher does)
      const known = await reconstructConstructorArgs(ethers.provider, quick.token, {
        deployments,
        creation: { blockNumber: quick.blockNumber, transactionHash: quick.txHash },
      });
      expect(known.meta.sources.totalSupply).to.equal("creation-receipt");
      // and without the receipt the archive path still answers
      const archive = await reconstructConstructorArgs(ethers.provider, quick.token, { deployments, strategies: ["creation-state"] });
      expect(norm(archive.args)).to.deep.equal(norm(r.args));
      expect(archive.meta.sources.totalSupply).to.equal("creation-state");
    });

    it("verifies the QuickLaunch token on Sourcify with the launch transaction as creation tx", async function () {
      const { deployments, quick } = await loadFixture(fixture);
      const r = await verifyOne(hre, { address: quick.token }, { deployments, log: () => {} });
      expect(r.status).to.equal(STATUS.VERIFIED);
      const s = mock.state.submissions[0];
      expect(s.body.contractIdentifier).to.equal(FQN.StandardToken);
      expect(s.body.creationTransactionHash).to.equal(quick.txHash);
    });
  });

  describe("auto-verify watcher", function () {
    function watcherFor(deployments, extra = {}) {
      const lines = [];
      const w = createWatcher(hre, {
        deployments,
        stateFile: path.join(tmpDir("verify-state"), "hardhat.json"),
        startBlock: 0,
        confirmations: 0,
        log: (...a) => lines.push(a.join(" ")),
        ...extra,
      });
      return { w, lines };
    }

    it("verifies every factory token (Standard, Tax, Rewards, QuickLaunch) on Sourcify and skips the presale with VERIFY_PRESALES=0", async function () {
      const { deployments, tokens, presaleAddr, chainId } = await loadFixture(fixture);
      const savedFlag = process.env.VERIFY_PRESALES;
      process.env.VERIFY_PRESALES = "0";
      let w, lines;
      try {
        ({ w, lines } = watcherFor(deployments));
      } finally {
        if (savedFlag === undefined) delete process.env.VERIFY_PRESALES;
        else process.env.VERIFY_PRESALES = savedFlag;
      }
      expect(w.cfg.verifyPresales).to.equal(false);
      const s = await w.tick();
      expect(s.error).to.equal(null);
      expect(s.found).to.equal(4);
      expect(s.pending).to.equal(0);
      expect(s.done).to.equal(4);

      // one submission per token, with the right identifier, compiler and creation tx
      expect(mock.state.submissions).to.have.length(4);
      for (const [address, exp] of Object.entries(tokens)) {
        const sub = mock.state.submissions.find((x) => x.address.toLowerCase() === address.toLowerCase());
        expect(sub, address).to.not.equal(undefined);
        expect(sub.chainId).to.equal(chainId);
        expect(sub.body.contractIdentifier).to.equal(exp.contract);
        expect(sub.body.compilerVersion).to.equal(SOLC);
        expect(sub.body.creationTransactionHash).to.equal(exp.txHash);
        expect(Object.keys(sub.body.stdJsonInput.sources)).to.include(exp.contract.split(":")[0]);
        const d = w.state.done[address.toLowerCase()];
        expect(d.status).to.equal(STATUS.VERIFIED);
        expect(d.kind).to.equal("token");
        expect(d.contract).to.equal(exp.contract);
        expect(d.match).to.equal("exact_match");
        expect(d.sourcifyUrl).to.equal(`https://repo.sourcify.dev/${chainId}/${address}`);
        expect(lines.some((l) => l.includes(address) && l.includes(d.sourcifyUrl) && /verified on Sourcify/.test(l)), address).to.equal(true);
      }
      expect(w.state.done[presaleAddr.toLowerCase()]).to.equal(undefined);
      expect(w.state.pending[presaleAddr.toLowerCase()]).to.equal(undefined);
      expect(Object.values(w.state.done).every((d) => d.kind === "token")).to.equal(true);

      // persisted
      const saved = JSON.parse(fs.readFileSync(w.stateFile, "utf8"));
      expect(Object.keys(saved.done)).to.have.length(4);
      expect(saved.done[Object.keys(tokens)[0].toLowerCase()].sourcifyUrl).to.match(/repo\.sourcify\.dev/);
      // a second round finds nothing new and submits nothing
      const s2 = await w.tick();
      expect(s2.found).to.equal(0);
      expect(mock.state.submissions).to.have.length(4);
    });

    it("submits a v4 token under its own contract, not the V2 one of its factory token type", async function () {
      const { deployments, tokens, chainId } = await loadFixture(v4Fixture);
      const { w, lines } = watcherFor(deployments, { verifyPresales: false });
      const s = await w.tick();
      expect(s.error).to.equal(null);
      expect(s.found).to.equal(4);
      expect(s.done).to.equal(4);
      expect(mock.state.submissions).to.have.length(4);
      for (const [address, exp] of Object.entries(tokens)) {
        const sub = mock.state.submissions.find((x) => x.address.toLowerCase() === address.toLowerCase());
        expect(sub, address).to.not.equal(undefined);
        expect(sub.body.contractIdentifier, address).to.equal(exp.contract);
        expect(sub.body.creationTransactionHash, address).to.equal(exp.txHash);
        const sources = Object.keys(sub.body.stdJsonInput.sources);
        expect(sources, address).to.include(exp.contract.split(":")[0]);
        const d = w.state.done[address.toLowerCase()];
        expect(d.status, address).to.equal(STATUS.VERIFIED);
        expect(d.kind, address).to.equal("token");
        expect(d.contract, address).to.equal(exp.contract);
        expect(d.sourcifyUrl).to.equal(`https://repo.sourcify.dev/${chainId}/${address}`);
        // the log line names the contract that was submitted
        const short = exp.contract.slice(exp.contract.lastIndexOf(":") + 1);
        expect(lines.some((l) => l.includes(address) && l.includes(`(${short})`)), address).to.equal(true);
      }
      // the v4 token's package carries the v4 source and not the V2 token it would otherwise be named after
      const v4Tax = Object.keys(tokens).find((a) => tokens[a].contract === FQN.HoodSaleTokenV4);
      const sub = mock.state.submissions.find((x) => x.address.toLowerCase() === v4Tax.toLowerCase());
      expect(Object.keys(sub.body.stdJsonInput.sources)).to.not.include("contracts/tokens/TaxToken.sol");
      expect(Object.keys(sub.body.stdJsonInput.sources)).to.not.include("contracts/tokens/StandardToken.sol");
    });

    it("submits a fee mode token under the v4 contract it shares with hook mode, naming the fee launcher", async function () {
      const { deployments, tokens, chainId, feeLauncher, launcher } = await loadFixture(feeFixture);
      const { w, lines } = watcherFor(deployments, { verifyPresales: false });
      const s = await w.tick();
      expect(s.error).to.equal(null);
      expect(s.found).to.equal(5);
      expect(s.done).to.equal(5);
      expect(mock.state.submissions).to.have.length(5);
      for (const [address, exp] of Object.entries(tokens)) {
        const sub = mock.state.submissions.find((x) => x.address.toLowerCase() === address.toLowerCase());
        expect(sub, address).to.not.equal(undefined);
        expect(sub.body.contractIdentifier, address).to.equal(exp.contract);
        expect(sub.body.creationTransactionHash, address).to.equal(exp.txHash);
        expect(Object.keys(sub.body.stdJsonInput.sources), address).to.include(exp.contract.split(":")[0]);
        const d = w.state.done[address.toLowerCase()];
        expect(d.status, address).to.equal(STATUS.VERIFIED);
        expect(d.kind, address).to.equal("token");
        expect(d.contract, address).to.equal(exp.contract);
        expect(d.sourcifyUrl).to.equal(`https://repo.sourcify.dev/${chainId}/${address}`);
        const short = exp.contract.slice(exp.contract.lastIndexOf(":") + 1);
        expect(lines.some((l) => l.includes(address) && l.includes(`(${short})`)), address).to.equal(true);
        // what the watcher submitted is what the reconstruction gives: the launcher argument is
        // the launcher that made the token, and the mode follows from it
        const r = await reconstructConstructorArgs(ethers.provider, address, { deployments });
        expect(r.meta.warnings, address).to.deep.equal([]);
        if (exp.launcher) {
          expect(r.args[3], address).to.equal(exp.launcher);
          expect(r.meta.launchMode, address).to.equal(exp.launcher === feeLauncher.target ? "fee" : "hook");
        } else {
          expect(r.meta.launchMode, address).to.equal(undefined);
        }
      }
      expect(Object.values(tokens).filter((t) => t.launcher === feeLauncher.target)).to.have.length(3);
      expect(Object.values(tokens).filter((t) => t.launcher === launcher.target)).to.have.length(1);
      // a fee mode token's package carries the v4 token and no V2 token, exactly as in hook mode
      const feeTax = Object.keys(tokens).find((a) => tokens[a].launcher === feeLauncher.target && tokens[a].contract === FQN.HoodSaleTokenV4);
      const sub = mock.state.submissions.find((x) => x.address.toLowerCase() === feeTax.toLowerCase());
      expect(Object.keys(sub.body.stdJsonInput.sources)).to.include("contracts/v4/tokens/HoodSaleTokenV4.sol");
      expect(Object.keys(sub.body.stdJsonInput.sources)).to.not.include("contracts/tokens/TaxToken.sol");
      expect(Object.keys(sub.body.stdJsonInput.sources)).to.not.include("contracts/tokens/StandardToken.sol");
    });

    it("includes presales by default", async function () {
      const { deployments, presaleAddr, quick } = await loadFixture(fixture);
      const { w } = watcherFor(deployments);
      expect(w.cfg.verifyPresales).to.equal(true);
      const s = await w.tick();
      // 4 tokens + the normal presale + the quick presale QuickLaunch created
      expect(s.found).to.equal(6);
      expect(s.done).to.equal(6);
      for (const address of [presaleAddr, quick.presale]) {
        const d = w.state.done[address.toLowerCase()];
        expect(d.kind, address).to.equal("presale");
        expect(d.status, address).to.equal(STATUS.VERIFIED);
        expect(d.contract, address).to.equal(FQN.Presale);
      }
      const sub = mock.state.submissions.find((x) => x.address.toLowerCase() === presaleAddr.toLowerCase());
      expect(sub.body.contractIdentifier).to.equal(FQN.Presale);
      expect(Object.keys(sub.body.stdJsonInput.sources)).to.include("contracts/Presale.sol");
    });

    it("retries with backoff after a Sourcify 500 and verifies on the next attempt", async function () {
      const { deployments, standardAddr } = await loadFixture(fixture);
      let now = 5_000_000;
      const realNow = Date.now;
      Date.now = () => now;
      try {
        // the first submission of every token fails, the later ones succeed
        for (let i = 0; i < 6; i++) mock.state.failNext.push({ status: 500 });
        const { w, lines } = watcherFor(deployments, { backoffBaseMs: 1000, backoffMaxMs: 8000, maxAttempts: 4 });
        await w.tick();
        expect(mock.state.submissions).to.have.length(6);
        const pending = Object.values(w.state.pending);
        expect(pending).to.have.length(6);
        expect(pending.every((p) => p.attempts === 1 && p.nextAttemptAt === now + 1000)).to.equal(true);
        expect(pending.every((p) => /HTTP 500/.test(p.lastError))).to.equal(true);
        expect(lines.some((l) => /attempt 1 failed .*HTTP 500.*retry in 1s/.test(l))).to.equal(true);
        expect(Object.keys(w.state.done)).to.have.length(0);

        await w.tick(); // not due yet
        expect(mock.state.submissions).to.have.length(6);
        now += 1000;
        await w.tick(); // attempt 2 succeeds
        expect(mock.state.submissions).to.have.length(12);
        expect(Object.keys(w.state.pending)).to.have.length(0);
        expect(Object.keys(w.state.done)).to.have.length(6);
        const d = w.state.done[standardAddr.toLowerCase()];
        expect(d.status).to.equal(STATUS.VERIFIED);
        expect(d.attempts).to.equal(2);
        expect(d.sourcifyUrl).to.match(/repo\.sourcify\.dev\/31337\//);
      } finally {
        Date.now = realNow;
      }
    });

    it("ONCE mode runs a single round and returns", async function () {
      const { deployments } = await loadFixture(fixture);
      const { w, lines } = watcherFor(deployments, { pollIntervalMs: 60_000 });
      const started = Date.now();
      await w.run({ once: true });
      expect(Date.now() - started).to.be.lessThan(30_000);
      expect(Object.keys(w.state.done)).to.have.length(6);
      expect(lines[0]).to.match(/watching TokenFactory .*and PresaleFactory .*target Sourcify then Blockscout/);
      expect(fs.existsSync(w.stateFile)).to.equal(true);
    });

    it("runs inside the keeper process unless AUTO_VERIFY=0", async function () {
      const { deployments } = await loadFixture(fixture);
      const off = await createVerificationWatcher(hre, { deployments, env: { AUTO_VERIFY: "0" } });
      expect(off.watcher).to.equal(null);
      expect(off.reason).to.equal("AUTO_VERIFY=0");

      const noVerifier = await createVerificationWatcher(hre, { deployments, env: {}, sourcifyOptions: { url: sourcify.DEFAULT_URL, chains: [4663] } });
      expect(noVerifier.watcher).to.equal(null);
      expect(noVerifier.reason).to.match(/no verifier for chainId 31337/);

      const lines = [];
      const on = await createVerificationWatcher(hre, {
        deployments,
        env: {},
        log: (l) => lines.push(l),
        stateFile: path.join(tmpDir("verify-state"), "hardhat.json"),
        startBlock: 0,
        confirmations: 0,
      });
      expect(on.reason).to.equal(null);
      expect(on.watcher.cfg.verifyPresales).to.equal(true);
      const s = await on.watcher.tick();
      // 4 tokens + the normal presale + the quick presale
      expect(s.done).to.equal(6);
      expect(lines.every((l) => l.startsWith("verify "))).to.equal(true);
      expect(lines.filter((l) => /verified on Sourcify/.test(l))).to.have.length(6);
    });
  });
});
