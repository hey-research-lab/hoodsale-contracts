// Read-only sanity check of a deployment: prints the wiring between the platform
// contracts (including QuickLaunch, the quick creation fee, the launch keeper and the two
// Uniswap v4 modes) and the HOODS token state. Usage:
//   npx hardhat run scripts/check-deployment.js --network robinhood
const hre = require("hardhat");
const { describeRewardRoutes } = require("./lib/reward-tokens");
const fs = require("fs");
const path = require("path");

/**
 * True when the code at `address` is the current build of `name`, with the immutable slots of
 * both masked out (their values differ per deployment, nothing else may).
 */
async function matchesBuild(hre, name, address) {
  const artifact = await hre.artifacts.readArtifact(name);
  const fqn = `${artifact.sourceName}:${artifact.contractName}`;
  const info = await hre.artifacts.getBuildInfo(fqn);
  const evm = info.output.contracts[artifact.sourceName][artifact.contractName].evm.deployedBytecode;
  const built = Buffer.from(evm.object, "hex");
  const onChain = Buffer.from((await hre.ethers.provider.getCode(address)).slice(2), "hex");
  if (built.length !== onChain.length) return false;
  for (const refs of Object.values(evm.immutableReferences || {})) {
    for (const { start, length } of refs) {
      built.fill(0, start, start + length);
      onChain.fill(0, start, start + length);
    }
  }
  // The CBOR metadata trailer (its length sits in the last two bytes) carries a hash of every
  // source of the compilation, so it changes whenever any imported file changes, comments
  // included; the code before it is what runs.
  const withoutMetadata = (code) => code.subarray(0, code.length - 2 - code.readUInt16BE(code.length - 2));
  return withoutMetadata(built).equals(withoutMetadata(onChain));
}

async function main() {
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const p = hre.ethers.provider;
  const [signer] = await hre.ethers.getSigners().catch(() => []);
  const deployer = process.env.DEPLOYER_ADDRESS || (signer ? signer.address : null);

  const tf = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const pf = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const tr = await hre.ethers.getContractAt("Treasury", d.treasury);
  const hs = await hre.ethers.getContractAt("HoodSaleToken", d.hoodsale);
  // Reads that only exist on the quick-presale generation of the contracts print "-" on an older deployment
  const safe = (fn) => fn().catch(() => "-");

  const out = {
    chainId: (await p.getNetwork()).chainId.toString(),
    block: await p.getBlockNumber(),
    tokenFactory_platformTaxBps: (await tf.platformTaxBps()).toString(),
    tokenFactory_presaleFactory: await tf.presaleFactory(),
    tokenFactory_treasury: await tf.treasury(),
    tokenFactory_rewardsDeployer: await tf.rewardsDeployer(),
    presaleFactory_tokenFactory: await pf.tokenFactory(),
    presaleFactory_treasury: await pf.treasury(),
    presaleFactory_locker: await pf.locker(),
    presaleFactory_hoodsaleAllowed: await pf.allowedToken(d.hoodsale),
    // The fee settings the frontend quotes from the chain (scripts/set-fees.js on mainnet: 2.5%
    // share, 10% exit penalty, no creation fees; the contract defaults are 10%, 10%, 0.1 and 0.03 ETH)
    presaleFactory_platformFeeBps: (await pf.platformFeeBps()).toString(),
    presaleFactory_exitPenaltyBps: (await pf.exitPenaltyBps()).toString(),
    presaleFactory_creationFee: `${hre.ethers.formatEther(await pf.creationFee())} ETH`,
    presaleFactory_quickCreationFee: await safe(async () => `${hre.ethers.formatEther(await pf.quickCreationFee())} ETH`),
    presaleFactory_presaleCode: await safe(() => pf.presaleCode()),
    presaleFactory_quickLaunch: await safe(() => pf.quickLaunch()),
    treasury_hoodsale: await tr.hoodsale(),
    treasury_owner: await tr.owner(),
    hoodsale_symbol: await hs.symbol(),
    hoodsale_totalSupply: hre.ethers.formatEther(await hs.totalSupply()),
    hoodsale_owner: await hs.owner(),
    hoodsale_mainPair: await hs.mainPair(),
    hoodsale_marketingWallet: await hs.marketingWallet(),
    hoodsale_presaleFactory: await hs.presaleFactory(),
  };
  if (d.metadataRegistry) {
    const reg = await hre.ethers.getContractAt("TokenMetadataRegistry", d.metadataRegistry);
    out.metadataRegistry_presaleFactory = await safe(() => reg.presaleFactory());
    // canEdit only exists on the editor generation of the registry
    if (deployer) out.metadataRegistry_deployerCanEditHoodsale = await safe(() => reg.canEdit(d.hoodsale, deployer));
  }
  if (d.lens) {
    const lens = await hre.ethers.getContractAt("HoodSaleLens", d.lens);
    out.lens_presaleFactory = await safe(() => lens.presaleFactory());
  }
  // The rewards deployer of the Uniswap V3 generation carries the chain's SwapRouter02 and QuoterV2
  // (the reward swap's V3 leg for the tokenized stocks); an earlier one prints "-" for both. The
  // address is the one TokenFactory uses, like the standard and tax deployers below, never the
  // record's: the two differ after a setDeployers sent by hand (a SKIP_SET_DEPLOYERS run of
  // scripts/deploy-v4-fee.js, or a rollback), and the report must describe the chain.
  const rewardsDeployerAddr = out.tokenFactory_rewardsDeployer;
  if (rewardsDeployerAddr && rewardsDeployerAddr !== hre.ethers.ZeroAddress) {
    const rd = await hre.ethers.getContractAt("RewardsTokenDeployer", rewardsDeployerAddr);
    out.rewardsDeployer = rewardsDeployerAddr;
    out.rewardsDeployer_v3Router = await safe(() => rd.v3Router());
    out.rewardsDeployer_v3Quoter = await safe(() => rd.v3Quoter());
    // The owner-locks generation holds RewardsToken's creation code in RewardsTokenCode
    out.rewardsDeployer_rewardsTokenCode = await safe(() => rd.rewardsTokenCode());
  }
  out.tokenFactory_standardDeployer = await tf.standardDeployer();
  out.tokenFactory_taxDeployer = await tf.taxDeployer();
  // A record that names other deployers than the factory uses is stale: say so, per slot
  for (const slot of ["standard", "tax", "rewards"]) {
    const recorded = d[`${slot}Deployer`];
    const used = out[`tokenFactory_${slot}Deployer`];
    if (recorded && String(recorded).toLowerCase() !== String(used).toLowerCase()) {
      out[`${slot}Deployer_recordIsStale`] = `record names ${recorded}, TokenFactory uses ${used}`;
    }
  }
  // The frontend ABIs come from the current build: a contract on chain that was deployed from
  // an earlier build answers with a different shape (the lens views, for instance) and breaks
  // the pages, so every upgradeable piece is compared with the build byte for byte
  // (immutable slots masked). "false" means redeploy before wiring the frontend.
  const builds = { ...d };
  if (rewardsDeployerAddr && rewardsDeployerAddr !== hre.ethers.ZeroAddress) builds.rewardsDeployer = rewardsDeployerAddr;
  builds.standardDeployer = out.tokenFactory_standardDeployer;
  builds.taxDeployer = out.tokenFactory_taxDeployer;
  if (out.rewardsDeployer_rewardsTokenCode && out.rewardsDeployer_rewardsTokenCode !== "-") builds.rewardsTokenCode = out.rewardsDeployer_rewardsTokenCode;
  // The token deployers come in three generations: V2 only, V4 (they also know the hook mode
  // launcher) and Fee (they know both v4 launchers). Each is compared with the build of its own.
  const generationOf = async (address) => {
    const c = new hre.ethers.Contract(
      address,
      ["function launcher() view returns (address)", "function feeLauncher() view returns (address)"],
      p
    );
    if (await c.feeLauncher().then(() => true, () => false)) return "Fee";
    return (await c.launcher().then(() => true, () => false)) ? "V4" : "";
  };
  for (const key of ["rewardsDeployer", "standardDeployer", "taxDeployer"]) {
    if (builds[key]) out[`${key}_generation`] = (await safe(() => generationOf(builds[key]))) || "V2";
  }
  const deployerBuild = (key, base) => `${base}${["V4", "Fee"].includes(out[`${key}_generation`]) ? out[`${key}_generation`] : ""}`;
  for (const [key, name] of [
    ["lens", "HoodSaleLens"],
    ["quickLaunch", "QuickLaunch"],
    ["metadataRegistry", "TokenMetadataRegistry"],
    ["presaleFactory", "PresaleFactory"],
    ["presaleCode", "PresaleCode"],
    ["rewardsDeployer", deployerBuild("rewardsDeployer", "RewardsTokenDeployer")],
    ["standardDeployer", deployerBuild("standardDeployer", "StandardTokenDeployer")],
    ["taxDeployer", deployerBuild("taxDeployer", "TaxTokenDeployer")],
    ["rewardsTokenCode", "RewardsTokenCode"],
    // Fee mode: the site's ABIs for its launcher and hook come from this build as well
    ["v4FeeLauncher", "V4FeeLauncher"],
    ["v4FeeHook", "HoodSaleV4FeeHook"],
    ["v4FeeLens", "HoodSaleV4Lens"],
    ["v4FeeRouter", "HoodSaleV4Router"],
  ]) {
    if (builds[key]) out[`${key}_matchesBuild`] = await safe(() => matchesBuild(hre, name, builds[key]));
  }
  // Who may send QuickLaunch.distributeRewards (the keeper bot runs with the launch keeper wallet,
  // the deployer wallet owns QuickLaunch): the two are printed next to each other
  out.presaleFactory_launchKeeper = await pf.launchKeeper();
  out.quickLaunch = d.quickLaunch || "-";
  if (d.quickLaunch) {
    const ql = await hre.ethers.getContractAt("QuickLaunch", d.quickLaunch);
    out.quickLaunch_owner = await safe(() => ql.owner());
    out.quickLaunch_distributeRewardsBy = `launchKeeper ${out.presaleFactory_launchKeeper} or owner ${out.quickLaunch_owner}`;
    out.quickLaunch_tokenFactory = await safe(() => ql.tokenFactory());
    out.quickLaunch_presaleFactory = await safe(() => ql.presaleFactory());
    out.quickLaunch_metadataRegistry = await safe(() => ql.metadataRegistry());
    // QuickLaunch must write into the registry the frontend reads (deploy-registry.js replaces both)
    out.quickLaunch_registryMatches = await safe(
      async () => String(await ql.metadataRegistry()).toLowerCase() === String(d.metadataRegistry || "").toLowerCase()
    );
    out.quickLaunch_launches = await safe(async () => (await ql.allLaunchesLength()).toString());
    // Only the creator tax generation and later have this constant
    out.quickLaunch_maxCreatorTaxBps = await safe(async () => (await ql.MAX_CREATOR_TAX_BPS()).toString());
    // Only the token type generation has these (launch takes a QuickParams struct, Rewards type, allowlist)
    out.quickLaunch_minRewardsTaxBps = await safe(async () => (await ql.MIN_REWARDS_TAX_BPS()).toString());
    // Only the route depth generation has these (previousQuickLaunch fallback, isRewardRouteLive probes)
    out.quickLaunch_previousQuickLaunch = await safe(() => ql.previousQuickLaunch());
    out.quickLaunch_routeProbeWeth = await safe(async () => `${hre.ethers.formatEther(await ql.ROUTE_PROBE_WETH())} ETH`);
    out.quickLaunch_rewardTokens = await safe(async () => (await ql.rewardTokens()).join(", "));
    // V3 routes print as "TSLA: token -> WETH -0.3%-> TSLA (V3, pools live)", V2 ones without the fee tiers
    out.quickLaunch_rewardRoutes = await safe(async () => (await describeRewardRoutes(hre, ql)).join(" | "));
  }
  // The Uniswap v4 modes. Hook mode (scripts/deploy-v4.js) takes the tax in the pool's hook, fee
  // mode (scripts/deploy-v4-fee.js) makes it the pool's own fee. Each has its own launcher, hook,
  // lens and router; both share the keeper wallet and the token deployers.
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (d.v4Launcher) {
    const launcher = await hre.ethers.getContractAt("V4Launcher", d.v4Launcher);
    out.v4Launcher_hook = await safe(() => launcher.hook());
    out.v4Launcher_lens = await safe(() => launcher.lens());
    out.v4Launcher_keeper = await safe(() => launcher.keeper());
  }
  if (d.v4FeeLauncher) {
    const feeLauncher = await hre.ethers.getContractAt("V4FeeLauncher", d.v4FeeLauncher);
    out.v4FeeLauncher_owner = await safe(() => feeLauncher.owner());
    out.v4FeeLauncher_hook = await safe(() => feeLauncher.hook());
    out.v4FeeLauncher_lens = await safe(() => feeLauncher.lens());
    out.v4FeeLauncher_keeper = await safe(() => feeLauncher.keeper());
    // The owner's brake on new fee mode tokens; it never touches a launch
    out.v4FeeLauncher_creationOpen = await safe(() => feeLauncher.creationOpen());
    out.v4FeeLauncher_tokens = await safe(async () => (await feeLauncher.tokenCount()).toString());
    const wiring = [
      same(out.v4FeeLauncher_hook, d.v4FeeHook),
      same(out.v4FeeLauncher_lens, d.v4FeeLens),
      same(out.v4FeeLauncher_keeper, out.v4Launcher_keeper) && !same(out.v4FeeLauncher_keeper, hre.ethers.ZeroAddress),
    ];
    if (d.v4FeeHook) {
      const feeHook = await hre.ethers.getContractAt("HoodSaleV4FeeHook", d.v4FeeHook);
      // A v4 hook's address carries its permissions: the two gate bits and nothing else
      const flags = BigInt(d.v4FeeHook) & 0x3fffn;
      out.v4FeeHook_flags = `0x${flags.toString(16)} (0x2800 expected)`;
      out.v4FeeHook_launcher = await safe(() => feeHook.launcher());
      out.v4FeeHook_platformTreasury = await safe(() => feeHook.platformTreasury());
      out.v4FeeHook_pendingPlatform = await safe(async () => `${hre.ethers.formatEther(await feeHook.pendingPlatform())} ETH`);
      wiring.push(flags === 0x2800n, same(out.v4FeeHook_launcher, d.v4FeeLauncher), same(out.v4FeeHook_platformTreasury, d.treasury));
    }
    if (d.v4FeeLens) {
      const feeLens = await hre.ethers.getContractAt("HoodSaleV4Lens", d.v4FeeLens);
      out.v4FeeLens_launcher = await safe(() => feeLens.launcher());
      out.v4FeeLens_hook = await safe(() => feeLens.hook());
      wiring.push(same(out.v4FeeLens_launcher, d.v4FeeLauncher), same(out.v4FeeLens_hook, d.v4FeeHook));
    }
    if (d.v4FeeRouter) {
      const feeRouter = await hre.ethers.getContractAt("HoodSaleV4Router", d.v4FeeRouter);
      out.v4FeeRouter_launcher = await safe(() => feeRouter.launcher());
      wiring.push(same(out.v4FeeRouter_launcher, d.v4FeeLauncher));
    }
    out.v4Fee_wiringMatches = wiring.every(Boolean);
    // Fee mode tokens come out right only while all three of TokenFactory's deployers name both
    // launchers (TokenFactory.setDeployers is the last step of scripts/deploy-v4-fee.js, and the
    // rollback); otherwise V4FeeLauncher.createToken reverts NotFeeToken.
    const knowsBoth = async (address) => {
      const c = await hre.ethers.getContractAt("StandardTokenDeployerFee", address);
      return same(await c.feeLauncher(), d.v4FeeLauncher) && same(await c.launcher(), d.v4Launcher);
    };
    const live = [builds.standardDeployer, builds.taxDeployer, builds.rewardsDeployer];
    out.v4Fee_creationWired = (await Promise.all(live.map((a) => knowsBoth(a).catch(() => false)))).every(Boolean);
  }
  if (deployer) {
    out.deployer = deployer;
    out.deployer_hoodsale = hre.ethers.formatEther(await hs.balanceOf(deployer));
    out.deployer_eth = hre.ethers.formatEther(await p.getBalance(deployer));
  }
  for (const [k, v] of Object.entries(out)) console.log(k.padEnd(34), String(v));
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
