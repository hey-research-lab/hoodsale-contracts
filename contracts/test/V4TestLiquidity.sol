// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";

/**
 * Test-only: adds liquidity to a pool straight on the PoolManager, without the PositionManager,
 * and donates to a pool's liquidity. A fee mode pool must refuse the first whoever asks and
 * whatever the range, because its hook lets in the launch position and nothing else; the second
 * is open to anyone and ends up in the launch position's fees. Not part of the platform.
 *
 * The caller pays: ETH with the call, tokens through an allowance to this contract.
 */
contract V4TestLiquidity is SafeCallback {
    using CurrencyLibrary for Currency;

    struct Call {
        bool isDonation;
        PoolKey key;
        ModifyLiquidityParams params;
        uint256 amount0;
        uint256 amount1;
        address payer;
    }

    constructor(IPoolManager manager) SafeCallback(manager) {}

    receive() external payable {}

    /// @notice Adds `liquidity` in the given range as a position owned by this contract.
    /// @return amount0 ETH the position took
    /// @return amount1 Tokens the position took
    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity, bytes32 salt)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        ModifyLiquidityParams memory params = ModifyLiquidityParams({
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidityDelta: int256(uint256(liquidity)),
            salt: salt
        });
        return _run(Call({isDonation: false, key: key, params: params, amount0: 0, amount1: 0, payer: msg.sender}));
    }

    /// @notice Donates to the pool's in-range liquidity, which collects it as fees.
    function donate(PoolKey calldata key, uint256 amount0, uint256 amount1)
        external
        payable
        returns (uint256, uint256)
    {
        ModifyLiquidityParams memory none;
        return
            _run(Call({isDonation: true, key: key, params: none, amount0: amount0, amount1: amount1, payer: msg.sender}));
    }

    function _run(Call memory c) private returns (uint256 amount0, uint256 amount1) {
        BalanceDelta delta = abi.decode(poolManager.unlock(abi.encode(c)), (BalanceDelta));
        amount0 = uint256(int256(-delta.amount0()));
        amount1 = uint256(int256(-delta.amount1()));
        // Whatever ETH was not needed goes back to the caller.
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok,) = msg.sender.call{value: left}("");
            require(ok, "refund failed");
        }
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        Call memory c = abi.decode(data, (Call));
        BalanceDelta delta;
        if (c.isDonation) {
            delta = poolManager.donate(c.key, c.amount0, c.amount1, "");
        } else {
            (delta,) = poolManager.modifyLiquidity(c.key, c.params, "");
        }
        _settle(c.key.currency0, delta.amount0(), c.payer);
        _settle(c.key.currency1, delta.amount1(), c.payer);
        return abi.encode(delta);
    }

    function _settle(Currency currency, int128 amount, address payer) private {
        if (amount >= 0) return;
        uint256 owed = uint256(int256(-amount));
        if (currency.isAddressZero()) {
            poolManager.settle{value: owed}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).transferFrom(payer, address(poolManager), owed);
            poolManager.settle();
        }
    }
}
