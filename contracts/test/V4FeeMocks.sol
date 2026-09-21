// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Test-only: a v4 rewards token that names the launcher that created it but takes its rewards
/// from some other hook. The platform's own rewards token cannot come out this way; the fee
/// launcher checks all the same, and this is what it must refuse.
contract MisboundRewardsToken is ERC20, Ownable {
    address public immutable launcher;
    address public immutable hook;

    constructor(string memory name_, string memory symbol_, uint256 supply_, address launcher_, address hook_)
        ERC20(name_, symbol_)
        Ownable(launcher_)
    {
        launcher = launcher_;
        hook = hook_;
        _mint(launcher_, supply_);
    }

    function poolVersion() external pure returns (uint8) {
        return 4;
    }

    function tokenType() external pure returns (uint8) {
        return 2;
    }
}

/// Test-only: stands in for the factory's rewards deployer and hands back the token above.
contract MisboundRewardsDeployer {
    address public immutable wrongHook;

    constructor(address wrongHook_) {
        wrongHook = wrongHook_;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address creator_,
        address,
        address,
        uint16,
        address,
        address,
        uint16[4] calldata
    ) external returns (address) {
        return address(new MisboundRewardsToken(name_, symbol_, totalSupply_, creator_, wrongHook));
    }
}

/// @dev The four entry points of HoodSaleV4FeeHook that pull fees in or pay them out, as the wallet
///      below calls them. A PoolId is a bytes32 on the wire.
interface IFeeHookEntryPoints {
    function collect(bytes32 id) external returns (uint256 ethFees, uint256 tokenFees);

    function convert(bytes32 id, uint256 quotedTokens, uint256 minEthOut, uint256 deadline)
        external
        returns (uint256 tokensSold, uint256 ethOut);

    function flush(bytes32 id) external;

    function flushPlatform() external;
}

/// Test-only: a wallet that calls back into the fee hook while the hook is paying it. On every
/// payment it tries collect, convert, flush and flushPlatform, records how each attempt ended and
/// never reverts itself, so the payout goes through and the record survives it. `attempt` makes
/// the same four calls outside a payment, to show that they are good calls when nothing guards
/// against them.
contract ReenteringWallet {
    /// @dev One storage slot, so recording it fits well inside the gas a payout carries.
    struct Record {
        /// @notice How many times this record has been written
        uint32 count;
        bool collectOk;
        bool convertOk;
        bool flushOk;
        bool flushPlatformOk;
        /// @notice The first four bytes each call came back with: the error's selector when it failed
        bytes4 collectAnswer;
        bytes4 convertAnswer;
        bytes4 flushAnswer;
        bytes4 flushPlatformAnswer;
    }

    address public hook;
    bytes32 public poolId;
    /// @notice What came of the four calls made from inside the last payment
    Record public last;
    /// @notice What came of the four calls made by the last `attempt`
    Record public direct;

    /// @notice Names the hook and the pool to call back into. Until it is called, a payment is just taken.
    function aim(address hook_, bytes32 poolId_) external {
        hook = hook_;
        poolId = poolId_;
    }

    receive() external payable {
        if (hook == address(0)) return;
        Record memory r = _attemptAll();
        r.count = last.count + 1;
        last = r;
    }

    function attempt() external {
        Record memory r = _attemptAll();
        r.count = direct.count + 1;
        direct = r;
    }

    function _attemptAll() private returns (Record memory r) {
        bytes32 id = poolId;
        (r.collectOk, r.collectAnswer) = _try(abi.encodeCall(IFeeHookEntryPoints.collect, (id)));
        // (1, 0) is no price floor and the deadline never passes, so nothing but a guard stops it.
        (r.convertOk, r.convertAnswer) = _try(
            abi.encodeCall(IFeeHookEntryPoints.convert, (id, 1, 0, type(uint256).max))
        );
        (r.flushOk, r.flushAnswer) = _try(abi.encodeCall(IFeeHookEntryPoints.flush, (id)));
        (r.flushPlatformOk, r.flushPlatformAnswer) = _try(abi.encodeCall(IFeeHookEntryPoints.flushPlatform, ()));
    }

    function _try(bytes memory data) private returns (bool ok, bytes4 answer) {
        bytes memory result;
        (ok, result) = hook.call(data);
        if (result.length >= 4) answer = bytes4(result);
    }
}
