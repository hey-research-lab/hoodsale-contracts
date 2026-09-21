// Adds the Uniswap v4 fee mode next to the live hook mode. In fee mode the trading tax is the
// pool's own LP fee: an ownerless gate hook holds the launch position forever, collects the fees,
// turns the token side into ETH and splits it. Nothing that is already on chain moves, and the
// only transaction on an existing contract is TokenFactory.setDeployers, sent last, which swaps in
// deployers that know both launchers and still build the identical token for every other creator.
//
// On a real chain the key is read without an echo, so it reaches neither the screen nor the shell
// history (never type DEPLOYER_KEY=0x... in front of a command):
//
//   cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && SKIP_SET_DEPLOYERS=1 npx hardhat run scripts/deploy-v4-fee.js --network robinhood
//
//   npx hardhat run scripts/deploy-v4-fee.js --network localhost      (after scripts/deploy-v4.js)
//
// The release order for mainnet, step by step, is docs/FEE-MODE-RELEASE.md.
//
// Order: V4FeeLauncher, HoodSaleV4FeeHook at a mined CREATE2 address, setHook, a second
// HoodSaleV4Lens (it takes the hook from the launcher, so it comes after setHook), setLens, a
// second HoodSaleV4Router, setKeeper, the three Fee deployers, and last TokenFactory.setDeployers.
// The wiring is checked and every token creation is simulated before that last step, and both are
// checked once more at the end.
//
// Resumable: every address is written to the deployments file the moment it exists, and a step
// that is already recorded there (or already in place on chain) is skipped, so a run that stopped
// half way is simply started again.
//
// Optional environment:
//   SKIP_SET_DEPLOYERS=1    stop before TokenFactory.setDeployers and print the exact call, so the
//                           deployment can be inspected first; run again without it to finish.
//                           SKIP_DEPLOYERS, the name scripts/deploy-v4.js reads, is refused here:
//                           that script also skips deploying the deployers, this one never does
//   CLOSE_CREATION=1        send V4FeeLauncher.setCreationOpen(false) before setDeployers, so
//                           nobody can create a fee mode token until the site is released. The
//                           brake stops createToken only: a token that exists still launches
//   OPEN_CREATION=1         send V4FeeLauncher.setCreationOpen(true) once the final checks pass:
//                           the last step of the release
//   V4_FEE_LAUNCHER=0x...   use this V4FeeLauncher instead of deploying or reading the record
//   V4_FEE_HOOK=0x...       use this HoodSaleV4FeeHook (must name the launcher above)
//   V4_FEE_LENS=0x...       use this HoodSaleV4Lens (must read the launcher and hook above)
//   V4_FEE_ROUTER=0x...     use this HoodSaleV4Router
//   V4_FEE_STANDARD_DEPLOYER, V4_FEE_TAX_DEPLOYER, V4_FEE_REWARDS_DEPLOYER   the same, per deployer
//                           An address given this way is written to the record only after the
//                           wiring check has passed with it, where each deployer also has to build
//                           a token of its own type in a simulation
//   DEPLOYMENTS_FILE=path   another deployments json than deployments/<network>.json (a rehearsal)
//
// Rollback is TokenFactory.setDeployers with the previous* addresses recorded here: the V4
// generation the factory named before the swap. They are recorded before the swap, whoever sends
// it, and printed again on every later run. Creating a fee mode token then reverts NotFeeToken;
// the fee mode tokens and sales that exist keep working.
//
// Nothing here prints or stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { v4For, v4AddressesFor, PERMIT2 } = require("./lib/uniswap-v4");
const { mineHookSalt, feeHookInitcode, deployWithCreate2, FEE_HOOK_FLAGS, ALL_HOOK_MASK } = require("./lib/hook-miner");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** EIP-170: a contract whose runtime code is larger than this cannot be deployed on a real chain. */
const MAX_CODE_SIZE = 24_576;

/** Hook addresses the miner passes over. Their reason is unverified and the check costs nothing. */
const rejectHookAddress = (address) => address.toLowerCase().startsWith("0x91");

async function codeSize(address) {
  return ((await hre.ethers.provider.getCode(address)).length - 2) / 2;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A revert is an answer from the chain; anything else (a dropped or timed out call) is not. */
const isRevert = (e) =>
  e.code === "CALL_EXCEPTION" ||
  e.code === "BAD_DATA" ||
  Boolean(e.revert) ||
  (typeof e.data === "string" && e.data.length >= 10) ||
  /revert/i.test(String(e.message));

/** A view's answer, or null when the contract has no such function. Anything else is tried again. */
async function readOrNull(read, { retries = 2, delayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      if (isRevert(e)) return null;
      if (attempt >= retries) throw e;
      await sleep(delayMs);
    }
  }
}

/**
 * What a token deployer knows, asked of the address itself. "Fee" knows both v4 launchers, "V4"
 * the hook mode launcher only, "V2" neither; "none" has no code. `launcher` is the hook mode
 * launcher it names, null for a V2 deployer.
 */
async function generationOf(address, retry) {
  if (!address || !hre.ethers.isAddress(address) || (await hre.ethers.provider.getCode(address)) === "0x") {
    return { generation: "none", launcher: null };
  }
  const c = new hre.ethers.Contract(
    address,
    ["function launcher() view returns (address)", "function feeLauncher() view returns (address)"],
    hre.ethers.provider
  );
  const launcher = await readOrNull(() => c.launcher(), retry);
  if (!launcher) return { generation: "V2", launcher: null };
  const feeLauncher = await readOrNull(() => c.feeLauncher(), retry);
  return { generation: feeLauncher ? "Fee" : "V4", launcher };
}

/** The name of the error a simulated call reverted with, or the first line of what went wrong. */
function reasonOf(e, iface) {
  if (e.revert && e.revert.name) return e.revert.name === "Error" ? String(e.revert.args[0]) : e.revert.name;
  try {
    const parsed = e.data && e.data !== "0x" ? iface.parseError(e.data) : null;
    if (parsed) return parsed.name === "Error" ? String(parsed.args[0]) : parsed.name;
  } catch {
    // data that is no error of this interface: the message below says what there is to say
  }
  return e.shortMessage || String(e.message).split("\n")[0];
}

/**
 * Runs a static call and returns null when it succeeds, else the reason. A failure that is not a
 * revert is tried again, so one dropped RPC call is never reported as a broken platform.
 */
async function simulate(call, iface, { retries = 2, delayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await call();
      return null;
    } catch (e) {
      if (isRevert(e) || attempt >= retries) return reasonOf(e, iface);
      await sleep(delayMs);
    }
  }
}

/**
 * @param options { file, signer, retryDelayMs } another deployments json, the wallet that deploys
 *                (a fork rehearsal passes the impersonated owner) and the wait before a dropped
 *                read is tried again. All default to what the network gives.
 */
async function main(options = {}) {
  // Refused before anything is deployed or sent. scripts/deploy-v4.js reads SKIP_DEPLOYERS and the
  // plan once named it for this script too; read silently as nothing, it would let a run that was
  // meant to stop for inspection go on to TokenFactory.setDeployers.
  if (process.env.SKIP_DEPLOYERS && !process.env.SKIP_SET_DEPLOYERS) {
    throw new Error(
      "SKIP_DEPLOYERS is the name scripts/deploy-v4.js reads; this script reads SKIP_SET_DEPLOYERS=1 " +
        "(it always deploys the Fee deployers and holds back only TokenFactory.setDeployers). Nothing was deployed or sent."
    );
  }
  // Any value holds setDeployers back and any value closes creation: both fail safe. Opening
  // creation to the public is the other direction, so it takes exactly 1.
  const skipSetDeployers = Boolean(process.env.SKIP_SET_DEPLOYERS);
  const closeCreation = Boolean(process.env.CLOSE_CREATION);
  if (process.env.OPEN_CREATION && process.env.OPEN_CREATION !== "1") {
    throw new Error(`OPEN_CREATION is "${process.env.OPEN_CREATION}": set it to 1 to open fee mode creation, or leave it out`);
  }
  const openCreation = process.env.OPEN_CREATION === "1";
  if (openCreation && closeCreation) throw new Error("CLOSE_CREATION and OPEN_CREATION are both set: choose one");
  if (openCreation && skipSetDeployers) {
    throw new Error("OPEN_CREATION opens fee mode to everyone and belongs to a run after setDeployers: it cannot go with SKIP_SET_DEPLOYERS");
  }
  const retry = { delayMs: options.retryDelayMs ?? 1500 };

  const deployer = options.signer || (await hre.ethers.getSigners())[0];
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const defaultFile = path.join(__dirname, "..", "deployments", `${network}.json`);
  const file = options.file || process.env.DEPLOYMENTS_FILE || defaultFile;
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  let d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["tokenFactory", "presaleFactory", "treasury", "v4Launcher"]) {
    if (!d[k]) throw new Error(`${path.basename(file)} lacks ${k}: fee mode is added to a platform that has the v4 hook mode (scripts/deploy-v4.js)`);
  }
  console.log(`Adding the Uniswap v4 fee mode on ${network} with ${deployer.address}`);

  // Every step saves what it made, so the next run finds it and moves on. The local network's
  // addresses are read straight from the frontend config, the way deploy.js keeps them in step.
  const mirrored = network === "localhost" && path.resolve(file) === defaultFile;
  const recordedIn = `${path.resolve(file) === defaultFile ? `deployments/${network}.json` : file}${mirrored ? " and frontend/src/config/localhost.json" : ""}`;
  const save = (changes) => {
    d = { ...d, ...changes };
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
    if (!mirrored) return;
    const frontendConfig = path.join(__dirname, "..", "..", "frontend", "src", "config", "localhost.json");
    if (fs.existsSync(path.dirname(frontendConfig))) fs.writeFileSync(frontendConfig, JSON.stringify(d, null, 2));
  };

  // An address named through the environment is written to the record only once the wiring check
  // has passed with it: a wrong one written on sight would be read back by every later run. Until
  // then a run that stops half way is started again with the same variables.
  const overridden = {};

  /** The address a step starts from: the environment first, then the record, else null. */
  const known = async (envName, key, what) => {
    const address = process.env[envName] || d[key];
    if (!address) return null;
    const from = process.env[envName] ? envName : `${key} in ${path.basename(file)}`;
    if (!hre.ethers.isAddress(address)) throw new Error(`${from} is not an address: ${address}`);
    if ((await hre.ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${from} has no code at ${address}: remove it to deploy a fresh ${what}`);
    }
    console.log(`${what}: reusing ${address}`);
    return hre.ethers.getAddress(address);
  };

  // ------------------------------------------------------------- preflight

  // A dev node and a fork carry their Uniswap v4 addresses in the deployments file (see
  // scripts/deploy-v4.js); a real chain uses the published ones.
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
    throw new Error("this chain has no Uniswap v4: run scripts/deploy-v4-uniswap-local.js and scripts/deploy-v4.js first");
  }
  const v4 = await v4For(hre, local);
  console.log(`Uniswap v4: poolManager ${v4.poolManager}, positionManager ${v4.positionManager}, stateView ${v4.stateView}`);

  // Fee mode stands on the same Uniswap contracts, factories and Treasury as hook mode, so the
  // live launcher is the reference for all of them, and for the keeper wallet.
  const hookLauncher = await hre.ethers.getContractAt("V4Launcher", d.v4Launcher, deployer);
  for (const [what, got, want] of [
    ["poolManager", await hookLauncher.poolManager(), v4.poolManager],
    ["positionManager", await hookLauncher.positionManager(), v4.positionManager],
    ["permit2", await hookLauncher.permit2(), v4.permit2],
    ["tokenFactory", await hookLauncher.tokenFactory(), d.tokenFactory],
    ["presaleFactory", await hookLauncher.presaleFactory(), d.presaleFactory],
    ["treasury", await hookLauncher.treasury(), d.treasury],
  ]) {
    if (!same(got, want)) throw new Error(`the live V4Launcher's ${what} is ${got}, this deployment's is ${want}`);
  }
  const presaleFactory = await hre.ethers.getContractAt("PresaleFactory", d.presaleFactory, deployer);
  const launchKeeper = await presaleFactory.launchKeeper();
  let keeper = await hookLauncher.keeper();
  if (keeper === hre.ethers.ZeroAddress) keeper = launchKeeper;
  if (keeper === hre.ethers.ZeroAddress) {
    throw new Error("neither V4Launcher.keeper() nor PresaleFactory.launchKeeper() is set: run scripts/set-launch-keeper.js first");
  }
  if (!same(keeper, launchKeeper)) {
    console.log(`Note: V4Launcher.keeper() ${keeper} is not PresaleFactory.launchKeeper() ${launchKeeper}; the launcher's is used`);
  }

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory, deployer);
  const factoryOwner = await tokenFactory.owner();
  if (!same(factoryOwner, deployer.address)) {
    if (!skipSetDeployers) {
      throw new Error(`the deployer must own TokenFactory to register the deployers (owner is ${factoryOwner})`);
    }
    console.log(`Note: TokenFactory is owned by ${factoryOwner}, who will have to send setDeployers`);
  }

  // The deployers in use now. Everything the new rewards deployer is built with comes from the
  // one it replaces, so a V2 Rewards token, a hook mode one and the reward swap's route stay
  // exactly as they are, and no code holder is deployed again.
  const current = {
    standard: await tokenFactory.standardDeployer(),
    tax: await tokenFactory.taxDeployer(),
    rewards: await tokenFactory.rewardsDeployer(),
  };
  const liveRewards = await hre.ethers.getContractAt("RewardsTokenDeployerV4", current.rewards);
  const [factoryOf, v3Router, v3Quoter, rewardsCodeV2, rewardsCodeV4, launcherOf] = await Promise.all([
    liveRewards.factory(),
    liveRewards.v3Router(),
    liveRewards.v3Quoter(),
    liveRewards.rewardsTokenCode(),
    liveRewards.rewardsTokenCodeV4(),
    liveRewards.launcher(),
  ]).catch(() => {
    throw new Error(`the rewards deployer ${current.rewards} is not of the v4 generation: run scripts/deploy-v4.js first`);
  });
  if (!same(factoryOf, d.tokenFactory) || !same(launcherOf, d.v4Launcher)) {
    throw new Error(`the current rewards deployer ${current.rewards} does not belong to this deployment`);
  }

  // -------------------------------------------------------------- launcher

  let launcherAddress = await known("V4_FEE_LAUNCHER", "v4FeeLauncher", "V4FeeLauncher");
  if (!launcherAddress) {
    const deployed = await hre.ethers.deployContract(
      "V4FeeLauncher",
      [deployer.address, v4.poolManager, v4.positionManager, v4.permit2, d.tokenFactory, d.presaleFactory, d.treasury],
      deployer
    );
    await deployed.waitForDeployment();
    launcherAddress = deployed.target;
    // The launcher's first block: where the site starts reading its TaxConfigUpdated events
    const receipt = await deployed.deploymentTransaction().wait();
    save({ v4FeeLauncher: launcherAddress, v4FeeFromBlock: receipt.blockNumber });
    console.log(`V4FeeLauncher: deployed ${launcherAddress} (block ${receipt.blockNumber})`);
  } else if (!same(d.v4FeeLauncher, launcherAddress)) {
    overridden.v4FeeLauncher = launcherAddress;
    if (d.v4FeeLauncher && d.v4FeeFromBlock !== undefined) {
      console.log(`Note: v4FeeFromBlock ${d.v4FeeFromBlock} belongs to ${d.v4FeeLauncher}; correct it by hand to the deployment block of ${launcherAddress}`);
    }
  }
  const launcher = await hre.ethers.getContractAt("V4FeeLauncher", launcherAddress, deployer);
  if (d.v4FeeFromBlock === undefined) {
    console.log("Note: v4FeeFromBlock is not recorded; put the launcher's deployment block into the deployments file by hand");
  }
  if (same(launcherAddress, d.v4Launcher)) throw new Error("the fee launcher and the hook mode launcher are the same address");
  // setHook, setLens and setKeeper are the owner's; a step that is already in place asks nothing.
  const requireLauncherOwner = async (step) => {
    const owner = await launcher.owner();
    if (!same(owner, deployer.address)) throw new Error(`${step} needs the owner of V4FeeLauncher, which is ${owner}`);
  };

  // ------------------------------------------------------------------ hook

  let hookAddress = await known("V4_FEE_HOOK", "v4FeeHook", "HoodSaleV4FeeHook");
  if (!hookAddress) {
    // The address carries the hook's permissions, so it has to be mined before it can be deployed.
    const initcode = await feeHookInitcode(hre, v4.poolManager, v4.positionManager, launcherAddress, d.treasury);
    console.log("Mining a hook address that carries the two gate bits...");
    const mined = mineHookSalt(hre.ethers, initcode, FEE_HOOK_FLAGS, { reject: rejectHookAddress });
    console.log(`  found ${mined.address} after ${mined.tried} tries`);
    // The same launcher always mines the same address, so a run that stopped between the deploy
    // and the save finds its hook already there.
    if ((await hre.ethers.provider.getCode(mined.address)) === "0x") {
      const result = await deployWithCreate2(hre, deployer, initcode, mined.salt, mined.address);
      console.log(`HoodSaleV4FeeHook: deployed ${mined.address} (${result.gasUsed} gas)`);
    } else {
      console.log(`HoodSaleV4FeeHook: already at ${mined.address}`);
    }
    hookAddress = mined.address;
    save({ v4FeeHook: hookAddress, v4FeeHookSalt: mined.salt });
  } else if (!same(d.v4FeeHook, hookAddress)) {
    overridden.v4FeeHook = hookAddress;
  }
  const hook = await hre.ethers.getContractAt("HoodSaleV4FeeHook", hookAddress, deployer);
  if ((BigInt(hookAddress) & BigInt(ALL_HOOK_MASK)) !== BigInt(FEE_HOOK_FLAGS)) {
    throw new Error(`hook ${hookAddress} does not carry the permission bits 0x${FEE_HOOK_FLAGS.toString(16)}`);
  }
  if (!same(await hook.launcher(), launcherAddress)) throw new Error("the hook names a different launcher");

  const wiredHook = await launcher.hook();
  if (wiredHook === hre.ethers.ZeroAddress) {
    await requireLauncherOwner("setHook");
    await (await launcher.setHook(hookAddress)).wait();
    console.log("V4FeeLauncher: hook set");
  } else if (!same(wiredHook, hookAddress)) {
    throw new Error(`the launcher already points at hook ${wiredHook}, and its hook can be set only once`);
  }

  // ------------------------------------------------------------ lens, router

  // The same lens and router contracts as hook mode; each instance reads one launcher.
  let lensAddress = await known("V4_FEE_LENS", "v4FeeLens", "HoodSaleV4Lens (fee mode)");
  if (!lensAddress) {
    const deployed = await hre.ethers.deployContract("HoodSaleV4Lens", [launcherAddress, v4.stateView], deployer);
    await deployed.waitForDeployment();
    lensAddress = deployed.target;
    save({ v4FeeLens: lensAddress });
    console.log(`HoodSaleV4Lens (fee mode): deployed ${lensAddress}`);
  } else if (!same(d.v4FeeLens, lensAddress)) {
    overridden.v4FeeLens = lensAddress;
  }
  const v4FeeLens = await hre.ethers.getContractAt("HoodSaleV4Lens", lensAddress, deployer);
  // A lens fixes its launcher and hook when it is built; setLens refuses any other (BadLens).
  if (!same(await v4FeeLens.launcher(), launcherAddress) || !same(await v4FeeLens.hook(), hookAddress)) {
    throw new Error(`lens ${lensAddress} reads another launcher or hook: remove it to deploy a fresh one`);
  }
  if (!same(await launcher.lens(), lensAddress)) {
    await requireLauncherOwner("setLens");
    await (await launcher.setLens(lensAddress)).wait();
    console.log("V4FeeLauncher: lens set");
  }

  let routerAddress = await known("V4_FEE_ROUTER", "v4FeeRouter", "HoodSaleV4Router (fee mode)");
  if (!routerAddress) {
    const deployed = await hre.ethers.deployContract("HoodSaleV4Router", [v4.poolManager, launcherAddress], deployer);
    await deployed.waitForDeployment();
    routerAddress = deployed.target;
    save({ v4FeeRouter: routerAddress });
    console.log(`HoodSaleV4Router (fee mode): deployed ${routerAddress}`);
  } else if (!same(d.v4FeeRouter, routerAddress)) {
    overridden.v4FeeRouter = routerAddress;
  }
  const router = await hre.ethers.getContractAt("HoodSaleV4Router", routerAddress, deployer);
  if (!same(await router.launcher(), launcherAddress)) {
    throw new Error(`router ${routerAddress} trades another launcher's pools: remove it to deploy a fresh one`);
  }

  // ---------------------------------------------------------------- keeper

  // The same wallet as hook mode: it runs the reward distributions of both launchers.
  if (!same(await launcher.keeper(), keeper)) {
    await requireLauncherOwner("setKeeper");
    await (await launcher.setKeeper(keeper)).wait();
    console.log(`V4FeeLauncher: keeper set to ${keeper}`);
  }

  // ------------------------------------------------------------- deployers

  // All three answer the same getters, so the wiring alone cannot tell a Tax deployer from a
  // Standard one: what tells them apart is the simulated creation in the check below.
  const feeDeployers = {};
  for (const [slot, key, name, args] of [
    ["standard", "v4FeeStandardDeployer", "StandardTokenDeployerFee", [d.tokenFactory, d.v4Launcher, launcherAddress]],
    ["tax", "v4FeeTaxDeployer", "TaxTokenDeployerFee", [d.tokenFactory, d.v4Launcher, launcherAddress]],
    [
      "rewards",
      "v4FeeRewardsDeployer",
      "RewardsTokenDeployerFee",
      [d.tokenFactory, v3Router, v3Quoter, rewardsCodeV2, rewardsCodeV4, d.v4Launcher, launcherAddress],
    ],
  ]) {
    let address = await known(`V4_FEE_${slot.toUpperCase()}_DEPLOYER`, key, name);
    if (!address) {
      const deployed = await hre.ethers.deployContract(name, args, deployer);
      await deployed.waitForDeployment();
      address = deployed.target;
      save({ [key]: address });
      console.log(`${name}: deployed ${address}`);
    } else if (!same(d[key], address)) {
      overridden[key] = address;
    }
    feeDeployers[slot] = await hre.ethers.getContractAt(name, address, deployer);
  }
  console.log(`  RewardsTokenCode ${rewardsCodeV2} and RewardsTokenCodeV4 ${rewardsCodeV4} are kept, read from ${current.rewards}`);

  // ---------------------------------------------------------------- checks

  // What TokenFactory hands every deployer with a creation, for the simulations below
  const dexRouterAddress = await tokenFactory.router();
  const dexRouter = new hre.ethers.Contract(dexRouterAddress, ["function WETH() view returns (address)"], hre.ethers.provider);
  const weth = await dexRouter.WETH();
  const factoryTreasury = await tokenFactory.treasury();
  const platformTaxBps = await tokenFactory.platformTaxBps();
  const spec = { name: "Fee Mode Check", symbol: "CHECK", totalSupply: hre.ethers.parseEther("1000000"), rewardToken: weth };
  const deployArgs = (slot, creator) => {
    const base = [spec.name, spec.symbol, spec.totalSupply, creator, factoryTreasury, dexRouterAddress, platformTaxBps];
    if (slot === "tax") return [...base, deployer.address, 200, 200];
    if (slot === "rewards") return [...base, weth, deployer.address, [200, 200, 100, 100]];
    return base;
  };

  const report = (title, checks) => {
    console.log(`\n${title}`);
    for (const [what, ok, reason] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${!ok && reason ? ` (${reason})` : ""}`);
  };

  // Run before TokenFactory is touched and again at the end. A failure before setDeployers leaves
  // the platform exactly as it was: nothing deployed so far is reachable from it.
  const checkWiring = async (title) => {
    const flags = BigInt(hookAddress) & BigInt(ALL_HOOK_MASK);
    const checks = [
      [`hook address carries the flags 0x${FEE_HOOK_FLAGS.toString(16)}`, flags === BigInt(FEE_HOOK_FLAGS)],
      ["hook names the fee launcher", same(await hook.launcher(), launcherAddress)],
      ["hook uses this PoolManager", same(await hook.poolManager(), v4.poolManager)],
      ["hook uses this PositionManager", same(await hook.positionManager(), v4.positionManager)],
      ["hook pays the platform Treasury", same(await hook.platformTreasury(), d.treasury)],
      ["launcher points at the hook", same(await launcher.hook(), hookAddress)],
      ["launcher points at the lens", same(await launcher.lens(), lensAddress)],
      ["launcher has the keeper of hook mode", same(await launcher.keeper(), keeper) && keeper !== hre.ethers.ZeroAddress],
      ["launcher creates through this TokenFactory", same(await launcher.tokenFactory(), d.tokenFactory)],
      ["launcher serves this PresaleFactory", same(await launcher.presaleFactory(), d.presaleFactory)],
      ["lens reads the fee launcher", same(await v4FeeLens.launcher(), launcherAddress)],
      ["lens reads the fee hook", same(await v4FeeLens.hook(), hookAddress)],
      ["router uses the fee launcher", same(await router.launcher(), launcherAddress)],
    ];
    // A deployer can come through the environment, so a getter it does not have is a FAIL line
    // here, not an exception out of the check
    const ask = (getter) => readOrNull(getter, retry);
    for (const [slot, c] of Object.entries(feeDeployers)) {
      checks.push([`${slot} deployer belongs to this TokenFactory`, same(await ask(() => c.factory()), d.tokenFactory)]);
      checks.push([`${slot} deployer names the live V4Launcher`, same(await ask(() => c.launcher()), d.v4Launcher)]);
      checks.push([`${slot} deployer names the fee launcher`, same(await ask(() => c.feeLauncher()), launcherAddress)]);
    }
    const r = feeDeployers.rewards;
    checks.push([
      "rewards deployer keeps the live V3 router, quoter and both code holders",
      same(await ask(() => r.v3Router()), v3Router) &&
        same(await ask(() => r.v3Quoter()), v3Quoter) &&
        same(await ask(() => r.rewardsTokenCode()), rewardsCodeV2) &&
        same(await ask(() => r.rewardsTokenCodeV4()), rewardsCodeV4),
    ]);
    // The three deployers answer the same getters, so only a creation tells a Tax deployer from a
    // Standard one. Each is asked for a token of its own type the way TokenFactory asks, in an
    // eth_call from the factory's address (the contract is bound to the provider for it: a signer
    // refuses a foreign sender). A deployer of another type has no such function and reverts.
    // Nothing is sent, and this runs before setDeployers, the one step that cannot be taken back.
    for (const [slot, c] of Object.entries(feeDeployers)) {
      const asFactory = c.connect(hre.ethers.provider);
      for (const [who, creator] of [
        ["the fee launcher", launcherAddress],
        ["the hook mode launcher", d.v4Launcher],
        ["a wallet", deployer.address],
      ]) {
        const reason = await simulate(
          () => asFactory.deploy.staticCall(...deployArgs(slot, creator), { from: d.tokenFactory }),
          c.interface,
          retry
        );
        const hint = "a deployer of another type in this slot has no such function";
        checks.push([`${slot} deployer builds its token for ${who}, asked as TokenFactory`, reason === null, `${reason}; ${hint}`]);
      }
    }
    for (const [what, address] of [
      ["V4FeeLauncher", launcherAddress],
      ["HoodSaleV4FeeHook", hookAddress],
      ["HoodSaleV4Lens", lensAddress],
      ["HoodSaleV4Router", routerAddress],
      ["StandardTokenDeployerFee", feeDeployers.standard.target],
      ["TaxTokenDeployerFee", feeDeployers.tax.target],
      ["RewardsTokenDeployerFee", feeDeployers.rewards.target],
    ]) {
      const size = await codeSize(address);
      checks.push([`${what} runtime code is ${size} bytes, within ${MAX_CODE_SIZE}`, size > 0 && size <= MAX_CODE_SIZE]);
    }
    report(title, checks);
    console.log(`  note V4FeeLauncher.creationOpen() is ${await launcher.creationOpen()}`);
    if (checks.some(([, ok]) => !ok)) throw new Error("wiring check failed");
  };
  const fee = {
    standard: feeDeployers.standard.target,
    tax: feeDeployers.tax.target,
    rewards: feeDeployers.rewards.target,
  };
  const inUse = same(current.standard, fee.standard) && same(current.tax, fee.tax) && same(current.rewards, fee.rewards);
  await checkWiring(inUse ? "Wiring, with the Fee deployers already in use" : "Wiring, before TokenFactory.setDeployers");
  // Only now is an address that came through the environment written down
  if (Object.keys(overridden).length > 0) save(overridden);

  // ------------------------------------------------------- the creation brake

  // V4FeeLauncher.setCreationOpen is the owner's brake on createToken, open from deployment. It
  // never touches a launch: a token that exists still opens its pool with the brake on.
  const brake = (open) => {
    console.log(`  to:    ${launcherAddress} (V4FeeLauncher)`);
    console.log(`  call:  setCreationOpen(${open})`);
    console.log(`  data:  ${launcher.interface.encodeFunctionData("setCreationOpen", [open])}`);
  };
  if (closeCreation && (await launcher.creationOpen())) {
    await requireLauncherOwner("setCreationOpen");
    await (await launcher.setCreationOpen(false)).wait();
    console.log("\nV4FeeLauncher: creation closed (CLOSE_CREATION). createToken reverts CreationClosed until it is opened:");
    brake(true);
  }

  // ---------------------------------------------------------- setDeployers

  const slots = ["Standard", "Tax", "Rewards"];
  const rollbackOf = (from) => `setDeployers(${from.standard}, ${from.tax}, ${from.rewards})`;
  /** True when all three are deployers of the V4 generation of this deployment: what a rollback needs. */
  const isV4Generation = async (from) => {
    for (const slot of slots) {
      const g = await generationOf(from[slot.toLowerCase()], retry);
      if (g.generation !== "V4" || !same(g.launcher, d.v4Launcher)) return false;
    }
    return true;
  };
  /**
   * Records `from`, the deployers the Fee generation replaces, as the rollback target under
   * previous*. What previous* named before moves to deployersBeforeV4, once, each with the
   * generation it answers to: on a deployment whose rewards deployer was replaced after v4 shipped
   * (scripts/deploy-v4-fixes.js), that slot holds an earlier V4 deployer, not one from before v4.
   */
  const recordRollback = async (from) => {
    const before = {};
    const generation = {};
    for (const slot of slots) {
      const key = slot.toLowerCase();
      const was = d[`previous${slot}Deployer`];
      if (!was || same(was, from[key])) continue;
      before[key] = was;
      const g = await generationOf(was, retry);
      generation[key] =
        g.generation === "V2"
          ? "V2 only, from before v4"
          : g.generation === "none"
            ? "no code at this address"
            : `${g.generation} generation, superseded: it names the launcher ${g.launcher}`;
    }
    const moved = !d.deployersBeforeV4 && Object.keys(before).length > 0;
    save({
      ...(moved ? { deployersBeforeV4: before, deployersBeforeV4Generation: generation } : {}),
      previousStandardDeployer: from.standard,
      previousTaxDeployer: from.tax,
      previousRewardsDeployer: from.rewards,
    });
    if (moved) {
      console.log("\nRecord: what previous* named until now is kept under deployersBeforeV4");
      for (const [key, was] of Object.entries(before)) console.log(`  ${key.padEnd(8)} ${was}  ${generation[key]}`);
    }
  };

  let sent = false;
  // False only when nothing in the record names the V4 generation the Fee deployers replace
  let rollbackKnown = true;
  const recorded = { standard: d.previousStandardDeployer, tax: d.previousTaxDeployer, rewards: d.previousRewardsDeployer };
  if (inUse) {
    console.log("\nTokenFactory: already uses the Fee deployers");
    // setDeployers may have been sent by hand, or by a run of an earlier version of this script
    // that stopped before it recorded anything: the record is brought up to date before its last
    // mention of the V4 generation is overwritten below.
    const replaced = { standard: d.standardDeployer, tax: d.taxDeployer, rewards: d.rewardsDeployer };
    if (await isV4Generation(recorded)) {
      console.log(`  rollback: ${rollbackOf(recorded)}`);
    } else if (await isV4Generation(replaced)) {
      await recordRollback(replaced);
      console.log(`  rollback: ${rollbackOf(replaced)}   (recorded now, from the deployers the record still named)`);
    } else {
      rollbackKnown = false;
      console.log("  WARNING: the record names no rollback target. previous*Deployer should be the three V4 generation");
      console.log(`  deployers TokenFactory used before the swap (each answers launcher() = ${d.v4Launcher} and has no`);
      console.log(`  feeLauncher()). Find them and put them into ${path.basename(file)} by hand before they are needed.`);
    }
  } else {
    // The rollback target is recorded before the swap, whoever sends it: it survives a run that
    // stops right after, and a setDeployers the owner sends by hand. Only the V4 generation is
    // one: a factory that names anything else (a mix left by a setDeployers sent by hand) is
    // replaced all the same, but it is not written over what the record names.
    const currentIsTarget = await isV4Generation(current);
    if (currentIsTarget) {
      await recordRollback(current);
    } else {
      rollbackKnown = await isV4Generation(recorded);
      console.log("\nWARNING: TokenFactory's three deployers are not all of the V4 generation of this deployment (each answering");
      console.log(`launcher() = ${d.v4Launcher} and no feeLauncher()), so they are not recorded as the rollback target:`);
      console.log(`  ${rollbackOf(current)}`);
      console.log(`previous* in ${path.basename(file)} is left as it is${rollbackKnown ? ", and it names the V4 generation" : ""}.`);
    }
    if (skipSetDeployers) {
      const data = tokenFactory.interface.encodeFunctionData("setDeployers", [fee.standard, fee.tax, fee.rewards]);
      console.log("\nTokenFactory.setDeployers: not sent (SKIP_SET_DEPLOYERS). Fee mode stays off until it is.");
      console.log(`  to:    ${d.tokenFactory} (TokenFactory, owner ${factoryOwner})`);
      console.log(`  call:  ${rollbackOf(fee)}`);
      console.log(`  data:  ${data}`);
      console.log(`  now:   ${rollbackOf(current)}${currentIsTarget ? "   (the rollback, recorded as previous*)" : "   (not the V4 generation: see the warning above)"}`);
      console.log("Run this script again without SKIP_SET_DEPLOYERS to send it; every step above is skipped.");
      console.log("\nWARNING: the moment setDeployers lands, V4FeeLauncher.createToken is open to every caller, while the");
      console.log("released site still reads a fee mode sale through the hook mode contracts. Run the sending step with");
      console.log("CLOSE_CREATION=1 and follow docs/FEE-MODE-RELEASE.md, which opens creation after the site release.");
      console.log(`\nRecorded in ${recordedIn}`);
      return { sent: false, deployments: d };
    }
    await (await tokenFactory.setDeployers(fee.standard, fee.tax, fee.rewards)).wait();
    sent = true;
    console.log(`\nTokenFactory: deployers set to standard ${fee.standard}, tax ${fee.tax}, rewards ${fee.rewards}`);
    if (currentIsTarget) console.log(`  rollback: ${rollbackOf(current)}`);
  }
  save({ standardDeployer: fee.standard, taxDeployer: fee.tax, rewardsDeployer: fee.rewards });
  console.log(`Recorded in ${recordedIn}`);
  const rollback = rollbackKnown
    ? rollbackOf({ standard: d.previousStandardDeployer, tax: d.previousTaxDeployer, rewards: d.previousRewardsDeployer })
    : "setDeployers with the three V4 generation deployers, which the record does not name (see the warning above)";

  // ----------------------------------------------------------- final check

  // From here on TokenFactory names the Fee deployers and the record says so. A failure below
  // stops the run, but there is nothing left to resume: a rerun repeats only these checks.
  let open = null; // V4FeeLauncher.creationOpen(), once it has been read below
  const afterSwap = (what) =>
    new Error(
      `${what}. TokenFactory.setDeployers has landed and is recorded; running this script again repeats only the checks. ` +
        (open ? "Fee mode creation is open: CLOSE_CREATION=1 with this script closes it. " : "") +
        `If the platform must go back to the V4 generation, the owner sends TokenFactory.${rollback}`
    );
  try {
    await checkWiring("Wiring");
  } catch (e) {
    throw afterSwap(e.message);
  }
  const live = [
    ["token factory builds with the standard Fee deployer", same(await tokenFactory.standardDeployer(), fee.standard)],
    ["token factory builds with the tax Fee deployer", same(await tokenFactory.taxDeployer(), fee.tax)],
    ["token factory builds with the rewards Fee deployer", same(await tokenFactory.rewardsDeployer(), fee.rewards)],
  ];
  // Nothing is sent: each creation is only simulated, from the deployer's own address. A Rewards
  // token also proves the token takes its rewards from the fee hook (HookNotFunder otherwise).
  const cfg = (marketingBps, rewardsBps) => ({
    marketingWallet: deployer.address,
    marketingBuyBps: marketingBps,
    marketingSellBps: marketingBps,
    rewardsBuyBps: rewardsBps,
    rewardsSellBps: rewardsBps,
    taxLocked: true,
    walletLocked: false,
  });
  const types = [
    ["Standard", 0, cfg(0, 0)],
    ["Tax", 1, cfg(200, 0)],
    ["Rewards", 2, cfg(100, 200)],
  ];
  for (const [name, tokenType, config] of types) {
    const reason = await simulate(() => hookLauncher.createToken.staticCall(tokenType, spec, config, deployer.address), hookLauncher.interface, retry);
    live.push([`hook mode launcher can still create a ${name} token`, reason === null, reason]);
  }
  const v2Reason = await simulate(
    () => tokenFactory.createStandardToken.staticCall(spec.name, spec.symbol, spec.totalSupply),
    tokenFactory.interface,
    retry
  );
  live.push(["an ordinary creator still gets a V2 token", v2Reason === null, v2Reason]);

  // Opening creation is the release's last step, so it waits for everything that can be checked
  // with the brake on; the fee launcher's own creations are simulated right after it.
  open = await launcher.creationOpen();
  if (openCreation && !open && live.every(([, ok]) => ok)) {
    await requireLauncherOwner("setCreationOpen");
    await (await launcher.setCreationOpen(true)).wait();
    open = true;
    console.log("\nV4FeeLauncher: creation opened (OPEN_CREATION). The brake, should it be needed again:");
    brake(false);
  }
  if (open) {
    for (const [name, tokenType, config] of types) {
      const reason = await simulate(() => launcher.createToken.staticCall(tokenType, spec, config, deployer.address), launcher.interface, retry);
      live.push([`fee launcher can create a ${name} token`, reason === null, reason]);
    }
  }
  report("Token creation", live);
  if (!open) {
    console.log("  note fee launcher creation is closed, so its three creations were not simulated here; each Fee");
    console.log("       deployer built a fee mode token in the wiring check above. OPEN_CREATION=1 opens it and simulates them.");
  }
  if (live.some(([, ok]) => !ok)) throw afterSwap("token creation check failed (the reasons are next to each FAIL above)");

  if (rollbackKnown) {
    console.log("\nRollback, should it ever be needed. The owner of TokenFactory sends:");
    console.log(`  to:    ${d.tokenFactory} (TokenFactory)`);
    console.log(`  call:  ${rollback}`);
    console.log(`  data:  ${tokenFactory.interface.encodeFunctionData("setDeployers", [d.previousStandardDeployer, d.previousTaxDeployer, d.previousRewardsDeployer])}`);
    console.log("  Creating a fee mode token then reverts NotFeeToken; fee mode tokens and sales that exist keep working.");
  } else {
    console.log("\nWARNING: no rollback call can be printed, because the record names no rollback target (see above).");
  }
  if (mirrored) {
    // A dev chain has no release: the local site reads the record itself
    console.log("\nThe local site reads these addresses from frontend/src/config/localhost.json.");
    console.log("scripts/test-v4-fee-launch.js --network localhost makes a fee mode launch with data in it.");
    return { sent, deployments: d };
  }
  if (open) {
    console.log("\nWARNING: V4FeeLauncher.createToken is open to every caller. Until the released site carries these addresses");
    console.log("in frontend/src/config/v4.js it reads a fee mode sale through the hook mode contracts: for a Lock sale its");
    console.log("lock card would show V4PositionLocker lock 0, which is another sale's lock, and its trade box would revert.");
    console.log("To keep the public out until the site is released (the brake never touches a launch):");
    brake(false);
    console.log("  or run this script again with CLOSE_CREATION=1. To open it again:");
    brake(true);
  } else {
    console.log("\nFee mode creation is closed. To open it, as the last step of the release:");
    brake(true);
    console.log("  or run this script again with OPEN_CREATION=1.");
  }

  console.log("\nNext, in this order (docs/FEE-MODE-RELEASE.md has every command)");
  console.log("  1. verify V4FeeLauncher, HoodSaleV4FeeHook, the second lens and router and the three Fee deployers on");
  console.log("     Sourcify (scripts/verify-platform.js). The Trust page marks them verified as soon as it has their addresses");
  console.log("  2. rehearse one sale with scripts/test-v4-fee-launch.js and trade it in the Uniswap app");
  console.log("  3. update the keeper on the server, so it collects, converts and flushes fee mode pools. It reads");
  console.log(`     v4FeeLauncher, v4FeeHook and v4Quoter from its own deployments/${network}.json`);
  console.log("  4. frontend/src/config/v4.js, the fee entry of this chain:");
  console.log(`       launcher '${launcherAddress}', hook '${hookAddress}',`);
  console.log(`       lens '${lensAddress}', router '${routerAddress}',`);
  console.log(`       fromBlock ${d.v4FeeFromBlock === undefined ? "<the launcher's deployment block>" : d.v4FeeFromBlock}n   (a bigint: without it the site reads the launcher's logs from block 0)`);
  console.log("  5. frontend/src/config/contracts.js, MAINNET_EXTRA and the three deployer rows, which TokenFactory no longer uses:");
  console.log(`       standardDeployer '${fee.standard}'   row name StandardTokenDeployerFee`);
  console.log(`       taxDeployer      '${fee.tax}'   row name TaxTokenDeployerFee`);
  console.log(`       rewardsDeployer  '${fee.rewards}'   row name RewardsTokenDeployerFee`);
  console.log("     and OFFLINE_TEST_COUNT, to what npx hardhat test counts with the fee mode suites");
  console.log("  6. hide the rehearsal sale in frontend/src/config/hidden.js, release the site");
  console.log(`  7. ${open ? "creation is already open: nothing more to send" : "open creation: OPEN_CREATION=1 with this script, or the setCreationOpen(true) call above"}`);
  return { sent, deployments: d };
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
