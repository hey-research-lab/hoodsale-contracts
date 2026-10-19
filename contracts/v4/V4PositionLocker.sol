// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManagerV4} from "./interfaces/IPositionManagerV4.sol";

/**
 * @title V4PositionLocker
 * @notice Holds a launch's Uniswap v4 liquidity until a given time, the way LiquidityLocker holds
 *         V2 LP tokens. On v4 a position is an NFT rather than a balance, so the lock is proved by
 *         this contract owning the position: anyone can check `ownerOf` on the PositionManager.
 *
 *         While locked, the position keeps earning the pool's LP fee, and the lock owner can take
 *         those fees out without touching the principal. The principal itself can only leave
 *         through `unlock`, after the time is up; the period can be extended, never shortened.
 */
contract V4PositionLocker is Ownable, ReentrancyGuard {
    struct LockInfo {
        uint256 tokenId;
        address owner;
        uint64 unlockTime;
        bool withdrawn;
    }

    IPositionManagerV4 public immutable positionManager;

    LockInfo[] public locks;
    mapping(address => uint256[]) private _locksOfOwner;
    /// @dev Whether a lock id is already in an owner's raw list, so a lock handed back to a
    ///      previous owner (or to its own owner) is not listed twice.
    mapping(address => mapping(uint256 => bool)) private _inOwnerList;
    /// @notice The lock a position belongs to, plus one; zero means the position is not locked here
    mapping(uint256 => uint256) private _lockOfTokenPlusOne;
    /// @notice Contracts allowed to create locks (the launchers)
    mapping(address => bool) public isLauncher;

    event Locked(uint256 indexed lockId, uint256 indexed tokenId, address indexed owner, uint64 unlockTime);
    event Unlocked(uint256 indexed lockId, address indexed owner, uint256 tokenId);
    event LockExtended(uint256 indexed lockId, uint64 newUnlockTime);
    event LockOwnershipTransferred(uint256 indexed lockId, address indexed newOwner);
    event FeesCollected(uint256 indexed lockId, address indexed to);
    event LauncherSet(address indexed launcher, bool allowed);

    error NotLauncher();
    error NotLockOwner();
    error AlreadyWithdrawn();
    error StillLocked();
    error NotHeld();
    error AlreadyLocked();
    error UnlockInPast();
    error CanOnlyExtend();

    constructor(address owner_, IPositionManagerV4 positionManager_) Ownable(owner_) {
        require(address(positionManager_) != address(0), "zero posm");
        positionManager = positionManager_;
    }

    function setLauncher(address launcher, bool allowed) external onlyOwner {
        isLauncher[launcher] = allowed;
        emit LauncherSet(launcher, allowed);
    }

    /// @notice Records a lock for a position already transferred to this contract.
    function lock(uint256 tokenId, uint64 unlockTime, address owner_) external nonReentrant returns (uint256 lockId) {
        if (!isLauncher[msg.sender]) revert NotLauncher();
        require(owner_ != address(0), "zero owner");
        if (unlockTime <= block.timestamp) revert UnlockInPast();
        if (positionManager.ownerOf(tokenId) != address(this)) revert NotHeld();
        if (_lockOfTokenPlusOne[tokenId] != 0) revert AlreadyLocked();

        lockId = locks.length;
        locks.push(LockInfo({tokenId: tokenId, owner: owner_, unlockTime: unlockTime, withdrawn: false}));
        _listForOwner(owner_, lockId);
        _lockOfTokenPlusOne[tokenId] = lockId + 1;
        emit Locked(lockId, tokenId, owner_, unlockTime);
    }

    function unlock(uint256 lockId) external nonReentrant {
        LockInfo storage info = locks[lockId];
        if (msg.sender != info.owner) revert NotLockOwner();
        if (info.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < info.unlockTime) revert StillLocked();
        info.withdrawn = true;
        positionManager.transferFrom(address(this), info.owner, info.tokenId);
        emit Unlocked(lockId, info.owner, info.tokenId);
    }

    function extendLock(uint256 lockId, uint64 newUnlockTime) external {
        LockInfo storage info = locks[lockId];
        if (msg.sender != info.owner) revert NotLockOwner();
        if (info.withdrawn) revert AlreadyWithdrawn();
        if (newUnlockTime <= info.unlockTime) revert CanOnlyExtend();
        info.unlockTime = newUnlockTime;
        emit LockExtended(lockId, newUnlockTime);
    }

    function transferLockOwnership(uint256 lockId, address newOwner) external {
        LockInfo storage info = locks[lockId];
        if (msg.sender != info.owner) revert NotLockOwner();
        require(newOwner != address(0), "zero owner");
        info.owner = newOwner;
        _listForOwner(newOwner, lockId);
        emit LockOwnershipTransferred(lockId, newOwner);
    }

    /**
     * @notice Sends the LP fees the locked position has earned to the lock owner.
     * @dev Taking liquidity out is never encoded here: the only decrease this contract can perform
     *      is one of zero liquidity, which collects the fees and leaves the principal in place.
     */
    function collectFees(uint256 lockId) external nonReentrant {
        LockInfo storage info = locks[lockId];
        if (msg.sender != info.owner) revert NotLockOwner();
        if (info.withdrawn) revert AlreadyWithdrawn();

        (PoolKey memory key, ) = positionManager.getPoolAndPositionInfo(info.tokenId);
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(info.tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, info.owner);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        emit FeesCollected(lockId, info.owner);
    }

    function _listForOwner(address owner_, uint256 lockId) private {
        if (_inOwnerList[owner_][lockId]) return;
        _inOwnerList[owner_][lockId] = true;
        _locksOfOwner[owner_].push(lockId);
    }

    // ------------------------------------------------------------- views

    function lockCount() external view returns (uint256) {
        return locks.length;
    }

    /// @notice The lock holding a position, and whether there is one at all.
    function lockOfToken(uint256 tokenId) external view returns (uint256 lockId, bool exists) {
        uint256 stored = _lockOfTokenPlusOne[tokenId];
        return stored == 0 ? (0, false) : (stored - 1, true);
    }

    /// @dev Transferred locks remain in the previous owner's raw list; the result is filtered by
    ///      current ownership before being returned.
    function locksOfOwner(address owner_) external view returns (uint256[] memory) {
        uint256[] storage ids = _locksOfOwner[owner_];
        uint256 count;
        for (uint256 i = 0; i < ids.length; i++) {
            if (locks[ids[i]].owner == owner_) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 j;
        for (uint256 i = 0; i < ids.length; i++) {
            if (locks[ids[i]].owner == owner_) result[j++] = ids[i];
        }
        return result;
    }
}
