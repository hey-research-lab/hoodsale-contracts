// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPositionManagerV4} from "../interfaces/IPositionManagerV4.sol";

interface IOwnable {
    function owner() external view returns (address);
}

/**
 * @title HoodSaleV4FeeHook
 * @notice The tax of a HoodSale launch that lists on Uniswap v4 in fee mode.
 *
 *         In fee mode the tax is the pool's own LP fee. Nothing is charged by a hook during a
 *         swap, so the pool trades like any plain v4 pool and every router can use it without
 *         knowing HoodSale. The fee a pool charges goes to its liquidity, and the whole liquidity
 *         of a launch is one full-range position that this contract holds. Collecting that
 *         position's fees is therefore collecting the tax: ETH on buys, tokens on sells.
 *
 *         This contract does three jobs.
 *
 *         It is the gate of the pool. Only the launcher can open a pool with this hook, and the
 *         only liquidity a pool ever accepts is the launch position, once. Without the gate a
 *         stranger's narrow position would earn most of the fee and the advertised split would be
 *         false.
 *
 *         It is the holder of the launch position, forever. No function transfers, approves or
 *         burns the position, and the only liquidity change it can encode is a decrease of zero,
 *         which collects the fees and leaves the principal in place. There is no owner and no
 *         upgrade path.
 *
 *         It turns the fees into ETH and splits them. Token fees are sold back into the same pool
 *         by `convert`, which anyone may call but whose size and pace the contract decides. Every
 *         ETH amount is booked to the platform, the marketing wallet and the rewards token in the
 *         ratio of their rates, and sent later by `flush`, so a wallet that rejects ETH can never
 *         block a collection.
 *
 *         The pool's fee is fixed when the pool opens. That makes the tax of a fee mode launch
 *         immutable, the same on buys and sells: there is no setTaxes here.
 */
contract HoodSaleV4FeeHook is BaseHook, ReentrancyGuard, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice The platform's share of every trade, matching the other launch modes
    uint16 public constant PLATFORM_TAX_BPS = 25;
    /// @notice Total tax cap, 10% including the platform share
    uint16 public constant MAX_TOTAL_TAX_BPS = 1_000;
    int24 public constant TICK_SPACING = 200;
    /// @notice The most one conversion may sell, in bps of the pool's token reserve
    uint256 public constant MAX_CONVERT_BPS = 100;
    /// @notice The shortest time between two conversions of one pool
    uint64 public constant CONVERT_COOLDOWN = 300;
    /// @dev Gas allowance for a push to a wallet or contract we do not control
    uint256 private constant PUSH_GAS = 100_000;

    address public immutable launcher;
    address public immutable platformTreasury;
    IPositionManagerV4 public immutable positionManager;

    /// @dev Same fields in the same order as HoodSaleV4Hook.PoolConfig, so the lens and the site
    ///      decode both hooks alike. Buy and sell rates are always equal here.
    struct PoolConfig {
        address token;
        /// @notice Receives the creator's share; never zero on a registered pool
        address marketingWallet;
        /// @notice A rewards token that turns ETH into holder rewards; zero on Standard and Tax launches
        address rewardsSink;
        uint16 marketingBuyBps;
        uint16 marketingSellBps;
        uint16 rewardsBuyBps;
        uint16 rewardsSellBps;
        bool taxLocked;
        bool walletLocked;
        bool exists;
    }

    struct PoolState {
        /// @notice The launch position, held by this contract
        uint256 tokenId;
        /// @notice Token fees collected and not yet sold for ETH
        uint256 pendingTokens;
        uint64 lastConvertAt;
        /// @notice Set by the launch position's mint; no liquidity is accepted after it
        bool seeded;
    }

    mapping(PoolId => PoolConfig) private _configOf;
    mapping(PoolId => PoolKey) private _keyOf;
    mapping(PoolId => PoolState) private _stateOf;
    /// @notice The HoodSale pool of a token; zero id when the token has no launch here
    mapping(address => PoolId) public poolIdOf;

    /// @notice ETH owed to a pool's marketing wallet, waiting for a flush
    mapping(PoolId => uint256) public pendingMarketing;
    /// @notice ETH owed to a pool's rewards token, waiting for a flush
    mapping(PoolId => uint256) public pendingRewards;
    /// @notice ETH owed to the platform Treasury across every pool
    uint256 public pendingPlatform;

    event PoolRegistered(PoolId indexed poolId, address indexed token, PoolKey key, PoolConfig config, uint256 tokenId);
    event LiquiditySeeded(PoolId indexed poolId, uint256 tokenId, uint256 liquidity);
    event FeesCollected(PoolId indexed poolId, uint256 ethFees, uint256 tokenFees);
    event Converted(PoolId indexed poolId, address indexed caller, uint256 tokensSold, uint256 ethOut);
    event FeeBooked(PoolId indexed poolId, uint256 platform, uint256 marketing, uint256 rewards);
    event MarketingWalletUpdated(PoolId indexed poolId, address wallet);
    event MarketingWalletLocked(PoolId indexed poolId);
    event Flushed(PoolId indexed poolId, address indexed to, uint256 amount, bool ok);
    event PlatformFlushed(uint256 amount, bool ok);

    error NotLauncher();
    error NotTokenOwner();
    error AlreadyRegistered();
    error Unregistered();
    error BadKey();
    error ZeroWallet();
    error TaxTooHigh();
    error UnequalRates();
    error TaxNotFixed();
    error SettingLocked();
    error NoRewardsSink();
    error LiquidityClosed();
    error NotSeeded();
    error CoolingDown();
    error NothingToConvert();
    error Expired();
    error PartialFill();
    error TooLittleReceived(uint256 got, uint256 min);

    constructor(
        IPoolManager poolManager_,
        address positionManager_,
        address launcher_,
        address treasury_
    ) BaseHook(poolManager_) {
        require(
            positionManager_ != address(0) && launcher_ != address(0) && treasury_ != address(0),
            "zero addr"
        );
        positionManager = IPositionManagerV4(positionManager_);
        launcher = launcher_;
        platformTreasury = treasury_;
    }

    /// @dev Only the PoolManager pays ETH here: collected fees and the proceeds of a conversion.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    // ------------------------------------------------------------ registration

    /**
     * @notice The launcher declares a pool before opening it. Called once per token.
     * @param tokenId The id the launch position will be minted with. The launcher registers,
     *        opens the pool and mints in one call, so this is the PositionManager's next id.
     */
    function register(PoolKey calldata key, PoolConfig calldata cfg, uint256 tokenId) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (cfg.marketingBuyBps != cfg.marketingSellBps || cfg.rewardsBuyBps != cfg.rewardsSellBps) {
            revert UnequalRates();
        }
        if (!cfg.taxLocked) revert TaxNotFixed();
        uint256 total = uint256(PLATFORM_TAX_BPS) + cfg.marketingBuyBps + cfg.rewardsBuyBps;
        if (total > MAX_TOTAL_TAX_BPS) revert TaxTooHigh();
        if (
            !key.currency0.isAddressZero() ||
            Currency.unwrap(key.currency1) != cfg.token ||
            cfg.token == address(0) ||
            address(key.hooks) != address(this) ||
            key.fee != total * 100 ||
            key.tickSpacing != TICK_SPACING ||
            tokenId == 0
        ) revert BadKey();
        if (cfg.marketingWallet == address(0)) revert ZeroWallet();
        if (cfg.rewardsSink == address(0) && cfg.rewardsBuyBps != 0) revert NoRewardsSink();

        PoolId id = key.toId();
        // One pool per token: the same token at another rate is another pool id, and a second
        // registration would take over `poolIdOf` and orphan the first pool's fees.
        if (_configOf[id].exists || PoolId.unwrap(poolIdOf[cfg.token]) != bytes32(0)) revert AlreadyRegistered();

        PoolConfig memory stored = cfg;
        stored.exists = true;
        _configOf[id] = stored;
        _keyOf[id] = key;
        _stateOf[id].tokenId = tokenId;
        poolIdOf[cfg.token] = id;
        emit PoolRegistered(id, cfg.token, key, stored, tokenId);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (sender != launcher) revert NotLauncher();
        if (!_configOf[key.toId()].exists) revert Unregistered();
        return BaseHook.beforeInitialize.selector;
    }

    /// @dev Lets the launch position in, once, and nothing after it. The PositionManager salts a
    ///      position with its token id, which is how the launch mint is told from any other.
    ///      Collecting fees is a change of zero liquidity and never reaches this gate.
    function _beforeAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata
    ) internal override returns (bytes4) {
        PoolId id = key.toId();
        PoolState storage s = _stateOf[id];
        if (
            sender != address(positionManager) ||
            s.seeded ||
            s.tokenId == 0 ||
            uint256(params.salt) != s.tokenId ||
            params.tickLower != TickMath.minUsableTick(TICK_SPACING) ||
            params.tickUpper != TickMath.maxUsableTick(TICK_SPACING)
        ) revert LiquidityClosed();
        s.seeded = true;
        emit LiquiditySeeded(id, s.tokenId, uint256(params.liquidityDelta));
        return BaseHook.beforeAddLiquidity.selector;
    }

    // ------------------------------------------------------------ collecting

    /**
     * @notice Collects the fees the launch position has earned and books the ETH part. Anyone may
     *         call it; a static call reads what is waiting in the position.
     * @return ethFees ETH collected, already booked to the three shares
     * @return tokenFees Tokens collected, waiting for `convert`
     */
    function collect(PoolId id) external nonReentrant returns (uint256 ethFees, uint256 tokenFees) {
        return _collect(id);
    }

    /// @dev Taking liquidity out is never encoded here: the only decrease this contract can
    ///      perform is one of zero liquidity, which collects the fees and nothing else.
    ///      Uniswap v4 casts the fees a position is owed to int128, so a collection could only
    ///      fail for a token whose supply exceeds that; the launcher caps the supply far below it.
    function _collect(PoolId id) private returns (uint256 ethFees, uint256 tokenFees) {
        PoolState storage s = _stateOf[id];
        if (!s.seeded) revert NotSeeded();
        PoolKey memory key = _keyOf[id];
        IERC20 token = IERC20(Currency.unwrap(key.currency1));
        uint256 ethBefore = address(this).balance;
        uint256 tokenBefore = token.balanceOf(address(this));

        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(s.tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        ethFees = address(this).balance - ethBefore;
        tokenFees = token.balanceOf(address(this)) - tokenBefore;
        if (ethFees > 0) _book(id, ethFees);
        if (tokenFees > 0) s.pendingTokens += tokenFees;
        emit FeesCollected(id, ethFees, tokenFees);
    }

    // ------------------------------------------------------------ converting

    /**
     * @notice Sells collected token fees for ETH in the pool they came from and books the ETH.
     *         Anyone may call it. The caller chooses neither the amount nor the pace: one call
     *         sells at most `maxConvert`, and a pool converts at most once per cooldown.
     * @param quotedTokens The size the caller's floor was quoted for. The contract picks the real
     *        size when it runs, so the floor is scaled to it: the pair is a price, not an amount.
     * @param minEthOut The least ETH a conversion of `quotedTokens` must return. Pass (1, 0) for
     *        no floor.
     */
    function convert(PoolId id, uint256 quotedTokens, uint256 minEthOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensSold, uint256 ethOut)
    {
        if (block.timestamp > deadline) revert Expired();
        PoolState storage s = _stateOf[id];
        if (block.timestamp < uint256(s.lastConvertAt) + CONVERT_COOLDOWN) revert CoolingDown();
        _collect(id);

        uint256 amountIn = Math.min(s.pendingTokens, maxConvert(id));
        if (amountIn == 0) revert NothingToConvert();
        s.lastConvertAt = uint64(block.timestamp);

        (tokensSold, ethOut) = abi.decode(poolManager.unlock(abi.encode(id, amountIn)), (uint256, uint256));
        uint256 floor = Math.mulDiv(minEthOut, tokensSold, quotedTokens, Math.Rounding.Ceil);
        if (ethOut < floor) revert TooLittleReceived(ethOut, floor);
        s.pendingTokens -= tokensSold;
        if (ethOut > 0) _book(id, ethOut);
        emit Converted(id, msg.sender, tokensSold, ethOut);
    }

    /// @dev The PoolManager calls back here only inside the `unlock` that `convert` opened.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (PoolId id, uint256 amountIn) = abi.decode(data, (PoolId, uint256));
        PoolKey memory key = _keyOf[id];
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        uint256 spent = uint256(int256(-delta.amount1()));
        if (spent != amountIn) revert PartialFill();
        uint256 out = uint256(int256(delta.amount0()));

        poolManager.sync(key.currency1);
        IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(poolManager), spent);
        poolManager.settle();
        if (out > 0) poolManager.take(key.currency0, address(this), out);
        return abi.encode(spent, out);
    }

    /// @notice The most tokens one conversion may sell now: a share of the pool's token reserve
    ///         that grows with the tax, half the tax rate and never above `MAX_CONVERT_BPS`.
    function maxConvert(PoolId id) public view returns (uint256) {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) return 0;
        (uint160 sqrtPriceX96, , , ) = StateLibrary.getSlot0(poolManager, id);
        uint256 reserve = Math.mulDiv(StateLibrary.getLiquidity(poolManager, id), sqrtPriceX96, 1 << 96);
        return (reserve * Math.min(_totalBps(cfg) / 2, MAX_CONVERT_BPS)) / BPS;
    }

    /// @dev Splits an ETH amount in the ratio of the rates. Rounding dust goes to the platform.
    function _book(PoolId id, uint256 amount) private {
        PoolConfig storage cfg = _configOf[id];
        uint256 total = _totalBps(cfg);
        uint256 marketing = (amount * cfg.marketingBuyBps) / total;
        uint256 rewards = (amount * cfg.rewardsBuyBps) / total;
        uint256 platform = amount - marketing - rewards;
        if (marketing > 0) pendingMarketing[id] += marketing;
        if (rewards > 0) pendingRewards[id] += rewards;
        if (platform > 0) pendingPlatform += platform;
        emit FeeBooked(id, platform, marketing, rewards);
    }

    // ------------------------------------------------------------ paying out

    /// @notice Sends a pool's collected creator and rewards shares. Anyone may call it; a
    ///         recipient that rejects the ETH only leaves its own share pending.
    function flush(PoolId id) external nonReentrant {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) revert Unregistered();
        _push(id, cfg.marketingWallet, pendingMarketing);
        if (cfg.rewardsSink != address(0)) _push(id, cfg.rewardsSink, pendingRewards);
    }

    /// @notice Sends the platform's collected share to the Treasury. Anyone may call it.
    function flushPlatform() external nonReentrant {
        uint256 amount = pendingPlatform;
        if (amount == 0) return;
        pendingPlatform = 0;
        (bool ok, ) = platformTreasury.call{value: amount, gas: PUSH_GAS}("");
        if (!ok) pendingPlatform = amount;
        emit PlatformFlushed(amount, ok);
    }

    function _push(PoolId id, address to, mapping(PoolId => uint256) storage ledger) private {
        uint256 amount = ledger[id];
        if (amount == 0) return;
        ledger[id] = 0;
        (bool ok, ) = to.call{value: amount, gas: PUSH_GAS}("");
        if (!ok) ledger[id] = amount;
        emit Flushed(id, to, amount, ok);
    }

    // ------------------------------------------------------------ creator controls

    modifier onlyTokenOwner(PoolId id) {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) revert Unregistered();
        if (msg.sender != IOwnable(cfg.token).owner()) revert NotTokenOwner();
        _;
    }

    function setMarketingWallet(PoolId id, address wallet) external onlyTokenOwner(id) {
        PoolConfig storage cfg = _configOf[id];
        if (cfg.walletLocked) revert SettingLocked();
        if (wallet == address(0)) revert ZeroWallet();
        cfg.marketingWallet = wallet;
        emit MarketingWalletUpdated(id, wallet);
    }

    /// @notice Freezes the wallet that receives the creator's share for good.
    function lockMarketingWallet(PoolId id) external onlyTokenOwner(id) {
        _configOf[id].walletLocked = true;
        emit MarketingWalletLocked(id);
    }

    // ------------------------------------------------------------ views

    function configOf(PoolId id) external view returns (PoolConfig memory) {
        return _configOf[id];
    }

    function poolKeyOf(PoolId id) external view returns (PoolKey memory) {
        return _keyOf[id];
    }

    function configOfToken(address token) external view returns (PoolConfig memory) {
        return _configOf[poolIdOf[token]];
    }

    /// @notice The launch position of a pool, held here for good.
    function positionIdOf(PoolId id) external view returns (uint256) {
        return _stateOf[id].tokenId;
    }

    function seeded(PoolId id) external view returns (bool) {
        return _stateOf[id].seeded;
    }

    function pendingTokens(PoolId id) external view returns (uint256) {
        return _stateOf[id].pendingTokens;
    }

    function lastConvertAt(PoolId id) external view returns (uint64) {
        return _stateOf[id].lastConvertAt;
    }

    function nextConvertAt(PoolId id) external view returns (uint256) {
        return uint256(_stateOf[id].lastConvertAt) + CONVERT_COOLDOWN;
    }

    /// @notice The total fee a trade pays, platform share included. The same in both directions;
    ///         the flag is kept so both hooks answer the same call.
    function feeBps(PoolId id, bool) external view returns (uint16) {
        PoolConfig storage cfg = _configOf[id];
        if (!cfg.exists) return 0;
        return uint16(_totalBps(cfg));
    }

    function _totalBps(PoolConfig storage cfg) private view returns (uint256) {
        return uint256(PLATFORM_TAX_BPS) + cfg.marketingBuyBps + cfg.rewardsBuyBps;
    }
}
