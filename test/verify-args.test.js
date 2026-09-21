const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { deployPlatform } = require("./helpers");
const { reconstructConstructorArgs, toPlainArgs, FQN, bytecodeMatches } = require("../scripts/lib/constructorArgs");
const { buildVerificationPackage, writeVerificationPackage } = require("../scripts/verify-standard-json");
const { verifyOne, verifyAddresses, classifyVerifyError, probeExplorerApi, STATUS } = require("../scripts/verify-contract");
const verifyPlatform = require("../scripts/verify-platform");
const { createWatcher } = require("../scripts/auto-verify");

const E = (n) => ethers.parseEther(String(n));

// bigint/number -> string, addresses lowercased; for deep comparison
function norm(v) {
  if (typeof v === "bigint" || typeof v === "number") return v.toString();
  if (typeof v === "string") return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = norm(v[k]);
    return o;
  }
  return v;
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hoodsale-${name}-`));
}

async function fixture() {
  const env = await deployPlatform();
  const { tokenFactory, presaleFactory, treasury, locker, router, hoodsale, metadataRegistry, lens, weth, v3Router, v3Quoter, rewardsTokenCode } = env;
  const { deployer, alice, bob, carol, dave, marketing } = env;
  const provider = ethers.provider;

  // One token of each type, with distinctive parameters
  await tokenFactory.connect(alice).createStandardToken("Alpha One", "ALP1", E("12345678"));
  await tokenFactory.connect(bob).createTaxToken("Taxed Two", "TAX2", E("500000"), carol.address, 250, 375);
  await tokenFactory
    .connect(carol)
    .createRewardsToken("Rewarding Three", "RWD3", E("2000000"), weth.target, dave.address, [150, 250, 100, 200]);
  // One more tax token that is never changed (for the events path)
  await tokenFactory.connect(dave).createTaxToken("Untouched", "UNT", E("777"), alice.address, 111, 222);

  const tokens = [];
  for (let i = 0; i < 4; i++) tokens.push(await tokenFactory.allTokens(i));
  const [standardAddr, taxAddr, rewardsAddr, untouchedAddr] = tokens;

  // Presale: whitelist + launchTime + burn option
  const std = await ethers.getContractAt("StandardToken", standardAddr);
  const now = (await provider.getBlock("latest")).timestamp;
  const params = {
    token: standardAddr,
    presaleRate: E("1000"),
    listingRate: E("800"),
    softCap: E("2"),
    hardCap: E("8"),
    minContribution: E("0.5"),
    maxContribution: E("4"),
    startTime: now + 100,
    endTime: now + 1000,
    liquidityBps: 6000,
    liquidityAction: 1,
    lockDuration: 30n * 24n * 3600n,
    launchTime: now + 1500,
    whitelistEnabled: true,
  };
  const required = await presaleFactory.requiredTokensFor(params);
  await std.connect(alice).approve(presaleFactory.target, required);
  await presaleFactory.connect(alice).createPresale(params, { value: E("0.1") });
  const presaleAddr = await presaleFactory.allPresales(0);

  // The owners change everything afterwards: reconstruction must still return the ORIGINAL values
  const tax = await ethers.getContractAt("TaxToken", taxAddr);
  await tax.connect(bob).setTaxes(100, 200);
  await tax.connect(bob).setMarketingWallet(dave.address);
  const rw = await ethers.getContractAt("RewardsToken", rewardsAddr);
  await rw.connect(carol).setTaxes(50, 60, 70, 80);
  await rw.connect(carol).setMarketingWallet(alice.address);
  await treasury.transferOwnership(bob.address);
  await tokenFactory.setRouter(bob.address);
  await tokenFactory.setTreasury(carol.address);
  await presaleFactory.setLocker(dave.address);
  await presaleFactory.setTreasury(alice.address);
  await hoodsale.setMarketingWallet(alice.address);
  await hoodsale.setTreasury(bob.address);
  await hoodsale.transferOwnership(carol.address);

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
    marketingWallet: marketing.address,
  };

  const expected = {
    [standardAddr]: {
      contract: FQN.StandardToken,
      args: ["Alpha One", "ALP1", E("12345678"), alice.address, treasury.target, tokenFactory.target, router.target, 25],
    },
    [taxAddr]: {
      contract: FQN.TaxToken,
      args: ["Taxed Two", "TAX2", E("500000"), bob.address, treasury.target, tokenFactory.target, router.target, 25, carol.address, 250, 375],
    },
    [rewardsAddr]: {
      contract: FQN.RewardsToken,
      args: [
        "Rewarding Three", "RWD3", E("2000000"), carol.address, treasury.target, tokenFactory.target, router.target, 25,
        weth.target, dave.address, [150, 250, 100, 200],
        // the Uniswap V3 leg: the chain's router and quoter, and no platform path for WETH
        v3Router.target, v3Quoter.target, "0x",
      ],
    },
    [untouchedAddr]: {
      contract: FQN.TaxToken,
      args: ["Untouched", "UNT", E("777"), dave.address, treasury.target, tokenFactory.target, router.target, 25, alice.address, 111, 222],
    },
    [presaleAddr]: {
      contract: FQN.Presale,
      args: [params, alice.address, router.target, locker.target, treasury.target, 1000, 1000],
    },
    [await tokenFactory.standardDeployer()]: { contract: FQN.StandardTokenDeployer, args: [tokenFactory.target] },
    [await tokenFactory.taxDeployer()]: { contract: FQN.TaxTokenDeployer, args: [tokenFactory.target] },
    [await tokenFactory.rewardsDeployer()]: { contract: FQN.RewardsTokenDeployer, args: [tokenFactory.target, v3Router.target, v3Quoter.target, rewardsTokenCode.target] },
    [rewardsTokenCode.target]: { contract: FQN.RewardsTokenCode, args: [] },
    [treasury.target]: { contract: FQN.Treasury, args: [deployer.address] },
    [locker.target]: { contract: FQN.LiquidityLocker, args: [] },
    [tokenFactory.target]: { contract: FQN.TokenFactory, args: [deployer.address, treasury.target, router.target] },
    [presaleFactory.target]: {
      contract: FQN.PresaleFactory,
      args: [deployer.address, treasury.target, tokenFactory.target, locker.target, router.target],
    },
    [hoodsale.target]: { contract: FQN.HoodSaleToken, args: [deployer.address, router.target, treasury.target, marketing.address] },
    [metadataRegistry.target]: { contract: FQN.TokenMetadataRegistry, args: [tokenFactory.target] },
    [lens.target]: { contract: FQN.HoodSaleLens, args: [presaleFactory.target, tokenFactory.target, router.target] },
  };

  return { ...env, provider, deployments, expected, standardAddr, taxAddr, rewardsAddr, untouchedAddr, presaleAddr, params };
}

describe("constructor argument reconstruction", function () {
  it("sanity: the owners really changed the mutable state", async function () {
    const { taxAddr, rewardsAddr, treasury, tokenFactory, hoodsale, bob, alice } = await loadFixture(fixture);
    const tax = await ethers.getContractAt("TaxToken", taxAddr);
    expect(await tax.buyTaxBps()).to.equal(100);
    expect(await tax.marketingWallet()).to.not.equal((await loadFixture(fixture)).carol.address);
    const rw = await ethers.getContractAt("RewardsToken", rewardsAddr);
    expect(await rw.rewardsBuyTaxBps()).to.equal(50);
    expect(await rw.marketingWallet()).to.equal(alice.address);
    expect(await treasury.owner()).to.equal(bob.address);
    expect(await tokenFactory.router()).to.equal(bob.address);
    expect(await hoodsale.marketingWallet()).to.equal(alice.address);
  });

  it("returns the exact fully qualified name and original args for every contract (default strategies)", async function () {
    const { provider, deployments, expected } = await loadFixture(fixture);
    for (const [address, exp] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments });
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), `${exp.contract} ${address}`).to.deep.equal(norm(exp.args));
      expect(r.address).to.equal(ethers.getAddress(address));
    }
  });

  it("uses creation calldata for tokens and the creation tx for EOA-deployed platform contracts", async function () {
    const { provider, deployments, taxAddr, rewardsAddr, standardAddr, tokenFactory, hoodsale, treasury } = await loadFixture(fixture);
    for (const a of [taxAddr, rewardsAddr, standardAddr]) {
      const r = await reconstructConstructorArgs(provider, a, { deployments });
      // The V3 path of a Rewards token is not in the factory calldata: it comes from the creation
      // receipt, the router and quoter are immutables
      const fromCalldata = Object.entries(r.meta.sources).filter(([k]) => !["rewardRouteV3", "v3Router", "v3Quoter"].includes(k));
      expect(fromCalldata.every(([, s]) => s === "creation-calldata"), a).to.equal(true);
      if (a === rewardsAddr) {
        expect(r.meta.sources.rewardRouteV3).to.equal("creation-receipt");
        expect(r.meta.sources.v3Router).to.equal("immutable-state");
      }
      expect(r.meta.warnings).to.deep.equal([]);
      expect(r.meta.creation.blockNumber).to.be.a("number");
    }
    for (const a of [tokenFactory.target, hoodsale.target, treasury.target]) {
      const r = await reconstructConstructorArgs(provider, a, { deployments });
      expect(r.meta.sources.all, a).to.equal("creation-tx");
      expect(r.meta.warnings).to.deep.equal([]);
    }
  });

  it("still recovers the original values from creation-block state (archive path)", async function () {
    const { provider, deployments, expected } = await loadFixture(fixture);
    for (const [address, exp] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments, strategies: ["creation-state"] });
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), `${exp.contract} ${address}`).to.deep.equal(norm(exp.args));
    }
  });

  it("falls back to current state with explicit warnings when only events are available", async function () {
    const { provider, deployments, taxAddr, untouchedAddr, rewardsAddr, expected, dave } = await loadFixture(fixture);
    // Modified tax token: current values + CHANGED warnings
    const changed = await reconstructConstructorArgs(provider, taxAddr, { deployments, strategies: ["events", "current"] });
    expect(changed.args[9]).to.equal(100n);
    expect(changed.args[10]).to.equal(200n);
    expect(changed.args[8]).to.equal(dave.address);
    expect(changed.meta.sources.buyTaxBps).to.equal("current-CHANGED");
    expect(changed.meta.sources.marketingWallet).to.equal("current-CHANGED");
    expect(changed.meta.warnings.join(" ")).to.match(/setTaxes/).and.match(/setMarketingWallet/);
    // Never-modified tax token: current == original, verified through events
    const same = await reconstructConstructorArgs(provider, untouchedAddr, { deployments, strategies: ["events", "current"] });
    expect(norm(same.args)).to.deep.equal(norm(expected[untouchedAddr].args));
    expect(same.meta.sources.buyTaxBps).to.equal("current-unchanged-by-events");
    expect(same.meta.warnings).to.deep.equal([]);
    // Rewards: always UNVERIFIED because marketingWallet emits no event; the V3 path never changed
    const rw = await reconstructConstructorArgs(provider, rewardsAddr, { deployments, strategies: ["events", "current"] });
    expect(rw.meta.sources.marketingWallet).to.equal("current-UNVERIFIED");
    expect(rw.meta.sources.rewardRouteV3).to.equal("current-unchanged-by-events");
    expect(rw.meta.warnings.join(" ")).to.match(/emits no event/);
    expect(rw.args[13]).to.equal("0x");
  });

  // A Rewards token whose V3 path was set by the deployer at creation (the platform route of its
  // reward token) and changed afterwards: the receipt keeps the original exactly, the archive path
  // reads it at the creation block, and the events path reports the change.
  async function v3PathFixture() {
    const env = await deployPlatform();
    const { tokenFactory, quickLaunch, v3Factory, v3Router, v3Quoter, weth, treasury, router, carol, dave } = env;
    const tsla = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E("1000000")]);
    const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 1_000_000n * 10n ** 6n]);
    await v3Factory.createPool(weth.target, tsla.target, 3000);
    await v3Factory.createPool(weth.target, usdg.target, 500);
    await v3Factory.createPool(usdg.target, tsla.target, 3000);
    const pool = await ethers.getContractAt("MockV3Pool", await v3Factory.getPool(weth.target, tsla.target, 3000));
    await weth.deposit({ value: E("50") });
    await weth.transfer(pool.target, E("50"));
    await tsla.transfer(pool.target, E("345"));
    await pool.sync();
    const path = ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, tsla.target]);
    const otherPath = ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address"],
      [weth.target, 500, usdg.target, 3000, tsla.target]
    );
    await quickLaunch.setRewardTokenAllowed(tsla.target, true);
    await quickLaunch.setRewardRouteV3(tsla.target, path);

    // Created directly through the factory: the deployer passes the platform path
    const direct = await (
      await tokenFactory.connect(carol).createRewardsToken("Direct Stock", "DSTK", E("3000000"), tsla.target, dave.address, [150, 250, 100, 200])
    ).wait();
    const directAddr = await tokenFactory.allTokens(0);
    const directToken = await ethers.getContractAt("RewardsToken", directAddr);
    expect(await directToken.rewardRouteV3()).to.equal(path);
    // The owner points it elsewhere, then clears it through a V2 route
    await directToken.connect(carol).setRewardRouteV3(otherPath);
    await directToken.connect(carol).setRewardRoute([weth.target, usdg.target]);
    expect(await directToken.rewardRouteV3()).to.equal("0x");

    // Launched through QuickLaunch: the constructor stores the path, launch applies it again in the same tx
    const q = {
      name: "Quick Stock", symbol: "QSTK", hardCap: E("1"), durationOption: 0, creatorSharePercent: 0,
      tokenType: 2, rewardToken: tsla.target, taxWallet: ethers.ZeroAddress, buyTaxBps: 100, sellTaxBps: 100,
      rewardsBuyBps: 300, rewardsSellBps: 300, logoURI: "", description: "",
    };
    const launch = await (await quickLaunch.connect(dave).launch(q, { value: await env.presaleFactory.quickCreationFee() })).wait();
    const quickAddr = await tokenFactory.allTokens(1);
    const quickToken = await ethers.getContractAt("RewardsToken", quickAddr);
    expect(await quickToken.rewardRouteV3()).to.equal(path);

    const deployments = { network: "hardhat", router: router.target, treasury: treasury.target, tokenFactory: tokenFactory.target, presaleFactory: env.presaleFactory.target, quickLaunch: quickLaunch.target };
    const base = [treasury.target, tokenFactory.target, router.target, 25, tsla.target];
    const expected = {
      [directAddr]: ["Direct Stock", "DSTK", E("3000000"), carol.address, ...base, dave.address, [150, 250, 100, 200], v3Router.target, v3Quoter.target, path],
      [quickAddr]: ["Quick Stock", "QSTK", await quickLaunch.TOTAL_SUPPLY(), quickLaunch.target, ...base, dave.address, [300, 300, 100, 100], v3Router.target, v3Quoter.target, path],
    };
    return { ...env, provider: ethers.provider, deployments, expected, directAddr, quickAddr, path, otherPath, txs: { direct: direct.hash, launch: launch.hash } };
  }

  it("recovers the original V3 path of a Rewards token from the creation receipt after the route changed", async function () {
    const { provider, deployments, expected, directAddr, quickAddr, path, txs } = await loadFixture(v3PathFixture);
    for (const [address, args] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments });
      expect(r.contract, address).to.equal(FQN.RewardsToken);
      expect(norm(r.args), address).to.deep.equal(norm(args));
      expect(r.meta.sources.rewardRouteV3, address).to.equal("creation-receipt");
      // the quick token's taxes come from the creation-block state (no factory calldata), which
      // carries the usual marketing wallet note; nothing about the route
      expect(r.meta.warnings.filter((w) => !/setMarketingWallet/.test(w)), address).to.deep.equal([]);
      // the encoded arguments decode back to the same values
      const artifact = await hre.artifacts.readArtifact(FQN.RewardsToken);
      const types = artifact.abi.find((f) => f.type === "constructor").inputs;
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, new ethers.Interface(artifact.abi).encodeDeploy(r.args));
      expect(decoded[13]).to.equal(path);
    }
    // the receipt path also works when the creation is passed in (as the watcher does)
    const known = await reconstructConstructorArgs(provider, quickAddr, { deployments, creation: { blockNumber: (await provider.getTransactionReceipt(txs.launch)).blockNumber, transactionHash: txs.launch } });
    expect(known.args[13]).to.equal(path);
    // the archive path reads the path at the creation block
    const archive = await reconstructConstructorArgs(provider, directAddr, { deployments, strategies: ["creation-state"] });
    expect(archive.args[13]).to.equal(path);
    expect(archive.meta.sources.rewardRouteV3).to.equal("creation-state");
    // events only: the direct token changed its route (current empty path, CHANGED), the quick one did not
    const changed = await reconstructConstructorArgs(provider, directAddr, { deployments, strategies: ["events", "current"] });
    expect(changed.args[13]).to.equal("0x");
    expect(changed.meta.sources.rewardRouteV3).to.equal("current-CHANGED");
    expect(changed.meta.warnings.join(" ")).to.match(/RewardRouteV3Updated/);
    const same = await reconstructConstructorArgs(provider, quickAddr, { deployments, strategies: ["events", "current"] });
    expect(same.args[13]).to.equal(path);
    expect(same.meta.sources.rewardRouteV3).to.equal("current-unchanged-by-events");
  });

  it("identifies platform contracts by bytecode when no deployments file is given", async function () {
    const { provider, expected, deployments } = await loadFixture(fixture);
    for (const key of ["treasury", "locker", "tokenFactory", "presaleFactory", "hoodsale", "metadataRegistry", "lens"]) {
      const address = deployments[key];
      const r = await reconstructConstructorArgs(provider, address, {});
      expect(r.contract, key).to.equal(expected[address].contract);
      expect(norm(r.args), key).to.deep.equal(norm(expected[address].args));
      expect(r.meta.viaBytecode).to.equal(true);
    }
    // tokens/presale/deployers are recognised from the chain even without deployments
    for (const address of Object.keys(expected)) {
      const r = await reconstructConstructorArgs(provider, address, {});
      expect(r.contract, address).to.equal(expected[address].contract);
    }
  });

  it("accepts a known creation block and skips the log search", async function () {
    const { provider, deployments, taxAddr, tokenFactory, expected } = await loadFixture(fixture);
    const logs = await tokenFactory.queryFilter(tokenFactory.filters.TokenCreated(taxAddr));
    const creation = { blockNumber: logs[0].blockNumber, transactionHash: logs[0].transactionHash };
    const r = await reconstructConstructorArgs(provider, taxAddr, { deployments, creation });
    expect(norm(r.args)).to.deep.equal(norm(expected[taxAddr].args));
    expect(r.meta.creation.transactionHash).to.equal(creation.transactionHash);
  });

  it("rejects EOAs and foreign contracts with clear errors", async function () {
    const { provider, deployments, weth, alice } = await loadFixture(fixture);
    await expect(reconstructConstructorArgs(provider, alice.address, { deployments })).to.be.rejectedWith(/no code/);
    await expect(reconstructConstructorArgs(provider, weth.target, { deployments })).to.be.rejectedWith(/not a HoodSale/);
  });

  it("ABI-encodes the reconstructed args to exactly the tail of the deployment transaction", async function () {
    const { provider, deployments, treasury, tokenFactory, presaleFactory, hoodsale, lens, metadataRegistry } = await loadFixture(fixture);
    for (const c of [treasury, tokenFactory, presaleFactory, hoodsale, lens, metadataRegistry]) {
      const r = await reconstructConstructorArgs(provider, c.target, { deployments });
      const artifact = await hre.artifacts.readArtifact(r.contract);
      const encoded = new ethers.Interface(artifact.abi).encodeDeploy(r.args);
      const data = c.deploymentTransaction().data;
      expect(data.endsWith(encoded.slice(2)), r.contract).to.equal(true);
      expect(data.length, r.contract).to.equal(artifact.bytecode.length + encoded.length - 2);
    }
  });

  it("bytecodeMatches masks metadata and immutables only", function () {
    // 2-byte fake "code" + CBOR length 0 -> tail 0x0000
    expect(bytecodeMatches("0xaabb0000", "0xaabb0000", {})).to.equal(true);
    expect(bytecodeMatches("0xaabb0000", "0xaacc0000", {})).to.equal(false);
    expect(bytecodeMatches("0xaabb0000", "0xaacc0000", { 1: [{ start: 1, length: 1 }] })).to.equal(true);
    expect(bytecodeMatches("0xaabb0000", "0xaabb000000", {})).to.equal(false);
  });
});

describe("manual verification package (Standard JSON input)", function () {
  it("builds a package from the build-info with identical compiler settings", async function () {
    const { deployments, taxAddr, expected } = await loadFixture(fixture);
    const pkg = await buildVerificationPackage(hre, { address: taxAddr }, { deployments });
    const buildInfo = await hre.artifacts.getBuildInfo(FQN.TaxToken);

    expect(pkg.contractName).to.equal(FQN.TaxToken);
    expect(pkg.compilerVersion).to.equal(`v${buildInfo.solcLongVersion}`);
    expect(pkg.compilerVersion).to.match(/^v0\.8\.26\+commit\./);
    expect(pkg.optimizer).to.deep.equal({ enabled: true, runs: 200 });
    expect(pkg.viaIR).to.equal(true);
    expect(pkg.standardJsonInput.settings).to.deep.equal(buildInfo.input.settings);
    expect(pkg.standardJsonInput.language).to.equal("Solidity");

    const sources = Object.keys(pkg.standardJsonInput.sources);
    expect(sources).to.include("contracts/tokens/TaxToken.sol");
    expect(sources).to.include("contracts/tokens/PlatformTaxBase.sol");
    expect(sources).to.include("contracts/interfaces/IUniswapV2.sol");
    expect(sources).to.include("@openzeppelin/contracts/token/ERC20/ERC20.sol");
    expect(sources).to.not.include("contracts/Presale.sol");
    expect(sources).to.not.include("contracts/test/MockDex.sol");
    for (const s of sources) expect(pkg.standardJsonInput.sources[s].content).to.equal(buildInfo.input.sources[s].content);

    // Decoding the encoded arguments yields the original values
    const artifact = await hre.artifacts.readArtifact(FQN.TaxToken);
    const types = artifact.abi.find((f) => f.type === "constructor").inputs;
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, pkg.constructorArguments.abiEncoded);
    expect(norm(Array.from(decoded))).to.deep.equal(norm(expected[taxAddr].args));
    expect(pkg.constructorArguments.abiEncodedNoPrefix).to.equal(pkg.constructorArguments.abiEncoded.slice(2));
    expect(norm(pkg.constructorArguments.decoded)).to.deep.equal(norm(expected[taxAddr].args));
    expect(pkg.readme).to.match(/Standard JSON input/);
    expect(pkg.explorer).to.equal(null); // no explorer for the hardhat network
  });

  it("encodes the Presale struct argument and keeps only the presale dependency closure", async function () {
    const { deployments, presaleAddr, expected } = await loadFixture(fixture);
    const pkg = await buildVerificationPackage(hre, { address: presaleAddr }, { deployments });
    const artifact = await hre.artifacts.readArtifact(FQN.Presale);
    const types = artifact.abi.find((f) => f.type === "constructor").inputs;
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, pkg.constructorArguments.abiEncoded);
    const exp = expected[presaleAddr].args;
    const p = decoded[0];
    expect(norm(Object.fromEntries(Object.keys(exp[0]).map((k) => [k, p[k]])))).to.deep.equal(norm(exp[0]));
    expect(norm(Array.from(decoded).slice(1))).to.deep.equal(norm(exp.slice(1)));
    const sources = Object.keys(pkg.standardJsonInput.sources);
    expect(sources).to.include("contracts/Presale.sol").and.include("contracts/LiquidityLocker.sol");
    expect(sources).to.not.include("contracts/PresaleFactory.sol");
  });

  it("writes <address>.json, <address>.input.json, README.md and a .gitignore", async function () {
    const { deployments, rewardsAddr } = await loadFixture(fixture);
    const out = tmpDir("verify-out");
    const pkg = await buildVerificationPackage(hre, { address: rewardsAddr }, { deployments });
    const { packagePath, inputPath } = writeVerificationPackage(hre, pkg, out);
    expect(packagePath).to.equal(path.join(out, "hardhat", `${rewardsAddr}.json`));
    expect(fs.existsSync(inputPath)).to.equal(true);
    expect(fs.readFileSync(path.join(out, ".gitignore"), "utf8")).to.match(/^\*/);
    expect(fs.existsSync(path.join(out, "hardhat", "README.md"))).to.equal(true);
    const back = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    expect(back.contractName).to.equal(FQN.RewardsToken);
    expect(JSON.parse(fs.readFileSync(inputPath, "utf8"))).to.deep.equal(pkg.standardJsonInput);
  });
});

describe("explorer API handling", function () {
  function serve(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/api` }));
    });
  }

  it("detects a Cloudflare challenge page (HTTP 403 + HTML)", async function () {
    const { server, url } = await serve((req, res) => {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl</body></html>");
    });
    try {
      const r = await probeExplorerApi(url, "blockscout");
      expect(r.status).to.equal("cloudflare");
      expect(r.httpStatus).to.equal(403);
    } finally {
      server.close();
    }
  });

  it("recognises a healthy JSON API and an unreachable one", async function () {
    const seen = [];
    const { server, url } = await serve((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "1", message: "OK", result: "0x10" }));
    });
    try {
      const r = await probeExplorerApi(url, "my-key");
      expect(r.status).to.equal("ok");
      expect(seen[0]).to.match(/apikey=my-key/);
    } finally {
      server.close();
    }
    const dead = await probeExplorerApi("http://127.0.0.1:1/api", null, { timeoutMs: 2000 });
    expect(dead.status).to.equal("unreachable");
  });

  it("classifies hardhat-verify errors", function () {
    expect(classifyVerifyError(new Error("The block explorer's API responded that the contract X at 0x1 is already verified."))).to.equal("already-verified");
    expect(classifyVerifyError(new Error("A network request failed. Error: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"))).to.equal("blocked");
    expect(classifyVerifyError(new Error("Failed to send contract verification request. HTTP status code 403 Just a moment"))).to.equal("blocked");
    expect(classifyVerifyError(new Error("The address 0x1 does not have bytecode. Check the explorer"))).to.equal("not-indexed");
    expect(classifyVerifyError(new Error("A network request failed. Error: fetch failed"))).to.equal("network");
    expect(classifyVerifyError(new Error("The selected network is hardhat. Please select a network supported by Etherscan."))).to.equal("unsupported-network");
    expect(classifyVerifyError(new Error("The contract verification failed. Reason: Fail - Unable to verify"))).to.equal("failed");
  });
});

describe("verification scripts (offline, in-process network)", function () {
  it("verify-contract DRY_RUN prints the submission without touching the network", async function () {
    const { deployments, taxAddr, presaleAddr, expected } = await loadFixture(fixture);
    const lines = [];
    const results = await verifyAddresses(hre, [taxAddr, presaleAddr], { dryRun: true, deployments, quiet: true, log: (l) => lines.push(l) });
    expect(results.map((r) => r.status)).to.deep.equal([STATUS.DRY_RUN, STATUS.DRY_RUN]);
    expect(results[0].contract).to.equal(FQN.TaxToken);
    expect(results[1].contract).to.equal(FQN.Presale);
    expect(norm(results[0].plainArgs)).to.deep.equal(norm(expected[taxAddr].args));
    expect(results[0].encodedArgs).to.match(/^0x[0-9a-f]+$/);
    expect(results[0].sourceCount).to.be.greaterThan(3);
    const text = lines.join("\n");
    expect(text).to.include("verify:verify");
    expect(text).to.include(FQN.TaxToken);
    expect(text).to.match(/compiler:\s+v0\.8\.26/);
  });

  it("verify-contract on an explorer-less network reports unsupported-network and never throws", async function () {
    const { deployments, standardAddr } = await loadFixture(fixture);
    const r = await verifyOne(hre, { address: standardAddr }, { deployments, log: () => {} });
    expect(r.status).to.equal(STATUS.UNSUPPORTED);
    expect(r.contract).to.equal(FQN.StandardToken);
  });

  it("FORCE_MANUAL writes the manual package instead of calling the API", async function () {
    const { deployments, standardAddr } = await loadFixture(fixture);
    const out = tmpDir("force-manual");
    const r = await verifyOne(hre, { address: standardAddr }, { deployments, forceManual: true, outDir: out, log: () => {} });
    expect(r.status).to.equal(STATUS.MANUAL);
    expect(fs.existsSync(r.packagePath)).to.equal(true);
    expect(fs.existsSync(r.inputPath)).to.equal(true);
    expect(r.encodedArgs).to.match(/^0x/);
  });

  it("reports a clean failure for an address that is not a platform contract", async function () {
    const { deployments, weth } = await loadFixture(fixture);
    const r = await verifyOne(hre, { address: weth.target }, { deployments, dryRun: true, log: () => {} });
    expect(r.status).to.equal(STATUS.FAILED);
    expect(r.message).to.match(/not a HoodSale/);
  });

  it("verify-platform DRY_RUN covers every platform contract plus the three deployers and the rewards code holder in deploy order", async function () {
    const { deployments, expected, tokenFactory } = await loadFixture(fixture);
    const lines = [];
    const results = await verifyPlatform.run(hre, { dryRun: true, deployments, log: (l) => lines.push(l) });
    const labels = results.map((r) => r.label);
    expect(labels).to.deep.equal([
      "treasury", "locker", "tokenFactory", "standardDeployer", "taxDeployer", "rewardsDeployer", "rewardsTokenCode",
      "presaleFactory", "hoodsale", "metadataRegistry", "lens",
    ]);
    for (const r of results) {
      expect(r.status, r.label).to.equal(STATUS.DRY_RUN);
      expect(r.contract, r.label).to.equal(expected[r.address].contract);
      expect(norm(r.plainArgs), r.label).to.deep.equal(norm(expected[r.address].args));
    }
    expect(results[3].address).to.equal(await tokenFactory.standardDeployer());
    expect(lines.join("\n")).to.include("summary: dry-run=11");
  });

  it("verify-platform marks keys missing from the deployments file as skipped", async function () {
    const { deployments } = await loadFixture(fixture);
    const partial = { ...deployments };
    delete partial.lens;
    delete partial.metadataRegistry;
    const results = await verifyPlatform.run(hre, { dryRun: true, deployments: partial, quiet: true, log: () => {} });
    const skipped = results.filter((r) => r.status === "skipped").map((r) => r.label);
    expect(skipped).to.deep.equal(["metadataRegistry", "lens"]);
  });
});

describe("auto-verify watcher (offline)", function () {
  it("picks up every TokenCreated / PresaleCreated from the cursor and dry-runs them", async function () {
    const { deployments, expected, standardAddr, taxAddr, rewardsAddr, untouchedAddr, presaleAddr } = await loadFixture(fixture);
    const lines = [];
    const w = createWatcher(hre, {
      deployments,
      verifyPresales: true,
      stateFile: path.join(tmpDir("verify-state"), "hardhat.json"),
      startBlock: 0,
      confirmations: 0,
      dryRun: true,
      logChunk: 3, // also exercise the chunked scan
      log: (...a) => lines.push(a.join(" ")),
    });
    const s = await w.tick();
    expect(s.error).to.equal(null);
    expect(s.found).to.equal(5);
    expect(s.pending).to.equal(0);
    expect(s.done).to.equal(5);
    const done = w.state.done;
    for (const a of [standardAddr, taxAddr, rewardsAddr, untouchedAddr, presaleAddr]) {
      const d = done[a.toLowerCase()];
      expect(d, a).to.not.equal(undefined);
      expect(d.status).to.equal(STATUS.DRY_RUN);
      expect(d.contract).to.equal(expected[a].contract);
      expect(d.kind).to.equal(a === presaleAddr ? "presale" : "token");
    }
    expect(fs.existsSync(w.stateFile)).to.equal(false); // DRY_RUN does not write the state file
    // A second round finds nothing new
    const s2 = await w.tick();
    expect(s2.found).to.equal(0);
    expect(s2.done).to.equal(5);
  });

  it("waits for confirmations, persists the cursor and resumes from the state file", async function () {
    const { deployments, standardAddr } = await loadFixture(fixture);
    const stateFile = path.join(tmpDir("verify-state"), "hardhat.json");
    const out = tmpDir("verify-out");
    const latest = await ethers.provider.getBlockNumber();
    const mk = () =>
      createWatcher(hre, { deployments, verifyPresales: true, stateFile, startBlock: 0, confirmations: latest + 5, forceManual: true, outDir: out, log: () => {} });

    const w1 = mk();
    const s1 = await w1.tick();
    expect(s1.found).to.equal(0); // not enough confirmations yet
    expect(fs.existsSync(stateFile)).to.equal(true);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).cursor).to.equal(0);

    await mine(latest + 10);
    const s2 = await w1.tick();
    expect(s2.found).to.equal(5);
    expect(s2.done).to.equal(5);
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(saved.cursor).to.equal((await ethers.provider.getBlockNumber()) - (latest + 5));
    expect(saved.done[standardAddr.toLowerCase()].status).to.equal(STATUS.MANUAL);
    expect(fs.existsSync(saved.done[standardAddr.toLowerCase()].packagePath)).to.equal(true);

    // A new process resumes from the same file: nothing is queued again
    const w2 = mk();
    expect(w2.state.cursor).to.equal(saved.cursor);
    const s3 = await w2.tick();
    expect(s3.found).to.equal(0);
    expect(Object.keys(w2.state.done)).to.have.length(5);
  });

  it("retries with exponential backoff and gives up after MAX_ATTEMPTS without crashing", async function () {
    const { deployments, presaleAddr } = await loadFixture(fixture);
    const calls = [];
    let now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const w = createWatcher(hre, {
        deployments,
        verifyPresales: true,
        stateFile: path.join(tmpDir("verify-state"), "hardhat.json"),
        startBlock: 0,
        confirmations: 0,
        maxAttempts: 3,
        backoffBaseMs: 1000,
        backoffMaxMs: 3000,
        log: () => {},
        verifyFn: async (_hre, target) => {
          calls.push(target.address);
          if (target.address === presaleAddr) return { status: STATUS.VERIFIED, message: "ok", contract: FQN.Presale };
          throw new Error("explorer exploded");
        },
      });
      await w.tick(); // all contracts, attempt 1
      expect(calls).to.have.length(5);
      expect(w.state.done[presaleAddr.toLowerCase()].status).to.equal(STATUS.VERIFIED);
      const pending = Object.values(w.state.pending);
      expect(pending).to.have.length(4);
      expect(pending.every((p) => p.attempts === 1 && p.nextAttemptAt === now + 1000)).to.equal(true);

      await w.tick(); // not due yet
      expect(calls).to.have.length(5);
      now += 1000;
      await w.tick(); // attempt 2, backoff 2000
      expect(calls).to.have.length(9);
      expect(Object.values(w.state.pending).every((p) => p.attempts === 2 && p.nextAttemptAt === now + 2000)).to.equal(true);
      now += 2000;
      await w.tick(); // attempt 3 = MAX_ATTEMPTS -> gave-up
      expect(calls).to.have.length(13);
      expect(Object.keys(w.state.pending)).to.have.length(0);
      const gaveUp = Object.values(w.state.done).filter((d) => d.status === "gave-up");
      expect(gaveUp).to.have.length(4);
      expect(gaveUp[0].message).to.match(/explorer exploded/);
    } finally {
      Date.now = realNow;
    }
  });
});

// ------------------------------------------------------------------ Uniswap v4 tokens

/**
 * The creation code each CREATE / CREATE2 of a transaction received, in order, read from its
 * trace. A token built inside a deployer never shows its creation code in the transaction data,
 * so this is what the reconstructed arguments are held against.
 */
async function createdInitcodes(txHash) {
  const trace = await hre.network.provider.send("debug_traceTransaction", [txHash, { disableStorage: true }]);
  return trace.structLogs
    .filter((l) => l.op === "CREATE" || l.op === "CREATE2")
    .map((l) => {
      // the stack lists its top last: value, offset, size
      const top = l.stack.length - 1;
      const offset = Number(BigInt("0x" + l.stack[top - 1]));
      const size = Number(BigInt("0x" + l.stack[top - 2]));
      return "0x" + l.memory.join("").slice(offset * 2, (offset + size) * 2);
    });
}

describe("constructor argument reconstruction: Uniswap v4 tokens", function () {
  const { deployPlatformV4, taxConfig } = require("./v4/helpers");

  // One v4 token of each kind, created through the V4Launcher: a Standard and a Tax token (both
  // HoodSaleTokenV4), a Rewards token paying WETH and one paying a tokenized stock along the V3
  // route the platform stores for it (both RewardsTokenV4). Next to them two V2 tokens the same
  // dual-mode deployers build when the creator is not the launcher.
  async function v4Fixture() {
    const env = await deployPlatformV4();
    const { launcher, hook, tokenFactory, presaleFactory, quickLaunch, v3Factory, weth, v3Router, v3Quoter, treasury, locker, router } = env;
    const { alice, bob, carol, dave, marketing } = env;

    const tsla = await ethers.deployContract("MockERC20", ["Mock Tesla", "TSLA", 18, E("1000000")]);
    const usdg = await ethers.deployContract("MockERC20", ["Mock USDG", "USDG", 6, 1_000_000n * 10n ** 6n]);
    await v3Factory.createPool(weth.target, tsla.target, 3000);
    await v3Factory.createPool(weth.target, usdg.target, 500);
    await v3Factory.createPool(usdg.target, tsla.target, 3000);
    const path = ethers.solidityPacked(["address", "uint24", "address"], [weth.target, 3000, tsla.target]);
    const otherPath = ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address"],
      [weth.target, 500, usdg.target, 3000, tsla.target]
    );
    await quickLaunch.setRewardTokenAllowed(tsla.target, true);
    await quickLaunch.setRewardRouteV3(tsla.target, path);

    const create = async (signer, tokenType, spec, cfg = {}) => {
      const tx = await launcher
        .connect(signer)
        .createToken(tokenType, { rewardToken: ethers.ZeroAddress, ...spec }, taxConfig(marketing.address, cfg), signer.address);
      const receipt = await tx.wait();
      const created = await launcher.tokensOfCreator(signer.address);
      return { address: created[created.length - 1], txHash: tx.hash, blockNumber: receipt.blockNumber };
    };
    const standard = await create(alice, 0, { name: "Vee Four Standard", symbol: "V4S", totalSupply: E("4444444") }, { taxLocked: true, walletLocked: true });
    const tax = await create(bob, 1, { name: "Vee Four Tax", symbol: "V4T", totalSupply: E("777000") }, { marketingBuyBps: 300, marketingSellBps: 500 });
    const rewardsWeth = await create(
      carol, 2, { name: "Vee Four Yield", symbol: "V4Y", totalSupply: E("1000000"), rewardToken: weth.target },
      { rewardsBuyBps: 200, rewardsSellBps: 300 }
    );
    const rewardsStock = await create(
      dave, 2, { name: "Vee Four Stock", symbol: "V4K", totalSupply: E("2500000"), rewardToken: tsla.target },
      { marketingBuyBps: 200, marketingSellBps: 200, rewardsBuyBps: 200, rewardsSellBps: 200 }
    );
    // The owner points the stock token elsewhere afterwards: the arguments still carry the path it was built with
    const stockToken = await ethers.getContractAt("RewardsTokenV4", rewardsStock.address);
    await stockToken.connect(dave).setRewardRouteV3(otherPath);
    expect(await stockToken.rewardRouteV3()).to.equal(otherPath);

    const v2 = async (promise) => {
      const tx = await promise;
      await tx.wait();
      return { address: await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n), txHash: tx.hash };
    };
    const v2Tax = await v2(tokenFactory.connect(alice).createTaxToken("Still Vee Two", "SV2", E("900"), carol.address, 150, 250));
    const v2Rewards = await v2(
      tokenFactory.connect(bob).createRewardsToken("Still Two Stock", "ST2", E("3000"), tsla.target, dave.address, [150, 250, 100, 200])
    );

    const deployments = {
      network: "hardhat",
      router: router.target,
      treasury: treasury.target,
      locker: locker.target,
      tokenFactory: tokenFactory.target,
      presaleFactory: presaleFactory.target,
      quickLaunch: quickLaunch.target,
      v4Launcher: launcher.target,
      v4Hook: hook.target,
    };
    const V4 = [launcher.target, tokenFactory.target];
    const V3 = [v3Router.target, v3Quoter.target];
    const expected = {
      [standard.address]: { contract: FQN.HoodSaleTokenV4, txHash: standard.txHash, args: ["Vee Four Standard", "V4S", E("4444444"), ...V4, 0] },
      [tax.address]: { contract: FQN.HoodSaleTokenV4, txHash: tax.txHash, args: ["Vee Four Tax", "V4T", E("777000"), ...V4, 1] },
      [rewardsWeth.address]: {
        contract: FQN.RewardsTokenV4,
        txHash: rewardsWeth.txHash,
        args: ["Vee Four Yield", "V4Y", E("1000000"), ...V4, weth.target, weth.target, ...V3, "0x"],
      },
      [rewardsStock.address]: {
        contract: FQN.RewardsTokenV4,
        txHash: rewardsStock.txHash,
        args: ["Vee Four Stock", "V4K", E("2500000"), ...V4, tsla.target, weth.target, ...V3, path],
      },
      [v2Tax.address]: {
        contract: FQN.TaxToken,
        txHash: v2Tax.txHash,
        args: ["Still Vee Two", "SV2", E("900"), alice.address, treasury.target, tokenFactory.target, router.target, 25, carol.address, 150, 250],
      },
      [v2Rewards.address]: {
        contract: FQN.RewardsToken,
        txHash: v2Rewards.txHash,
        args: [
          "Still Two Stock", "ST2", E("3000"), bob.address, treasury.target, tokenFactory.target, router.target, 25,
          tsla.target, dave.address, [150, 250, 100, 200], ...V3, path,
        ],
      },
    };
    const v4 = { standard, tax, rewardsWeth, rewardsStock };
    return { ...env, provider: ethers.provider, deployments, expected, v4, v2Tax, v2Rewards, tsla, path, otherPath };
  }

  it("names each v4 token by its own contract and returns the arguments its deployer used", async function () {
    const { provider, deployments, expected } = await loadFixture(v4Fixture);
    for (const [address, exp] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments });
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), `${exp.contract} ${address}`).to.deep.equal(norm(exp.args));
      expect(r.meta.warnings, address).to.deep.equal([]);
      expect(r.meta.creation.transactionHash, address).to.equal(exp.txHash);
    }
  });

  it("rebuilds byte for byte the creation code a deployer handed to CREATE", async function () {
    const { provider, deployments, v4, v2Tax } = await loadFixture(v4Fixture);
    // The deployers that build with `new` hold little memory, so their trace is cheap to read. The
    // rewards deployer copies the whole creation code around in memory first, which makes its trace
    // take minutes; the next test covers the rewards tokens by deploying them again instead.
    for (const t of [v4.standard, v4.tax, v2Tax]) {
      const r = await reconstructConstructorArgs(provider, t.address, { deployments });
      const artifact = await hre.artifacts.readArtifact(r.contract);
      const encoded = new ethers.Interface(artifact.abi).encodeDeploy(r.args);
      // the token is the first contract the transaction creates (a V2 token creates its pair next)
      const [initcode] = await createdInitcodes(t.txHash);
      expect(initcode.endsWith(encoded.slice(2)), `${r.contract} ${t.address}`).to.equal(true);
      expect(initcode, `${r.contract} ${t.address}`).to.equal(artifact.bytecode + encoded.slice(2));
    }
  });

  it("deploys the artifact again with the reconstructed arguments into the very same contract", async function () {
    const { provider, deployments, v4, deployer } = await loadFixture(v4Fixture);
    for (const t of Object.values(v4)) {
      const r = await reconstructConstructorArgs(provider, t.address, { deployments });
      const artifact = await hre.artifacts.readArtifact(r.contract);
      const copy = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(...r.args);
      await copy.waitForDeployment();
      // Every address argument (and the hook the launcher names) is an immutable, so the runtime
      // code only comes out identical when they all are
      expect(await provider.getCode(copy.target), `${r.contract} ${t.address}`).to.equal(await provider.getCode(t.address));
      // the rest of the arguments live in storage: compared with the original as it was created
      const original = new ethers.Contract(t.address, artifact.abi, provider);
      const getters = r.contract === FQN.RewardsTokenV4 ? ["name", "symbol", "totalSupply", "rewardRouteV3"] : ["name", "symbol", "totalSupply"];
      for (const g of getters) {
        expect(await copy[g](), `${g} ${t.address}`).to.equal(await original[g]({ blockTag: t.blockNumber }));
      }
    }
  });

  it("reads the supply and the V3 path from the creation receipt and the rest from immutables", async function () {
    const { provider, deployments, v4, path } = await loadFixture(v4Fixture);
    const std = await reconstructConstructorArgs(provider, v4.standard.address, { deployments });
    expect(std.meta.poolVersion).to.equal(4);
    expect(std.meta.sources).to.deep.equal({
      launcher: "immutable-state",
      tokenFactory: "immutable-state",
      totalSupply: "creation-receipt",
      tokenType: "immutable-state",
    });
    const stock = await reconstructConstructorArgs(provider, v4.rewardsStock.address, { deployments });
    expect(stock.meta.sources.totalSupply).to.equal("creation-receipt");
    expect(stock.meta.sources.rewardRouteV3).to.equal("creation-receipt");
    for (const k of ["launcher", "tokenFactory", "rewardToken", "weth", "v3Router", "v3Quoter"]) {
      expect(stock.meta.sources[k], k).to.equal("immutable-state");
    }
    // the route changed after creation, the argument did not
    expect(stock.args[9]).to.equal(path);
    // the watcher passes the creation in; the receipt path answers the same
    const known = await reconstructConstructorArgs(provider, v4.rewardsStock.address, {
      deployments,
      creation: { blockNumber: v4.rewardsStock.blockNumber, transactionHash: v4.rewardsStock.txHash },
    });
    expect(known.args[9]).to.equal(path);
    expect(known.meta.sources.rewardRouteV3).to.equal("creation-receipt");
  });

  it("falls back to creation-block state and to events when the receipt is not used", async function () {
    const { provider, deployments, expected, v4, path, otherPath } = await loadFixture(v4Fixture);
    // archive path: the state at the creation block still holds the original path and supply
    for (const t of Object.values(v4)) {
      const r = await reconstructConstructorArgs(provider, t.address, { deployments, strategies: ["creation-state"] });
      expect(norm(r.args), t.address).to.deep.equal(norm(expected[t.address].args));
      expect(r.meta.sources.totalSupply).to.equal("creation-state");
      expect(r.meta.warnings, t.address).to.deep.equal([]);
    }
    // events only: the supply cannot change; the stock token's route did (CHANGED), the WETH one's did not
    const changed = await reconstructConstructorArgs(provider, v4.rewardsStock.address, { deployments, strategies: ["events", "current"] });
    expect(changed.args[2]).to.equal(E("2500000"));
    expect(changed.meta.sources.totalSupply).to.equal("current-immutable");
    expect(changed.args[9]).to.equal(otherPath);
    expect(changed.args[9]).to.not.equal(path);
    expect(changed.meta.sources.rewardRouteV3).to.equal("current-CHANGED");
    expect(changed.meta.warnings.join(" ")).to.match(/RewardRouteV3Updated/);
    const same = await reconstructConstructorArgs(provider, v4.rewardsWeth.address, { deployments, strategies: ["events", "current"] });
    expect(norm(same.args)).to.deep.equal(norm(expected[v4.rewardsWeth.address].args));
    expect(same.meta.sources.rewardRouteV3).to.equal("current-unchanged-by-events");
    expect(same.meta.warnings).to.deep.equal([]);
    // with nothing that can recover the supply the reconstruction refuses instead of guessing
    await expect(
      reconstructConstructorArgs(provider, v4.tax.address, { deployments, strategies: ["calldata"] })
    ).to.be.rejectedWith(/totalSupply of the HoodSaleTokenV4 could not be recovered/);
  });

  it("recognises a v4 token without a deployments file, and by its selector when poolVersion() does not answer", async function () {
    const { provider, expected, v4 } = await loadFixture(v4Fixture);
    for (const [address, exp] of Object.entries(expected)) {
      const r = await reconstructConstructorArgs(provider, address, {});
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), address).to.deep.equal(norm(exp.args));
    }
    // An RPC that fails every poolVersion() call: the dispatcher's selector still tells a v4 token
    // apart, and a V2 token, which has no such selector, stays V2
    const selector = ethers.id("poolVersion()").slice(0, 10);
    const flaky = new Proxy(provider, {
      get(target, key) {
        if (key === "call") {
          return async (tx) => {
            if (String(tx.data || "").startsWith(selector)) throw new Error("rpc hiccup");
            return target.call(tx);
          };
        }
        const v = target[key];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const asV4 = new ethers.Contract(v4.tax.address, ["function poolVersion() view returns (uint8)"], flaky);
    await expect(asV4.poolVersion()).to.be.rejectedWith(/rpc hiccup/);
    for (const address of [v4.tax.address, v4.rewardsWeth.address, ...Object.keys(expected).filter((a) => !/V4/.test(expected[a].contract))]) {
      const r = await reconstructConstructorArgs(flaky, address, {});
      expect(r.contract, address).to.equal(expected[address].contract);
      expect(norm(r.args), address).to.deep.equal(norm(expected[address].args));
    }
  });

  it("keeps a V2 token V2 on its revert, however the provider reports it", async function () {
    const { provider, expected } = await loadFixture(v4Fixture);
    const selector = ethers.id("poolVersion()").slice(0, 10);
    const push = "63" + selector.slice(2);
    const v2 = Object.keys(expected).filter((a) => !/V4/.test(expected[a].contract));
    // Each V2 token's code is served with a v4 dispatcher's selector appended, so only the revert
    // of poolVersion() can keep it V2: as the in-process network reports it (no code), as a remote
    // node's JSON-RPC error passed through hardhat-ethers (code 3), and as ethers' CALL_EXCEPTION
    const reverts = [
      null,
      () => Object.assign(new Error("execution reverted"), { code: 3 }),
      () => Object.assign(new Error("execution reverted (no data present; likely require(false) occurred"), { code: "CALL_EXCEPTION" }),
    ];
    for (const makeError of reverts) {
      const shaped = new Proxy(provider, {
        get(target, key) {
          if (key === "getCode") {
            return async (a, tag) => {
              const c = await target.getCode(a, tag);
              return c && c !== "0x" ? c + push : c;
            };
          }
          if (key === "call" && makeError) {
            return async (tx) => {
              if (String(tx.data || "").startsWith(selector)) throw makeError();
              return target.call(tx);
            };
          }
          const v = target[key];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      for (const address of v2) {
        const r = await reconstructConstructorArgs(shaped, address, {});
        expect(r.contract, address).to.equal(expected[address].contract);
        expect(norm(r.args), address).to.deep.equal(norm(expected[address].args));
      }
    }
  });

  it("dry-runs a v4 token with its own source in the package", async function () {
    const { deployments, expected, v4 } = await loadFixture(v4Fixture);
    const lines = [];
    const results = await verifyAddresses(hre, [v4.tax.address, v4.rewardsStock.address], {
      dryRun: true,
      deployments,
      quiet: true,
      log: (l) => lines.push(l),
    });
    expect(results.map((r) => r.status)).to.deep.equal([STATUS.DRY_RUN, STATUS.DRY_RUN]);
    expect(results[0].contract).to.equal(FQN.HoodSaleTokenV4);
    expect(results[1].contract).to.equal(FQN.RewardsTokenV4);
    expect(norm(results[1].plainArgs)).to.deep.equal(norm(expected[v4.rewardsStock.address].args));
    const pkg = await buildVerificationPackage(hre, { address: v4.rewardsStock.address }, { deployments });
    const sources = Object.keys(pkg.standardJsonInput.sources);
    expect(sources).to.include("contracts/v4/tokens/RewardsTokenV4.sol");
    expect(sources).to.not.include("contracts/tokens/RewardsToken.sol");
    expect(lines.join("\n")).to.include(FQN.HoodSaleTokenV4);
  });
});

describe("constructor argument reconstruction: Uniswap v4 fee mode", function () {
  const { deployPlatformV4Fee, taxConfig, feeTaxConfig, PERMIT2 } = require("./v4/helpers");
  const Miner = require("../scripts/lib/hook-miner");

  // Fee mode next to hook mode on one TokenFactory. One fee mode token of each type, created
  // through the V4FeeLauncher: the same two token contracts as hook mode, with the fee launcher as
  // their launcher. As controls, a hook mode token and a V2 token from the same Fee deployers.
  async function feeFixture() {
    const env = await deployPlatformV4Fee();
    const { launcher, hook, feeLauncher, feeHook, v4Lens, v4Router, v4FeeLens, v4FeeRouter, positionLocker, feeDeployers, v4Deployers } = env;
    const { tokenFactory, presaleFactory, quickLaunch, treasury, locker, router, hoodsale, metadataRegistry, lens } = env;
    const { poolManager, positionManager, stateView, weth, v3Router, v3Quoter, rewardsTokenCode, rewardsTokenCodeV4 } = env;
    const { deployer, alice, bob, carol, dave, marketing } = env;

    const create = async (through, signer, tokenType, spec, cfg) => {
      const tx = await through.connect(signer).createToken(tokenType, { rewardToken: ethers.ZeroAddress, ...spec }, cfg, signer.address);
      const receipt = await tx.wait();
      const created = await through.tokensOfCreator(signer.address);
      return { address: created[created.length - 1], txHash: tx.hash, blockNumber: receipt.blockNumber };
    };
    const standard = await create(feeLauncher, alice, 0, { name: "Fee Standard", symbol: "FEES", totalSupply: E("5555555") }, feeTaxConfig(marketing.address));
    const tax = await create(feeLauncher, bob, 1, { name: "Fee Tax", symbol: "FEET", totalSupply: E("888000") }, feeTaxConfig(marketing.address, { marketingBps: 300 }));
    const rewards = await create(
      feeLauncher, carol, 2, { name: "Fee Yield", symbol: "FEEY", totalSupply: E("1500000"), rewardToken: weth.target },
      feeTaxConfig(marketing.address, { marketingBps: 100, rewardsBps: 200 })
    );
    const hookMode = await create(
      launcher, dave, 1, { name: "Hook Tax", symbol: "HOOKT", totalSupply: E("640000") },
      taxConfig(marketing.address, { marketingBuyBps: 300, marketingSellBps: 500 })
    );
    const v2Tx = await tokenFactory.connect(alice).createTaxToken("Fee Era Vee Two", "FV2", E("900"), carol.address, 150, 250);
    await v2Tx.wait();
    const v2 = { address: await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n), txHash: v2Tx.hash };

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
      v4Locker: positionLocker.target,
      v4Launcher: launcher.target,
      v4Hook: hook.target,
      v4Lens: v4Lens.target,
      v4Router: v4Router.target,
      rewardsTokenCodeV4: rewardsTokenCodeV4.target,
      v4FeeLauncher: feeLauncher.target,
      v4FeeHook: feeHook.target,
      v4FeeLens: v4FeeLens.target,
      v4FeeRouter: v4FeeRouter.target,
      v4FeeStandardDeployer: feeDeployers.standardDeployer.target,
      v4FeeTaxDeployer: feeDeployers.taxDeployer.target,
      v4FeeRewardsDeployer: feeDeployers.rewardsDeployer.target,
    };
    const FEE = [feeLauncher.target, tokenFactory.target];
    const tokens = {
      [standard.address]: { contract: FQN.HoodSaleTokenV4, mode: "fee", txHash: standard.txHash, args: ["Fee Standard", "FEES", E("5555555"), ...FEE, 0] },
      [tax.address]: { contract: FQN.HoodSaleTokenV4, mode: "fee", txHash: tax.txHash, args: ["Fee Tax", "FEET", E("888000"), ...FEE, 1] },
      [rewards.address]: {
        contract: FQN.RewardsTokenV4,
        mode: "fee",
        txHash: rewards.txHash,
        args: ["Fee Yield", "FEEY", E("1500000"), ...FEE, weth.target, weth.target, v3Router.target, v3Quoter.target, "0x"],
      },
      [hookMode.address]: {
        contract: FQN.HoodSaleTokenV4,
        mode: "hook",
        txHash: hookMode.txHash,
        args: ["Hook Tax", "HOOKT", E("640000"), launcher.target, tokenFactory.target, 1],
      },
      [v2.address]: {
        contract: FQN.TaxToken,
        mode: undefined,
        txHash: v2.txHash,
        args: ["Fee Era Vee Two", "FV2", E("900"), alice.address, treasury.target, tokenFactory.target, router.target, 25, carol.address, 150, 250],
      },
    };
    // The fee mode contracts, and the instances of the shared lens and router on either side
    const both = [launcher.target, feeLauncher.target];
    const platform = [
      { c: feeLauncher, contract: FQN.V4FeeLauncher, args: [deployer.address, poolManager.target, positionManager.target, PERMIT2, tokenFactory.target, presaleFactory.target, treasury.target] },
      { c: feeHook, contract: FQN.HoodSaleV4FeeHook, args: [poolManager.target, positionManager.target, feeLauncher.target, treasury.target] },
      { c: v4FeeLens, contract: FQN.HoodSaleV4Lens, args: [feeLauncher.target, stateView.target] },
      { c: v4FeeRouter, contract: FQN.HoodSaleV4Router, args: [poolManager.target, feeLauncher.target] },
      { c: v4Lens, contract: FQN.HoodSaleV4Lens, args: [launcher.target, stateView.target] },
      { c: v4Router, contract: FQN.HoodSaleV4Router, args: [poolManager.target, launcher.target] },
      { c: feeDeployers.standardDeployer, contract: FQN.StandardTokenDeployerFee, args: [tokenFactory.target, ...both] },
      { c: feeDeployers.taxDeployer, contract: FQN.TaxTokenDeployerFee, args: [tokenFactory.target, ...both] },
      {
        c: feeDeployers.rewardsDeployer,
        contract: FQN.RewardsTokenDeployerFee,
        args: [tokenFactory.target, v3Router.target, v3Quoter.target, rewardsTokenCode.target, rewardsTokenCodeV4.target, ...both],
      },
      // The V4 generation the Fee deployers replaced: the factory no longer names it
      { c: v4Deployers.standardDeployer, contract: FQN.StandardTokenDeployerV4, args: [tokenFactory.target, launcher.target] },
      { c: v4Deployers.taxDeployer, contract: FQN.TaxTokenDeployerV4, args: [tokenFactory.target, launcher.target] },
      {
        c: v4Deployers.rewardsDeployer,
        contract: FQN.RewardsTokenDeployerV4,
        args: [tokenFactory.target, v3Router.target, v3Quoter.target, rewardsTokenCode.target, rewardsTokenCodeV4.target, launcher.target],
      },
    ];
    return { ...env, provider: ethers.provider, deployments, tokens, platform, fee: { standard, tax, rewards }, hookMode, v2 };
  }

  it("rebuilds a fee mode token as the shared v4 contract with the fee launcher as its launcher, and says which launcher made it", async function () {
    const { provider, deployments, tokens, feeLauncher } = await loadFixture(feeFixture);
    for (const [address, exp] of Object.entries(tokens)) {
      const r = await reconstructConstructorArgs(provider, address, { deployments });
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), `${exp.contract} ${address}`).to.deep.equal(norm(exp.args));
      expect(r.meta.warnings, address).to.deep.equal([]);
      expect(r.meta.creation.transactionHash, address).to.equal(exp.txHash);
      expect(r.meta.launchMode, address).to.equal(exp.mode);
      if (exp.mode === "fee") expect(r.meta.launcher, address).to.equal(feeLauncher.target);
    }
  });

  it("tells the two launchers apart without a deployments file, by the hook each one names", async function () {
    const { provider, deployments, tokens, fee, feeHook, hook } = await loadFixture(feeFixture);
    // the fee hook's address carries its two gate bits and nothing else, the tax hook's does not
    expect(BigInt(feeHook.target) & 0x3fffn).to.equal(BigInt(Miner.FEE_HOOK_FLAGS));
    expect(BigInt(hook.target) & 0x3fffn).to.equal(BigInt(Miner.HOODSALE_HOOK_FLAGS));
    for (const [address, exp] of Object.entries(tokens)) {
      const r = await reconstructConstructorArgs(provider, address, {});
      expect(r.contract, address).to.equal(exp.contract);
      expect(norm(r.args), address).to.deep.equal(norm(exp.args));
      expect(r.meta.launchMode, address).to.equal(exp.mode);
    }
    // A deployments file from before fee mode knows one launcher only: the token still comes out
    // right, with a warning that its launcher is not a listed one
    const old = { ...deployments };
    for (const k of Object.keys(old)) if (k.startsWith("v4Fee")) delete old[k];
    const r = await reconstructConstructorArgs(provider, fee.tax.address, { deployments: old });
    expect(norm(r.args)).to.deep.equal(norm(tokens[fee.tax.address].args));
    expect(r.meta.launchMode).to.equal("fee");
    expect(r.meta.warnings.join(" ")).to.match(/neither v4 launcher in deployments/);
  });

  it("deploys the artifact again with the reconstructed arguments into the very same fee mode token", async function () {
    const { provider, deployments, fee, deployer, feeHook } = await loadFixture(feeFixture);
    for (const t of Object.values(fee)) {
      const r = await reconstructConstructorArgs(provider, t.address, { deployments });
      const artifact = await hre.artifacts.readArtifact(r.contract);
      const copy = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(...r.args);
      await copy.waitForDeployment();
      // The launcher is an immutable, and so is the hook a Rewards token reads from it: the runtime
      // code only comes out identical when the launcher argument is the fee launcher
      expect(await provider.getCode(copy.target), `${r.contract} ${t.address}`).to.equal(await provider.getCode(t.address));
      if (r.contract === FQN.RewardsTokenV4) expect(await copy.hook()).to.equal(feeHook.target);
    }
  });

  it("reconstructs the fee launcher, the fee hook, both lens and router instances and every deployer generation", async function () {
    const { provider, deployments, platform, feeHook } = await loadFixture(feeFixture);
    for (const exp of platform) {
      // from the deployments file, and without one (the factory's slot or the bytecode decides)
      for (const opts of [{ deployments }, {}]) {
        const r = await reconstructConstructorArgs(provider, exp.c.target, opts);
        expect(r.contract, exp.contract).to.equal(exp.contract);
        expect(norm(r.args), exp.contract).to.deep.equal(norm(exp.args));
        expect(r.meta.warnings, exp.contract).to.deep.equal([]);
      }
      const artifact = await hre.artifacts.readArtifact(exp.contract);
      const encoded = new ethers.Interface(artifact.abi).encodeDeploy(exp.args);
      if (exp.c === feeHook) {
        // The hook went through the CREATE2 proxy: its address is a hash of the creation code with
        // these very arguments, so mining again from the reconstruction lands on the same address
        const mined = Miner.mineHookSalt(ethers, artifact.bytecode + encoded.slice(2), Miner.FEE_HOOK_FLAGS, {
          reject: (address) => address.toLowerCase().startsWith("0x91"),
        });
        expect(mined.address).to.equal(feeHook.target);
      } else {
        expect(exp.c.deploymentTransaction().data, exp.contract).to.equal(artifact.bytecode + encoded.slice(2));
      }
    }
    // Ownable: the owner argument is the one of the creation's OwnershipTransferred(0, owner) log
    const launcher = await reconstructConstructorArgs(provider, platform[0].c.target, { deployments });
    expect(launcher.meta.sources.owner).to.equal("ownership-event");
    expect(launcher.meta.creation.transactionHash).to.equal(platform[0].c.deploymentTransaction().hash);
    expect(launcher.kind).to.equal("platform");
    const deployer = await reconstructConstructorArgs(provider, platform[8].c.target, { deployments });
    expect(deployer.kind).to.equal("deployer");
    expect(deployer.meta.sources.feeLauncher).to.equal("immutable-state");
  });

  it("keeps the deploying owner of the launchers and the locker after ownership is handed on", async function () {
    const { provider, deployments, deployer, alice, feeLauncher, launcher, positionLocker, poolManager, positionManager, tokenFactory, presaleFactory, treasury } =
      await loadFixture(feeFixture);
    const expected = [
      [feeLauncher, FQN.V4FeeLauncher, [deployer.address, poolManager.target, positionManager.target, PERMIT2, tokenFactory.target, presaleFactory.target, treasury.target]],
      [launcher, FQN.V4Launcher, [deployer.address, poolManager.target, positionManager.target, PERMIT2, tokenFactory.target, presaleFactory.target, positionLocker.target, treasury.target]],
      [positionLocker, FQN.V4PositionLocker, [deployer.address, positionManager.target]],
    ];
    for (const [c] of expected) await (await c.connect(deployer).transferOwnership(alice.address)).wait();

    for (const [c, contract, args] of expected) {
      expect(await c.owner(), contract).to.equal(alice.address);
      const r = await reconstructConstructorArgs(provider, c.target, { deployments });
      expect(r.contract).to.equal(contract);
      expect(norm(r.args), contract).to.deep.equal(norm(args));
      expect(r.meta.sources.owner, contract).to.equal("ownership-event");
      expect(r.meta.warnings, contract).to.deep.equal([]);
      // what the explorers are sent: exactly the tail of the deployment transaction
      const artifact = await hre.artifacts.readArtifact(contract);
      const encoded = new ethers.Interface(artifact.abi).encodeDeploy(r.args);
      expect(c.deploymentTransaction().data, contract).to.equal(artifact.bytecode + encoded.slice(2));
    }

    // When the creation log cannot be found (an RPC that has pruned it answers with no logs), the
    // current owner is all there is: it is used, and the warning says what that means
    const blind = new Proxy(provider, {
      get(target, prop) {
        if (prop === "getLogs") return async () => [];
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const r = await reconstructConstructorArgs(blind, feeLauncher.target, { deployments });
    expect(r.args[0]).to.equal(alice.address);
    expect(r.meta.sources.owner).to.equal("current-owner");
    expect(r.meta.warnings.join(" ")).to.match(/OwnershipTransferred\(0, owner\) log not found.*wrong if ownership was handed on/);
  });

  it("verify-platform DRY_RUN lists both v4 modes after the V2 platform, and the Fee deployers under their own keys until the factory names them", async function () {
    const { deployments, platform, tokenFactory, v4Deployers, feeDeployers } = await loadFixture(feeFixture);
    const expectedOf = Object.fromEntries(platform.map((p) => [p.c.target, p]));
    const V2 = ["treasury", "locker", "tokenFactory", "standardDeployer", "taxDeployer", "rewardsDeployer", "rewardsTokenCode", "presaleFactory", "hoodsale", "metadataRegistry", "lens"];
    const V4 = ["v4Locker", "v4Launcher", "v4Hook", "v4Lens", "v4Router", "rewardsTokenCodeV4", "v4FeeLauncher", "v4FeeHook", "v4FeeLens", "v4FeeRouter"];
    const check = (results) => {
      for (const r of results) {
        expect(r.status, r.label).to.equal(STATUS.DRY_RUN);
        if (!expectedOf[r.address]) continue;
        expect(r.contract, r.label).to.equal(expectedOf[r.address].contract);
        expect(norm(r.plainArgs), r.label).to.deep.equal(norm(expectedOf[r.address].args));
      }
    };

    // the factory names the Fee deployers: they are verified once, as the factory's own
    const wired = await verifyPlatform.run(hre, { dryRun: true, deployments, quiet: true, log: () => {} });
    expect(wired.map((r) => r.label)).to.deep.equal([...V2, ...V4]);
    expect(wired[3].address).to.equal(feeDeployers.standardDeployer.target);
    check(wired);

    // before TokenFactory.setDeployers (and after a rollback) the factory still names the V4
    // generation, and the Fee deployers are found under their own keys
    await tokenFactory.setDeployers(v4Deployers.standardDeployer.target, v4Deployers.taxDeployer.target, v4Deployers.rewardsDeployer.target);
    const lines = [];
    const before = await verifyPlatform.run(hre, { dryRun: true, deployments, log: (l) => lines.push(l) });
    expect(before.map((r) => r.label)).to.deep.equal([...V2, ...V4, "v4FeeStandardDeployer", "v4FeeTaxDeployer", "v4FeeRewardsDeployer"]);
    expect(before[3].address).to.equal(v4Deployers.standardDeployer.target);
    check(before);
    expect(lines.join("\n")).to.include("summary: dry-run=24");
  });

  it("dry-runs a fee mode token and the fee hook with their own sources in the package", async function () {
    const { deployments, tokens, fee, feeHook, feeLauncher } = await loadFixture(feeFixture);
    const lines = [];
    const results = await verifyAddresses(hre, [fee.rewards.address, feeHook.target], { dryRun: true, deployments, quiet: true, log: (l) => lines.push(l) });
    expect(results.map((r) => r.status)).to.deep.equal([STATUS.DRY_RUN, STATUS.DRY_RUN]);
    expect(results[0].contract).to.equal(FQN.RewardsTokenV4);
    expect(norm(results[0].plainArgs)).to.deep.equal(norm(tokens[fee.rewards.address].args));
    expect(results[0].plainArgs[3]).to.equal(feeLauncher.target);
    expect(results[1].contract).to.equal(FQN.HoodSaleV4FeeHook);
    const pkg = await buildVerificationPackage(hre, { address: feeHook.target }, { deployments });
    const sources = Object.keys(pkg.standardJsonInput.sources);
    expect(sources).to.include("contracts/v4/fee/HoodSaleV4FeeHook.sol");
    expect(sources).to.not.include("contracts/v4/HoodSaleV4Hook.sol");
    expect(lines.join("\n")).to.include(FQN.HoodSaleV4FeeHook);
  });
});
