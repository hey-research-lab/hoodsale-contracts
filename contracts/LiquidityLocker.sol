// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LiquidityLocker
/// @notice Locks LP tokens (or any ERC-20) until a given time. Liquidity is locked
///         here when a presale is finalized; once the period ends the lock owner
///         can withdraw. The period can only be extended, never shortened.
contract LiquidityLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LockInfo {
        address token;
        address owner;
        uint256 amount;
        uint64 unlockTime;
        bool withdrawn;
    }

    LockInfo[] public locks;
    mapping(address => uint256[]) private _locksOfOwner;
    mapping(address => uint256[]) private _locksOfToken;
    /// @dev Whether a lock id is already in an owner's raw list, so a lock handed back to a
    ///      previous owner (or to its own owner) is not listed twice.
    mapping(address => mapping(uint256 => bool)) private _inOwnerList;

    event Locked(uint256 indexed lockId, address indexed token, address indexed owner, uint256 amount, uint64 unlockTime);
    event Unlocked(uint256 indexed lockId, address indexed owner, uint256 amount);
    event LockExtended(uint256 indexed lockId, uint64 newUnlockTime);
    event LockOwnershipTransferred(uint256 indexed lockId, address indexed newOwner);

    function lock(address token, uint256 amount, uint64 unlockTime, address owner)
        external
        nonReentrant
        returns (uint256 lockId)
    {
        require(token != address(0) && owner != address(0), "zero addr");
        require(amount > 0, "zero amount");
        require(unlockTime > block.timestamp, "unlock in past");

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        require(received > 0, "nothing received");

        lockId = locks.length;
        locks.push(LockInfo({token: token, owner: owner, amount: received, unlockTime: unlockTime, withdrawn: false}));
        _listForOwner(owner, lockId);
        _locksOfToken[token].push(lockId);
        emit Locked(lockId, token, owner, received, unlockTime);
    }

    function unlock(uint256 lockId) external nonReentrant {
        LockInfo storage info = locks[lockId];
        require(msg.sender == info.owner, "not lock owner");
        require(!info.withdrawn, "already withdrawn");
        require(block.timestamp >= info.unlockTime, "still locked");
        info.withdrawn = true;
        IERC20(info.token).safeTransfer(info.owner, info.amount);
        emit Unlocked(lockId, info.owner, info.amount);
    }

    function extendLock(uint256 lockId, uint64 newUnlockTime) external {
        LockInfo storage info = locks[lockId];
        require(msg.sender == info.owner, "not lock owner");
        require(!info.withdrawn, "already withdrawn");
        require(newUnlockTime > info.unlockTime, "can only extend");
        info.unlockTime = newUnlockTime;
        emit LockExtended(lockId, newUnlockTime);
    }

    function transferLockOwnership(uint256 lockId, address newOwner) external {
        LockInfo storage info = locks[lockId];
        require(msg.sender == info.owner, "not lock owner");
        require(newOwner != address(0), "zero owner");
        info.owner = newOwner;
        _listForOwner(newOwner, lockId);
        emit LockOwnershipTransferred(lockId, newOwner);
    }

    function _listForOwner(address owner, uint256 lockId) private {
        if (_inOwnerList[owner][lockId]) return;
        _inOwnerList[owner][lockId] = true;
        _locksOfOwner[owner].push(lockId);
    }

    function lockCount() external view returns (uint256) {
        return locks.length;
    }

    /// @dev Transferred locks remain in the previous owner's raw list; here the
    ///      result is filtered by current ownership before being returned.
    function locksOfOwner(address owner) external view returns (uint256[] memory) {
        uint256[] storage ids = _locksOfOwner[owner];
        uint256 count;
        for (uint256 i = 0; i < ids.length; i++) {
            if (locks[ids[i]].owner == owner) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 j;
        for (uint256 i = 0; i < ids.length; i++) {
            if (locks[ids[i]].owner == owner) result[j++] = ids[i];
        }
        return result;
    }

    function locksOfToken(address token) external view returns (uint256[] memory) {
        return _locksOfToken[token];
    }

    /// @notice Paged read. Since lock lists can grow permissionlessly, the frontend
    ///         should use this instead of fetching the whole list.
    function locksOfOwnerPaged(address owner, uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        uint256[] storage all = _locksOfOwner[owner];
        total = all.length;
        if (start >= total) return (new uint256[](0), total);
        uint256 end = start + count > total ? total : start + count;
        ids = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) {
            ids[i - start] = all[i];
        }
    }

    function locksOfTokenPaged(address token, uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        uint256[] storage all = _locksOfToken[token];
        total = all.length;
        if (start >= total) return (new uint256[](0), total);
        uint256 end = start + count > total ? total : start + count;
        ids = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) {
            ids[i - start] = all[i];
        }
    }
}
