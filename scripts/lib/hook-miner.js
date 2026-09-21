// A Uniswap v4 hook declares its permissions in the low 14 bits of its own address, so the address
// has to be mined: a CREATE2 salt is searched until the resulting address carries exactly the bits
// the hook's getHookPermissions returns. This mirrors v4-periphery's HookMiner in JavaScript so the
// deploy script and the tests mine the same way, against the canonical CREATE2 proxy.

const { CREATE2_PROXY } = require("./uniswap-v4");

/** Hook permission bits (v4-core Hooks.sol). */
const HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1 << 13,
  AFTER_INITIALIZE: 1 << 12,
  BEFORE_ADD_LIQUIDITY: 1 << 11,
  AFTER_ADD_LIQUIDITY: 1 << 10,
  BEFORE_REMOVE_LIQUIDITY: 1 << 9,
  AFTER_REMOVE_LIQUIDITY: 1 << 8,
  BEFORE_SWAP: 1 << 7,
  AFTER_SWAP: 1 << 6,
  BEFORE_DONATE: 1 << 5,
  AFTER_DONATE: 1 << 4,
  BEFORE_SWAP_RETURNS_DELTA: 1 << 3,
  AFTER_SWAP_RETURNS_DELTA: 1 << 2,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1 << 1,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1 << 0,
};

const ALL_HOOK_MASK = (1 << 14) - 1;

/** What HoodSaleV4Hook's permissions come to: it opens the pool and charges on every swap. */
const HOODSALE_HOOK_FLAGS =
  HOOK_FLAGS.BEFORE_INITIALIZE |
  HOOK_FLAGS.BEFORE_SWAP |
  HOOK_FLAGS.AFTER_SWAP |
  HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA |
  HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA;

/** What HoodSaleV4FeeHook's permissions come to: it opens the pool and lets one position in. */
const FEE_HOOK_FLAGS = HOOK_FLAGS.BEFORE_INITIALIZE | HOOK_FLAGS.BEFORE_ADD_LIQUIDITY;

/**
 * Searches for a salt whose CREATE2 address carries `flags` in its low 14 bits.
 * `options.reject(address)` skips addresses the caller does not want.
 * @returns {{address: string, salt: string, tried: number}}
 */
function mineHookSalt(ethers, initcode, flags = HOODSALE_HOOK_FLAGS, options = {}) {
  const { deployer = CREATE2_PROXY, start = 0n, maxIterations = 2_000_000n, reject } = options;
  const initcodeHash = ethers.keccak256(initcode);
  const mask = BigInt(ALL_HOOK_MASK);
  const target = BigInt(flags) & mask;
  for (let salt = BigInt(start); salt < BigInt(start) + BigInt(maxIterations); salt++) {
    const saltHex = ethers.toBeHex(salt, 32);
    const address = ethers.getCreate2Address(deployer, saltHex, initcodeHash);
    if ((BigInt(address) & mask) === target && !(reject && reject(address))) {
      return { address, salt: saltHex, tried: Number(salt - BigInt(start)) + 1 };
    }
  }
  throw new Error("no salt found for the requested hook flags");
}

/** Builds HoodSaleV4Hook's creation code with its constructor arguments appended. */
async function hookInitcode(hre, poolManager, launcher, treasury) {
  const factory = await hre.ethers.getContractFactory("HoodSaleV4Hook");
  return hre.ethers.concat([
    factory.bytecode,
    hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address"],
      [poolManager, launcher, treasury]
    ),
  ]);
}

/** Builds HoodSaleV4FeeHook's creation code with its constructor arguments appended. */
async function feeHookInitcode(hre, poolManager, positionManager, launcher, treasury) {
  const factory = await hre.ethers.getContractFactory("HoodSaleV4FeeHook");
  return hre.ethers.concat([
    factory.bytecode,
    hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address"],
      [poolManager, positionManager, launcher, treasury]
    ),
  ]);
}

/**
 * Deploys through the CREATE2 proxy, whose call data is the salt followed by the creation code.
 * Returns the address the contract actually landed at, checked against the mined one.
 */
async function deployWithCreate2(hre, signer, initcode, salt, expectedAddress) {
  const tx = await signer.sendTransaction({ to: CREATE2_PROXY, data: hre.ethers.concat([salt, initcode]) });
  const receipt = await tx.wait();
  const code = await hre.ethers.provider.getCode(expectedAddress);
  if (code === "0x") throw new Error(`CREATE2 deploy did not land at ${expectedAddress} (tx ${tx.hash})`);
  return { address: expectedAddress, hash: tx.hash, gasUsed: receipt.gasUsed };
}

module.exports = {
  HOOK_FLAGS,
  ALL_HOOK_MASK,
  HOODSALE_HOOK_FLAGS,
  FEE_HOOK_FLAGS,
  mineHookSalt,
  hookInitcode,
  feeHookInitcode,
  deployWithCreate2,
  CREATE2_PROXY,
};
