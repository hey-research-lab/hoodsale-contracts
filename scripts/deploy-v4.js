// Deploys the Uniswap v4 launch mode next to the live V2 one. Nothing that is already on chain
// moves: TokenFactory, PresaleFactory, Treasury and LiquidityLocker keep their addresses, and the
// only wiring this touches is TokenFactory.setDeployers, which swaps in deployers that still build
// the identical V2 token for every V2 creator.
//
// The key is read without an echo, so it reaches neither the screen nor the shell history:
//
//   cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && npx hardhat run scripts/deploy-v4.js --network robinhood
//
// Optional environment, to continue a run that stopped half way without deploying twice:
//   V4_LOCKER=0x...        reuse an already deployed V4PositionLocker
//   V4_LAUNCHER=0x...      reuse an already deployed V4Launcher (must point at this deployment)
//   V4_HOOK=0x...          reuse an already deployed HoodSaleV4Hook (must name the launcher above)
//   V4_LENS=0x...          reuse an already deployed HoodSaleV4Lens
//   V4_ROUTER=0x...        reuse an already deployed HoodSaleV4Router
//   SKIP_DEPLOYERS=1       leave TokenFactory's deployers alone (v4 token creation stays off)
//   REPLACE_FEE_DEPLOYERS=1  go on although TokenFactory uses the Fee deployers of fee mode
//
// Once fee mode is live (scripts/deploy-v4-fee.js) the factory's deployers know both v4 launchers.
// The V4 generation built here knows one, so registering it would make every fee mode token
// creation revert NotFeeToken: without SKIP_DEPLOYERS the script stops before it deploys or sends
// anything when a live deployer answers feeLauncher().
//
// After this, run scripts/upgrade-presale-code.js (so new sales can finalize into a v4 pool) and
// scripts/deploy-lens.js (so the site's views carry poolKind), then verify everything on the
// explorer: the Uniswap hook allowlist refuses a hook whose source is not verified.
//
// Nothing here prints or stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { v4For, v4AddressesFor, PERMIT2 } = require("./lib/uniswap-v4");
const { mineHookSalt, hookInitcode, deployWithCreate2, HOODSALE_HOOK_FLAGS, ALL_HOOK_MASK } = require("./lib/hook-miner");
const { v3For } = require("./lib/reward-tokens");

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

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["tokenFactory", "presaleFactory", "treasury"]) {
    if (!d[k]) throw new Error(`deployments/${network}.json lacks ${k}`);
  }
  console.log(`Adding the Uniswap v4 launch mode on ${network} with ${deployer.address}`);

  // A dev node has no Uniswap v4 of its own, so scripts/deploy-v4-uniswap-local.js puts one there
  // and records it in the deployments file; a real chain uses the published addresses.
  const { chainId } = await hre.ethers.provider.getNetwork();
  const local = v4AddressesFor(chainId)
    ? {}
    : {
        poolManager: d.v4PoolManager,
        positionManager: d.v4PositionManager,
        stateView: d.v4StateView,
        quoter: d.v4Quoter,
        permit2: d.permit2 || PERMIT2,
      };
  if (!v4AddressesFor(chainId) && !d.v4PoolManager) {
    throw new Error("this chain has no Uniswap v4: run scripts/deploy-v4-uniswap-local.js first");
  }
  const v4 = await v4For(hre, local);
  if (!v4) throw new Error(`no Uniswap v4 deployment known for this chain (scripts/lib/uniswap-v4.js)`);
  console.log(`Uniswap v4: poolManager ${v4.poolManager}, positionManager ${v4.positionManager}, stateView ${v4.stateView}`);

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const factoryOwner = await tokenFactory.owner();
  if (!same(factoryOwner, deployer.address)) {
    throw new Error(`the deployer must own TokenFactory to register the deployers (owner is ${factoryOwner})`);
  }
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory);
  const keeper = await presaleFactory.launchKeeper();

  // Checked here, before the locker and the launcher are deployed, so a refusal leaves nothing
  // behind. With SKIP_DEPLOYERS the factory's deployers are not touched and nothing is asked.
  if (!process.env.SKIP_DEPLOYERS) {
    for (const [slot, address] of [
      ["standard", await tokenFactory.standardDeployer()],
      ["tax", await tokenFactory.taxDeployer()],
      ["rewards", await tokenFactory.rewardsDeployer()],
    ]) {
      if (!(await knowsFeeLauncher(address))) continue;
      if (process.env.REPLACE_FEE_DEPLOYERS === "1") {
        console.log(`WARNING: the ${slot} deployer ${address} is of the Fee generation; going on (REPLACE_FEE_DEPLOYERS)`);
        continue;
      }
      throw new Error(
        `the live ${slot} deployer ${address} is of the Fee generation (scripts/deploy-v4-fee.js). This script would register ` +
          "deployers that do not know the fee launcher, and fee mode token creation would revert NotFeeToken. " +
          "Nothing was deployed or sent. SKIP_DEPLOYERS=1 leaves the deployers alone; REPLACE_FEE_DEPLOYERS=1 goes on regardless."
      );
    }
  }

  // ---------------------------------------------------------------- locker

  let locker;
  if (process.env.V4_LOCKER) {
    locker = await hre.ethers.getContractAt("V4PositionLocker", process.env.V4_LOCKER);
    console.log(`V4PositionLocker: reusing ${locker.target}`);
  } else {
    locker = await hre.ethers.deployContract("V4PositionLocker", [deployer.address, v4.positionManager]);
    await locker.waitForDeployment();
    console.log(`V4PositionLocker: deployed ${locker.target}`);
  }

  // -------------------------------------------------------------- launcher

  let launcher;
  if (process.env.V4_LAUNCHER) {
    launcher = await hre.ethers.getContractAt("V4Launcher", process.env.V4_LAUNCHER);
    console.log(`V4Launcher: reusing ${launcher.target}`);
  } else {
    launcher = await hre.ethers.deployContract("V4Launcher", [
      deployer.address,
      v4.poolManager,
      v4.positionManager,
      v4.permit2,
      d.tokenFactory,
      d.presaleFactory,
      locker.target,
      d.treasury,
    ]);
    await launcher.waitForDeployment();
    console.log(`V4Launcher: deployed ${launcher.target}`);
  }

  // ------------------------------------------------------------------ hook

  let hookAddress = process.env.V4_HOOK;
  let hookSalt = d.v4HookSalt;
  if (hookAddress) {
    console.log(`HoodSaleV4Hook: reusing ${hookAddress}`);
  } else {
    // The address carries the hook's permissions, so it has to be mined before it can be deployed.
    const initcode = await hookInitcode(hre, v4.poolManager, launcher.target, d.treasury);
    console.log("Mining a hook address that carries the permission bits...");
    const mined = mineHookSalt(hre.ethers, initcode, HOODSALE_HOOK_FLAGS);
    console.log(`  found ${mined.address} after ${mined.tried} tries`);
    const result = await deployWithCreate2(hre, deployer, initcode, mined.salt, mined.address);
    hookAddress = result.address;
    hookSalt = mined.salt;
    console.log(`HoodSaleV4Hook: deployed ${hookAddress} (${result.gasUsed} gas)`);
  }
  const hook = await hre.ethers.getContractAt("HoodSaleV4Hook", hookAddress);
  if ((BigInt(hookAddress) & BigInt(ALL_HOOK_MASK)) !== BigInt(HOODSALE_HOOK_FLAGS)) {
    throw new Error(`hook ${hookAddress} does not carry the permission bits 0x${HOODSALE_HOOK_FLAGS.toString(16)}`);
  }
  if (!same(await hook.launcher(), launcher.target)) throw new Error("the hook names a different launcher");

  const wiredHook = await launcher.hook();
  if (wiredHook === hre.ethers.ZeroAddress) {
    await (await launcher.setHook(hookAddress)).wait();
    console.log("V4Launcher: hook set");
  } else if (!same(wiredHook, hookAddress)) {
    throw new Error(`the launcher already points at hook ${wiredHook}`);
  }

  if (!(await locker.isLauncher(launcher.target))) {
    await (await locker.setLauncher(launcher.target, true)).wait();
    console.log("V4PositionLocker: launcher allowed");
  }
  if (keeper !== hre.ethers.ZeroAddress && !same(await launcher.keeper(), keeper)) {
    await (await launcher.setKeeper(keeper)).wait();
    console.log(`V4Launcher: keeper set to ${keeper}`);
  }

  // ------------------------------------------------------------- deployers

  const previous = {
    standard: await tokenFactory.standardDeployer(),
    tax: await tokenFactory.taxDeployer(),
    rewards: await tokenFactory.rewardsDeployer(),
  };
  let deployers = null;
  if (process.env.SKIP_DEPLOYERS) {
    console.log("Token deployers: left alone (SKIP_DEPLOYERS)");
  } else {
    const v3 = await v3For(hre, d);
    const v3Router = v3 ? v3.router : hre.ethers.ZeroAddress;
    const v3Quoter = v3 ? v3.quoter : hre.ethers.ZeroAddress;
    const rewardsCodeV2 = await (await hre.ethers.getContractAt("RewardsTokenDeployer", previous.rewards)).rewardsTokenCode();

    const codeV4 = await hre.ethers.deployContract("RewardsTokenCodeV4");
    await codeV4.waitForDeployment();
    const standard = await hre.ethers.deployContract("StandardTokenDeployerV4", [d.tokenFactory, launcher.target]);
    const tax = await hre.ethers.deployContract("TaxTokenDeployerV4", [d.tokenFactory, launcher.target]);
    const rewards = await hre.ethers.deployContract("RewardsTokenDeployerV4", [
      d.tokenFactory,
      v3Router,
      v3Quoter,
      rewardsCodeV2,
      codeV4.target,
      launcher.target,
    ]);
    await Promise.all([standard.waitForDeployment(), tax.waitForDeployment(), rewards.waitForDeployment()]);
    await (await tokenFactory.setDeployers(standard.target, tax.target, rewards.target)).wait();
    deployers = { standard: standard.target, tax: tax.target, rewards: rewards.target, codeV4: codeV4.target };
    console.log(`Token deployers: standard ${standard.target}, tax ${tax.target}, rewards ${rewards.target}`);
    console.log(`  RewardsTokenCodeV4 ${codeV4.target}, keeping the V2 code contract ${rewardsCodeV2}`);
  }

  // ------------------------------------------------------------ lens, router

  let v4Lens;
  if (process.env.V4_LENS) {
    v4Lens = await hre.ethers.getContractAt("HoodSaleV4Lens", process.env.V4_LENS);
    console.log(`HoodSaleV4Lens: reusing ${v4Lens.target}`);
  } else {
    v4Lens = await hre.ethers.deployContract("HoodSaleV4Lens", [launcher.target, v4.stateView]);
    await v4Lens.waitForDeployment();
    console.log(`HoodSaleV4Lens: deployed ${v4Lens.target}`);
  }
  if (!same(await launcher.lens(), v4Lens.target)) {
    await (await launcher.setLens(v4Lens.target)).wait();
    console.log("V4Launcher: lens set");
  }

  let router;
  if (process.env.V4_ROUTER) {
    router = await hre.ethers.getContractAt("HoodSaleV4Router", process.env.V4_ROUTER);
    console.log(`HoodSaleV4Router: reusing ${router.target}`);
  } else {
    router = await hre.ethers.deployContract("HoodSaleV4Router", [v4.poolManager, launcher.target]);
    await router.waitForDeployment();
    console.log(`HoodSaleV4Router: deployed ${router.target}`);
  }

  // ------------------------------------------------------------------ save

  const next = {
    ...d,
    v4PoolManager: v4.poolManager,
    v4PositionManager: v4.positionManager,
    v4StateView: v4.stateView,
    v4Quoter: v4.quoter,
    ...(v4.universalRouter ? { v4UniversalRouter: v4.universalRouter } : {}),
    permit2: v4.permit2,
    v4Locker: locker.target,
    v4Launcher: launcher.target,
    v4Hook: hookAddress,
    v4HookSalt: hookSalt,
    v4Lens: v4Lens.target,
    v4Router: router.target,
  };
  if (deployers) {
    next.standardDeployer = deployers.standard;
    next.taxDeployer = deployers.tax;
    next.rewardsDeployer = deployers.rewards;
    next.rewardsTokenCodeV4 = deployers.codeV4;
    if (!same(previous.standard, deployers.standard)) next.previousStandardDeployer = previous.standard;
    if (!same(previous.tax, deployers.tax)) next.previousTaxDeployer = previous.tax;
    if (!same(previous.rewards, deployers.rewards)) next.previousRewardsDeployer = previous.rewards;
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nSaved to deployments/${network}.json`);
  // The local network's addresses are read straight from the frontend config, the way deploy.js
  // keeps them in step.
  if (network === "localhost" || network === "hardhat") {
    const frontendConfig = path.join(__dirname, "..", "..", "frontend", "src", "config", "localhost.json");
    if (fs.existsSync(path.dirname(frontendConfig))) {
      fs.writeFileSync(frontendConfig, JSON.stringify(next, null, 2));
      console.log("Updated frontend/src/config/localhost.json");
    }
  }

  // ----------------------------------------------------------- final check

  const checks = [
    ["hook names the launcher", same(await hook.launcher(), launcher.target)],
    ["launcher points at the hook", same(await launcher.hook(), hookAddress)],
    ["launcher points at the lens", same(await launcher.lens(), v4Lens.target)],
    ["locker allows the launcher", await locker.isLauncher(launcher.target)],
    ["hook pays the platform Treasury", same(await hook.platformTreasury(), d.treasury)],
    ["router uses the launcher", same(await router.launcher(), launcher.target)],
  ];
  console.log("\nWiring");
  for (const [what, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (checks.some(([, ok]) => !ok)) throw new Error("wiring check failed");

  console.log("\nNext");
  console.log("  1. npx hardhat run scripts/upgrade-presale-code.js --network " + network + "   (sales can finalize into a v4 pool)");
  console.log("  2. npx hardhat run scripts/deploy-lens.js --network " + network + "            (views carry poolKind)");
  console.log("  3. verify every new contract on the explorer and Sourcify");
  console.log("  4. put v4Launcher, v4Hook, v4Lens, v4Router and the lens into frontend/src/config/registry.js");
  console.log("  5. submit the hook to Uniswap's routing allowlist (developers.uniswap.org/hook-allowlist)");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
