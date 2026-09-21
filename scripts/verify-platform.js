// Verifies every platform contract listed in deployments/<network>.json.
//
//   npx hardhat run scripts/verify-platform.js --network robinhoodTestnet
//   DRY_RUN=1      npx hardhat run scripts/verify-platform.js --network robinhoodTestnet
//   FORCE_MANUAL=1 npx hardhat run scripts/verify-platform.js --network robinhood
//
// The order matches the deploy order (they are independent, each one is verified on its own):
//   Treasury, LiquidityLocker, TokenFactory, Standard/Tax/RewardsTokenDeployer (read from
//   TokenFactory, not present in the deployments file) and RewardsTokenCode (read from the
//   rewards deployer), PresaleFactory, HoodSaleToken, TokenMetadataRegistry, HoodSaleLens.
// Then the Uniswap v4 modes, for the keys the deployments file has: hook mode (V4PositionLocker,
//   V4Launcher, HoodSaleV4Hook, HoodSaleV4Lens, HoodSaleV4Router, RewardsTokenCodeV4) and fee mode
//   (V4FeeLauncher, HoodSaleV4FeeHook, its own HoodSaleV4Lens and HoodSaleV4Router, and the three
//   Fee deployers while TokenFactory does not name them yet).
// "router" (Uniswap, external contract) and "marketingWallet" (EOA) are skipped.
// "Already Verified" responses count as success; a summary table is printed at the end.

const { verifyAddresses, loadDeployments, optionsFromEnv, printSummary, explorerBaseUrl, STATUS } = require("./verify-contract");

const ORDER = [
  ["treasury", "Treasury"],
  ["locker", "LiquidityLocker"],
  ["tokenFactory", "TokenFactory"],
  ["presaleFactory", "PresaleFactory"],
  ["hoodsale", "HoodSaleToken"],
  ["metadataRegistry", "TokenMetadataRegistry"],
  ["lens", "HoodSaleLens"],
];

// The Uniswap v4 modes, in deploy order (scripts/deploy-v4.js, then scripts/deploy-v4-fee.js). A
// chain without a mode has none of its keys, so a missing key here is not reported as skipped.
// The Fee deployers are recorded under keys of their own because they exist before
// TokenFactory.setDeployers names them; once it does, they are already in the list above.
const V4_ORDER = [
  ["v4Locker", "V4PositionLocker"],
  ["v4Launcher", "V4Launcher"],
  ["v4Hook", "HoodSaleV4Hook"],
  ["v4Lens", "HoodSaleV4Lens"],
  ["v4Router", "HoodSaleV4Router"],
  ["rewardsTokenCodeV4", "RewardsTokenCodeV4"],
  ["v4FeeLauncher", "V4FeeLauncher"],
  ["v4FeeHook", "HoodSaleV4FeeHook"],
  ["v4FeeLens", "HoodSaleV4Lens"],
  ["v4FeeRouter", "HoodSaleV4Router"],
  ["v4FeeStandardDeployer", "StandardTokenDeployerFee"],
  ["v4FeeTaxDeployer", "TaxTokenDeployerFee"],
  ["v4FeeRewardsDeployer", "RewardsTokenDeployerFee"],
];

/** The list of targets to verify (label, address) and the keys missing from deployments. */
async function platformTargets(hre, deployments) {
  const targets = [];
  const skipped = [];
  const zero = hre.ethers.ZeroAddress;
  for (const [key, name] of ORDER) {
    const address = deployments[key];
    if (!address || address === zero) {
      skipped.push({ label: key, address: address || "-", contract: name, status: "skipped", message: "not in deployments file", warnings: [] });
      continue;
    }
    targets.push({ label: key, address });
    if (key === "tokenFactory") {
      const tf = await hre.ethers.getContractAt("TokenFactory", address);
      const deployers = [
        ["standardDeployer", await tf.standardDeployer()],
        ["taxDeployer", await tf.taxDeployer()],
        ["rewardsDeployer", await tf.rewardsDeployer()],
      ];
      for (const [label, addr] of deployers) {
        if (addr && addr !== zero) targets.push({ label, address: addr });
        else skipped.push({ label, address: "-", contract: label, status: "skipped", message: "not set on TokenFactory", warnings: [] });
      }
      // The owner-locks generation keeps RewardsToken's creation code in its own contract
      const rewardsDeployer = deployers[2][1];
      if (rewardsDeployer && rewardsDeployer !== zero) {
        const rd = await hre.ethers.getContractAt("RewardsTokenDeployer", rewardsDeployer);
        const code = await rd.rewardsTokenCode().catch(() => zero);
        if (code && code !== zero) targets.push({ label: "rewardsTokenCode", address: code });
        else skipped.push({ label: "rewardsTokenCode", address: "-", contract: "RewardsTokenCode", status: "skipped", message: "rewards deployer predates RewardsTokenCode", warnings: [] });
      }
    }
  }
  for (const [key] of V4_ORDER) {
    const address = deployments[key];
    if (!address || address === zero) continue;
    if (targets.some((t) => t.address.toLowerCase() === address.toLowerCase())) continue;
    targets.push({ label: key, address });
  }
  return { targets, skipped };
}

/**
 * @param options { dryRun, forceManual, outDir, deployments, fromBlock, log, quiet }
 * @returns results (including the summary table; the skipped rows are included too)
 */
async function run(hre, options = {}) {
  const deployments = options.deployments || loadDeployments(hre, { required: true });
  const log = options.log || console.log;
  const { targets, skipped } = await platformTargets(hre, deployments);
  log(`[verify-platform] network ${hre.network.name}, ${targets.length} contracts${options.dryRun ? " (DRY_RUN)" : ""}`);
  const results = await verifyAddresses(hre, targets, { ...options, deployments, quiet: true });
  const all = [...results, ...skipped];
  if (!options.quiet) printSummary(all, log, await explorerBaseUrl(hre));
  return all;
}

async function main() {
  const hre = require("hardhat");
  const results = await run(hre, optionsFromEnv(hre));
  if (results.some((r) => r.status === STATUS.FAILED)) process.exitCode = 1;
}

module.exports = { main, run, platformTargets, ORDER, V4_ORDER };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
