// Replaces the three token deployers of an existing deployment with the owner-locks generation:
// every token created afterwards carries lock() (one-way locks of the project tax rates, the tax
// wallet and the owner's fee-exempt list, or a renounce that locks everything and records the
// renouncer) and RewardsToken's creation code lives in its own RewardsTokenCode contract, which
// keeps the rewards deployer under the 24KB limit. TokenFactory itself does not move:
// setDeployers swaps the deployers, tokens created before keep their old code.
//
// The key is read without an echo, so it reaches neither the screen nor the shell history:
//
//   cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && npx hardhat run scripts/deploy-token-deployers.js --network robinhood
//
// Optional environment:
//   STANDARD_DEPLOYER=0x...  reuse an already deployed new StandardTokenDeployer
//   TAX_DEPLOYER=0x...       reuse an already deployed new TaxTokenDeployer
//   REWARDS_TOKEN_CODE=0x... reuse an already deployed RewardsTokenCode
//   REWARDS_DEPLOYER=0x...   reuse an already deployed new RewardsTokenDeployer (must point at
//                            this deployment's TokenFactory, the chain's V3 router and quoter and
//                            the RewardsTokenCode above)
//   REPLACE_V4_DEPLOYERS=1   go on although TokenFactory uses deployers that know a v4 launcher
//
// The deployers built here are V2 only. On a platform with a Uniswap v4 mode the factory's
// deployers also build the plain token a v4 launcher asks for (the V4 generation of
// scripts/deploy-v4.js, the Fee generation of scripts/deploy-v4-fee.js); replacing them with these
// would hand every v4 launch a V2 token and make fee mode creation revert NotFeeToken. The script
// therefore stops before it deploys or sends anything when a live deployer answers launcher().
//
// Safe to re-run: the wiring step is skipped when the factory already holds the deployers, and
// the reuse variables let a run that stopped half way continue without deploying twice. The
// deployments file gains standardDeployer, taxDeployer, rewardsDeployer, rewardsTokenCode (and
// v3Router, v3Quoter, v3Factory on a chain with Uniswap V3); the replaced contracts are kept under
// previousStandardDeployer, previousTaxDeployer and previousRewardsDeployer. Run
// scripts/deploy-registry.js afterwards: the registry of this generation lets the wallet that
// renounced a token keep its profile. Nothing here prints or stores a private key.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { v3For } = require("./lib/reward-tokens");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("no signer: set DEPLOYER_KEY");
  const network = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment file for ${network}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!d.tokenFactory) throw new Error(`deployments/${network}.json has no tokenFactory`);
  console.log(`Replacing the token deployers on ${network} with ${deployer.address}`);

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", d.tokenFactory);
  const owner = await tokenFactory.owner();
  if (!same(owner, deployer.address)) throw new Error(`the deployer must own TokenFactory (owner is ${owner})`);

  // The V3 leg of the rewards deployer: the chain's SwapRouter02 and QuoterV2, zero addresses on
  // a chain without Uniswap V3 (the tokens then swap rewards on V2 only)
  const v3 = await v3For(hre, d);
  let v3Router = hre.ethers.ZeroAddress;
  let v3Quoter = hre.ethers.ZeroAddress;
  let v3Factory = null;
  if (v3) {
    const routerFactory = await (await hre.ethers.getContractAt("IV3SwapRouter", v3.router)).factory();
    const quoterFactory = await (await hre.ethers.getContractAt("IQuoterV2", v3.quoter)).factory();
    if (!same(routerFactory, quoterFactory)) throw new Error(`V3 router factory ${routerFactory} and quoter factory ${quoterFactory} differ`);
    if (v3.factory && !same(routerFactory, v3.factory)) throw new Error(`V3 router factory ${routerFactory} is not the configured factory ${v3.factory}`);
    v3Router = v3.router;
    v3Quoter = v3.quoter;
    v3Factory = routerFactory;
    console.log(`Uniswap V3: factory ${v3Factory}, router ${v3Router}, quoter ${v3Quoter}`);
  } else {
    console.log("No Uniswap V3 addresses for this chain: the rewards deployer gets no V3 leg");
  }

  const [previousStandard, previousTax, previousRewards] = await Promise.all([
    tokenFactory.standardDeployer(),
    tokenFactory.taxDeployer(),
    tokenFactory.rewardsDeployer(),
  ]);
  console.log(`Current deployers: standard ${previousStandard}, tax ${previousTax}, rewards ${previousRewards}`);

  // The V4 and the Fee generation both answer launcher(); only the Fee generation feeLauncher()
  const answers = async (address, getter) => {
    if (address === hre.ethers.ZeroAddress) return false;
    const c = new hre.ethers.Contract(address, [`function ${getter}() view returns (address)`], hre.ethers.provider);
    try {
      await c[getter]();
      return true;
    } catch (e) {
      // A deployer without the getter reverts. Anything else (a dropped call) must not pass as a no.
      if (e.code === "CALL_EXCEPTION" || e.code === "BAD_DATA" || /revert/i.test(String(e.message))) return false;
      throw e;
    }
  };
  for (const [slot, address] of [["standard", previousStandard], ["tax", previousTax], ["rewards", previousRewards]]) {
    if (!(await answers(address, "launcher"))) continue;
    const generation = (await answers(address, "feeLauncher")) ? "Fee generation (scripts/deploy-v4-fee.js)" : "V4 generation (scripts/deploy-v4.js)";
    if (process.env.REPLACE_V4_DEPLOYERS === "1") {
      console.log(`WARNING: the ${slot} deployer ${address} is of the ${generation}; going on (REPLACE_V4_DEPLOYERS)`);
      continue;
    }
    throw new Error(
      `the live ${slot} deployer ${address} is of the ${generation}. This script would replace it with a V2 only deployer: ` +
        "a v4 launcher would be handed V2 tokens, and fee mode token creation would revert NotFeeToken. " +
        "Nothing was deployed or sent. REPLACE_V4_DEPLOYERS=1 goes on regardless."
    );
  }

  const deployOrReuse = async (envKey, name, args) => {
    if (process.env[envKey]) {
      const addr = process.env[envKey];
      if (!hre.ethers.isAddress(addr)) throw new Error(`${envKey} is not an address: ${addr}`);
      if ((await hre.ethers.provider.getCode(addr)) === "0x") throw new Error(`${envKey} has no code on ${network}: ${addr}`);
      console.log(`${name}: reusing ${addr}`);
      return hre.ethers.getContractAt(name, addr);
    }
    const c = await hre.ethers.deployContract(name, args);
    await c.waitForDeployment();
    console.log(`${name}: deployed ${c.target}`);
    return c;
  };

  const standardDeployer = await deployOrReuse("STANDARD_DEPLOYER", "StandardTokenDeployer", [d.tokenFactory]);
  const taxDeployer = await deployOrReuse("TAX_DEPLOYER", "TaxTokenDeployer", [d.tokenFactory]);
  const rewardsTokenCode = await deployOrReuse("REWARDS_TOKEN_CODE", "RewardsTokenCode", []);
  const rewardsDeployer = await deployOrReuse("REWARDS_DEPLOYER", "RewardsTokenDeployer", [
    d.tokenFactory,
    v3Router,
    v3Quoter,
    rewardsTokenCode.target,
  ]);
  for (const [name, c] of [["StandardTokenDeployer", standardDeployer], ["TaxTokenDeployer", taxDeployer], ["RewardsTokenDeployer", rewardsDeployer]]) {
    if (!same(await c.factory(), d.tokenFactory)) throw new Error(`${name} does not point at this deployment's TokenFactory`);
  }
  if (!same(await rewardsDeployer.v3Router(), v3Router)) throw new Error("RewardsTokenDeployer does not carry the chain's V3 router");
  if (!same(await rewardsDeployer.v3Quoter(), v3Quoter)) throw new Error("RewardsTokenDeployer does not carry the chain's V3 quoter");
  if (!same(await rewardsDeployer.rewardsTokenCode(), rewardsTokenCode.target)) throw new Error("RewardsTokenDeployer does not point at the RewardsTokenCode above");
  // The code holder must be the build of this generation: a token created from it has lock()
  const codeArtifact = await hre.artifacts.readArtifact("RewardsToken");
  const held = await rewardsTokenCode.creationCode();
  if (held.toLowerCase() !== codeArtifact.bytecode.toLowerCase()) throw new Error("RewardsTokenCode holds a different RewardsToken build than this checkout");

  const wanted = [standardDeployer.target, taxDeployer.target, rewardsDeployer.target];
  if (same(previousStandard, wanted[0]) && same(previousTax, wanted[1]) && same(previousRewards, wanted[2])) {
    console.log("tokenFactory.setDeployers: already set");
  } else {
    await (await tokenFactory.setDeployers(...wanted)).wait();
    console.log(`tokenFactory.setDeployers: standard ${wanted[0]}, tax ${wanted[1]}, rewards ${wanted[2]}`);
  }

  const addresses = { ...d };
  addresses.standardDeployer = standardDeployer.target;
  addresses.taxDeployer = taxDeployer.target;
  addresses.rewardsDeployer = rewardsDeployer.target;
  addresses.rewardsTokenCode = rewardsTokenCode.target;
  if (v3) {
    addresses.v3Router = v3Router;
    addresses.v3Quoter = v3Quoter;
    addresses.v3Factory = v3Factory;
  }
  const zero = hre.ethers.ZeroAddress;
  if (previousStandard !== zero && !same(previousStandard, standardDeployer.target)) addresses.previousStandardDeployer = previousStandard;
  if (previousTax !== zero && !same(previousTax, taxDeployer.target)) addresses.previousTaxDeployer = previousTax;
  if (previousRewards !== zero && !same(previousRewards, rewardsDeployer.target)) addresses.previousRewardsDeployer = previousRewards;
  fs.writeFileSync(file, JSON.stringify(addresses, null, 2));
  console.log(`Saved to deployments/${network}.json`);

  console.log("Done.");
  console.log(`  standardDeployer  ${standardDeployer.target}`);
  console.log(`  taxDeployer       ${taxDeployer.target}`);
  console.log(`  rewardsDeployer   ${rewardsDeployer.target}`);
  console.log(`  rewardsTokenCode  ${rewardsTokenCode.target}`);
  console.log("Next: run scripts/deploy-registry.js (the registry that keeps a renounced token's profile with");
  console.log("its renouncer, plus the QuickLaunch on top of it), then scripts/verify-platform.js and");
  console.log("scripts/check-deployment.js.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
