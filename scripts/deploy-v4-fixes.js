// Ships the fixes from the v4 security review. The hook, the launcher, the locker and the router
// stay where they are (the hook is the one Uniswap's routing allowlist was asked to accept), so
// only three pieces are replaced:
//
//   1. the Rewards token for v4 launches: the keeper may run distributions but no longer set the
//      reward route or the exclusions. A fresh RewardsTokenCodeV4 and RewardsTokenDeployerV4 are
//      deployed and TokenFactory.setDeployers swaps in the new rewards deployer, keeping the
//      standard and tax deployers it has now. V2 Rewards tokens come out exactly as before.
//   2. the presale: a v4 sale opens its pool only with the tax it was created with. A fresh
//      PresaleCode is deployed and PresaleFactory.setPresaleCode points new sales at it.
//   3. the v4 lens: a launch is valued by its own position, not by the pool's active liquidity.
//      A fresh HoodSaleV4Lens is deployed and V4Launcher.setLens points the platform lens at it.
//
// Tokens and sales that already exist keep their own code; only new ones get the fixes.
//
// The key is read without an echo, so it reaches neither the screen nor the shell history:
//
//   cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && npx hardhat run scripts/deploy-v4-fixes.js --network robinhood
//
// Optional environment, to continue a run that stopped half way without deploying twice:
//   REWARDS_CODE_V4=0x...    reuse an already deployed RewardsTokenCodeV4
//   REWARDS_DEPLOYER=0x...   reuse an already deployed RewardsTokenDeployerV4
//   PRESALE_CODE=0x...       reuse an already deployed PresaleCode
//   V4_LENS=0x...            reuse an already deployed HoodSaleV4Lens
//   REPLACE_FEE_DEPLOYERS=1  go on although TokenFactory uses the Fee deployers (see below)
//
// Safe to re-run while the factory's deployers are the V4 generation: every wiring step is skipped
// when it is already in place. Once fee mode is live (scripts/deploy-v4-fee.js) the factory's
// deployers know both v4 launchers, and the rewards deployer this script builds knows only the
// hook mode one: swapping it in would make every fee mode Rewards token creation revert
// NotFeeToken. The script therefore stops before it deploys or sends anything when a live deployer
// answers feeLauncher(). A new PresaleCode alone is shipped by scripts/upgrade-presale-code.js.
// Nothing here prints or stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Whether `address` is a token deployer of the Fee generation, asked of the chain itself. */
async function knowsFeeLauncher(address) {
  const c = new hre.ethers.Contract(address, ["function feeLauncher() view returns (address)"], hre.ethers.provider);
  try {
    await c.feeLauncher();
    return true;
  } catch (e) {
    // A deployer without the getter reverts. Anything else (a dropped call) must not pass as a no.
    if (e.code === "CALL_EXCEPTION" || e.code === "BAD_DATA" || /revert/i.test(String(e.message))) return false;
    throw e;
  }
}

async function reuseOrDeploy(envName, contractName, args) {
  const addr = process.env[envName];
  if (addr) {
    if (!hre.ethers.isAddress(addr)) throw new Error(`${envName} is not an address: ${addr}`);
    if ((await hre.ethers.provider.getCode(addr)) === "0x") throw new Error(`${envName} has no code: ${addr}`);
    console.log(`${contractName}: reusing ${addr}`);
    return hre.ethers.getContractAt(contractName, addr);
  }
  const c = await hre.ethers.deployContract(contractName, args);
  await c.waitForDeployment();
  console.log(`${contractName}: deployed ${c.target}`);
  return c;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["tokenFactory", "presaleFactory", "v4Launcher", "v4StateView"]) {
    if (!d[k]) throw new Error(`deployments/${network}.json lacks ${k}`);
  }
  console.log(`Shipping the v4 review fixes on ${network} with ${deployer.address}`);

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const launcher = await hre.ethers.getContractAt("V4Launcher", d.v4Launcher);
  for (const [name, c] of [
    ["TokenFactory", tokenFactory],
    ["PresaleFactory", presaleFactory],
    ["V4Launcher", launcher],
  ]) {
    const owner = await c.owner();
    if (!same(owner, deployer.address)) throw new Error(`the deployer must own ${name} (owner is ${owner})`);
  }

  // ------------------------------------------------- 1. the v4 Rewards token

  const current = {
    standard: await tokenFactory.standardDeployer(),
    tax: await tokenFactory.taxDeployer(),
    rewards: await tokenFactory.rewardsDeployer(),
  };
  // A Fee deployer answers every getter read below and names the same hook mode launcher, so
  // without this it would pass for the V4 generation and be replaced by a deployer that does not
  // know the fee launcher.
  for (const [slot, address] of Object.entries(current)) {
    if (!(await knowsFeeLauncher(address))) continue;
    if (process.env.REPLACE_FEE_DEPLOYERS === "1") {
      console.log(`WARNING: the ${slot} deployer ${address} is of the Fee generation; going on (REPLACE_FEE_DEPLOYERS)`);
      continue;
    }
    throw new Error(
      `the live ${slot} deployer ${address} is of the Fee generation (scripts/deploy-v4-fee.js). This script would swap in a ` +
        "rewards deployer that does not know the fee launcher, and fee mode Rewards token creation would revert NotFeeToken. " +
        "Nothing was deployed or sent. A new PresaleCode alone: scripts/upgrade-presale-code.js. " +
        "REPLACE_FEE_DEPLOYERS=1 goes on regardless."
    );
  }
  // Everything the new rewards deployer is built with comes from the one it replaces, so a V2
  // Rewards token and the reward swap's route stay exactly as they are.
  const old = await hre.ethers.getContractAt("RewardsTokenDeployerV4", current.rewards);
  const [factoryOf, v3Router, v3Quoter, rewardsCodeV2, launcherOf, oldCodeV4] = await Promise.all([
    old.factory(),
    old.v3Router(),
    old.v3Quoter(),
    old.rewardsTokenCode(),
    old.launcher(),
    old.rewardsTokenCodeV4(),
  ]);
  if (!same(factoryOf, d.tokenFactory) || !same(launcherOf, d.v4Launcher)) {
    throw new Error(`the current rewards deployer ${current.rewards} does not belong to this deployment`);
  }

  const codeV4 = await reuseOrDeploy("REWARDS_CODE_V4", "RewardsTokenCodeV4", []);
  const rewardsDeployer = await reuseOrDeploy("REWARDS_DEPLOYER", "RewardsTokenDeployerV4", [
    d.tokenFactory,
    v3Router,
    v3Quoter,
    rewardsCodeV2,
    codeV4.target,
    d.v4Launcher,
  ]);
  if (!same(await rewardsDeployer.rewardsTokenCodeV4(), codeV4.target)) {
    throw new Error(`${rewardsDeployer.target} does not build from ${codeV4.target}`);
  }
  if (same(current.rewards, rewardsDeployer.target)) {
    console.log("TokenFactory: already uses the new rewards deployer");
  } else {
    await (await tokenFactory.setDeployers(current.standard, current.tax, rewardsDeployer.target)).wait();
    console.log(`TokenFactory: rewards deployer set to ${rewardsDeployer.target}`);
  }

  // --------------------------------------------------------- 2. the presale

  const presaleCode = await reuseOrDeploy("PRESALE_CODE", "PresaleCode", []);
  const expected = (await hre.artifacts.readArtifact("Presale")).bytecode.toLowerCase();
  const onChain = (await presaleCode.creationCode()).toLowerCase();
  if (onChain !== expected) {
    throw new Error(`${presaleCode.target} does not carry the Presale of this build; compile and deploy a fresh PresaleCode`);
  }
  const currentPresaleCode = await presaleFactory.presaleCode();
  if (same(currentPresaleCode, presaleCode.target)) {
    console.log("PresaleFactory: already uses the new presale code");
  } else {
    await (await presaleFactory.setPresaleCode(presaleCode.target)).wait();
    console.log(`PresaleFactory: presale code set to ${presaleCode.target}`);
  }

  // --------------------------------------------------------- 3. the v4 lens

  const v4Lens = await reuseOrDeploy("V4_LENS", "HoodSaleV4Lens", [d.v4Launcher, d.v4StateView]);
  const currentLens = await launcher.lens();
  if (same(currentLens, v4Lens.target)) {
    console.log("V4Launcher: already points at the new lens");
  } else {
    await (await launcher.setLens(v4Lens.target)).wait();
    console.log(`V4Launcher: lens set to ${v4Lens.target}`);
  }

  // ------------------------------------------------------------------ save

  const next = { ...d };
  const replace = (key, previousKey, was, now) => {
    next[key] = now;
    if (was && !same(was, now)) next[previousKey] = was;
  };
  replace("rewardsDeployer", "previousRewardsDeployer", current.rewards, rewardsDeployer.target);
  replace("rewardsTokenCodeV4", "previousRewardsTokenCodeV4", oldCodeV4, codeV4.target);
  replace("presaleCode", "previousPresaleCode", currentPresaleCode, presaleCode.target);
  replace("v4Lens", "previousV4Lens", currentLens, v4Lens.target);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nSaved to deployments/${network}.json`);
  // The local network's addresses are read straight from the frontend config, the way deploy.js
  // keeps them in step.
  if (network === "localhost") {
    const frontendConfig = path.join(__dirname, "..", "..", "frontend", "src", "config", "localhost.json");
    if (fs.existsSync(path.dirname(frontendConfig))) {
      fs.writeFileSync(frontendConfig, JSON.stringify(next, null, 2));
      console.log("Updated frontend/src/config/localhost.json");
    }
  }

  // ----------------------------------------------------------- final check

  const checks = [
    ["token factory builds v4 Rewards tokens with the new deployer", same(await tokenFactory.rewardsDeployer(), rewardsDeployer.target)],
    ["standard deployer unchanged", same(await tokenFactory.standardDeployer(), current.standard)],
    ["tax deployer unchanged", same(await tokenFactory.taxDeployer(), current.tax)],
    ["presale factory creates sales from the new code", same(await presaleFactory.presaleCode(), presaleCode.target)],
    ["launcher points at the new lens", same(await launcher.lens(), v4Lens.target)],
    ["new lens reads this launcher", same(await v4Lens.launcher(), d.v4Launcher)],
  ];
  console.log("\nWiring");
  for (const [what, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("wiring check failed");

  console.log("\nNext: verify RewardsTokenCodeV4, RewardsTokenDeployerV4, PresaleCode and HoodSaleV4Lens");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { main };
