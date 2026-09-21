// Points the platform at a new launch keeper wallet (the wallet the keeper service runs with).
// Used to rotate the keeper wallet: the old one keeps nothing but its gas money.
//
//   DEPLOYER_KEY=0x... ROBINHOOD_RPC=... LAUNCH_KEEPER=0xNewWallet npx hardhat run scripts/set-launch-keeper.js --network robinhood
//
// The wallet is named in up to three places: the PresaleFactory's launchKeeper (scheduled launches
// and quick reward distributions), and keeper() of each Uniswap v4 launcher the deployments file
// has, v4Launcher for hook mode and v4FeeLauncher for fee mode (the payouts of their Rewards
// tokens). A contract that already names the new wallet is left alone, so the script can be run
// again after a launcher was added or a run stopped half way. A run that finishes a rotation an
// earlier run began (the factory changed, then a launcher failed) still records the new keeper
// in the deployments file and prints the steps below: the record follows the chain, not only
// what this run sent.
//
// The signer must own the PresaleFactory and every launcher whose keeper changes; this is checked
// before anything is sent. After it, put the new wallet's private key into the keeper service's
// environment (/etc/hoodsale/keeper.env on the server) and restart the service; send the old
// wallet's ETH to the new one for gas.
const fs = require("fs");
const path = require("path");

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Sets `next` as the keeper on the PresaleFactory and on the v4 launchers of `deployments`.
 * Returns { previousLaunchKeeper, changed: [{ name, address, previous, hash }] }; `changed` is
 * empty when every contract names `next` already.
 * @param options { deployments, next, signer, log }
 */
async function setLaunchKeeper(hre, options) {
  const { deployments: d, next, signer } = options;
  const log = options.log || console.log;
  if (!d.presaleFactory) throw new Error("deployments file has no presaleFactory");
  if (!next || !hre.ethers.isAddress(next)) throw new Error("set LAUNCH_KEEPER to the new keeper wallet address");

  const targets = [{ name: "PresaleFactory", address: d.presaleFactory, label: "launch keeper", getter: "launchKeeper", setter: "setLaunchKeeper" }];
  for (const [key, name] of [["v4Launcher", "V4Launcher"], ["v4FeeLauncher", "V4FeeLauncher"]]) {
    if (d[key]) targets.push({ name, address: d[key], label: "keeper       ", getter: "keeper", setter: "setKeeper" });
  }
  for (const t of targets) {
    t.contract = await hre.ethers.getContractAt(t.name, t.address, signer);
    t.current = await t.contract[t.getter]();
    t.owner = await t.contract.owner();
    log(`${t.name} ${t.address}`);
    log(`  ${t.label}  ${t.current}`);
  }
  const [presaleFactory] = targets;
  // Every owner is checked before the first send: a rotation never stops half way on a wallet
  // that could not have finished it
  for (const t of targets) {
    if ((t === presaleFactory || !same(t.current, next)) && !same(t.owner, signer.address)) {
      throw new Error(`the signer must own ${t.name} (owner is ${t.owner}, signer is ${signer.address})`);
    }
  }

  const changed = [];
  for (const t of targets) {
    if (same(t.current, next)) continue;
    const tx = await t.contract[t.setter](next);
    log(`${t.name}.${t.setter}(${next}) sent ${tx.hash}`);
    await tx.wait();
    log(`  ${t.label}  ${await t.contract[t.getter]()} (now)`);
    changed.push({ name: t.name, address: t.address, previous: t.current, hash: tx.hash });
  }
  if (changed.length === 0) log("Nothing to change.");
  return { previousLaunchKeeper: presaleFactory.current, changed };
}

/**
 * What the deployments file should say after setLaunchKeeper has run, when every contract names
 * `next`. The file records the factory's keeper; a launcher's is always read from the chain.
 * Returns { addresses, previous, rotated }:
 *   addresses  the file's new content, or null when it names `next` already and the factory was
 *              not changed by this run
 *   previous   the wallet that was rotated out, or null: the factory's old keeper when this run
 *              changed it; when an earlier run did and stopped before it could record it, the
 *              wallet the file still names, or without such a record the one a launcher named
 *              until this run
 *   rotated    whether the keeper service has a new wallet to be given, by this run or by one it
 *              finished. A launcher merely brought in line with a factory the file agrees with
 *              rotates nothing.
 * @param d the deployments file as read before the run
 * @param result what setLaunchKeeper returned
 */
function rotationRecord(d, next, result) {
  const { previousLaunchKeeper, changed } = result;
  const factoryChanged = changed.some((c) => c.name === "PresaleFactory");
  const fileNamesNext = Boolean(d.launchKeeper) && same(d.launchKeeper, next);
  const fileNamesAnother = Boolean(d.launchKeeper) && !fileNamesNext;
  const resumed = !factoryChanged && (fileNamesAnother || (!d.launchKeeper && changed.length > 0));

  let previous = null;
  if (factoryChanged) previous = previousLaunchKeeper;
  else if (fileNamesAnother) previous = d.launchKeeper;
  else if (resumed) previous = changed[0].previous;
  if (previous && (same(previous, next) || same(previous, ZERO_ADDRESS))) previous = null;

  const addresses = fileNamesNext && !factoryChanged ? null : { ...d, launchKeeper: next };
  if (addresses && previous) addresses.previousLaunchKeeper = previous;
  return { addresses, previous, rotated: factoryChanged || resumed };
}

async function main() {
  const hre = require("hardhat");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const next = process.env.LAUNCH_KEEPER;

  const [signer] = await hre.ethers.getSigners();
  console.log(`Launch keeper on ${network}`);
  const result = await setLaunchKeeper(hre, { deployments: d, next, signer });
  // The record follows the chain: a run that only finished what an earlier one began (the factory
  // in line already, a launcher changed now) still writes it and still prints the steps.
  const { addresses, previous, rotated } = rotationRecord(d, next, result);
  if (addresses) {
    fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
    console.log(`Saved to deployments/${network}.json`);
  }
  if (!rotated) {
    // Every contract named the wallet already and the file had no record of it. That is also what
    // is left of a run whose last transaction was mined but never confirmed to it, so the step
    // is still named.
    if (addresses) console.log("The contracts named this wallet already, only the record was missing. If the keeper service runs with another wallet, put this one's private key into the service environment and restart it.");
    return;
  }
  console.log("Next: make sure the keeper service runs with the new wallet: put its private key into the service environment and restart it.");
  if (previous) {
    console.log(`Send the old wallet's ETH (${previous}, ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(previous))} ETH) to the new one for gas.`);
  }
}

module.exports = { main, setLaunchKeeper, rotationRecord };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
