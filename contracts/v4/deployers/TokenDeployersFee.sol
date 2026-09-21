// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.26;

import {StandardToken} from "../../tokens/StandardToken.sol";
import {TaxToken} from "../../tokens/TaxToken.sol";
import {RewardsTokenCode} from "../../tokens/RewardsTokenCode.sol";
import {RewardsTokenCodeV4} from "../tokens/RewardsTokenCodeV4.sol";
import {HoodSaleTokenV4} from "../tokens/HoodSaleTokenV4.sol";
import {IUniswapV2Router02} from "../../interfaces/IUniswapV2.sol";
import {TokenFactory} from "../../TokenFactory.sol";

/**
 * Token deployers that know both Uniswap v4 launchers.
 *
 * They are the V4 generation with one more creator recognised. TokenFactory is still not changed
 * at all and still calls these with the same arguments: when the creator is the hook mode
 * launcher or the fee mode launcher the token is the plain, tax-free v4 token, created with that
 * launcher as its own, and otherwise it is the very same V2 token as before, deployed by the
 * identical expression. The v4 tokens themselves are reused byte for byte; a fee mode token
 * differs from a hook mode one only in the launcher it names, and through it the hook that may
 * fund its rewards.
 */

interface IPresaleFactoryQuickLaunch {
    function quickLaunch() external view returns (address);
}

interface IRewardRouteStore {
    function rewardRouteV3Of(address rewardToken) external view returns (bytes memory);
}

contract StandardTokenDeployerFee {
    address public immutable factory;
    /// @notice The hook mode launcher. The name is the V4 generation's, which scripts still read.
    address public immutable launcher;
    address public immutable feeLauncher;

    constructor(address factory_, address launcher_, address feeLauncher_) {
        require(launcher_ != address(0) && feeLauncher_ != address(0), "zero launcher");
        require(launcher_ != feeLauncher_, "same launcher");
        factory = factory_;
        launcher = launcher_;
        feeLauncher = feeLauncher_;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address router_,
        uint16 platformTaxBps_
    ) external returns (address) {
        require(msg.sender == factory, "only factory");
        if (creator_ == launcher || creator_ == feeLauncher) {
            return address(new HoodSaleTokenV4(name_, symbol_, totalSupply_, creator_, factory, 0));
        }
        return address(
            new StandardToken(name_, symbol_, totalSupply_, creator_, treasury_, factory, router_, platformTaxBps_)
        );
    }
}

contract TaxTokenDeployerFee {
    address public immutable factory;
    /// @notice The hook mode launcher. The name is the V4 generation's, which scripts still read.
    address public immutable launcher;
    address public immutable feeLauncher;

    constructor(address factory_, address launcher_, address feeLauncher_) {
        require(launcher_ != address(0) && feeLauncher_ != address(0), "zero launcher");
        require(launcher_ != feeLauncher_, "same launcher");
        factory = factory_;
        launcher = launcher_;
        feeLauncher = feeLauncher_;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address router_,
        uint16 platformTaxBps_,
        address marketingWallet_,
        uint16 buyTaxBps_,
        uint16 sellTaxBps_
    ) external returns (address) {
        require(msg.sender == factory, "only factory");
        if (creator_ == launcher || creator_ == feeLauncher) {
            // The marketing wallet and the tax rates belong to the pool on a v4 launch, so the
            // launcher that created the token registers them there; the token itself stays plain.
            return address(new HoodSaleTokenV4(name_, symbol_, totalSupply_, creator_, factory, 1));
        }
        return address(
            new TaxToken(
                name_, symbol_, totalSupply_, creator_, treasury_, factory, router_,
                platformTaxBps_, marketingWallet_, buyTaxBps_, sellTaxBps_
            )
        );
    }
}

contract RewardsTokenDeployerFee {
    address public immutable factory;
    address public immutable v3Router;
    address public immutable v3Quoter;
    RewardsTokenCode public immutable rewardsTokenCode;
    RewardsTokenCodeV4 public immutable rewardsTokenCodeV4;
    /// @notice The hook mode launcher. The name is the V4 generation's, which scripts still read.
    address public immutable launcher;
    address public immutable feeLauncher;

    constructor(
        address factory_,
        address v3Router_,
        address v3Quoter_,
        RewardsTokenCode code_,
        RewardsTokenCodeV4 codeV4_,
        address launcher_,
        address feeLauncher_
    ) {
        require(address(code_) != address(0) && address(codeV4_) != address(0), "zero code");
        require(launcher_ != address(0) && feeLauncher_ != address(0), "zero launcher");
        require(launcher_ != feeLauncher_, "same launcher");
        factory = factory_;
        v3Router = v3Router_;
        v3Quoter = v3Quoter_;
        rewardsTokenCode = code_;
        rewardsTokenCodeV4 = codeV4_;
        launcher = launcher_;
        feeLauncher = feeLauncher_;
    }

    function deploy(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address creator_,
        address treasury_,
        address router_,
        uint16 platformTaxBps_,
        address rewardToken_,
        address marketingWallet_,
        uint16[4] calldata taxes_
    ) external returns (address token) {
        require(msg.sender == factory, "only factory");
        // The token reads its hook from the launcher it is given, so a fee mode token takes its
        // rewards from the fee hook and a hook mode token from the tax hook.
        bytes memory initCode = (creator_ == launcher || creator_ == feeLauncher)
            ? abi.encodePacked(
                rewardsTokenCodeV4.creationCode(),
                abi.encode(
                    name_, symbol_, totalSupply_, creator_, factory, rewardToken_,
                    IUniswapV2Router02(router_).WETH(), v3Router, v3Quoter, platformRouteV3For(rewardToken_)
                )
            )
            : abi.encodePacked(
                rewardsTokenCode.creationCode(),
                abi.encode(
                    name_, symbol_, totalSupply_, creator_, treasury_, factory, router_,
                    platformTaxBps_, rewardToken_, marketingWallet_, taxes_,
                    v3Router, v3Quoter, platformRouteV3For(rewardToken_)
                )
            );
        assembly ("memory-safe") {
            token := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(token != address(0), "token deploy failed");
    }

    /// @notice The V3 path the platform's current QuickLaunch stores for `rewardToken`; empty when
    ///         there is none, or when the presale factory or its QuickLaunch has no route store.
    function platformRouteV3For(address rewardToken) public view returns (bytes memory) {
        if (v3Router == address(0)) return "";
        address presaleFactory = TokenFactory(factory).presaleFactory();
        if (presaleFactory == address(0)) return "";
        (bool ok, bytes memory data) = presaleFactory.staticcall(
            abi.encodeCall(IPresaleFactoryQuickLaunch.quickLaunch, ())
        );
        if (!ok || data.length < 32) return "";
        address quickLaunch = abi.decode(data, (address));
        if (quickLaunch == address(0)) return "";
        (ok, data) = quickLaunch.staticcall(abi.encodeCall(IRewardRouteStore.rewardRouteV3Of, (rewardToken)));
        if (!ok || data.length < 64) return "";
        return abi.decode(data, (bytes));
    }
}
