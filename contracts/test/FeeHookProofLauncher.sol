// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HoodSaleV4FeeHook} from "../v4/fee/HoodSaleV4FeeHook.sol";
import {IPositionManagerV4} from "../v4/interfaces/IPositionManagerV4.sol";
import {IAllowanceTransferV4} from "../v4/interfaces/IAllowanceTransferV4.sol";

/**
 * Proof-only launcher for HoodSaleV4FeeHook: the smallest thing that can open a fee mode pool the
 * way the platform launcher will, with register, initialize and the launch mint in one call so
 * nothing can slip between them. It exists to show on the real chain that routers and trackers
 * accept a pool behind the gate hook, before the platform launcher is written. It has no presale
 * behind it and only its deployer can use it. Not part of the platform.
 */
contract FeeHookProofLauncher {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable permit2;
    address public hook;

    event Launched(address indexed token, PoolId indexed poolId, uint256 tokenId, uint128 liquidity, uint160 sqrtPriceX96);

    constructor(address poolManager_, address positionManager_, address permit2_) {
        owner = msg.sender;
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
    }

    /// @dev The PositionManager sweeps the ETH a mint did not need back here.
    receive() external payable {}

    /// @notice The hook names this launcher in its constructor, so it is deployed second and set once.
    function setHook(address hook_) external {
        require(msg.sender == owner && hook == address(0) && hook_ != address(0), "set hook");
        hook = hook_;
    }

    function launch(address token, uint256 tokenAmount, address wallet, uint16 marketingBps, uint16 rewardsBps)
        external
        payable
        returns (PoolId poolId, uint256 tokenId, uint128 liquidity)
    {
        require(msg.sender == owner && hook != address(0), "not ready");
        require(tokenAmount > 0 && msg.value > 0, "zero liquidity");
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        uint24 fee = uint24((uint256(HoodSaleV4FeeHook(payable(hook)).PLATFORM_TAX_BPS()) + marketingBps + rewardsBps) * 100);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: HoodSaleV4FeeHook(payable(hook)).TICK_SPACING(),
            hooks: IHooks(hook)
        });
        poolId = key.toId();
        uint160 sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(tokenAmount, 1 << 192, msg.value)));

        tokenId = IPositionManagerV4(positionManager).nextTokenId();
        HoodSaleV4FeeHook(payable(hook)).register(
            key,
            HoodSaleV4FeeHook.PoolConfig({
                token: token,
                marketingWallet: wallet,
                rewardsSink: rewardsBps != 0 ? wallet : address(0),
                marketingBuyBps: marketingBps,
                marketingSellBps: marketingBps,
                rewardsBuyBps: rewardsBps,
                rewardsSellBps: rewardsBps,
                taxLocked: true,
                walletLocked: false,
                exists: false
            }),
            tokenId
        );
        IPoolManager(poolManager).initialize(key, sqrtPriceX96);
        liquidity = _mint(key, tokenAmount, msg.value, sqrtPriceX96);

        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IERC20(token).safeTransfer(msg.sender, tokenDust);
        if (address(this).balance > 0) {
            (bool ok, ) = msg.sender.call{value: address(this).balance}("");
            require(ok, "refund");
        }
        emit Launched(token, poolId, tokenId, liquidity, sqrtPriceX96);
    }

    /// @dev The whole liquidity as one full-range position owned by the hook.
    function _mint(PoolKey memory key, uint256 tokenAmount, uint256 ethAmount, uint160 sqrtPriceX96)
        private
        returns (uint128 liquidity)
    {
        int24 tickLower = TickMath.minUsableTick(key.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(key.tickSpacing);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            ethAmount,
            tokenAmount
        );

        IERC20(Currency.unwrap(key.currency1)).forceApprove(permit2, tokenAmount);
        IAllowanceTransferV4(permit2).approve(
            Currency.unwrap(key.currency1),
            positionManager,
            uint160(tokenAmount),
            uint48(block.timestamp)
        );

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION),
            uint8(Actions.SETTLE_PAIR),
            uint8(Actions.SWEEP)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, tickLower, tickUpper, uint256(liquidity), uint128(ethAmount), uint128(tokenAmount), hook, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, address(this));
        IPositionManagerV4(positionManager).modifyLiquidities{value: ethAmount}(abi.encode(actions, params), block.timestamp);
    }
}
