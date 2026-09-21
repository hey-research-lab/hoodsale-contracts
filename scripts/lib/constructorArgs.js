// Pure module that reconstructs constructor arguments from on-chain state.
// It does not depend on hre: it only takes an ethers v6 provider and an address.
//
//   const { reconstructConstructorArgs } = require("./lib/constructorArgs");
//   const r = await reconstructConstructorArgs(provider, address, { deployments });
//   // r = { contract: "contracts/tokens/TaxToken.sol:TaxToken", args: [...], kind, meta }
//
// Recognized contracts:
//   - TokenFactory tokens (Standard / Tax / Rewards, and the Uniswap v4 HoodSaleTokenV4 /
//     RewardsTokenV4 that the V4Launcher and the V4FeeLauncher create through the same factory)
//   - Presale contracts (PresaleFactory.isPresale)
//   - StandardTokenDeployer / TaxTokenDeployer / RewardsTokenDeployer, in their three generations
//     (V2 only, V4 with the hook mode launcher, Fee with both v4 launchers)
//   - Platform contracts: Treasury, LiquidityLocker, TokenFactory, PresaleFactory,
//     HoodSaleToken, HoodSaleLens, TokenMetadataRegistry, PresaleCode, QuickLaunch, and the
//     Uniswap v4 contracts of both modes (launcher, hook, lens, router; hook mode's locker)
//
// For mutable constructor values (taxes, marketing wallet, treasury/router/locker on the
// factories) the ORIGINAL value is looked up in this order:
//   1. creation-calldata : the TokenFactory.createXToken call of the transaction that created
//                          the token is decoded (exact if the tx went directly to the factory).
//   2. creation-tx       : for platform contracts, the init code tail of the deploy transaction
//                          (exact if deployed from an EOA).
//   3. creation-receipt  : for tokens, the Transfer(0, creator, totalSupply) log the constructor
//                          emitted in the creation transaction (exact totalSupply, also for tokens
//                          created inside another contract's call such as QuickLaunch).
//   4. creation-state    : eth_call at the creation block (needs an archive node; a setTaxes
//                          call made in the same block cannot be told apart).
//   5. events            : if there is no TaxesUpdated / MarketingWalletUpdated event at all,
//                          current value = original value. RewardsToken.setMarketingWallet
//                          emits no event, so the marketing wallet cannot be confirmed this way.
//   6. current           : the current state, with a warning in meta.warnings.
// Values are resolved field by field; which path was used is reported in meta.sources.
//
// RewardsToken takes three more arguments after the taxes: the chain's Uniswap V3 router and
// quoter (immutables, read back) and the packed V3 path the deployer gave it (v3Path_, the
// platform route stored for its reward token at creation). The constructor stores that path
// through _setRewardRouteV3, which emits RewardRouteV3Updated BEFORE the mint Transfer log, so
// the creation receipt gives the original exactly (creation-receipt): the first
// RewardRouteV3Updated of the token before its mint, or an empty path when there is none. Later
// setRewardRouteV3 / setRewardRoute calls emit the same event, so without the receipt the
// events strategy confirms the current value only when no such event followed the creation.
//
// A token created for a Uniswap v4 pool (its creator on the factory is the V4Launcher) is a
// different contract with its own constructor, told apart by poolVersion() == 4 before the V2
// names are used: HoodSaleTokenV4 (Standard and Tax) and RewardsTokenV4 (Rewards). Every argument
// but the supply and RewardsTokenV4's V3 path is an immutable and is read back; those two come
// from the creation receipt the same way (see reconstructTokenV4).
//
// Fee mode (the V4FeeLauncher, where the tax is the pool's own fee) reuses those two token
// contracts byte for byte. Its tokens differ in one argument only, the launcher, which is the fee
// launcher and is read back like any other immutable; meta.launchMode says which of the two
// launchers made the token ("hook" or "fee").

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ZERO = ethers.ZeroAddress;

const FQN = {
  StandardToken: "contracts/tokens/StandardToken.sol:StandardToken",
  TaxToken: "contracts/tokens/TaxToken.sol:TaxToken",
  RewardsToken: "contracts/tokens/RewardsToken.sol:RewardsToken",
  Presale: "contracts/Presale.sol:Presale",
  StandardTokenDeployer: "contracts/TokenFactory.sol:StandardTokenDeployer",
  TaxTokenDeployer: "contracts/TokenFactory.sol:TaxTokenDeployer",
  RewardsTokenDeployer: "contracts/TokenFactory.sol:RewardsTokenDeployer",
  TokenFactory: "contracts/TokenFactory.sol:TokenFactory",
  PresaleFactory: "contracts/PresaleFactory.sol:PresaleFactory",
  Treasury: "contracts/Treasury.sol:Treasury",
  LiquidityLocker: "contracts/LiquidityLocker.sol:LiquidityLocker",
  HoodSaleToken: "contracts/HoodSaleToken.sol:HoodSaleToken",
  // The stand-in of the HOODS rehearsal (scripts/rehearse-hoodsale.js): the same constructor
  HoodSaleRehearsalToken: "contracts/test/HoodSaleRehearsalToken.sol:HoodSaleRehearsalToken",
  HoodSaleLens: "contracts/HoodSaleLens.sol:HoodSaleLens",
  TokenMetadataRegistry: "contracts/TokenMetadataRegistry.sol:TokenMetadataRegistry",
  PresaleCode: "contracts/PresaleCode.sol:PresaleCode",
  LaunchBatch: "contracts/LaunchBatch.sol:LaunchBatch",
  RewardsTokenCode: "contracts/tokens/RewardsTokenCode.sol:RewardsTokenCode",
  QuickLaunch: "contracts/QuickLaunch.sol:QuickLaunch",
  // The Uniswap v4 launch mode
  HoodSaleV4Hook: "contracts/v4/HoodSaleV4Hook.sol:HoodSaleV4Hook",
  V4Launcher: "contracts/v4/V4Launcher.sol:V4Launcher",
  V4PositionLocker: "contracts/v4/V4PositionLocker.sol:V4PositionLocker",
  HoodSaleV4Lens: "contracts/v4/HoodSaleV4Lens.sol:HoodSaleV4Lens",
  HoodSaleV4Router: "contracts/v4/HoodSaleV4Router.sol:HoodSaleV4Router",
  RewardsTokenCodeV4: "contracts/v4/tokens/RewardsTokenCodeV4.sol:RewardsTokenCodeV4",
  HoodSaleTokenV4: "contracts/v4/tokens/HoodSaleTokenV4.sol:HoodSaleTokenV4",
  RewardsTokenV4: "contracts/v4/tokens/RewardsTokenV4.sol:RewardsTokenV4",
  StandardTokenDeployerV4: "contracts/v4/deployers/TokenDeployersV4.sol:StandardTokenDeployerV4",
  TaxTokenDeployerV4: "contracts/v4/deployers/TokenDeployersV4.sol:TaxTokenDeployerV4",
  RewardsTokenDeployerV4: "contracts/v4/deployers/TokenDeployersV4.sol:RewardsTokenDeployerV4",
  // The Uniswap v4 fee mode. Its lens and router are second instances of HoodSaleV4Lens and
  // HoodSaleV4Router, and its tokens are HoodSaleTokenV4 and RewardsTokenV4.
  V4FeeLauncher: "contracts/v4/fee/V4FeeLauncher.sol:V4FeeLauncher",
  HoodSaleV4FeeHook: "contracts/v4/fee/HoodSaleV4FeeHook.sol:HoodSaleV4FeeHook",
  StandardTokenDeployerFee: "contracts/v4/deployers/TokenDeployersFee.sol:StandardTokenDeployerFee",
  TaxTokenDeployerFee: "contracts/v4/deployers/TokenDeployersFee.sol:TaxTokenDeployerFee",
  RewardsTokenDeployerFee: "contracts/v4/deployers/TokenDeployersFee.sol:RewardsTokenDeployerFee",
};

// deployments/<network>.json key -> contract name
const DEPLOYMENT_KEYS = {
  treasury: "Treasury",
  locker: "LiquidityLocker",
  tokenFactory: "TokenFactory",
  presaleFactory: "PresaleFactory",
  hoodsale: "HoodSaleToken",
  hoodsaleRehearsal: "HoodSaleRehearsalToken",
  metadataRegistry: "TokenMetadataRegistry",
  lens: "HoodSaleLens",
  presaleCode: "PresaleCode",
  rewardsTokenCode: "RewardsTokenCode",
  quickLaunch: "QuickLaunch",
  v4Hook: "HoodSaleV4Hook",
  v4Launcher: "V4Launcher",
  v4Locker: "V4PositionLocker",
  v4Lens: "HoodSaleV4Lens",
  v4Router: "HoodSaleV4Router",
  rewardsTokenCodeV4: "RewardsTokenCodeV4",
  // Fee mode (scripts/deploy-v4-fee.js). The Fee deployers have keys of their own because they
  // exist before TokenFactory.setDeployers names them.
  v4FeeLauncher: "V4FeeLauncher",
  v4FeeHook: "HoodSaleV4FeeHook",
  v4FeeLens: "HoodSaleV4Lens",
  v4FeeRouter: "HoodSaleV4Router",
  v4FeeStandardDeployer: "StandardTokenDeployerFee",
  v4FeeTaxDeployer: "TaxTokenDeployerFee",
  v4FeeRewardsDeployer: "RewardsTokenDeployerFee",
};

const TOKEN_TYPE_NAMES = ["StandardToken", "TaxToken", "RewardsToken"];
// A token built for a Uniswap v4 pool: one contract for the Standard and Tax types (the tax lives
// in the pool's hook), another for Rewards
const V4_TOKEN_TYPE_NAMES = ["HoodSaleTokenV4", "HoodSaleTokenV4", "RewardsTokenV4"];
// PUSH4 poolVersion(): the dispatcher of a v4 token compares against it, a V2 token has no such function
const POOL_VERSION_PUSH = "63" + ethers.id("poolVersion()").slice(2, 10);

const PRESALE_PARAM_FIELDS = [
  "token",
  "presaleRate",
  "listingRate",
  "softCap",
  "hardCap",
  "minContribution",
  "maxContribution",
  "startTime",
  "endTime",
  "liquidityBps",
  "liquidityAction",
  "lockDuration",
  "launchTime",
  "whitelistEnabled",
];

// ------------------------------------------------------------------ ABIs

const OWNABLE_EVENT = "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)";

const TOKEN_FACTORY_ABI = [
  "function tokenInfo(address) view returns (tuple(address token, address creator, uint8 tokenType, uint64 createdAt, address rewardToken, string name, string symbol))",
  "function standardDeployer() view returns (address)",
  "function taxDeployer() view returns (address)",
  "function rewardsDeployer() view returns (address)",
  "function treasury() view returns (address)",
  "function router() view returns (address)",
  "function presaleFactory() view returns (address)",
  "function platformTaxBps() view returns (uint16)",
  "function owner() view returns (address)",
  "function createStandardToken(string name_, string symbol_, uint256 totalSupply_) returns (address)",
  "function createTaxToken(string name_, string symbol_, uint256 totalSupply_, address marketingWallet_, uint16 buyTaxBps_, uint16 sellTaxBps_) returns (address)",
  "function createRewardsToken(string name_, string symbol_, uint256 totalSupply_, address rewardToken_, address marketingWallet_, uint16[4] taxes_) returns (address)",
  "event TokenCreated(address indexed token, address indexed creator, uint8 tokenType, string name, string symbol)",
  OWNABLE_EVENT,
];

const PLATFORM_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function platformTreasury() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function router() view returns (address)",
  "function platformTaxBps() view returns (uint16)",
  "function marketingWallet() view returns (address)",
  "function buyTaxBps() view returns (uint16)",
  "function sellTaxBps() view returns (uint16)",
  "function rewardToken() view returns (address)",
  "function rewardsBuyTaxBps() view returns (uint16)",
  "function rewardsSellTaxBps() view returns (uint16)",
  "function marketingBuyTaxBps() view returns (uint16)",
  "function marketingSellTaxBps() view returns (uint16)",
  "function v3Router() view returns (address)",
  "function v3Quoter() view returns (address)",
  "function rewardRouteV3() view returns (bytes)",
  OWNABLE_EVENT,
];

// HoodSaleTokenV4 and RewardsTokenV4 (the getters the second one adds revert on the first)
const V4_TOKEN_ABI = [
  "function poolVersion() view returns (uint8)",
  "function tokenType() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function launcher() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function rewardToken() view returns (address)",
  "function weth() view returns (address)",
  "function v3Router() view returns (address)",
  "function v3Quoter() view returns (address)",
  "function rewardRouteV3() view returns (bytes)",
];

const TAX_TOKEN_EVENTS = [
  "event TaxesUpdated(uint16 buyTaxBps, uint16 sellTaxBps)",
  "event MarketingWalletUpdated(address wallet)",
];
const REWARDS_TOKEN_EVENTS = [
  "event TaxesUpdated(uint16 rewardsBuy, uint16 rewardsSell, uint16 marketingBuy, uint16 marketingSell)",
  "event RewardRouteUpdated(address[] intermediates)",
  "event RewardRouteV3Updated(bytes path)",
];

const PRESALE_FACTORY_ABI = [
  "function isPresale(address) view returns (bool)",
  "function treasury() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function locker() view returns (address)",
  "function router() view returns (address)",
  "function owner() view returns (address)",
  "event PresaleCreated(address indexed presale, address indexed token, address indexed creator)",
  OWNABLE_EVENT,
];

const PRESALE_ABI = [
  "function factory() view returns (address)",
  "function saleOwner() view returns (address)",
  "function router() view returns (address)",
  "function locker() view returns (address)",
  "function treasury() view returns (address)",
  "function platformFeeBps() view returns (uint16)",
  "function exitPenaltyBps() view returns (uint16)",
  "function getParams() view returns (tuple(address token, uint256 presaleRate, uint256 listingRate, uint256 softCap, uint256 hardCap, uint256 minContribution, uint256 maxContribution, uint64 startTime, uint64 endTime, uint16 liquidityBps, uint8 liquidityAction, uint64 lockDuration, uint64 launchTime, bool whitelistEnabled))",
];

const DEPLOYER_ABI = [
  "function factory() view returns (address)",
  // RewardsTokenDeployer only (the Uniswap V3 generation): the chain's SwapRouter02 and QuoterV2
  "function v3Router() view returns (address)",
  "function v3Quoter() view returns (address)",
  // RewardsTokenDeployer of the owner-locks generation: the holder of RewardsToken's creation code
  "function rewardsTokenCode() view returns (address)",
  // The deployers that can also build a token for a Uniswap v4 pool
  "function launcher() view returns (address)",
  "function rewardsTokenCodeV4() view returns (address)",
  // The Fee generation, which knows the fee mode launcher next to the hook mode one
  "function feeLauncher() view returns (address)",
];

// Constructor signatures of the token deployers. The rewards deployer of the Uniswap V3
// generation carries the V3 router and quoter; an earlier one took the factory alone.
const DEPLOYER_CONSTRUCTORS = {
  StandardTokenDeployer: ["address"],
  TaxTokenDeployer: ["address"],
  RewardsTokenDeployer: ["address", "address", "address"],
  // The generation that can also build a token for a Uniswap v4 pool names the launcher
  StandardTokenDeployerV4: ["address", "address"],
  TaxTokenDeployerV4: ["address", "address"],
  RewardsTokenDeployerV4: ["address", "address", "address", "address", "address", "address"],
  // The Fee generation names both v4 launchers: the hook mode one, then the fee mode one
  StandardTokenDeployerFee: ["address", "address", "address"],
  TaxTokenDeployerFee: ["address", "address", "address"],
  RewardsTokenDeployerFee: ["address", "address", "address", "address", "address", "address", "address"],
};

/** "StandardTokenDeployer", "...V4" and "...Fee" are all token deployers. */
function isDeployerName(name) {
  return Object.prototype.hasOwnProperty.call(DEPLOYER_CONSTRUCTORS, name);
}

const TREASURY_ABI = ["function owner() view returns (address)", OWNABLE_EVENT];

const HOODSALE_ABI = [
  "function owner() view returns (address)",
  "function router() view returns (address)",
  "function treasury() view returns (address)",
  "function marketingWallet() view returns (address)",
  OWNABLE_EVENT,
];

const LENS_ABI = [
  "function presaleFactory() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function router() view returns (address)",
];

const REGISTRY_ABI = ["function tokenFactory() view returns (address)"];

const QUICK_LAUNCH_ABI = [
  "function tokenFactory() view returns (address)",
  "function presaleFactory() view returns (address)",
  "function metadataRegistry() view returns (address)",
  // token type generation only: the reward allowlist the constructor received and the
  // generation it replaced
  "function initialRewardTokens() view returns (address[])",
  "function previousQuickLaunch() view returns (address)",
];

// Constructor signatures of the platform contracts (used to decode the creation-tx tail).
// All of them are statically typed, so the tail = the last 32*N bytes.
const PLATFORM_CONSTRUCTORS = {
  Treasury: ["address"],
  LiquidityLocker: [],
  TokenFactory: ["address", "address", "address"],
  PresaleFactory: ["address", "address", "address", "address", "address"],
  HoodSaleToken: ["address", "address", "address", "address"],
  HoodSaleRehearsalToken: ["address", "address", "address", "address"],
  HoodSaleLens: ["address", "address", "address"],
  TokenMetadataRegistry: ["address"],
  PresaleCode: [],
  LaunchBatch: [],
  RewardsTokenCode: [],
  // The token type generation adds a dynamic address[] (the reward allowlist) and the previous
  // generation; both are read back from the contract instead of the creation-tx tail.
  QuickLaunch: ["address", "address", "address", "address[]", "address"],
  // Every v4 contract keeps its constructor arguments as immutables, so they are read back from
  // the contract rather than dug out of the creation transaction.
  HoodSaleV4Hook: ["address", "address", "address"],
  V4Launcher: ["address", "address", "address", "address", "address", "address", "address", "address"],
  V4PositionLocker: ["address", "address"],
  HoodSaleV4Lens: ["address", "address"],
  HoodSaleV4Router: ["address", "address"],
  RewardsTokenCodeV4: [],
  HoodSaleV4FeeHook: ["address", "address", "address", "address"],
  V4FeeLauncher: ["address", "address", "address", "address", "address", "address", "address"],
};

const V4_HOOK_ABI = [
  "function poolManager() view returns (address)",
  "function launcher() view returns (address)",
  "function platformTreasury() view returns (address)",
];
const V4_LAUNCHER_ABI = [
  "function owner() view returns (address)",
  "function poolManager() view returns (address)",
  "function positionManager() view returns (address)",
  "function permit2() view returns (address)",
  "function tokenFactory() view returns (address)",
  "function presaleFactory() view returns (address)",
  "function locker() view returns (address)",
  "function treasury() view returns (address)",
];
// HoodSaleV4FeeHook and V4FeeLauncher: the hook also holds the PositionManager (it keeps the launch
// position), and the launcher has no locker argument (its locker() is a constant zero)
const V4_FEE_HOOK_ABI = [...V4_HOOK_ABI, "function positionManager() view returns (address)"];
const V4_FEE_LAUNCHER_ABI = V4_LAUNCHER_ABI.filter((f) => !f.startsWith("function locker()"));
// What tells the two launchers apart on chain: the hook each one names
const V4_ANY_LAUNCHER_ABI = ["function hook() view returns (address)"];
// HoodSaleV4FeeHook's permission bits (BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY), which a Uniswap
// v4 hook carries in the low 14 bits of its address (see scripts/lib/hook-miner.js)
const FEE_HOOK_FLAGS = 0x2800n;
const ALL_HOOK_MASK = 0x3fffn;
const V4_LOCKER_ABI = ["function owner() view returns (address)", "function positionManager() view returns (address)"];
const V4_LENS_ABI = ["function launcher() view returns (address)", "function stateView() view returns (address)"];
const V4_ROUTER_ABI = ["function poolManager() view returns (address)", "function launcher() view returns (address)"];

const TOPIC = {
  TokenCreated: ethers.id("TokenCreated(address,address,uint8,string,string)"),
  PresaleCreated: ethers.id("PresaleCreated(address,address,address)"),
  OwnershipTransferred: ethers.id("OwnershipTransferred(address,address)"),
  TaxTokenTaxesUpdated: ethers.id("TaxesUpdated(uint16,uint16)"),
  RewardsTaxesUpdated: ethers.id("TaxesUpdated(uint16,uint16,uint16,uint16)"),
  MarketingWalletUpdated: ethers.id("MarketingWalletUpdated(address)"),
  RewardRouteV3Updated: ethers.id("RewardRouteV3Updated(bytes)"),
  Transfer: ethers.id("Transfer(address,address,uint256)"),
};

const DEFAULT_ARTIFACTS_DIR = path.resolve(__dirname, "..", "..", "artifacts");

// ------------------------------------------------------------ helpers

class ReconstructError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReconstructError";
    this.code = code;
  }
}

function toPlainArgs(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toPlainArgs);
  if (value && typeof value === "object") {
    // ethers Result objects are converted to plain objects as well
    const out = {};
    for (const k of Object.keys(value)) out[k] = toPlainArgs(value[k]);
    return out;
  }
  return value;
}

async function tryCall(fn) {
  try {
    return await fn();
  } catch (e) {
    return null;
  }
}

function sameAddr(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function isHexAddressWord(word) {
  // the first 12 bytes of a 32-byte word must be zero
  return /^0{24}[0-9a-f]{40}$/i.test(word);
}

function padTopic(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

function makeOpts(opts) {
  return {
    deployments: opts.deployments || null,
    artifactsDir: opts.artifactsDir || DEFAULT_ARTIFACTS_DIR,
    fromBlock: Number.isFinite(opts.fromBlock) ? Number(opts.fromBlock) : 0,
    logChunk: Number.isFinite(opts.logChunk) ? Number(opts.logChunk) : 5000,
    maxChunks: Number.isFinite(opts.maxChunks) ? Number(opts.maxChunks) : 400,
    strategies: Array.isArray(opts.strategies) ? opts.strategies : null,
    creation: opts.creation || null, // { blockNumber, transactionHash } if known
    identifyByBytecode: opts.identifyByBytecode !== false,
  };
}

function allowed(o, name) {
  return !o.strategies || o.strategies.includes(name);
}

// ----------------------------------------------------------------- logs

/**
 * The whole range is tried in one request first; if the RPC enforces a range limit it is
 * scanned chunk by chunk. The returned logs are ordered by block/logIndex.
 */
async function getLogsResilient(provider, filter, o, fromBlock, toBlock) {
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (e) {
    // range limit etc. Fall back to chunked scanning.
  }
  const out = [];
  let chunks = 0;
  for (let start = fromBlock; start <= toBlock; start += o.logChunk) {
    if (++chunks > o.maxChunks) {
      throw new ReconstructError(
        `log scan aborted after ${o.maxChunks} chunks (raise logChunk/maxChunks or pass fromBlock)`,
        "LOG_SCAN_LIMIT"
      );
    }
    const end = Math.min(start + o.logChunk - 1, toBlock);
    const part = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
    out.push(...part);
  }
  return out;
}

/** Finds the creation block by binary search over eth_getCode. */
async function findCreationBlockByCode(provider, address, lo, hi) {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(address, mid);
    if (code && code !== "0x") high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Finds the log that created a contract (TokenCreated / PresaleCreated /
 * OwnershipTransferred(0, owner)). Order: the whole range, a single block located by
 * getCode binary search, chunked scanning. Returns null if not found.
 */
async function findCreationLog(provider, contractAddress, filter, o) {
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.min(o.fromBlock, latest);

  // 1. single request
  try {
    const logs = await provider.getLogs({ ...filter, fromBlock, toBlock: latest });
    if (logs.length > 0) return logs[0];
    return null;
  } catch (e) {
    // continue
  }

  // 2. getCode binary search (may fail for old blocks on non-archive nodes)
  try {
    const block = await findCreationBlockByCode(provider, contractAddress, fromBlock, latest);
    const logs = await provider.getLogs({ ...filter, fromBlock: block, toBlock: block });
    if (logs.length > 0) return logs[0];
  } catch (e) {
    // continue
  }

  // 3. chunked scanning
  const logs = await getLogsResilient(provider, filter, o, fromBlock, latest);
  return logs.length > 0 ? logs[0] : null;
}

// ------------------------------------------------------------- artifacts

const buildInfoCache = new Map();

function fqnParts(fqn) {
  const i = fqn.lastIndexOf(":");
  return { sourceName: fqn.slice(0, i), contractName: fqn.slice(i + 1) };
}

function loadArtifactSync(fqn, artifactsDir) {
  const { sourceName, contractName } = fqnParts(fqn);
  const file = path.join(artifactsDir, sourceName, `${contractName}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadBuildInfoSync(fqn, artifactsDir) {
  const { sourceName, contractName } = fqnParts(fqn);
  const dbgFile = path.join(artifactsDir, sourceName, `${contractName}.dbg.json`);
  if (!fs.existsSync(dbgFile)) return null;
  const dbg = JSON.parse(fs.readFileSync(dbgFile, "utf8"));
  const biPath = path.resolve(path.dirname(dbgFile), dbg.buildInfo);
  if (!buildInfoCache.has(biPath)) {
    if (!fs.existsSync(biPath)) return null;
    buildInfoCache.set(biPath, JSON.parse(fs.readFileSync(biPath, "utf8")));
  }
  return buildInfoCache.get(biPath);
}

function stripMetadata(hex) {
  // The last 2 bytes give the CBOR metadata length
  if (hex.length < 4) return hex;
  const len = parseInt(hex.slice(-4), 16);
  const cut = (len + 2) * 2;
  if (!Number.isFinite(len) || cut > hex.length) return hex;
  return hex.slice(0, hex.length - cut);
}

/**
 * Compares the deployed bytecode on chain with the artifact. Masks the immutable
 * slots and the metadata tail.
 */
function bytecodeMatches(onchainHex, artifactHex, immutableReferences) {
  const a = onchainHex.replace(/^0x/, "").toLowerCase();
  const b = artifactHex.replace(/^0x/, "").toLowerCase();
  if (a.length !== b.length || a.length === 0) return false;
  const sa = stripMetadata(a);
  const sb = stripMetadata(b);
  if (sa.length !== sb.length) return false;
  const masked = new Uint8Array(sa.length / 2);
  for (const refs of Object.values(immutableReferences || {})) {
    for (const { start, length } of refs) {
      for (let i = start; i < start + length && i < masked.length; i++) masked[i] = 1;
    }
  }
  for (let i = 0; i < masked.length; i++) {
    if (masked[i]) continue;
    if (sa[2 * i] !== sb[2 * i] || sa[2 * i + 1] !== sb[2 * i + 1]) return false;
  }
  return true;
}

function identifyByBytecode(code, artifactsDir, candidates) {
  for (const name of candidates) {
    const fqn = FQN[name];
    const artifact = loadArtifactSync(fqn, artifactsDir);
    if (!artifact || !artifact.deployedBytecode) continue;
    if (artifact.deployedBytecode.length !== code.length) continue;
    let refs = {};
    const bi = loadBuildInfoSync(fqn, artifactsDir);
    if (bi) {
      const { sourceName, contractName } = fqnParts(fqn);
      refs = bi.output?.contracts?.[sourceName]?.[contractName]?.evm?.deployedBytecode?.immutableReferences || {};
    }
    if (bytecodeMatches(code, artifact.deployedBytecode, refs)) return name;
  }
  return null;
}

// ---------------------------------------------------------------- detection

function matchDeployments(address, deployments) {
  if (!deployments) return null;
  for (const [key, name] of Object.entries(DEPLOYMENT_KEYS)) {
    if (deployments[key] && sameAddr(deployments[key], address)) return name;
  }
  return null;
}

/**
 * True when a failed call was the contract reverting, however the provider reports it: a bare
 * ethers provider raises CALL_EXCEPTION, the hardhat-ethers provider passes the node's JSON-RPC
 * error through (code 3, "execution reverted"), and the in-process hardhat network throws
 * "Transaction reverted: ..." without a code.
 */
function isRevertError(e) {
  if (!e) return false;
  if (e.code === "CALL_EXCEPTION" || e.code === 3 || (e.error && e.error.code === 3)) return true;
  return /\b(execution|transaction) reverted\b|VM Exception while processing transaction/i.test(String(e.message || ""));
}

/**
 * True for a token built for a Uniswap v4 pool: poolVersion() answers 4. A V2 token has no such
 * function and reverts. When the call fails any other way (a flaky RPC), the selector decides:
 * only the dispatcher of a v4 token's runtime code carries it.
 */
async function isV4Token(provider, address, code) {
  const c = new ethers.Contract(address, V4_TOKEN_ABI, provider);
  try {
    return Number(await c.poolVersion()) === 4;
  } catch (e) {
    if (isRevertError(e)) return false;
    return typeof code === "string" && code.toLowerCase().includes(POOL_VERSION_PUSH);
  }
}

async function detect(provider, address, code, o) {
  // 1. deployments file
  const known = matchDeployments(address, o.deployments);
  if (known) return { kind: isDeployerName(known) ? "deployer" : "platform", name: known };

  // 2. TokenFactory token
  const asToken = new ethers.Contract(address, PLATFORM_TOKEN_ABI, provider);
  const tf = await tryCall(() => asToken.tokenFactory());
  if (tf && tf !== ZERO) {
    const factory = new ethers.Contract(tf, TOKEN_FACTORY_ABI, provider);
    const info = await tryCall(() => factory.tokenInfo(address));
    if (info && sameAddr(info.token, address)) {
      // A token the V4Launcher or the V4FeeLauncher created is registered with the same token
      // types, but the deployers built a different contract for it, so it is told apart first
      if (await isV4Token(provider, address, code)) {
        return { kind: "token", name: V4_TOKEN_TYPE_NAMES[Number(info.tokenType)], tokenFactory: tf, info, poolVersion: 4 };
      }
      return { kind: "token", name: TOKEN_TYPE_NAMES[Number(info.tokenType)], tokenFactory: tf, info };
    }
  }

  // 3. contracts that expose factory(): Presale or deployer
  const asWithFactory = new ethers.Contract(address, DEPLOYER_ABI, provider);
  const f = await tryCall(() => asWithFactory.factory());
  if (f && f !== ZERO) {
    const pf = new ethers.Contract(f, PRESALE_FACTORY_ABI, provider);
    const isPresale = await tryCall(() => pf.isPresale(address));
    if (isPresale === true) return { kind: "presale", name: "Presale", presaleFactory: f };

    const tfc = new ethers.Contract(f, TOKEN_FACTORY_ABI, provider);
    const [sd, td, rd] = await Promise.all([
      tryCall(() => tfc.standardDeployer()),
      tryCall(() => tfc.taxDeployer()),
      tryCall(() => tfc.rewardsDeployer()),
    ]);
    // The slot in the factory says which of the three it is; only its own code says which
    // generation: the one that can also build a token for a Uniswap v4 pool names a launcher, and
    // the one that knows fee mode names a fee launcher next to it.
    const generation = (await tryCall(() => asWithFactory.feeLauncher()))
      ? "Fee"
      : (await tryCall(() => asWithFactory.launcher()))
        ? "V4"
        : "";
    if (sameAddr(sd, address)) return { kind: "deployer", name: `StandardTokenDeployer${generation}`, tokenFactory: f };
    if (sameAddr(td, address)) return { kind: "deployer", name: `TaxTokenDeployer${generation}`, tokenFactory: f };
    if (sameAddr(rd, address)) return { kind: "deployer", name: `RewardsTokenDeployer${generation}`, tokenFactory: f };
  }

  // 4. bytecode match (platform contracts when there is no deployments file)
  if (o.identifyByBytecode) {
    const name = identifyByBytecode(code, o.artifactsDir, [
      "Treasury",
      "LiquidityLocker",
      "TokenFactory",
      "PresaleFactory",
      "HoodSaleToken",
      "HoodSaleRehearsalToken",
      "HoodSaleLens",
      "TokenMetadataRegistry",
      "StandardTokenDeployer",
      "TaxTokenDeployer",
      "RewardsTokenDeployer",
      "RewardsTokenCode",
      "StandardTokenDeployerV4",
      "TaxTokenDeployerV4",
      "RewardsTokenDeployerV4",
      "RewardsTokenCodeV4",
      "HoodSaleV4Hook",
      "V4Launcher",
      "V4PositionLocker",
      "HoodSaleV4Lens",
      "HoodSaleV4Router",
      "StandardTokenDeployerFee",
      "TaxTokenDeployerFee",
      "RewardsTokenDeployerFee",
      "HoodSaleV4FeeHook",
      "V4FeeLauncher",
    ]);
    if (name) {
      // A deployer the factory no longer names (a replaced generation) or does not name yet (the
      // Fee generation before setDeployers) is only found here
      if (isDeployerName(name)) return { kind: "deployer", name, tokenFactory: f };
      return { kind: "platform", name, viaBytecode: true };
    }
  }

  throw new ReconstructError(`${address}: not a HoodSale platform contract, token or presale`, "UNRECOGNIZED");
}

// ------------------------------------------------------------ tokens

async function findTokenCreation(provider, tokenFactory, token, o) {
  if (o.creation && o.creation.blockNumber !== undefined) {
    return {
      blockNumber: Number(o.creation.blockNumber),
      transactionHash: o.creation.transactionHash || null,
    };
  }
  const log = await findCreationLog(
    provider,
    token,
    { address: tokenFactory, topics: [TOPIC.TokenCreated, padTopic(token)] },
    o
  );
  if (!log) return null;
  return { blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash, logIndex: log.index };
}

/**
 * Decodes the calldata of the creation transaction. Returns a result only if the tx was sent
 * directly to the TokenFactory (tx.to == factory) and the function is the expected createXToken.
 */
async function decodeCreationCalldata(provider, tokenFactory, creation, expectedFn, info) {
  if (!creation || !creation.transactionHash) return null;
  const tx = await tryCall(() => provider.getTransaction(creation.transactionHash));
  if (!tx || !tx.to || !sameAddr(tx.to, tokenFactory)) return null;
  const iface = new ethers.Interface(TOKEN_FACTORY_ABI);
  let parsed;
  try {
    parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  } catch (e) {
    return null;
  }
  if (!parsed || parsed.name !== expectedFn) return null;
  const a = parsed.args;
  // The same tx must be consistent with the recorded name/symbol
  if (a.name_ !== info.name || a.symbol_ !== info.symbol) return null;
  return parsed;
}

async function hadMutationEvents(provider, token, topics, fromBlock, o) {
  const latest = await provider.getBlockNumber();
  const logs = await getLogsResilient(provider, { address: token, topics: [topics] }, o, fromBlock, latest);
  return logs.length > 0;
}

/**
 * The amount of the Transfer(address(0), creator, amount) log the token emitted in its creation
 * transaction (the constructor's _mint), or null when the receipt or the log is not available.
 */
async function mintedSupplyFromReceipt(provider, token, creator, transactionHash) {
  const receipt = await tryCall(() => provider.getTransactionReceipt(transactionHash));
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const creatorTopic = creator ? padTopic(creator).toLowerCase() : null;
  const mint = receipt.logs.find(
    (l) =>
      sameAddr(l.address, token) &&
      l.topics.length === 3 &&
      l.topics[0] === TOPIC.Transfer &&
      l.topics[1].toLowerCase() === padTopic(ZERO).toLowerCase() &&
      (!creatorTopic || l.topics[2].toLowerCase() === creatorTopic)
  );
  if (!mint || !mint.data || mint.data === "0x") return null;
  try {
    return BigInt(mint.data);
  } catch (e) {
    return null;
  }
}

/**
 * The V3 path the RewardsToken constructor stored, read from the creation receipt: the first
 * RewardRouteV3Updated log of the token that comes before its mint Transfer (the constructor
 * sets the path right before minting; a QuickLaunch that sets a route in the same transaction
 * does so after the mint). Returns "0x" when the receipt holds the mint but no such log, and
 * null when the receipt (or the mint log) is not available.
 */
async function v3PathFromReceipt(provider, token, transactionHash) {
  const receipt = await tryCall(() => provider.getTransactionReceipt(transactionHash));
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const own = receipt.logs.filter((l) => sameAddr(l.address, token));
  const mint = own.find(
    (l) => l.topics.length === 3 && l.topics[0] === TOPIC.Transfer && l.topics[1].toLowerCase() === padTopic(ZERO).toLowerCase()
  );
  if (!mint) return null;
  const route = own.find((l) => l.topics[0] === TOPIC.RewardRouteV3Updated && Number(l.index) < Number(mint.index));
  if (!route) return "0x";
  try {
    return ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], route.data)[0];
  } catch (e) {
    return null;
  }
}

async function reconstructToken(provider, address, det, o) {
  const warnings = [];
  const sources = {};
  const token = new ethers.Contract(address, PLATFORM_TOKEN_ABI, provider);
  const info = det.info;
  const typeName = det.name;
  const tokenFactory = det.tokenFactory;

  if (o.deployments && o.deployments.tokenFactory && !sameAddr(o.deployments.tokenFactory, tokenFactory)) {
    warnings.push(`token is registered on TokenFactory ${tokenFactory}, not the one in deployments`);
  }

  // Immutable fields: current value == constructor value
  const [platformTreasury, router, platformTaxBps] = await Promise.all([
    token.platformTreasury(),
    token.router(),
    token.platformTaxBps(),
  ]);
  const creator = info.creator;
  const name = info.name;
  const symbol = info.symbol;

  const creation = await findTokenCreation(provider, tokenFactory, address, o);
  if (!creation) warnings.push("TokenCreated log not found; creation block unknown");

  // Mutable fields
  const wanted = { totalSupply: null };
  if (typeName === "TaxToken") Object.assign(wanted, { marketingWallet: null, buyTaxBps: null, sellTaxBps: null });
  // The Uniswap V3 generation of RewardsToken has three more constructor arguments (v3Router,
  // v3Quoter, v3Path); a token from before it has no v3Router() getter
  const hasV3 = typeName === "RewardsToken" && (await tryCall(() => token.v3Router())) !== null;
  if (typeName === "RewardsToken") {
    Object.assign(wanted, {
      marketingWallet: null,
      rewardsBuyTaxBps: null,
      rewardsSellTaxBps: null,
      marketingBuyTaxBps: null,
      marketingSellTaxBps: null,
    });
    // the packed V3 path the deployer passed; not part of the factory calldata
    if (hasV3) wanted.rewardRouteV3 = null;
  }
  const fnByType = {
    StandardToken: "createStandardToken",
    TaxToken: "createTaxToken",
    RewardsToken: "createRewardsToken",
  };

  // Values are resolved field by field: a strategy fills what it can, the next one takes the rest.
  const resolved = {};
  const missing = () => Object.keys(wanted).filter((k) => resolved[k] === undefined);

  // 1. creation-calldata (every field, exact; only when the creator called the factory directly)
  if (allowed(o, "calldata") && creation) {
    const parsed = await decodeCreationCalldata(provider, tokenFactory, creation, fnByType[typeName], info);
    if (parsed) {
      const a = parsed.args;
      resolved.totalSupply = a.totalSupply_;
      if (typeName === "TaxToken") {
        Object.assign(resolved, {
          marketingWallet: a.marketingWallet_,
          buyTaxBps: a.buyTaxBps_,
          sellTaxBps: a.sellTaxBps_,
        });
      } else if (typeName === "RewardsToken") {
        const t = a.taxes_;
        Object.assign(resolved, {
          marketingWallet: a.marketingWallet_,
          rewardsBuyTaxBps: t[0],
          rewardsSellTaxBps: t[1],
          marketingBuyTaxBps: t[2],
          marketingSellTaxBps: t[3],
        });
      }
      for (const k of Object.keys(wanted)) if (k !== "rewardRouteV3") sources[k] = "creation-calldata";
    }
  }

  // 2. creation-receipt: the RewardsToken constructor stores its V3 path before minting, so the
  //    receipt tells the original path exactly, even when a QuickLaunch changed it in the same tx
  if (missing().includes("rewardRouteV3") && allowed(o, "creation-receipt") && creation && creation.transactionHash) {
    const v3Path = await v3PathFromReceipt(provider, address, creation.transactionHash);
    if (v3Path !== null) {
      resolved.rewardRouteV3 = v3Path;
      sources.rewardRouteV3 = "creation-receipt";
    }
  }

  // 2. creation-receipt: the constructor mints the whole supply to the creator, so the
  //    Transfer(0, creator, totalSupply) log of the creation transaction gives the exact
  //    totalSupply even when the token was created inside another contract's call
  //    (QuickLaunch, a Safe) and the factory calldata is not visible. Needs no archive node.
  if (missing().includes("totalSupply") && allowed(o, "creation-receipt") && creation && creation.transactionHash) {
    const supply = await mintedSupplyFromReceipt(provider, address, creator, creation.transactionHash);
    if (supply !== null) {
      resolved.totalSupply = supply;
      sources.totalSupply = "creation-receipt";
    }
  }

  // 3. creation-state (eth_call at the creation block) for whatever is still missing
  if (missing().length > 0 && allowed(o, "creation-state") && creation) {
    const at = { blockTag: creation.blockNumber };
    const fields = missing();
    const values = {};
    let ok = true;
    for (const k of fields) {
      const v = await tryCall(() => token[k](at));
      if (v === null) {
        ok = false;
        break;
      }
      values[k] = v;
    }
    if (ok) {
      Object.assign(resolved, values);
      for (const k of fields) sources[k] = "creation-state";
      const taxFields = fields.filter((k) => k !== "totalSupply");
      // Was there a change in the same block? (RewardsToken.setMarketingWallet emits no event;
      // the constructor's own RewardRouteV3Updated is not a change and is not looked for here)
      const mutationTopics = typeName === "TaxToken"
        ? [TOPIC.TaxTokenTaxesUpdated, TOPIC.MarketingWalletUpdated]
        : typeName === "RewardsToken"
          ? [TOPIC.RewardsTaxesUpdated]
          : [];
      if (taxFields.length > 0 && mutationTopics.length > 0) {
        const sameBlock = await tryCall(() =>
          provider.getLogs({
            address,
            topics: [mutationTopics],
            fromBlock: creation.blockNumber,
            toBlock: creation.blockNumber,
          })
        );
        if (sameBlock && sameBlock.length > 0) {
          warnings.push("tax/marketing change detected in the creation block; creation-state values may be post-change");
        }
      }
      if (taxFields.includes("marketingWallet") && typeName === "RewardsToken") {
        warnings.push("RewardsToken.setMarketingWallet emits no event; a same-block change cannot be detected");
      }
    } else {
      warnings.push("historical eth_call at the creation block failed (non-archive RPC?)");
    }
  }

  // 4. events: if there is no change event at all, the current value is the original one
  if (missing().length > 0 && (allowed(o, "events") || allowed(o, "current"))) {
    const fields = missing();
    for (const k of fields) {
      resolved[k] = await token[k]();
      sources[k] = "current";
    }
    // totalSupply: nothing mints/burns (OZ ERC20, no burn function)
    if (fields.includes("totalSupply")) sources.totalSupply = "current-immutable";
    const taxFields = fields.filter((k) => k !== "totalSupply");
    const fromBlock = creation ? creation.blockNumber : o.fromBlock;
    if (taxFields.length === 0) {
      // nothing mutable left to explain
    } else if (allowed(o, "events") && typeName === "TaxToken") {
      const taxChanged = await hadMutationEvents(provider, address, [TOPIC.TaxTokenTaxesUpdated], fromBlock, o);
      const mwChanged = await hadMutationEvents(provider, address, [TOPIC.MarketingWalletUpdated], fromBlock, o);
      sources.buyTaxBps = sources.sellTaxBps = taxChanged ? "current-CHANGED" : "current-unchanged-by-events";
      sources.marketingWallet = mwChanged ? "current-CHANGED" : "current-unchanged-by-events";
      if (taxChanged) warnings.push("setTaxes was called after creation; original taxes NOT recoverable without calldata or archive state");
      if (mwChanged) warnings.push("setMarketingWallet was called after creation; original wallet NOT recoverable without calldata or archive state");
    } else if (allowed(o, "events") && typeName === "RewardsToken") {
      const taxChanged = await hadMutationEvents(provider, address, [TOPIC.RewardsTaxesUpdated], fromBlock, o);
      const tag = taxChanged ? "current-CHANGED" : "current-unchanged-by-events";
      for (const k of ["rewardsBuyTaxBps", "rewardsSellTaxBps", "marketingBuyTaxBps", "marketingSellTaxBps"]) {
        if (fields.includes(k)) sources[k] = tag;
      }
      if (fields.includes("marketingWallet")) {
        sources.marketingWallet = "current-UNVERIFIED";
        warnings.push("RewardsToken.setMarketingWallet emits no event; marketingWallet taken from current state and cannot be confirmed");
      }
      if (taxChanged) warnings.push("setTaxes was called after creation; original taxes NOT recoverable without calldata or archive state");
      if (fields.includes("rewardRouteV3")) {
        // The constructor's own event sits in the creation block; any event after it is a change.
        // Events in the creation block beyond the constructor's cannot be told apart here (the
        // receipt strategy handles that case exactly).
        const after = creation
          ? await hadMutationEvents(provider, address, [TOPIC.RewardRouteV3Updated], creation.blockNumber + 1, o)
          : true;
        sources.rewardRouteV3 = after ? "current-CHANGED" : "current-unchanged-by-events";
        if (after) warnings.push("the reward route changed after creation (RewardRouteV3Updated); original V3 path NOT recoverable without the creation receipt or archive state");
      }
    } else {
      warnings.push("mutable constructor values taken from current state (unverified)");
    }
  }

  // Argument list
  let args;
  if (typeName === "StandardToken") {
    args = [name, symbol, resolved.totalSupply, creator, platformTreasury, tokenFactory, router, platformTaxBps];
  } else if (typeName === "TaxToken") {
    args = [
      name, symbol, resolved.totalSupply, creator, platformTreasury, tokenFactory, router, platformTaxBps,
      resolved.marketingWallet, resolved.buyTaxBps, resolved.sellTaxBps,
    ];
  } else {
    const rewardToken = info.rewardToken && info.rewardToken !== ZERO ? info.rewardToken : await token.rewardToken();
    // The V3 leg (immutables); a token from before the V3 generation has no such getters
    let v3Router = ZERO;
    let v3Quoter = ZERO;
    let v3Path = "0x";
    if (hasV3) {
      [v3Router, v3Quoter] = await Promise.all([token.v3Router(), token.v3Quoter()]);
      v3Path = resolved.rewardRouteV3;
      sources.v3Router = sources.v3Quoter = "immutable-state";
    } else {
      warnings.push("no v3Router() / v3Quoter() on the token: a RewardsToken from before the Uniswap V3 generation (11 constructor arguments); zero addresses and an empty path are used");
      sources.v3Router = sources.v3Quoter = sources.rewardRouteV3 = "absent";
    }
    args = [
      name, symbol, resolved.totalSupply, creator, platformTreasury, tokenFactory, router, platformTaxBps,
      rewardToken, resolved.marketingWallet,
      [resolved.rewardsBuyTaxBps, resolved.rewardsSellTaxBps, resolved.marketingBuyTaxBps, resolved.marketingSellTaxBps],
      v3Router, v3Quoter, v3Path === null || v3Path === undefined ? "0x" : v3Path,
    ];
  }

  return {
    contract: FQN[typeName],
    args,
    kind: "token",
    name: typeName,
    address,
    meta: {
      tokenFactory,
      creator,
      creation,
      sources,
      warnings,
    },
  };
}

// ------------------------------------------------------------ v4 tokens

/**
 * Which of the two v4 launchers `launcher` is: "hook" for the V4Launcher (the tax is taken by the
 * pool's hook on every swap), "fee" for the V4FeeLauncher (the tax is the pool's own fee), or null
 * when it cannot be told. The deployments file answers first. Without it the launcher's hook
 * does: a Uniswap v4 hook carries its permissions in its address, and the fee mode hook's are its
 * two gate bits and nothing else.
 */
async function launchModeOf(provider, launcher, deployments) {
  if (deployments && deployments.v4FeeLauncher && sameAddr(deployments.v4FeeLauncher, launcher)) return "fee";
  if (deployments && deployments.v4Launcher && sameAddr(deployments.v4Launcher, launcher)) return "hook";
  const hook = await tryCall(() => new ethers.Contract(launcher, V4_ANY_LAUNCHER_ABI, provider).hook());
  if (!hook || hook === ZERO) return null;
  return (BigInt(hook) & ALL_HOOK_MASK) === FEE_HOOK_FLAGS ? "fee" : "hook";
}

/**
 * A token the V4Launcher or the V4FeeLauncher created through the TokenFactory. The deployers that
 * know them (contracts/v4/deployers/TokenDeployersV4.sol and TokenDeployersFee.sol) build it as
 *   HoodSaleTokenV4(name, symbol, totalSupply, launcher, tokenFactory, tokenType)   Standard, Tax
 *   RewardsTokenV4(name, symbol, totalSupply, launcher, tokenFactory, rewardToken, weth,
 *                  v3Router, v3Quoter, v3Path)                                     Rewards
 * Name and symbol are the ones the factory recorded, and every address and the token type are
 * immutables, read back. Neither contract can mint or burn after its constructor, which mints the
 * whole supply to the launcher, and RewardsTokenV4 stores its V3 path (the platform route of its
 * reward token at creation, emitting RewardRouteV3Updated) right before that mint. So the creation
 * receipt gives both exactly; the creation-block state and the events are the fallbacks, as for
 * the V2 tokens. The factory calldata is never available: the launcher is the one calling it.
 * Both modes share the two contracts, so a fee mode token only differs in the launcher it names.
 */
async function reconstructTokenV4(provider, address, det, o) {
  const warnings = [];
  const sources = {};
  const token = new ethers.Contract(address, V4_TOKEN_ABI, provider);
  const info = det.info;
  const typeName = det.name;
  const tokenFactory = det.tokenFactory;
  const isRewards = typeName === "RewardsTokenV4";

  if (o.deployments && o.deployments.tokenFactory && !sameAddr(o.deployments.tokenFactory, tokenFactory)) {
    warnings.push(`token is registered on TokenFactory ${tokenFactory}, not the one in deployments`);
  }

  const launcher = await token.launcher();
  sources.launcher = sources.tokenFactory = "immutable-state";
  if (!sameAddr(launcher, info.creator)) {
    warnings.push(`the token's launcher ${launcher} is not its creator on the factory (${info.creator})`);
  }
  const launchMode = await launchModeOf(provider, launcher, o.deployments);
  const listed = o.deployments ? [o.deployments.v4Launcher, o.deployments.v4FeeLauncher].filter(Boolean) : [];
  if (listed.length > 0 && !listed.some((l) => sameAddr(l, launcher))) {
    warnings.push(`token was created by launcher ${launcher}, which is neither v4 launcher in deployments`);
  }

  const creation = await findTokenCreation(provider, tokenFactory, address, o);
  if (!creation) warnings.push("TokenCreated log not found; creation block unknown");

  const wanted = isRewards ? ["totalSupply", "rewardRouteV3"] : ["totalSupply"];
  const resolved = {};
  const missing = () => wanted.filter((k) => resolved[k] === undefined);

  // 1. creation-receipt: the mint to the launcher, and the route stored before it
  if (allowed(o, "creation-receipt") && creation && creation.transactionHash) {
    const supply = await mintedSupplyFromReceipt(provider, address, launcher, creation.transactionHash);
    if (supply !== null) {
      resolved.totalSupply = supply;
      sources.totalSupply = "creation-receipt";
    }
    if (isRewards) {
      const v3Path = await v3PathFromReceipt(provider, address, creation.transactionHash);
      if (v3Path !== null) {
        resolved.rewardRouteV3 = v3Path;
        sources.rewardRouteV3 = "creation-receipt";
      }
    }
  }

  // 2. creation-state (eth_call at the creation block) for whatever is still missing
  if (missing().length > 0 && allowed(o, "creation-state") && creation) {
    const at = { blockTag: creation.blockNumber };
    const fields = missing();
    const values = {};
    let ok = true;
    for (const k of fields) {
      const v = await tryCall(() => token[k](at));
      if (v === null) {
        ok = false;
        break;
      }
      values[k] = v;
    }
    if (ok) {
      Object.assign(resolved, values);
      for (const k of fields) sources[k] = "creation-state";
      if (fields.includes("rewardRouteV3")) {
        // The constructor emits at most one RewardRouteV3Updated; another one in the creation
        // block, or one from a different transaction, may be a change the state already shows
        const sameBlock = await tryCall(() =>
          provider.getLogs({
            address,
            topics: [TOPIC.RewardRouteV3Updated],
            fromBlock: creation.blockNumber,
            toBlock: creation.blockNumber,
          })
        );
        const foreign = (sameBlock || []).filter(
          (l) => creation.transactionHash && l.transactionHash.toLowerCase() !== creation.transactionHash.toLowerCase()
        );
        if (sameBlock && (sameBlock.length > 1 || foreign.length > 0)) {
          warnings.push("reward route change detected in the creation block; the creation-state V3 path may be post-change");
        }
      }
    } else {
      warnings.push("historical eth_call at the creation block failed (non-archive RPC?)");
    }
  }

  // 3. events / current: the supply never changes; the route is confirmed by the absence of events
  if (missing().length > 0 && (allowed(o, "events") || allowed(o, "current"))) {
    const fields = missing();
    for (const k of fields) {
      resolved[k] = await token[k]();
      sources[k] = "current";
    }
    if (fields.includes("totalSupply")) sources.totalSupply = "current-immutable";
    if (fields.includes("rewardRouteV3")) {
      if (allowed(o, "events")) {
        // The constructor's own event sits in the creation block; any event after it is a change
        const after = creation
          ? await hadMutationEvents(provider, address, [TOPIC.RewardRouteV3Updated], creation.blockNumber + 1, o)
          : true;
        sources.rewardRouteV3 = after ? "current-CHANGED" : "current-unchanged-by-events";
        if (after) warnings.push("the reward route changed after creation (RewardRouteV3Updated); original V3 path NOT recoverable without the creation receipt or archive state");
      } else {
        warnings.push("mutable constructor values taken from current state (unverified)");
      }
    }
  }

  if (missing().length > 0) {
    throw new ReconstructError(
      `${address}: ${missing().join(", ")} of the ${typeName} could not be recovered with the allowed strategies`,
      "UNRESOLVED"
    );
  }

  let args;
  if (isRewards) {
    const [rewardToken, weth, v3Router, v3Quoter] = await Promise.all([
      token.rewardToken(),
      token.weth(),
      token.v3Router(),
      token.v3Quoter(),
    ]);
    sources.rewardToken = sources.weth = sources.v3Router = sources.v3Quoter = "immutable-state";
    args = [
      info.name, info.symbol, resolved.totalSupply, launcher, tokenFactory,
      rewardToken, weth, v3Router, v3Quoter, resolved.rewardRouteV3,
    ];
  } else {
    const tokenType = await token.tokenType();
    sources.tokenType = "immutable-state";
    if (Number(tokenType) !== Number(info.tokenType)) {
      warnings.push(`the token records type ${tokenType}, the factory ${info.tokenType}; the token's own value is used`);
    }
    args = [info.name, info.symbol, resolved.totalSupply, launcher, tokenFactory, tokenType];
  }

  return {
    contract: FQN[typeName],
    args,
    kind: "token",
    name: typeName,
    address,
    meta: {
      tokenFactory,
      creator: info.creator,
      launcher,
      launchMode,
      poolVersion: 4,
      creation,
      sources,
      warnings,
    },
  };
}

// ------------------------------------------------------------ presale

async function reconstructPresale(provider, address, det, o) {
  const warnings = [];
  const presale = new ethers.Contract(address, PRESALE_ABI, provider);
  const [saleOwner, router, locker, treasury, platformFeeBps, exitPenaltyBps, params] = await Promise.all([
    presale.saleOwner(),
    presale.router(),
    presale.locker(),
    presale.treasury(),
    presale.platformFeeBps(),
    presale.exitPenaltyBps(),
    presale.getParams(),
  ]);
  // params is written only in the constructor (Presale.sol: params = params_), the rest are immutable.
  const paramsObj = {};
  for (const f of PRESALE_PARAM_FIELDS) paramsObj[f] = params[f];

  let creation = null;
  if (o.creation && o.creation.blockNumber !== undefined) {
    creation = { blockNumber: Number(o.creation.blockNumber), transactionHash: o.creation.transactionHash || null };
  } else {
    const log = await tryCall(() =>
      findCreationLog(provider, address, { address: det.presaleFactory, topics: [TOPIC.PresaleCreated, padTopic(address)] }, o)
    );
    if (log) creation = { blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash, logIndex: log.index };
    else warnings.push("PresaleCreated log not found; creation block unknown");
  }

  return {
    contract: FQN.Presale,
    args: [paramsObj, saleOwner, router, locker, treasury, platformFeeBps, exitPenaltyBps],
    kind: "presale",
    name: "Presale",
    address,
    meta: { presaleFactory: det.presaleFactory, creation, sources: { all: "immutable-state" }, warnings },
  };
}

// ----------------------------------------------------------- deployers

async function reconstructDeployer(provider, address, det) {
  const c = new ethers.Contract(address, DEPLOYER_ABI, provider);
  const factory = await c.factory();
  const args = [factory];
  const sources = { factory: "immutable-state" };
  const warnings = [];
  if (det.name === "StandardTokenDeployerV4" || det.name === "TaxTokenDeployerV4") {
    args.push(await c.launcher());
    sources.launcher = "immutable-state";
  }
  if (det.name === "RewardsTokenDeployerV4") {
    const [v3Router, v3Quoter, codeV2, codeV4, launcher] = await Promise.all([
      c.v3Router(),
      c.v3Quoter(),
      c.rewardsTokenCode(),
      c.rewardsTokenCodeV4(),
      c.launcher(),
    ]);
    args.push(v3Router, v3Quoter, codeV2, codeV4, launcher);
    sources.v3Router = sources.v3Quoter = sources.rewardsTokenCode = "immutable-state";
    sources.rewardsTokenCodeV4 = sources.launcher = "immutable-state";
  }
  // The Fee generation: the V4 generation's arguments with the fee mode launcher after them
  if (det.name === "StandardTokenDeployerFee" || det.name === "TaxTokenDeployerFee") {
    args.push(...(await Promise.all([c.launcher(), c.feeLauncher()])));
    sources.launcher = sources.feeLauncher = "immutable-state";
  }
  if (det.name === "RewardsTokenDeployerFee") {
    args.push(
      ...(await Promise.all([
        c.v3Router(),
        c.v3Quoter(),
        c.rewardsTokenCode(),
        c.rewardsTokenCodeV4(),
        c.launcher(),
        c.feeLauncher(),
      ]))
    );
    sources.v3Router = sources.v3Quoter = sources.rewardsTokenCode = "immutable-state";
    sources.rewardsTokenCodeV4 = sources.launcher = sources.feeLauncher = "immutable-state";
  }
  if (det.name === "RewardsTokenDeployer") {
    // The Uniswap V3 generation carries the chain's SwapRouter02 and QuoterV2 as immutables
    const v3Router = await tryCall(() => c.v3Router());
    const v3Quoter = await tryCall(() => c.v3Quoter());
    if (v3Router === null || v3Quoter === null) {
      warnings.push("no v3Router() / v3Quoter(): a RewardsTokenDeployer from before the Uniswap V3 generation (one constructor argument)");
    } else {
      args.push(v3Router, v3Quoter);
      sources.v3Router = sources.v3Quoter = "immutable-state";
      // The owner-locks generation deploys the token from the creation code held by RewardsTokenCode
      const code = await tryCall(() => c.rewardsTokenCode());
      if (code === null) {
        warnings.push("no rewardsTokenCode(): a RewardsTokenDeployer from before the owner-locks generation (three constructor arguments)");
      } else {
        args.push(code);
        sources.rewardsTokenCode = "immutable-state";
      }
    }
  }
  return {
    contract: FQN[det.name],
    args,
    kind: "deployer",
    name: det.name,
    address,
    meta: { sources, warnings },
  };
}

// ------------------------------------------------------------ platform

/** Finds the initial owner and the creation transaction from the OwnershipTransferred(address(0), owner) event. */
async function findOwnableCreation(provider, address, o) {
  if (o.creation && o.creation.blockNumber !== undefined) {
    const logs = await tryCall(() =>
      provider.getLogs({
        address,
        topics: [TOPIC.OwnershipTransferred, padTopic(ZERO)],
        fromBlock: Number(o.creation.blockNumber),
        toBlock: Number(o.creation.blockNumber),
      })
    );
    const log = logs && logs[0];
    if (log) {
      return {
        blockNumber: Number(log.blockNumber),
        transactionHash: log.transactionHash,
        owner: ethers.getAddress(ethers.dataSlice(log.topics[2], 12)),
      };
    }
  }
  const log = await findCreationLog(provider, address, { address, topics: [TOPIC.OwnershipTransferred, padTopic(ZERO)] }, o);
  if (!log) return null;
  return {
    blockNumber: Number(log.blockNumber),
    transactionHash: log.transactionHash,
    owner: ethers.getAddress(ethers.dataSlice(log.topics[2], 12)),
  };
}

/** Decodes the static constructor arguments from the init code tail of the deploy transaction. */
async function decodeCreationTxTail(provider, address, txHash, types, o, name) {
  if (!txHash || types.length === 0) return null;
  const tx = await tryCall(() => provider.getTransaction(txHash));
  if (!tx || tx.to !== null) return null; // deployed through a factory/CREATE2
  const receipt = await tryCall(() => provider.getTransactionReceipt(txHash));
  if (!receipt || !receipt.contractAddress || !sameAddr(receipt.contractAddress, address)) return null;
  const data = tx.data.replace(/^0x/, "");
  const tailLen = types.length * 64;
  if (data.length <= tailLen) return null;
  const tail = data.slice(data.length - tailLen);
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "address" && !isHexAddressWord(tail.slice(i * 64, i * 64 + 64))) return null;
  }
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, "0x" + tail);
  const result = { values: Array.from(decoded), prefixMatches: null };
  // If an artifact exists the init code prefix is compared (a metadata difference produces a warning, not an error)
  const artifact = loadArtifactSync(FQN[name], o.artifactsDir);
  if (artifact && artifact.bytecode) {
    const prefix = artifact.bytecode.replace(/^0x/, "").toLowerCase();
    const head = data.slice(0, data.length - tailLen).toLowerCase();
    result.prefixMatches = head.length === prefix.length && stripMetadata(head) === stripMetadata(prefix);
  }
  return result;
}

async function reconstructPlatform(provider, address, det, o) {
  const name = det.name;
  const warnings = [];
  const sources = {};
  const types = PLATFORM_CONSTRUCTORS[name];

  const finish = (args, creation) => ({
    contract: FQN[name],
    args,
    kind: "platform",
    name,
    address,
    meta: { creation: creation || null, sources, warnings, viaBytecode: !!det.viaBytecode },
  });

  if (
    name === "LiquidityLocker" ||
    name === "PresaleCode" ||
    name === "RewardsTokenCode" ||
    name === "RewardsTokenCodeV4" ||
    name === "LaunchBatch"
  ) {
    sources.all = "no-constructor-args";
    return finish([], null);
  }

  // The Uniswap v4 contracts. Each one keeps what it was built with, so the arguments come
  // straight back off the contract. The owner of the three that are Ownable is the exception:
  // owner() answers with whoever holds the contract now, so the deploying owner is taken from the
  // OwnershipTransferred(0, owner) log of the creation, like the other Ownable platform contracts.
  // Only when that log cannot be found is the current owner used, with a warning, because it is
  // the wrong argument as soon as ownership has been handed on.
  const deployingOwner = async (currentOwner, what) => {
    const creation = await findOwnableCreation(provider, address, o);
    if (!creation) {
      sources.owner = "current-owner";
      warnings.push(
        currentOwner === ZERO
          ? `OwnershipTransferred(0, owner) log not found and owner() is zero: the ${what} was renounced, so the deploying owner is unknown`
          : "OwnershipTransferred(0, owner) log not found; owner taken from the current owner(), which is wrong if ownership was handed on since the deployment"
      );
      return { owner: currentOwner, creation: null };
    }
    sources.owner = "ownership-event";
    // Deployed from an EOA, so the deployment transaction carries the argument as well
    if (allowed(o, "creation-tx")) {
      const tail = await decodeCreationTxTail(provider, address, creation.transactionHash, types, o, name);
      if (tail && !sameAddr(tail.values[0], creation.owner)) {
        warnings.push(`the deployment transaction names owner ${tail.values[0]}, the OwnershipTransferred log ${creation.owner}; the log is used`);
      }
    }
    return { owner: creation.owner, creation };
  };

  if (name === "HoodSaleV4Hook") {
    const c = new ethers.Contract(address, V4_HOOK_ABI, provider);
    sources.all = "immutable-state";
    return finish(await Promise.all([c.poolManager(), c.launcher(), c.platformTreasury()]), null);
  }

  if (name === "V4Launcher") {
    const c = new ethers.Contract(address, V4_LAUNCHER_ABI, provider);
    const [owner, poolManager, positionManager, permit2, tokenFactory, presaleFactory, locker, treasury] =
      await Promise.all([
        c.owner(),
        c.poolManager(),
        c.positionManager(),
        c.permit2(),
        c.tokenFactory(),
        c.presaleFactory(),
        c.locker(),
        c.treasury(),
      ]);
    sources.all = "immutable-state";
    const deployed = await deployingOwner(owner, "launcher");
    return finish([deployed.owner, poolManager, positionManager, permit2, tokenFactory, presaleFactory, locker, treasury], deployed.creation);
  }

  // Fee mode: the hook has no owner and also keeps the PositionManager; the launcher is the hook
  // mode one without a locker.
  if (name === "HoodSaleV4FeeHook") {
    const c = new ethers.Contract(address, V4_FEE_HOOK_ABI, provider);
    sources.all = "immutable-state";
    return finish(await Promise.all([c.poolManager(), c.positionManager(), c.launcher(), c.platformTreasury()]), null);
  }

  if (name === "V4FeeLauncher") {
    const c = new ethers.Contract(address, V4_FEE_LAUNCHER_ABI, provider);
    const [owner, poolManager, positionManager, permit2, tokenFactory, presaleFactory, treasury] = await Promise.all([
      c.owner(),
      c.poolManager(),
      c.positionManager(),
      c.permit2(),
      c.tokenFactory(),
      c.presaleFactory(),
      c.treasury(),
    ]);
    sources.all = "immutable-state";
    const deployed = await deployingOwner(owner, "launcher");
    return finish([deployed.owner, poolManager, positionManager, permit2, tokenFactory, presaleFactory, treasury], deployed.creation);
  }

  if (name === "V4PositionLocker") {
    const c = new ethers.Contract(address, V4_LOCKER_ABI, provider);
    const [owner, positionManager] = await Promise.all([c.owner(), c.positionManager()]);
    sources.all = "immutable-state";
    const deployed = await deployingOwner(owner, "locker");
    return finish([deployed.owner, positionManager], deployed.creation);
  }

  if (name === "HoodSaleV4Lens") {
    const c = new ethers.Contract(address, V4_LENS_ABI, provider);
    sources.all = "immutable-state";
    return finish(await Promise.all([c.launcher(), c.stateView()]), null);
  }

  if (name === "HoodSaleV4Router") {
    const c = new ethers.Contract(address, V4_ROUTER_ABI, provider);
    sources.all = "immutable-state";
    return finish(await Promise.all([c.poolManager(), c.launcher()]), null);
  }

  if (name === "QuickLaunch") {
    const c = new ethers.Contract(address, QUICK_LAUNCH_ABI, provider);
    const args = await Promise.all([c.tokenFactory(), c.presaleFactory(), c.metadataRegistry()]);
    // The token type generation keeps its constructor allowlist on chain; earlier generations
    // have no such getter and no fourth argument.
    try {
      args.push([...(await c.initialRewardTokens())]);
      args.push(await c.previousQuickLaunch());
    } catch (e) {
      warnings.push("no initialRewardTokens() or previousQuickLaunch(): an earlier QuickLaunch generation with fewer constructor arguments");
    }
    sources.all = "immutable-state";
    return finish(args, null);
  }

  if (name === "HoodSaleLens") {
    const c = new ethers.Contract(address, LENS_ABI, provider);
    const args = await Promise.all([c.presaleFactory(), c.tokenFactory(), c.router()]);
    sources.all = "immutable-state";
    return finish(args, null);
  }

  if (name === "TokenMetadataRegistry") {
    const c = new ethers.Contract(address, REGISTRY_ABI, provider);
    sources.all = "immutable-state";
    return finish([await c.tokenFactory()], null);
  }

  // Ownable platform contracts: Treasury, TokenFactory, PresaleFactory, HoodSaleToken
  const creation = await findOwnableCreation(provider, address, o);
  if (!creation) warnings.push("OwnershipTransferred(0, owner) log not found; owner taken from current owner()");

  // 1. creation-tx: init code tail
  if (allowed(o, "creation-tx") && creation) {
    const tail = await decodeCreationTxTail(provider, address, creation.transactionHash, types, o, name);
    if (tail && sameAddr(tail.values[0], creation.owner)) {
      sources.all = "creation-tx";
      if (tail.prefixMatches === false) {
        warnings.push("creation bytecode differs from the local artifact (source or settings drift?); args decoded by length");
      }
      return finish(tail.values, creation);
    }
  }

  // 2. creation-state / 3. current
  const getters = {
    Treasury: [],
    TokenFactory: ["treasury", "router"],
    PresaleFactory: ["treasury", "tokenFactory", "locker", "router"],
    HoodSaleToken: ["router", "treasury", "marketingWallet"],
    HoodSaleRehearsalToken: ["router", "treasury", "marketingWallet"],
  }[name];
  const abi = { Treasury: TREASURY_ABI, TokenFactory: TOKEN_FACTORY_ABI, PresaleFactory: PRESALE_FACTORY_ABI, HoodSaleToken: HOODSALE_ABI, HoodSaleRehearsalToken: HOODSALE_ABI }[name];
  const c = new ethers.Contract(address, abi, provider);

  let owner = creation ? creation.owner : null;
  if (!owner) owner = await c.owner();
  sources.owner = creation ? "ownership-event" : "current";

  const values = [];
  let source = "current";
  if (allowed(o, "creation-state") && creation) {
    let ok = true;
    for (const g of getters) {
      const v = await tryCall(() => c[g]({ blockTag: creation.blockNumber }));
      if (v === null) {
        ok = false;
        break;
      }
      values.push(v);
    }
    if (ok) source = "creation-state";
    else {
      values.length = 0;
      warnings.push("historical eth_call at the creation block failed (non-archive RPC?)");
    }
  }
  if (values.length !== getters.length) {
    values.length = 0;
    for (const g of getters) values.push(await c[g]());
    source = "current";
    const mutable = { TokenFactory: "treasury/router", PresaleFactory: "treasury/locker/router", HoodSaleToken: "treasury/marketingWallet", HoodSaleRehearsalToken: "treasury/marketingWallet" }[name];
    if (mutable) warnings.push(`${mutable} taken from current state; they are mutable and may differ from the constructor values`);
  }
  for (const g of getters) sources[g] = source;
  return finish([owner, ...values], creation);
}

// ------------------------------------------------------------------ entry point

/**
 * @param provider ethers v6 Provider (hre.ethers.provider or JsonRpcProvider)
 * @param address  the address to inspect
 * @param opts     { deployments, artifactsDir, fromBlock, logChunk, maxChunks, strategies, creation }
 * @returns { contract, args, kind, name, address, meta }
 */
async function reconstructConstructorArgs(provider, address, opts = {}) {
  const o = makeOpts(opts);
  const addr = ethers.getAddress(address);
  const code = await provider.getCode(addr);
  if (!code || code === "0x") throw new ReconstructError(`${addr}: no code at address`, "NO_CODE");

  const det = await detect(provider, addr, code, o);
  switch (det.kind) {
    case "token":
      return det.poolVersion === 4 ? reconstructTokenV4(provider, addr, det, o) : reconstructToken(provider, addr, det, o);
    case "presale":
      return reconstructPresale(provider, addr, det, o);
    case "deployer":
      return reconstructDeployer(provider, addr, det);
    case "platform":
      return reconstructPlatform(provider, addr, det, o);
    default:
      throw new ReconstructError(`${addr}: unknown kind ${det.kind}`, "UNRECOGNIZED");
  }
}

/** Encodes args with the platform token's constructor ABI (hex, 0x-prefixed). */
function encodeConstructorArgs(abi, args) {
  const iface = new ethers.Interface(abi);
  return iface.encodeDeploy(args);
}

module.exports = {
  reconstructConstructorArgs,
  encodeConstructorArgs,
  toPlainArgs,
  identifyByBytecode,
  bytecodeMatches,
  findCreationBlockByCode,
  getLogsResilient,
  loadArtifactSync,
  loadBuildInfoSync,
  ReconstructError,
  FQN,
  DEPLOYMENT_KEYS,
  DEPLOYER_CONSTRUCTORS,
  PLATFORM_CONSTRUCTORS,
  TOPIC,
  PRESALE_PARAM_FIELDS,
  ABI: {
    TOKEN_FACTORY_ABI,
    PLATFORM_TOKEN_ABI,
    PRESALE_FACTORY_ABI,
    PRESALE_ABI,
    TAX_TOKEN_EVENTS,
    REWARDS_TOKEN_EVENTS,
  },
};
