// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
import {TokenFactory} from "../../TokenFactory.sol";
import {HoodSaleV4FeeHook} from "./HoodSaleV4FeeHook.sol";
import {IPositionManagerV4} from "../interfaces/IPositionManagerV4.sol";
import {IAllowanceTransferV4} from "../interfaces/IAllowanceTransferV4.sol";
import {IPresaleFactoryView, IPresaleParamsView} from "../interfaces/IV4Launcher.sol";

/// @dev What the launcher asks of a token it created. Every v4 token answers the first four; only
///      a Rewards token has a hook of its own to name, the one address allowed to fund it.
interface IFeeModeToken {
    function transferOwnership(address newOwner) external;

    function owner() external view returns (address);

    function launcher() external view returns (address);

    function tokenType() external view returns (uint8);

    function hook() external view returns (address);
}

/// @dev What the launcher asks of its reader: a v4 lens is built for one launcher and one hook.
interface IFeeModeLens {
    function launcher() external view returns (address);

    function hook() external view returns (address);
}

/**
 * @title V4FeeLauncher
 * @notice Creates HoodSale tokens that list on Uniswap v4 in fee mode and opens their pools.
 *
 *         It is a twin of V4Launcher: the same functions, structs and events, so a presale, the
 *         v4 lens, the v4 router and the site talk to either without knowing which one it is.
 *         What differs is where the tax lives. Here the tax is the pool's own LP fee, fixed in the
 *         pool key when the pool opens, and the launch liquidity is one full-range position that
 *         the fee hook holds for good and collects the fee from.
 *
 *         That has three consequences. The buy and the sell rate are one rate, because a pool has
 *         one fee. The rate can never change, so a tax is only accepted already locked. And the
 *         liquidity is never burned or handed to the timed locker: the hook keeps it forever,
 *         whichever of the two a sale asked for, since whoever held the position would be paid
 *         the tax.
 *
 *         A presale calls `launch` when it finalizes. Declaring the pool to the hook, opening it
 *         at the listing price and minting the launch position to the hook all happen inside that
 *         one call, so nobody can open the pool first or put liquidity in beside the launch.
 */
contract V4FeeLauncher is Ownable, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /// @notice Matches Presale's LiquidityAction enum: Lock first, then Burn
    uint8 public constant ACTION_LOCK = 0;
    uint8 public constant ACTION_BURN = 1;
    /// @notice Fee mode has no timed lock. The getter exists because the v4 lens reads it from
    ///         whichever launcher it is deployed for.
    address public constant locker = address(0);
    /// @notice The largest supply a fee mode token may have: 1e18 whole tokens at 18 decimals.
    ///         Uniswap v4 keeps pool amounts and the fees a position is owed in int128; a supply
    ///         under that bound can never overflow them, so a launch always mints and the hook
    ///         can always collect.
    uint256 public constant MAX_TOTAL_SUPPLY = 1e36;

    struct TaxConfig {
        address marketingWallet;
        uint16 marketingBuyBps;
        uint16 marketingSellBps;
        uint16 rewardsBuyBps;
        uint16 rewardsSellBps;
        bool taxLocked;
        bool walletLocked;
    }

    struct TokenSpec {
        string name;
        string symbol;
        uint256 totalSupply;
        /// @notice The reward token of a Rewards launch; ignored by the other types
        address rewardToken;
    }

    struct Launch {
        PoolId poolId;
        uint256 tokenId;
        uint256 lockId;
        bool burned;
        bool done;
    }

    address public immutable poolManager;
    address public immutable positionManager;
    address public immutable permit2;
    TokenFactory public immutable tokenFactory;
    address public immutable presaleFactory;
    address public immutable treasury;

    /// @notice The pool hook every launch of this launcher uses; set once, right after deployment
    address public hook;
    /// @notice The reader contract the site and the platform lens use for fee mode launches
    address public lens;
    /// @notice The platform bot allowed to run rewards distributions
    address public keeper;
    /// @notice Whether new tokens can be created here. A brake on creation only: tokens that
    ///         already exist launch whatever this says.
    bool public creationOpen = true;

    mapping(address => TaxConfig) private _pendingConfig;
    mapping(address => Launch) private _launchOf;
    mapping(address => PoolKey) private _poolKeyOf;
    mapping(address => address) public creatorOf;
    mapping(address => address[]) private _tokensOfCreator;
    address[] public allTokens;

    event V4TokenCreated(address indexed token, address indexed creator, address owner, uint8 tokenType);
    event TaxConfigUpdated(address indexed token, TaxConfig config);
    event Launched(
        address indexed token,
        address indexed presale,
        PoolId poolId,
        uint256 tokenId,
        uint256 lockId,
        uint128 liquidity,
        uint160 sqrtPriceX96
    );
    /// @notice A sale asked for a timed lock and got the only thing fee mode has: forever
    event LockTreatedAsForever(address indexed token, address indexed presale, uint64 lockDuration);
    event HookSet(address hook);
    event LensSet(address lens);
    event KeeperSet(address keeper);
    event CreationOpenSet(bool open);

    error HookNotSet();
    error HookAlreadySet();
    error HookMismatch();
    error LensNotSet();
    error BadLens();
    error SupplyTooLarge();
    error CreationClosed();
    error NotFeeToken();
    error HookNotFunder();
    error NotPresale();
    error TokenMismatch();
    error NoPendingConfig();
    error AlreadyLaunched();
    error PriceOutOfRange();
    error PositionMismatch();
    error NotSeeded();
    error PositionNotHeld();
    error RefundFailed();
    error NotTokenOwner();
    error BadTokenType();
    error TaxTooHigh();
    error UnequalRates();
    error TaxNotFixed();
    error BadShares();
    error ZeroWallet();

    constructor(
        address owner_,
        address poolManager_,
        address positionManager_,
        address permit2_,
        TokenFactory tokenFactory_,
        address presaleFactory_,
        address treasury_
    ) Ownable(owner_) {
        require(
            poolManager_ != address(0) &&
                positionManager_ != address(0) &&
                permit2_ != address(0) &&
                address(tokenFactory_) != address(0) &&
                presaleFactory_ != address(0) &&
                treasury_ != address(0),
            "zero addr"
        );
        poolManager = poolManager_;
        positionManager = positionManager_;
        permit2 = permit2_;
        tokenFactory = tokenFactory_;
        presaleFactory = presaleFactory_;
        treasury = treasury_;
    }

    /// @dev The PositionManager returns unspent ETH here after a mint, and so may the PoolManager.
    receive() external payable {}

    // -------------------------------------------------------------- admin

    /// @notice Points the launcher at its hook. The hook's address encodes its permissions and
    ///         names this launcher, so the two are tied together and this can only be done once.
    ///         A hook built for other Uniswap contracts or another Treasury is refused, because a
    ///         wrong hook could never be replaced.
    function setHook(address hook_) external onlyOwner {
        if (hook != address(0)) revert HookAlreadySet();
        HoodSaleV4FeeHook feeHook = HoodSaleV4FeeHook(payable(hook_));
        if (
            feeHook.launcher() != address(this) ||
            address(feeHook.poolManager()) != poolManager ||
            address(feeHook.positionManager()) != positionManager ||
            feeHook.platformTreasury() != treasury
        ) revert HookMismatch();
        hook = hook_;
        emit HookSet(hook_);
    }

    /// @notice Sets the reader for fee mode launches. It can be replaced but never removed: the
    ///         platform lens reads a token with no v4 lens as a V2 token.
    function setLens(address lens_) external onlyOwner {
        if (hook == address(0)) revert HookNotSet();
        if (lens_ == address(0) || lens_.code.length == 0) revert BadLens();
        // A lens fixes its launcher and hook when it is built. One built for the other launcher, or
        // before this launcher had its hook, would answer nothing for every fee mode token.
        if (IFeeModeLens(lens_).launcher() != address(this) || IFeeModeLens(lens_).hook() != hook) revert BadLens();
        lens = lens_;
        emit LensSet(lens_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Stops or resumes the creation of new tokens. It never touches a launch.
    function setCreationOpen(bool open) external onlyOwner {
        creationOpen = open;
        emit CreationOpenSet(open);
    }

    // ----------------------------------------------------------- creation

    /**
     * @notice Creates a token that will list on Uniswap v4 in fee mode and records the tax its
     *         pool will charge. The supply and the ownership go to `owner_`. Until the pool opens
     *         the tax can still be corrected with `setTaxConfig`; once it is open it is the pool's
     *         fee and nobody can change it.
     * @param tokenType 0 Standard, 1 Tax, 2 Rewards, matching TokenFactory.TokenType
     * @param cfg The buy and the sell rate of each share must be equal and `taxLocked` must be
     *        true, which is what the pool will make of them anyway
     */
    function createToken(
        uint8 tokenType,
        TokenSpec calldata spec,
        TaxConfig calldata cfg,
        address owner_
    ) external returns (address token) {
        if (hook == address(0)) revert HookNotSet();
        if (lens == address(0)) revert LensNotSet();
        if (!creationOpen) revert CreationClosed();
        require(owner_ != address(0), "zero owner");
        _validateConfig(tokenType, cfg);
        if (spec.totalSupply > MAX_TOTAL_SUPPLY) revert SupplyTooLarge();

        if (tokenType == 0) {
            token = tokenFactory.createStandardToken(spec.name, spec.symbol, spec.totalSupply);
        } else if (tokenType == 1) {
            token = tokenFactory.createTaxToken(
                spec.name,
                spec.symbol,
                spec.totalSupply,
                cfg.marketingWallet,
                cfg.marketingBuyBps,
                cfg.marketingSellBps
            );
        } else {
            token = tokenFactory.createRewardsToken(
                spec.name,
                spec.symbol,
                spec.totalSupply,
                spec.rewardToken,
                cfg.marketingWallet,
                [cfg.rewardsBuyBps, cfg.rewardsSellBps, cfg.marketingBuyBps, cfg.marketingSellBps]
            );
        }

        // The factory's deployers decide what comes out. Deployers that do not know this launcher
        // hand back a V2 token, which answers no `launcher` call and must never be recorded here.
        (bool ok, bytes memory data) = token.staticcall(abi.encodeCall(IFeeModeToken.launcher, ()));
        if (!ok || data.length != 32 || abi.decode(data, (uint256)) != uint256(uint160(address(this)))) {
            revert NotFeeToken();
        }
        // A rewards token takes ETH from one address only, fixed when it is created. Unless that
        // is this launcher's hook, the holders' share could never reach it.
        if (tokenType == 2 && IFeeModeToken(token).hook() != hook) revert HookNotFunder();

        _pendingConfig[token] = cfg;
        creatorOf[token] = msg.sender;
        _tokensOfCreator[msg.sender].push(token);
        allTokens.push(token);

        IERC20(token).safeTransfer(owner_, spec.totalSupply);
        IFeeModeToken(token).transferOwnership(owner_);

        emit V4TokenCreated(token, msg.sender, owner_, tokenType);
        emit TaxConfigUpdated(token, cfg);
    }

    /// @notice Corrects the tax a token's pool will charge, before the pool is opened. Afterwards
    ///         the rates are the pool's fee and cannot be changed by anyone.
    function setTaxConfig(address token, TaxConfig calldata cfg) external {
        if (_launchOf[token].done) revert AlreadyLaunched();
        if (_pendingConfig[token].marketingWallet == address(0)) revert NoPendingConfig();
        if (msg.sender != IFeeModeToken(token).owner()) revert NotTokenOwner();
        _validateConfig(IFeeModeToken(token).tokenType(), cfg);
        _pendingConfig[token] = cfg;
        emit TaxConfigUpdated(token, cfg);
    }

    // ------------------------------------------------------------- launch

    /**
     * @notice Opens the token's pool and provides the launch liquidity. Called by the presale as
     *         it finalizes, which must have approved this contract for `tokenAmount` first.
     * @param liquidityAction Accepted for both of Presale's values and treated the same: the
     *        position goes to the hook and stays there. A sale cannot be told at creation that
     *        fee mode has no timed lock, and refusing it here would strand its buyers, so a Lock
     *        sale is locked forever and says so with `LockTreatedAsForever`.
     * @param lockDuration Only reported in that event
     * @param saleOwner Unused: nobody can ever take the position back
     * @return poolId The pool that was opened
     * @return tokenId The position that holds the launch liquidity, held by the hook
     * @return lockId Always zero: there is no lock to look up
     * @return liquidity The liquidity the position was opened with
     */
    function launch(
        address token,
        uint256 tokenAmount,
        uint8 liquidityAction,
        uint64 lockDuration,
        address saleOwner
    ) external payable nonReentrant returns (PoolId poolId, uint256 tokenId, uint256 lockId, uint128 liquidity) {
        // The sale owner would own a timed lock. There is none here, so the argument only keeps
        // the call the same as V4Launcher's.
        saleOwner;
        if (hook == address(0)) revert HookNotSet();
        if (!IPresaleFactoryView(presaleFactory).isPresale(msg.sender)) revert NotPresale();
        (address saleToken, , , , , , , , , , , , , ) = IPresaleParamsView(msg.sender).params();
        if (saleToken != token) revert TokenMismatch();

        TaxConfig memory cfg = _pendingConfig[token];
        if (cfg.marketingWallet == address(0)) revert NoPendingConfig();
        if (_launchOf[token].done) revert AlreadyLaunched();
        require(tokenAmount > 0 && msg.value > 0, "zero liquidity");

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        PoolKey memory key = _keyFor(token);
        poolId = key.toId();
        uint160 sqrtPriceX96 = _sqrtPriceX96For(tokenAmount, msg.value);

        // The hook lets one position into the pool, the one with the id declared here. Nothing
        // between this line and the mint can mint another, so the next id is the launch's.
        tokenId = IPositionManagerV4(positionManager).nextTokenId();
        HoodSaleV4FeeHook(payable(hook)).register(
            key,
            HoodSaleV4FeeHook.PoolConfig({
                token: token,
                marketingWallet: cfg.marketingWallet,
                // A rewards token turns the holders' share into rewards itself, so it is its own sink.
                rewardsSink: cfg.rewardsBuyBps != 0 ? token : address(0),
                marketingBuyBps: cfg.marketingBuyBps,
                marketingSellBps: cfg.marketingSellBps,
                rewardsBuyBps: cfg.rewardsBuyBps,
                rewardsSellBps: cfg.rewardsSellBps,
                taxLocked: true,
                walletLocked: cfg.walletLocked,
                exists: false
            }),
            tokenId
        );
        IPoolManager(poolManager).initialize(key, sqrtPriceX96);

        uint256 minted;
        (minted, liquidity) = _mintPosition(key, tokenAmount, msg.value, sqrtPriceX96, hook);

        // The launch is only good if the declared position is the one that went in and the hook
        // holds it. Anything else would leave the tax with nobody, or with somebody else.
        if (minted != tokenId) revert PositionMismatch();
        if (!HoodSaleV4FeeHook(payable(hook)).seeded(poolId)) revert NotSeeded();
        if (IPositionManagerV4(positionManager).ownerOf(tokenId) != hook) revert PositionNotHeld();

        // `burned` tells the lens there is no lock to read; the position's holder is the hook.
        _launchOf[token] = Launch({poolId: poolId, tokenId: tokenId, lockId: 0, burned: true, done: true});
        _poolKeyOf[token] = key;

        if (liquidityAction == ACTION_LOCK) emit LockTreatedAsForever(token, msg.sender, lockDuration);

        _refund(token, msg.sender);
        emit Launched(token, msg.sender, poolId, tokenId, lockId, liquidity, sqrtPriceX96);
    }

    /// @dev Mints the whole launch liquidity as one full-range position owned by `recipient`.
    function _mintPosition(
        PoolKey memory key,
        uint256 tokenAmount,
        uint256 ethAmount,
        uint160 sqrtPriceX96,
        address recipient
    ) private returns (uint256 tokenId, uint128 liquidity) {
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
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            uint128(ethAmount),
            uint128(tokenAmount),
            recipient,
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        // Whatever ETH the position did not need comes straight back here.
        params[2] = abi.encode(key.currency0, address(this));

        tokenId = IPositionManagerV4(positionManager).nextTokenId();
        IPositionManagerV4(positionManager).modifyLiquidities{value: ethAmount}(
            abi.encode(actions, params),
            block.timestamp
        );
    }

    /// @dev Rounding leaves a little ETH or a few tokens behind; they belong to the sale. The
    ///      sale takes ETH from its launcher only, so the refund is paid from here and never
    ///      swept to the sale by the PositionManager.
    function _refund(address token, address to) private {
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IERC20(token).safeTransfer(to, tokenDust);
        uint256 ethDust = address(this).balance;
        if (ethDust > 0) {
            (bool ok, ) = to.call{value: ethDust}("");
            if (!ok) revert RefundFailed();
        }
    }

    // -------------------------------------------------------------- views

    function poolKeyOf(address token) external view returns (PoolKey memory) {
        return _poolKeyOf[token];
    }

    function launchOf(address token) external view returns (Launch memory) {
        return _launchOf[token];
    }

    /// @notice The tax a token's pool will charge. A presale hashes these seven words when it is
    ///         created and lists only while they are unchanged; zeros for a token not made here.
    function pendingConfig(address token) external view returns (TaxConfig memory) {
        return _pendingConfig[token];
    }

    function isV4Token(address token) external view returns (bool) {
        return _pendingConfig[token].marketingWallet != address(0);
    }

    function tokensOfCreator(address creator) external view returns (address[] memory) {
        return _tokensOfCreator[creator];
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice The pool key a token lists with: native ETH first, then the token, and the tax as
    ///         the fee. It follows the pending tax until the pool opens and is final after that.
    function keyFor(address token) external view returns (PoolKey memory) {
        return _keyFor(token);
    }

    // ---------------------------------------------------------- internals

    /// @dev The fee tier is a pure function of the pending tax, so the terms a presale hashed
    ///      bind the whole key. A pool fee is in hundredths of a bip: 325 bps is 32,500.
    function _keyFor(address token) private view returns (PoolKey memory) {
        TaxConfig storage cfg = _pendingConfig[token];
        return
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(token),
                fee: uint24(_totalBps(cfg.marketingBuyBps, cfg.rewardsBuyBps) * 100),
                tickSpacing: HoodSaleV4FeeHook(payable(hook)).TICK_SPACING(),
                hooks: IHooks(hook)
            });
    }

    /// @dev What a trade pays in all: the platform's share, the creator's and the holders'.
    function _totalBps(uint16 marketingBps, uint16 rewardsBps) private view returns (uint256) {
        return uint256(HoodSaleV4FeeHook(payable(hook)).PLATFORM_TAX_BPS()) + marketingBps + rewardsBps;
    }

    /// @dev The pool's opening price, from the amounts the sale is listing with. Native ETH sorts
    ///      first, so the price is tokens per ETH in Q64.96.
    function _sqrtPriceX96For(uint256 tokenAmount, uint256 ethAmount) private pure returns (uint160) {
        // tokenAmount * 2^192 only fits 256 bits while the ratio is under 2^64. Above that the root
        // is taken at 2^128 and scaled, which loses nothing that matters at such a price. The
        // supply cap keeps the ratio far below the 2^128 where this form would overflow too.
        uint256 root = tokenAmount >> 64 < ethAmount
            ? Math.sqrt(Math.mulDiv(tokenAmount, 1 << 192, ethAmount))
            : Math.sqrt(Math.mulDiv(tokenAmount, 1 << 128, ethAmount)) << 32;
        if (root < TickMath.MIN_SQRT_PRICE || root >= TickMath.MAX_SQRT_PRICE) revert PriceOutOfRange();
        return uint160(root);
    }

    /// @dev A pool has one fee and keeps it, so both rates of a share must be equal and the tax
    ///      must come locked; a presale checks the same lock before it lists a Standard token.
    ///      The shares must fit the kind of token: a Standard token charges the platform's share
    ///      only, and only a Rewards token has holders to pay, so it must pay them something.
    function _validateConfig(uint8 tokenType, TaxConfig calldata cfg) private view {
        if (tokenType > 2) revert BadTokenType();
        if (cfg.marketingWallet == address(0)) revert ZeroWallet();
        if (cfg.marketingBuyBps != cfg.marketingSellBps || cfg.rewardsBuyBps != cfg.rewardsSellBps) {
            revert UnequalRates();
        }
        if (!cfg.taxLocked) revert TaxNotFixed();
        if (_totalBps(cfg.marketingBuyBps, cfg.rewardsBuyBps) > HoodSaleV4FeeHook(payable(hook)).MAX_TOTAL_TAX_BPS()) {
            revert TaxTooHigh();
        }
        if (
            (tokenType == 0 && cfg.marketingBuyBps != 0) ||
            (tokenType != 2 && cfg.rewardsBuyBps != 0) ||
            (tokenType == 2 && cfg.rewardsBuyBps == 0)
        ) revert BadShares();
    }
}
