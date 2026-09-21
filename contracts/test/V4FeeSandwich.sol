// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SafeCallback} from "@uniswap/v4-periphery/src/base/SafeCallback.sol";
import {HoodSaleV4FeeHook} from "../v4/fee/HoodSaleV4FeeHook.sol";

/**
 * Test-only attacker for fee mode: trades around the fee hook's conversion inside one
 * transaction, the way a sandwich bot would, and reports what it made or lost. A conversion is a
 * sale of tokens by the hook, so the textbook attack sells first, lets the conversion push the
 * price further down and buys back below. Not part of the platform.
 *
 * It trades from its own balances: send it the ETH and the tokens it may use before calling
 * `run`. The steps are free-form so a test can search over sizes and orders; `ALL` stands for
 * whatever closes the position the earlier steps opened.
 */
contract V4FeeSandwich is SafeCallback {
    using PoolIdLibrary for PoolKey;

    enum Kind {
        /// Sells `amount` tokens. ALL: every token gained so far in this run.
        SellExactIn,
        /// Spends `amount` ETH on tokens. ALL: all the ETH gained so far in this run.
        BuyExactIn,
        /// Sells tokens for exactly `amount` ETH. ALL: the ETH spent so far in this run.
        SellExactOut,
        /// Buys exactly `amount` tokens. ALL: the tokens sold so far in this run.
        BuyExactOut,
        /// Calls the hook's `convert` with no floor, as the victim of the sandwich.
        Convert
    }

    struct Step {
        Kind kind;
        uint256 amount;
    }

    uint256 public constant ALL = type(uint256).max;

    HoodSaleV4FeeHook public immutable hook;

    /// @notice What one run changed: the attacker's own balances, and what the hook converted
    event Ran(int256 ethDelta, int256 tokenDelta, uint256 tokensConverted, uint256 ethConverted);

    constructor(IPoolManager manager, HoodSaleV4FeeHook hook_) SafeCallback(manager) {
        hook = hook_;
    }

    receive() external payable {}

    /**
     * @notice Runs the steps in order, in this one transaction.
     * @return ethDelta The change of this contract's ETH balance; the profit once the token
     *         position is closed
     * @return tokenDelta The change of this contract's token balance
     * @return tokensConverted Tokens the hook sold in the Convert steps
     * @return ethConverted ETH the hook received for them
     */
    function run(PoolKey calldata key, Step[] calldata steps)
        external
        returns (int256 ethDelta, int256 tokenDelta, uint256 tokensConverted, uint256 ethConverted)
    {
        IERC20 token = IERC20(Currency.unwrap(key.currency1));
        uint256 ethStart = address(this).balance;
        uint256 tokenStart = token.balanceOf(address(this));

        for (uint256 i = 0; i < steps.length; i++) {
            Kind kind = steps[i].kind;
            uint256 amount = steps[i].amount;
            if (kind == Kind.Convert) {
                (uint256 sold, uint256 got) = hook.convert(key.toId(), 1, 0, block.timestamp);
                tokensConverted += sold;
                ethConverted += got;
                continue;
            }
            if (amount == ALL) {
                uint256 ethNow = address(this).balance;
                uint256 tokenNow = token.balanceOf(address(this));
                if (kind == Kind.SellExactIn) amount = tokenNow > tokenStart ? tokenNow - tokenStart : 0;
                else if (kind == Kind.BuyExactIn) amount = ethNow > ethStart ? ethNow - ethStart : 0;
                else if (kind == Kind.SellExactOut) amount = ethStart > ethNow ? ethStart - ethNow : 0;
                else amount = tokenStart > tokenNow ? tokenStart - tokenNow : 0;
            }
            if (amount == 0) continue;
            bool buy = kind == Kind.BuyExactIn || kind == Kind.BuyExactOut;
            bool exactIn = kind == Kind.SellExactIn || kind == Kind.BuyExactIn;
            _swap(key, buy, exactIn, amount);
        }

        ethDelta = int256(address(this).balance) - int256(ethStart);
        tokenDelta = int256(token.balanceOf(address(this))) - int256(tokenStart);
        emit Ran(ethDelta, tokenDelta, tokensConverted, ethConverted);
    }

    /// @dev A buy pays ETH (currency0) for the token; every swap runs to the end of the price range.
    function _swap(PoolKey calldata key, bool buy, bool exactIn, uint256 amount) private {
        SwapParams memory params = SwapParams({
            zeroForOne: buy,
            amountSpecified: exactIn ? -int256(amount) : int256(amount),
            sqrtPriceLimitX96: buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
        poolManager.unlock(abi.encode(key, params));
    }

    function _unlockCallback(bytes calldata data) internal override returns (bytes memory) {
        (PoolKey memory key, SwapParams memory params) = abi.decode(data, (PoolKey, SwapParams));
        BalanceDelta delta = poolManager.swap(key, params, "");

        if (delta.amount0() < 0) poolManager.settle{value: uint256(int256(-delta.amount0()))}();
        if (delta.amount1() < 0) {
            poolManager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).transfer(address(poolManager), uint256(int256(-delta.amount1())));
            poolManager.settle();
        }
        if (delta.amount0() > 0) poolManager.take(key.currency0, address(this), uint256(int256(delta.amount0())));
        if (delta.amount1() > 0) poolManager.take(key.currency1, address(this), uint256(int256(delta.amount1())));
        return "";
    }
}
