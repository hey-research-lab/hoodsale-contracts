// Integration tests against the REAL Uniswap V2 (Router02, Factory, WETH) and the REAL Uniswap
// V3 (SwapRouter02, QuoterV2, the TSLA pools) on a Robinhood Chain mainnet fork. The offline
// suite uses the mocks; here we verify how faithful they are and explicitly test the differences
// (MINIMUM_LIQUIDITY, revert messages, fee-on-transfer paths, pre-seeded pair behaviour, the V3
// stock rewards of a quick launch).
//
// Run: npm run test:fork
//   or FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK=<recent block> \
//        npx hardhat test test/fork/robinhood-uniswap.test.js
const { expect } = require("chai");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const hre = require("hardhat");
const H = require("./helpers");
const { rewardRoutesFor, applyRewardRoutes, describeRewardRoutes, decodeV3Path, describeV3Hops } = require("../../scripts/lib/reward-tokens");
const { createKeeper } = require("../../scripts/launch-keeper");

const E = ethers.parseEther;
const BPS = 10_000n;
const MAGNITUDE = 1n << 128n;
const DAY = 86400n;
const FEE = E("0.1");
const ZERO = ethers.ZeroAddress;
const { DEAD, MINIMUM_LIQUIDITY, ROBINHOOD } = H;
const WETH = ROBINHOOD.weth;
const Lock = 0;
const Burn = 1;
const Finalized = 5n;

if (!process.env.FORK_URL) {
  describe.skip("Robinhood Chain fork (real Uniswap V2)", function () {
    it("skipped: FORK_URL is not set, run `npm run test:fork` to fork Robinhood Chain mainnet", function () {});
  });
} else {
  describe("Robinhood Chain fork (real Uniswap V2)", forkSuite);
}

// ---------------------------------------------------------------- trade helpers

async function buy(router, token, signer, ethAmt) {
  return router
    .connect(signer)
    .swapExactETHForTokens(0, [WETH, token.target], signer.address, await H.deadline(), { value: ethAmt });
}

async function sell(router, token, signer, amount) {
  await token.connect(signer).approve(ROBINHOOD.router, amount);
  return router
    .connect(signer)
    .swapExactTokensForETHSupportingFeeOnTransferTokens(
      amount,
      0,
      [token.target, WETH],
      signer.address,
      await H.deadline()
    );
}

async function addLiq(router, token, signer, tokenAmt, ethAmt) {
  await token.connect(signer).approve(ROBINHOOD.router, tokenAmt);
  return router
    .connect(signer)
    .addLiquidityETH(token.target, tokenAmt, 0, 0, signer.address, await H.deadline(), { value: ethAmt });
}

async function createPresale(ctx, token, owner, p) {
  const required = await ctx.presaleFactory.requiredTokensFor(p);
  await token.connect(owner).approve(ctx.presaleFactory.target, required);
  await ctx.presaleFactory.connect(owner).createPresale(p, { value: FEE });
  const n = await ctx.presaleFactory.allPresalesLength();
  return ethers.getContractAt("Presale", await ctx.presaleFactory.allPresales(n - 1n));
}

// ---------------------------------------------------------------- fixtures

async function baseFixture() {
  return H.deployPlatformOnFork();
}

/**
 * Standard token PUMP (alice) + Lock presale: bob 3 + carol 3 = 6 ETH, sale ended,
 * NOT finalized. Second token BRN + Burn presale: bob 5 + carol 5 = hardcap.
 * PUMP finalize expectations: fee 0.6, liq 3.24 ETH + 129600 tokens, claim 150k/150k,
 * 286400 tokens + 2.16 ETH to the owner. BRN: fee 1, liq 5.4 ETH + 216000 tokens, claim 250k/250k.
 */
async function readyFixture() {
  const ctx = await baseFixture();
  const { tokenFactory, alice, bob, carol } = ctx;

  await tokenFactory.connect(alice).createStandardToken("Pump", "PUMP", E("1000000"));
  const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(0));
  await tokenFactory.connect(alice).createStandardToken("Burnt", "BRN", E("1000000"));
  const burnToken = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(1));

  const now = BigInt(await time.latest());
  const start = now + 100n;
  const params = {
    token: token.target,
    presaleRate: E("50000"),
    listingRate: E("40000"),
    softCap: E("5"),
    hardCap: E("10"),
    minContribution: E("0.1"),
    maxContribution: E("5"),
    startTime: start,
    endTime: start + DAY,
    liquidityBps: 6000,
    liquidityAction: Lock,
    lockDuration: 30n * DAY,
    launchTime: 0,
    whitelistEnabled: false,
  };
  const burnParams = { ...params, token: burnToken.target, liquidityAction: Burn, lockDuration: 0n };

  const presale = await createPresale(ctx, token, alice, params);
  const burnPresale = await createPresale(ctx, burnToken, alice, burnParams);

  await time.increaseTo(start);
  await presale.connect(bob).contribute({ value: E("3") });
  await presale.connect(carol).contribute({ value: E("3") });
  await burnPresale.connect(bob).contribute({ value: E("5") });
  await burnPresale.connect(carol).contribute({ value: E("5") });
  await time.increaseTo(start + DAY + 1n);

  const pair = H.pairAt(await token.mainPair());
  const burnPair = H.pairAt(await burnToken.mainPair());
  return { ...ctx, token, burnToken, presale, burnPresale, params, burnParams, pair, burnPair };
}

/** PUMP finalized, bob and carol have claimed (150k tokens each). Pool: 129600 PUMP / 3.24 WETH. */
async function launchedFixture() {
  const ctx = await readyFixture();
  await ctx.presale.connect(ctx.alice).finalize(0, 0);
  await ctx.presale.connect(ctx.bob).claim();
  await ctx.presale.connect(ctx.carol).claim();
  return ctx;
}

/** TaxToken (alice, marketing dave, buy 4 / sell 5), 500k + 100 ETH liquidity through the real router. */
async function taxFixture() {
  const ctx = await baseFixture();
  const { tokenFactory, router, alice, bob, dave } = ctx;
  await tokenFactory.connect(alice).createTaxToken("Taxed", "TAXD", E("1000000"), dave.address, 400, 500);
  const token = await ethers.getContractAt("TaxToken", await tokenFactory.allTokens(0));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("300000"));
  const pair = H.pairAt(await token.mainPair());
  return { ...ctx, token, pair };
}

/** RewardsToken, reward token is the REAL WETH; rewards 3/3, marketing 1/1 (+1 platform). */
async function rewardsFixture() {
  const ctx = await baseFixture();
  const { tokenFactory, router, alice, bob, carol, dave } = ctx;
  await tokenFactory
    .connect(alice)
    .createRewardsToken("Divi", "DIVI", E("1000000"), WETH, dave.address, [300, 300, 100, 100]);
  const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(0));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("200000"));
  await token.connect(alice).transfer(carol.address, E("100000"));
  const pair = H.pairAt(await token.mainPair());
  return { ...ctx, token, pair };
}

/** RewardsToken, reward token is a real tokenized stock (TSLA); 3-hop path: token -> WETH -> TSLA. */
async function stockFixture() {
  const ctx = await baseFixture();
  const { tokenFactory, router, alice, bob, dave } = ctx;
  await tokenFactory
    .connect(alice)
    .createRewardsToken("StockRew", "SREW", E("1000000"), ROBINHOOD.tsla, dave.address, [300, 300, 0, 0]);
  const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(0));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("200000"));
  const pair = H.pairAt(await token.mainPair());
  const tsla = H.erc20At(ROBINHOOD.tsla);
  return { ...ctx, token, pair, tsla };
}

/** RewardsToken, reward token is the real USDG; 3-hop path token -> WETH -> USDG, the second hop is the REAL USDG/WETH pool. */
async function usdgFixture() {
  const ctx = await baseFixture();
  const { tokenFactory, dexFactory, router, alice, bob, carol, dave } = ctx;
  await tokenFactory
    .connect(alice)
    .createRewardsToken("Dollar", "DOLR", E("1000000"), ROBINHOOD.usdg, dave.address, [300, 300, 0, 0]);
  const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens(0));
  await addLiq(router, token, alice, E("500000"), E("100"));
  await token.connect(alice).transfer(bob.address, E("200000"));
  await token.connect(alice).transfer(carol.address, E("100000"));
  const pair = H.pairAt(await token.mainPair());
  const usdg = H.erc20At(ROBINHOOD.usdg);
  const usdgPairAddr = await dexFactory.getPair(WETH, ROBINHOOD.usdg);
  const usdgPair = usdgPairAddr === ZERO ? null : H.pairAt(usdgPairAddr);
  return { ...ctx, token, pair, usdg, usdgPair };
}

/**
 * HOODS presale (deployer), whitelist enabled: alice 4 + bob 2 = 6 ETH, carol is not on the list.
 * Expectation: fee 0.6, liq 3.78 ETH + 3,024,000 HOODS (listing 800k / ETH), claim 4M / 2M.
 */
async function hoodsaleReadyFixture() {
  const ctx = await baseFixture();
  const { hoodsale, deployer, alice, bob, carol } = ctx;
  const now = BigInt(await time.latest());
  const start = now + 100n;
  const hoodParams = {
    token: hoodsale.target,
    presaleRate: E("1000000"),
    listingRate: E("800000"),
    softCap: E("3"),
    hardCap: E("10"),
    minContribution: E("0.1"),
    maxContribution: E("5"),
    startTime: start,
    endTime: start + DAY,
    liquidityBps: 7000,
    liquidityAction: Lock,
    lockDuration: 365n * DAY,
    launchTime: 0,
    whitelistEnabled: true,
  };
  const hoodPresale = await createPresale(ctx, hoodsale, deployer, hoodParams);
  await hoodPresale.connect(deployer).addToWhitelist([alice.address, bob.address]);
  await time.increaseTo(start);
  await expect(hoodPresale.connect(carol).contribute({ value: E("1") })).to.be.revertedWith("not whitelisted");
  await hoodPresale.connect(alice).contribute({ value: E("4") });
  await hoodPresale.connect(bob).contribute({ value: E("2") });
  await time.increaseTo(start + DAY + 1n);
  const hoodPair = H.pairAt(await hoodsale.mainPair());
  return { ...ctx, hoodPresale, hoodParams, hoodPair };
}

async function hoodsaleLaunchedFixture() {
  const ctx = await hoodsaleReadyFixture();
  await ctx.hoodPresale.connect(ctx.deployer).finalize(0, 0);
  await ctx.hoodPresale.connect(ctx.alice).claim();
  await ctx.hoodPresale.connect(ctx.bob).claim();
  return ctx;
}

// ================================================================ suite

function forkSuite() {
  this.timeout(600000);

  // Does a WETH/TSLA pair exist (if not, the 3-hop stock reward test is skipped)
  const stock = { pair: ZERO, live: false, reason: "" };

  before(async function () {
    const info = await H.forkInfo();
    expect(info, "hardhat_metadata.forkedNetwork (forking not active?)").to.not.equal(null);
    console.log(`      [fork] chainId ${info.chainId}, pinned block ${info.forkBlockNumber}, ${info.clientVersion}`);
    expect(Number(info.chainId)).to.equal(ROBINHOOD.chainId);
    // eth_call does not work on the fork block itself (see helpers.mineOne); mine one block first.
    await H.mineOne();

    const router = H.routerAt();
    const factory = H.factoryAt();
    await H.withRetry(
      async () => {
        expect(await ethers.provider.getCode(ROBINHOOD.router)).to.not.equal("0x");
        expect(await router.factory()).to.equal(ROBINHOOD.factory);
        expect(await router.WETH()).to.equal(WETH);
        const feeTo = await factory.feeTo();
        const pairs = await factory.allPairsLength();
        console.log(`      [fork] factory.feeTo ${feeTo} (protocol fee ${feeTo === ZERO ? "off" : "ON"}), ${pairs} pairs`);

        const pairAddr = await factory.getPair(WETH, ROBINHOOD.tsla);
        if (pairAddr === ZERO) {
          stock.reason = "no WETH/TSLA Uniswap V2 pair exists on Robinhood Chain (factory.getPair returned zero)";
        } else {
          const [r0, r1] = await H.pairAt(pairAddr).getReserves();
          if (r0 === 0n || r1 === 0n) stock.reason = `WETH/TSLA pair ${pairAddr} exists but has no reserves`;
          else {
            stock.live = true;
            stock.pair = pairAddr;
          }
        }
        console.log(`      [fork] WETH/TSLA pair: ${stock.live ? stock.pair : "none (" + stock.reason + ")"}`);
      },
      { label: "preflight" }
    );
  });

  // -------------------------------------------------------------- 1. token creation

  describe("1. token creation on the real Uniswap V2 factory", function () {
    it("all three token types open their token/WETH pair on the real factory and register it as AMM pair", async function () {
      const { tokenFactory, dexFactory, hoodsale, alice, dave } = await loadFixture(baseFixture);
      const pairsBefore = await dexFactory.allPairsLength();

      await tokenFactory.connect(alice).createStandardToken("Alpha", "ALPHA", E("1000"));
      await tokenFactory.connect(alice).createTaxToken("Taxed", "TAXD", E("2000"), dave.address, 400, 500);
      await tokenFactory
        .connect(alice)
        .createRewardsToken("Divi", "DIVI", E("3000"), WETH, dave.address, [300, 300, 100, 100]);
      expect(await dexFactory.allPairsLength()).to.equal(pairsBefore + 3n);

      for (let i = 0; i < 3; i++) {
        const token = await ethers.getContractAt("StandardToken", await tokenFactory.allTokens(i));
        const pairAddr = await token.mainPair();
        expect(pairAddr).to.not.equal(ZERO);
        expect(await dexFactory.getPair(token.target, WETH)).to.equal(pairAddr);
        expect(await dexFactory.getPair(WETH, token.target)).to.equal(pairAddr);
        expect(await token.isAmmPair(pairAddr)).to.equal(true);
        expect(await token.router()).to.equal(ROBINHOOD.router);

        const pair = H.pairAt(pairAddr);
        const [lo, hi] =
          token.target.toLowerCase() < WETH.toLowerCase() ? [token.target, WETH] : [WETH, token.target];
        expect(await pair.token0()).to.equal(lo);
        expect(await pair.token1()).to.equal(hi);
        expect(await pair.totalSupply()).to.equal(0n);
        expect(await pair.MINIMUM_LIQUIDITY()).to.equal(MINIMUM_LIQUIDITY);
      }

      // The HOODS constructor also opened a pair on the real factory
      const hoodPair = await hoodsale.mainPair();
      expect(hoodPair).to.not.equal(ZERO);
      expect(await dexFactory.getPair(hoodsale.target, WETH)).to.equal(hoodPair);
      expect(await hoodsale.isAmmPair(hoodPair)).to.equal(true);
    });

    it("adopts a pair a griefer pre-created on the real factory for the predicted token address", async function () {
      const { tokenFactory, dexFactory, alice, carol } = await loadFixture(baseFixture);
      const standardDeployer = await tokenFactory.standardDeployer();
      const nonce = await ethers.provider.getTransactionCount(standardDeployer);
      const predicted = ethers.getCreateAddress({ from: standardDeployer, nonce });

      // The real factory does not check for code at the token address in createPair; the attack is possible on mainnet too.
      await dexFactory.connect(carol).createPair(predicted, WETH);
      const preCreated = await dexFactory.getPair(predicted, WETH);
      expect(preCreated).to.not.equal(ZERO);

      await expect(tokenFactory.connect(alice).createStandardToken("Pre", "PRE", E("1000000"))).to.not.be.reverted;
      const tokenAddr = await tokenFactory.allTokens(0);
      expect(tokenAddr).to.equal(predicted);
      const token = await ethers.getContractAt("StandardToken", tokenAddr);
      expect(await token.mainPair()).to.equal(preCreated);
      expect(await token.isAmmPair(preCreated)).to.equal(true);
      expect(await token.balanceOf(alice.address)).to.equal(E("1000000"));
    });
  });

  // -------------------------------------------------------------- 2. presale lifecycle

  describe("2. presale lifecycle with liquidity on the real router", function () {
    it("finalize (Lock) runs the real addLiquidityETH: reserves at listing rate, LP minus MINIMUM_LIQUIDITY locked, fees and claims exact", async function () {
      const ctx = await loadFixture(readyFixture);
      const { presale, token, pair, weth, treasury, locker, lens, alice, bob, carol } = ctx;
      const liqEth = E("3.24");
      const liqTokens = E("129600");
      // The real UniswapV2Pair mints 1000 wei of LP to address(0) on the first mint (the mock router does not)
      const expectedLp = H.firstMintLiquidity(liqTokens, liqEth);
      expect(expectedLp).to.equal(E("648") - MINIMUM_LIQUIDITY);

      const tx = presale.connect(alice).finalize(0, 0);
      await expect(tx).to.emit(presale, "Finalized").withArgs(E("0.6"), liqEth, liqTokens, expectedLp);
      // Treasury gets exactly 10%, the owner gets the remainder (6 - 0.6 - 3.24 = 2.16), no router refund
      await expect(tx).to.changeEtherBalances([treasury, alice], [E("0.6"), E("2.16")]);
      await expect(tx).to.emit(treasury, "RevenueReceived").withArgs(presale.target, E("0.6"), E("0.18"));
      // leftover tokens to the owner: 716000 - 129600 - 300000
      await expect(tx).to.changeTokenBalance(token, alice, E("286400"));
      expect(await ethers.provider.getBalance(presale.target)).to.equal(0n);
      expect(await token.balanceOf(presale.target)).to.equal(E("300000"));

      // real pair reserves are exactly at the listing rate
      const r = await H.reservesOf(pair, token.target);
      expect(r.token).to.equal(liqTokens);
      expect(r.weth).to.equal(liqEth);
      expect(await token.balanceOf(pair.target)).to.equal(liqTokens);
      expect(await weth.balanceOf(pair.target)).to.equal(liqEth);
      expect((r.token * E("1")) / r.weth).to.equal(E("40000"));

      // LP accounting
      expect(await presale.lpAmount()).to.equal(expectedLp);
      expect(await pair.totalSupply()).to.equal(expectedLp + MINIMUM_LIQUIDITY);
      expect(await pair.balanceOf(ZERO)).to.equal(MINIMUM_LIQUIDITY);
      expect(await pair.balanceOf(locker.target)).to.equal(expectedLp);
      expect(await pair.balanceOf(presale.target)).to.equal(0n);
      const lockId = await presale.lpLockId();
      const lock = await locker.locks(lockId);
      expect(lock.token).to.equal(pair.target);
      expect(lock.owner).to.equal(alice.address);
      expect(lock.amount).to.equal(expectedLp);
      expect(lock.unlockTime).to.equal((await presale.finalizedAt()) + 30n * DAY);

      // claim = contribution * presaleRate / 1e18
      await expect(presale.connect(bob).claim()).to.changeTokenBalance(token, bob, E("150000"));
      await expect(presale.connect(carol).claim()).to.changeTokenBalance(token, carol, E("150000"));
      expect(await presale.status()).to.equal(Finalized);

      // The Lens reads 1.00x from the real reserves
      const v = await lens.launchView(presale.target);
      expect(v.priceAvailable).to.equal(true);
      expect(v.liquidityWeth).to.equal(liqEth);
      expect(v.multiplierX18).to.equal(E("1"));
      expect(v.lpBurned).to.equal(false);

      // when the lock expires the real LP returns to the owner
      await expect(locker.connect(alice).unlock(lockId)).to.be.revertedWith("still locked");
      await time.increaseTo(lock.unlockTime);
      await locker.connect(alice).unlock(lockId);
      expect(await pair.balanceOf(alice.address)).to.equal(expectedLp);
    });

    it("finalize (Burn) on a second token sends the real LP to 0xdEaD", async function () {
      const ctx = await loadFixture(readyFixture);
      const { burnPresale, burnToken, burnPair, treasury, lens, alice, bob, carol } = ctx;
      const liqEth = E("5.4");
      const liqTokens = E("216000");
      const expectedLp = H.firstMintLiquidity(liqTokens, liqEth);
      expect(expectedLp).to.equal(E("1080") - MINIMUM_LIQUIDITY);

      const tx = burnPresale.connect(alice).finalize(0, 0);
      await expect(tx).to.emit(burnPresale, "Finalized").withArgs(E("1"), liqEth, liqTokens, expectedLp);
      await expect(tx).to.changeEtherBalances([treasury, alice], [E("1"), E("3.6")]);

      expect(await burnPresale.lpAmount()).to.equal(expectedLp);
      expect(await burnPair.balanceOf(DEAD)).to.equal(expectedLp);
      expect(await burnPair.balanceOf(burnPresale.target)).to.equal(0n);
      expect(await burnPair.totalSupply()).to.equal(expectedLp + MINIMUM_LIQUIDITY);
      const r = await H.reservesOf(burnPair, burnToken.target);
      expect(r.token).to.equal(liqTokens);
      expect(r.weth).to.equal(liqEth);

      await expect(burnPresale.connect(bob).claim()).to.changeTokenBalance(burnToken, bob, E("250000"));
      await expect(burnPresale.connect(carol).claim()).to.changeTokenBalance(burnToken, carol, E("250000"));
      expect(await burnToken.balanceOf(burnPresale.target)).to.equal(0n);
      expect((await lens.launchView(burnPresale.target)).lpBurned).to.equal(true);
    });
  });

  // -------------------------------------------------------------- 3. trading

  describe("3. trading after launch through the real router", function () {
    it("a buy pays exactly the 0.25 percent platform tax; the router quote equals the V2 formula", async function () {
      const { token, router, pair, dave } = await loadFixture(launchedFixture);
      const r = await H.reservesOf(pair, token.target);
      const ethIn = E("1");
      const raw = (await router.getAmountsOut(ethIn, [WETH, token.target]))[1];
      expect(raw).to.equal(H.getAmountOut(ethIn, r.weth, r.token));
      const fee = (raw * 25n) / BPS;

      await buy(router, token, dave, ethIn);
      expect(await token.balanceOf(dave.address)).to.equal(raw - fee);
      expect(await token.balanceOf(token.target)).to.equal(fee);
      expect(await token.pendingPlatformTokens()).to.equal(fee);
      const after = await H.reservesOf(pair, token.target);
      expect(after.token).to.equal(r.token - raw);
      expect(after.weth).to.equal(r.weth + ethIn);
    });

    it("a sell pays exactly 0.25 percent and the seller receives the V2 output for the taxed input", async function () {
      const { token, router, pair, bob } = await loadFixture(launchedFixture);
      const r = await H.reservesOf(pair, token.target);
      const amount = E("10000");
      const fee = (amount * 25n) / BPS;
      const effIn = amount - fee;
      const expectedOut = H.getAmountOut(effIn, r.token, r.weth);
      expect(expectedOut).to.be.gt(0n);

      await token.connect(bob).approve(ROBINHOOD.router, amount);
      const tx = router
        .connect(bob)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          amount,
          0,
          [token.target, WETH],
          bob.address,
          await H.deadline()
        );
      await expect(tx).to.changeEtherBalances([bob], [expectedOut]);
      const after = await H.reservesOf(pair, token.target);
      expect(after.token).to.equal(r.token + effIn);
      expect(after.weth).to.equal(r.weth - expectedOut);
      expect(await token.pendingPlatformTokens()).to.equal(fee);
      expect(await token.balanceOf(token.target)).to.equal(fee);
    });

    it("volume past swapThreshold makes the next sell run _swapBack on the real router: Treasury gets the ETH, 30 percent earmarked", async function () {
      const { token, router, pair, treasury, alice, bob } = await loadFixture(launchedFixture);
      expect(await token.swapThreshold()).to.equal(E("1000")); // 1M / 1000
      // Reaching the threshold at 0.25% takes 400k of sells; bob is given tokens via a wallet transfer (tax free)
      await token.connect(alice).transfer(bob.address, E("300000"));

      await sell(router, token, bob, E("200000")); // +500 pending (0.25%)
      await sell(router, token, bob, E("200000")); // +500 => 1000 = threshold
      expect(await token.pendingPlatformTokens()).to.equal(E("1000"));

      // Two nested swaps: first the contract sells the accrued 1000, then the user's 997.5 goes through (0.25%)
      const r = await H.reservesOf(pair, token.target);
      const swapBackOut = H.getAmountOut(E("1000"), r.token, r.weth);
      const userOut = H.getAmountOut(E("997.5"), r.token + E("1000"), r.weth - swapBackOut);
      const treBefore = await ethers.provider.getBalance(treasury.target);
      const reserveBefore = await treasury.buybackReserve();

      await token.connect(bob).approve(ROBINHOOD.router, E("1000"));
      const tx = router
        .connect(bob)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          E("1000"),
          0,
          [token.target, WETH],
          bob.address,
          await H.deadline()
        );
      await expect(tx).to.emit(token, "SwapBack").withArgs(E("1000"), swapBackOut);
      await expect(tx)
        .to.emit(treasury, "RevenueReceived")
        .withArgs(token.target, swapBackOut, (swapBackOut * 3000n) / BPS);
      await expect(tx).to.changeEtherBalances([bob], [userOut]);

      expect(await ethers.provider.getBalance(treasury.target)).to.equal(treBefore + swapBackOut);
      expect(await treasury.buybackReserve()).to.equal(reserveBefore + (swapBackOut * 3000n) / BPS);
      expect(await token.pendingPlatformTokens()).to.equal(E("2.5"));
      expect(await token.balanceOf(token.target)).to.equal(E("2.5"));
      expect(await ethers.provider.getBalance(token.target)).to.equal(0n);
      const after = await H.reservesOf(pair, token.target);
      expect(after.token).to.equal(r.token + E("1000") + E("997.5"));
      expect(after.weth).to.equal(r.weth - swapBackOut - userOut);
    });

    it("the plain swapExactTokensForETH reverts with UniswapV2: K for a taxed wallet (frontend must use the fee-on-transfer variant)", async function () {
      const { token, router, alice, bob } = await loadFixture(launchedFixture);
      await token.connect(bob).approve(ROBINHOOD.router, E("1000"));
      await expect(
        router.connect(bob).swapExactTokensForETH(E("1000"), 0, [token.target, WETH], bob.address, await H.deadline())
      ).to.be.revertedWith("UniswapV2: K");
      // the same function works for the tax-exempt owner
      await token.connect(alice).approve(ROBINHOOD.router, E("1000"));
      await expect(
        router
          .connect(alice)
          .swapExactTokensForETH(E("1000"), 0, [token.target, WETH], alice.address, await H.deadline())
      ).to.not.be.reverted;
    });

    it("TaxToken: creator taxes on top of the platform tax, wallet transfers tax free, swap-back splits ETH pro rata with the marketing wallet", async function () {
      const { token, router, pair, treasury, bob, carol, dave } = await loadFixture(taxFixture);

      // wallet-to-wallet transfer is tax free
      await token.connect(bob).transfer(carol.address, E("10000"));
      expect(await token.balanceOf(carol.address)).to.equal(E("10000"));
      expect(await token.balanceOf(token.target)).to.equal(0n);
      expect(await token.pendingPlatformTokens()).to.equal(0n);
      expect(await token.pendingMarketingTokens()).to.equal(0n);

      // buy: 0.25% platform + 4% owner
      const raw = (await router.getAmountsOut(E("1"), [WETH, token.target]))[1];
      const platformFee = (raw * 25n) / BPS;
      const creatorFee = (raw * 400n) / BPS;
      await buy(router, token, carol, E("1"));
      expect(await token.balanceOf(carol.address)).to.equal(E("10000") + raw - platformFee - creatorFee);
      expect(await token.pendingPlatformTokens()).to.equal(platformFee);
      expect(await token.pendingMarketingTokens()).to.equal(creatorFee);

      // two sells of 10k: platform +25, marketing +500 (each)
      await sell(router, token, bob, E("10000"));
      await sell(router, token, bob, E("10000"));
      const pendingP = await token.pendingPlatformTokens();
      const pendingM = await token.pendingMarketingTokens();
      expect(pendingP).to.equal(platformFee + E("50"));
      expect(pendingM).to.equal(creatorFee + E("1000"));
      expect(pendingP + pendingM).to.be.gte(await token.swapThreshold());

      const r = await H.reservesOf(pair, token.target);
      const total = pendingP + pendingM;
      const ethGained = H.getAmountOut(total, r.token, r.weth);
      const marketingEth = (ethGained * pendingM) / total;
      const platformEth = ethGained - marketingEth;
      const treBefore = await ethers.provider.getBalance(treasury.target);
      const mktBefore = await ethers.provider.getBalance(dave.address);
      const reserveBefore = await treasury.buybackReserve();

      const tx = sell(router, token, bob, E("1000"));
      await expect(tx).to.emit(token, "SwapBack").withArgs(total, ethGained);
      expect(await ethers.provider.getBalance(dave.address)).to.equal(mktBefore + marketingEth);
      expect(await ethers.provider.getBalance(treasury.target)).to.equal(treBefore + platformEth);
      expect(await treasury.buybackReserve()).to.equal(reserveBefore + (platformEth * 3000n) / BPS);
      expect(await token.pendingPlatformTokens()).to.equal(E("2.5"));
      expect(await token.pendingMarketingTokens()).to.equal(E("50"));
      expect(await token.balanceOf(token.target)).to.equal(E("52.5"));
    });
  });

  // -------------------------------------------------------------- 4. rewards

  describe("4. RewardsToken with real WETH, USDG and tokenized stock rewards", function () {
    it("rewards, marketing and platform taxes accrue separately on real trades", async function () {
      const { token, router, bob } = await loadFixture(rewardsFixture);
      const raw = (await router.getAmountsOut(E("1"), [WETH, token.target]))[1];
      await buy(router, token, bob, E("1"));
      expect(await token.pendingRewardsTokens()).to.equal((raw * 300n) / BPS);
      expect(await token.pendingMarketingTokens()).to.equal((raw * 100n) / BPS);
      expect(await token.pendingPlatformTokens()).to.equal((raw * 25n) / BPS);

      const before = await token.pendingRewardsTokens();
      await sell(router, token, bob, E("10000"));
      expect(await token.pendingRewardsTokens()).to.equal(before + E("300"));
    });

    // rewardToken == WETH: the contract uses the ETH path and wraps into WETH (the real pair does not throw INVALID_TO).
    it("rewardToken = WETH: distributeRewards pays real WETH pro rata", async function () {
      const { token, router, pair, weth, alice, bob, carol } = await loadFixture(rewardsFixture);
      await sell(router, token, bob, E("20000")); // rewards 600, marketing 200, platform 200
      expect(await token.pendingRewardsTokens()).to.equal(E("600"));

      const r = await H.reservesOf(pair, token.target);
      const expectedReceived = H.getAmountOut(E("600"), r.token, r.weth);
      const wethBefore = await weth.balanceOf(token.target);

      const tx = token.connect(alice).distributeRewards(0);
      await expect(tx).to.emit(token, "RewardsDistributed").withArgs(E("600"), expectedReceived);
      expect(await weth.balanceOf(token.target)).to.equal(wethBefore + expectedReceived);
      expect(await token.pendingRewardsTokens()).to.equal(0n);
      expect(await token.totalRewardsDistributed()).to.equal(expectedReceived);

      const perShare = await token.magnifiedRewardPerShare();
      const totalShares = await token.totalShares();
      expect(perShare).to.equal((expectedReceived * MAGNITUDE) / totalShares);
      let sum = 0n;
      for (const holder of [alice, bob, carol]) {
        const shares = await token.sharesOf(holder.address);
        const w = await token.withdrawableRewardOf(holder.address);
        expect(w).to.equal((perShare * shares) / MAGNITUDE);
        sum += w;
      }
      expect(sum).to.be.lte(expectedReceived);
      expect(expectedReceived - sum).to.be.lt(10n);

      const claimable = await token.withdrawableRewardOf(bob.address);
      const bobWethBefore = await weth.balanceOf(bob.address);
      await expect(token.connect(bob).claimRewards()).to.emit(token, "RewardsClaimed").withArgs(bob.address, claimable);
      expect(await weth.balanceOf(bob.address)).to.equal(bobWethBefore + claimable);
      await expect(weth.connect(bob).withdraw(claimable)).to.changeEtherBalances([bob], [claimable]);
    });

    it("rewardToken = USDG (real 3-hop path token -> WETH -> USDG through the live USDG/WETH pool): amount matches both pairs, holders get exact pro rata and claim real USDG", async function () {
      const { token, pair, usdg, usdgPair, router, alice, bob, carol } = await loadFixture(usdgFixture);
      expect(usdgPair, "USDG/WETH pair missing on the fork").to.not.equal(null);
      const u = await H.reservesOf(usdgPair, ROBINHOOD.usdg); // { token: USDG reserve, weth: WETH reserve }
      expect(u.token).to.be.gt(0n);
      expect(u.weth).to.be.gt(0n);
      const decimals = await usdg.decimals();
      console.log(
        `      USDG/WETH pool: ${ethers.formatUnits(u.token, decimals)} USDG / ${ethers.formatEther(u.weth)} WETH`
      );

      await sell(router, token, bob, E("20000")); // rewards 600, platform 200
      expect(await token.pendingRewardsTokens()).to.equal(E("600"));

      const r = await H.reservesOf(pair, token.target);
      const wethOut = H.getAmountOut(E("600"), r.token, r.weth);
      const expectedUsdg = H.getAmountOut(wethOut, u.weth, u.token);
      expect(expectedUsdg).to.be.gt(0n);
      const before = await usdg.balanceOf(token.target);

      const tx = token.connect(alice).distributeRewards(0);
      await expect(tx).to.emit(token, "RewardsDistributed").withArgs(E("600"), expectedUsdg);
      expect(await usdg.balanceOf(token.target)).to.equal(before + expectedUsdg);
      expect(await token.pendingRewardsTokens()).to.equal(0n);
      expect(await token.totalRewardsDistributed()).to.equal(expectedUsdg);
      // the real USDG/WETH pool was updated too
      const u2 = await H.reservesOf(usdgPair, ROBINHOOD.usdg);
      expect(u2.weth).to.equal(u.weth + wethOut);
      expect(u2.token).to.equal(u.token - expectedUsdg);

      const perShare = await token.magnifiedRewardPerShare();
      const totalShares = await token.totalShares();
      expect(perShare).to.equal((expectedUsdg * MAGNITUDE) / totalShares);
      let sum = 0n;
      for (const holder of [alice, bob, carol]) {
        const shares = await token.sharesOf(holder.address);
        expect(shares).to.equal(await token.balanceOf(holder.address));
        const w = await token.withdrawableRewardOf(holder.address);
        expect(w).to.equal((perShare * shares) / MAGNITUDE);
        sum += w;
      }
      expect(sum).to.be.lte(expectedUsdg);
      expect(expectedUsdg - sum).to.be.lt(10n);

      const claimable = await token.withdrawableRewardOf(bob.address);
      expect(claimable).to.be.gt(0n);
      const bobBefore = await usdg.balanceOf(bob.address);
      await expect(token.connect(bob).claimRewards()).to.emit(token, "RewardsClaimed").withArgs(bob.address, claimable);
      expect(await usdg.balanceOf(bob.address)).to.equal(bobBefore + claimable);
      expect(await token.withdrawableRewardOf(bob.address)).to.equal(0n);
      await expect(token.connect(bob).claimRewards()).to.be.revertedWith("nothing to claim");
    });

    it("distributeRewards amountOutMin is enforced by the real router with its own revert string", async function () {
      const { token, router, alice, bob } = await loadFixture(usdgFixture);
      await sell(router, token, bob, E("20000"));
      // Mock: "router: insufficient output". Real: "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
      await expect(token.connect(alice).distributeRewards(ethers.MaxUint256)).to.be.revertedWith(
        "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
      );
      expect(await token.pendingRewardsTokens()).to.equal(E("600"));
    });

    it("stock rewards (rewardToken = TSLA): distributes through the 3-hop path when the WETH/TSLA pair exists", async function () {
      if (!stock.live) {
        console.log(`      skipped: ${stock.reason}`);
        this.skip();
      }
      const { token, tsla, router, alice, bob } = await loadFixture(stockFixture);
      await sell(router, token, bob, E("20000"));
      expect(await token.pendingRewardsTokens()).to.equal(E("600"));

      const before = await tsla.balanceOf(token.target);
      const receipt = await (await token.connect(alice).distributeRewards(0)).wait();
      const evt = H.findEvent(receipt, token.interface, "RewardsDistributed");
      expect(evt).to.not.equal(null);
      const received = evt.args.rewardsReceived;
      expect(received).to.be.gt(0n);
      expect(await tsla.balanceOf(token.target)).to.equal(before + received);

      const claimable = await token.withdrawableRewardOf(bob.address);
      expect(claimable).to.be.gt(0n);
      const bobBefore = await tsla.balanceOf(bob.address);
      await token.connect(bob).claimRewards();
      expect(await tsla.balanceOf(bob.address)).to.equal(bobBefore + claimable);
    });

    it("stock rewards (rewardToken = TSLA): without a WETH/TSLA pair the 3-hop distribution reverts atomically, nothing is lost", async function () {
      if (stock.live) {
        console.log("      skipped: WETH/TSLA pair exists, covered by the positive test above");
        this.skip();
      }
      const { token, tsla, router, alice, bob } = await loadFixture(stockFixture);
      // Token creation does not validate the reward token's path; without a pair, distribution cannot run.
      await sell(router, token, bob, E("20000"));
      expect(await token.pendingRewardsTokens()).to.equal(E("600"));
      const contractBefore = await token.balanceOf(token.target);

      await expect(token.connect(alice).distributeRewards(0)).to.be.reverted;

      expect(await token.pendingRewardsTokens()).to.equal(E("600"));
      expect(await token.balanceOf(token.target)).to.equal(contractBefore);
      expect(await tsla.balanceOf(token.target)).to.equal(0n);
      expect(await token.totalRewardsDistributed()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------- 7. V3 stock rewards

  // The quick launch flow with a tokenized stock reward on the real Uniswap V3: QuickLaunch stores
  // the best quoted path for TSLA (scripts/lib/reward-tokens.js quotes every candidate on the real
  // QuoterV2), a quick Rewards launch paying TSLA fills, launches and delivers, real trades accrue
  // rewards, the launch keeper distributes through QuickLaunch with a floor from the quoter (a
  // stranger is refused: the caller sets the floor), holders claim real TSLA, and the keeper bot
  // sends a distribution of its own with a non-zero floor.
  describe("7. V3 stock rewards on the real Uniswap V3", function () {
    const QUOTE_SYMBOLS = ["TSLA", "AAPL"];
    const quickFee = async (ctx) => ctx.presaleFactory.quickCreationFee();

    /** A funded random wallet (hardhat_setBalance, no transfer from a signer) */
    async function freshWallet(ethWei) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await H.fundSigners([w], ethWei);
      return w;
    }

    // The creator takes no share of a quick raise (QuickLaunch.MAX_CREATOR_SHARE_PERCENT is 0); the
    // field stays in the ABI and anything above zero is refused with "share too high".
    function quickRewardsParams(name, symbol, rewardToken) {
      return {
        name, symbol, hardCap: E("1"), durationOption: 0, creatorSharePercent: 0,
        tokenType: 2, rewardToken, taxWallet: ZERO, buyTaxBps: 100, sellTaxBps: 100,
        rewardsBuyBps: 300, rewardsSellBps: 300, logoURI: "", description: "",
      };
    }

    /** The factory's launch keeper as QuickLaunch sees it (the only sender of distributeRewards besides its owner) */
    async function ctxLaunchKeeper(quickLaunch) {
      const factory = await ethers.getContractAt("PresaleFactory", await quickLaunch.presaleFactory());
      return factory.launchKeeper();
    }

    /** The two-leg quote the keeper makes: token -> WETH on V2, then the packed path on QuoterV2 */
    async function twoLegQuote(ctx, token, pendingTokens) {
      const wethOut = (await ctx.router.getAmountsOut(pendingTokens, [token.target, WETH]))[1];
      const quoter = await ethers.getContractAt("IQuoterV2", ROBINHOOD.v3.quoter);
      const [amountOut] = await quoter.quoteExactInput.staticCall(await token.rewardRouteV3(), wethOut);
      return { wethOut, amountOut };
    }

    /** QuickLaunch with TSLA allowlisted and the V3 routes of TSLA and AAPL quoted on the real QuoterV2 and stored */
    async function v3RoutesFixture() {
      const ctx = await baseFixture();
      const { quickLaunch } = ctx;
      await quickLaunch.setRewardTokenAllowed(ROBINHOOD.tsla, true);
      await quickLaunch.setRewardTokenAllowed(ROBINHOOD.aapl, true);
      const lines = [];
      const deployments = { tokenFactory: ctx.tokenFactory.target, router: ROBINHOOD.router };
      const routes = await H.withRetry(() => rewardRoutesFor(hre, deployments, { symbols: QUOTE_SYMBOLS, log: (l) => lines.push(l) }), { label: "rewardRoutesFor" });
      for (const l of lines) console.log(`      ${l}`);
      await applyRewardRoutes(hre, quickLaunch, routes, (l) => console.log(`      ${l}`));
      for (const l of await describeRewardRoutes(hre, quickLaunch)) console.log(`      route ${l}`);
      const tsla = H.erc20At(ROBINHOOD.tsla);
      return { ...ctx, routes, tsla };
    }

    /** A quick Rewards launch paying TSLA, filled by 50 wallets (soft cap met, one short of the hard cap) and delivered */
    async function quickStockFixture() {
      const ctx = await v3RoutesFixture();
      const { quickLaunch, carol } = ctx;
      const receipt = await (await quickLaunch.connect(carol).launch(quickRewardsParams("Stock Yield", "SYLD", ROBINHOOD.tsla), { value: await quickFee(ctx) })).wait();
      const ev = H.findEvent(receipt, quickLaunch.interface, "QuickLaunched");
      const token = await ethers.getContractAt("RewardsToken", ev.args.token);
      const presale = await ethers.getContractAt("Presale", ev.args.presale);
      const wallets = [];
      for (let i = 0; i < 50; i++) {
        const w = await freshWallet(E("0.05"));
        await presale.connect(w).contribute({ value: i < 49 ? E("0.02") : E("0.0195") });
        wallets.push(w);
      }
      await presale.distribute(100);
      expect(await presale.distributionComplete()).to.equal(true);
      return { ...ctx, token, presale, wallets, launchTx: receipt.hash };
    }

    it("stores the best quoted V3 path for TSLA and isRewardRouteLive agrees with the real pools", async function () {
      const { quickLaunch, routes } = await loadFixture(v3RoutesFixture);
      const tslaRoute = routes.find((r) => r.symbol === "TSLA");
      expect(tslaRoute, "TSLA route").to.not.equal(undefined);
      expect(tslaRoute.v3Path, `TSLA has no usable V3 candidate (${tslaRoute.reason || ""})`).to.not.equal(null);
      const decoded = decodeV3Path(hre, tslaRoute.v3Path);
      expect(decoded.tokens[0]).to.equal(WETH);
      expect(decoded.tokens[decoded.tokens.length - 1]).to.equal(ROBINHOOD.tsla);
      console.log(`      TSLA path chosen: ${tslaRoute.hops} (${ethers.formatEther(tslaRoute.quote)} TSLA for 0.1 WETH)`);
      const quoted = tslaRoute.candidates.filter((c) => c.amountOut !== null && c.amountOut > 0n);
      expect(quoted.length).to.be.gte(1);
      expect(quoted.every((c) => c.amountOut <= tslaRoute.quote)).to.equal(true);
      expect((await quickLaunch.rewardRouteV3Of(ROBINHOOD.tsla)).toLowerCase()).to.equal(tslaRoute.v3Path.toLowerCase());
      expect([...(await quickLaunch.rewardRouteOf(ROBINHOOD.tsla))]).to.deep.equal([]);
      expect(await quickLaunch.isRewardRouteLive(ROBINHOOD.tsla)).to.equal(true);
      // Every stock quoted here is on the allowlist; one whose best candidate has no pool (if any) is not live
      for (const r of routes) {
        const live = await quickLaunch.isRewardRouteLive(r.token);
        console.log(`      ${r.symbol}: ${r.v3Path ? r.hops : "no candidate"}, live ${live}`);
        if (!r.v3Path) expect(live).to.equal(false);
      }
      // A path with a pool that does not exist is refused by the store
      const bogus = ethers.solidityPacked(["address", "uint24", "address"], [WETH, 123, ROBINHOOD.tsla]);
      await expect(quickLaunch.setRewardRouteV3(ROBINHOOD.tsla, bogus)).to.be.revertedWith("no V3 pool");
    });

    it("a quick Rewards launch paying TSLA fills and delivers, real trades accrue rewards, the launch keeper distributes real TSLA with a quoter floor, a stranger is refused and a holder claims", async function () {
      const { quickLaunch, router, token, presale, wallets, tsla, routes, dave, marketing, keeper } = await loadFixture(quickStockFixture);
      const tslaRoute = routes.find((r) => r.symbol === "TSLA");
      expect((await token.rewardRouteV3()).toLowerCase()).to.equal(tslaRoute.v3Path.toLowerCase());
      expect(await token.v3Router()).to.equal(ROBINHOOD.v3.router);
      expect(await token.v3Quoter()).to.equal(ROBINHOOD.v3.quoter);
      expect(await token.owner()).to.equal(quickLaunch.target);
      expect(await presale.status()).to.equal(Finalized);
      expect(await token.balanceOf(wallets[0].address)).to.equal(E("0.02") * 500_000_000n);

      // A real buy and a real sell through Router02
      await buy(router, token, dave, E("0.2"));
      await sell(router, token, wallets[0], (await token.balanceOf(wallets[0].address)) / 2n);
      const pending = await token.pendingRewardsTokens();
      expect(pending).to.be.gte(await token.swapThreshold());
      expect(await quickLaunch.isTokenRouteLive(token.target)).to.equal(true);

      // The launch keeper triggers the distribution through QuickLaunch with the quoter's floor
      // minus 3%; a stranger (marketing is neither the keeper nor the QuickLaunch owner) is refused
      const { wethOut, amountOut } = await twoLegQuote({ router }, token, pending);
      expect(amountOut).to.be.gt(0n);
      const amountOutMin = (amountOut * 9700n) / BPS;
      console.log(`      pending ${ethers.formatEther(pending)} SYLD -> ${ethers.formatEther(wethOut)} WETH -> quoted ${ethers.formatEther(amountOut)} TSLA, floor ${ethers.formatEther(amountOutMin)} TSLA`);
      expect(await quickLaunch.owner()).to.not.equal(marketing.address);
      expect(await ctxLaunchKeeper(quickLaunch)).to.equal(keeper.address);
      await expect(quickLaunch.connect(marketing).distributeRewards(token.target, amountOutMin)).to.be.revertedWith("not keeper");
      expect(await token.pendingRewardsTokens()).to.equal(pending);
      const before = await tsla.balanceOf(token.target);
      const receipt = await (await quickLaunch.connect(keeper).distributeRewards(token.target, amountOutMin)).wait();
      const evt = H.findEvent(receipt, token.interface, "RewardsDistributed");
      expect(evt).to.not.equal(null);
      expect(evt.args.tokensSwapped).to.equal(pending);
      const received = evt.args.rewardsReceived;
      expect(received).to.be.gte(amountOutMin);
      console.log(`      distributed ${ethers.formatEther(received)} TSLA to the holders`);
      expect(await tsla.balanceOf(token.target)).to.equal(before + received);
      expect(await token.pendingRewardsTokens()).to.equal(0n);
      expect(await token.totalRewardsDistributed()).to.equal(received);
      expect(await ethers.provider.getBalance(token.target)).to.equal(0n);
      expect(await H.wethAt().balanceOf(token.target)).to.equal(0n);

      // A holder claims: the balance matches the pro rata share
      const holder = wallets[1];
      const perShare = await token.magnifiedRewardPerShare();
      const claimable = await token.withdrawableRewardOf(holder.address);
      expect(claimable).to.equal((perShare * (await token.sharesOf(holder.address))) / MAGNITUDE);
      expect(claimable).to.be.gt(0n);
      const holderBefore = await tsla.balanceOf(holder.address);
      await expect(token.connect(holder).claimRewards()).to.emit(token, "RewardsClaimed").withArgs(holder.address, claimable);
      expect(await tsla.balanceOf(holder.address)).to.equal(holderBefore + claimable);
      expect(await token.withdrawableRewardOf(holder.address)).to.equal(0n);
      console.log(`      holder ${holder.address} claimed ${ethers.formatEther(claimable)} TSLA`);

      // A floor above the market is enforced by the real SwapRouter02
      await buy(router, token, dave, E("0.2"));
      await expect(quickLaunch.connect(keeper).distributeRewards(token.target, ethers.MaxUint256)).to.be.revertedWith("Too little received");
    });

    it("the keeper sends a distribution with a non-zero floor after a fresh buy", async function () {
      const { presaleFactory, quickLaunch, router, token, tsla, keeper, dave } = await loadFixture(quickStockFixture);
      await buy(router, token, dave, E("0.3"));
      const pending = await token.pendingRewardsTokens();
      expect(pending).to.be.gte(await token.swapThreshold());
      const { amountOut } = await twoLegQuote({ router }, token, pending);

      const lines = [];
      const bot = await createKeeper(hre, { factoryAddress: presaleFactory.target, quickLaunchAddress: quickLaunch.target, signer: keeper, log: (l) => lines.push(l), retrySeconds: 60 });
      expect(bot.canDistribute).to.equal(true);
      await bot.poll(); // a single poll, as KEEPER_ONCE=1 does
      for (const l of lines) console.log(`      keeper: ${l}`);
      const sent = bot.actions.filter((a) => a.kind === "rewards");
      expect(sent.map((a) => a.presale)).to.deep.equal([token.target]);
      expect(lines.some((l) => /^rewards .* sent .* quoted [\d.]+ TSLA, min [\d.]+ TSLA$/.test(l))).to.equal(true);
      const tx = await ethers.provider.getTransaction(sent[0].hash);
      const parsed = quickLaunch.interface.parseTransaction({ data: tx.data });
      expect(parsed.name).to.equal("distributeRewards");
      expect(parsed.args.amountOutMin).to.equal((amountOut * 9700n) / BPS);
      expect(parsed.args.amountOutMin).to.be.gt(0n);
      const receipt = await ethers.provider.getTransactionReceipt(sent[0].hash);
      const evt = H.findEvent(receipt, token.interface, "RewardsDistributed");
      expect(evt.args.rewardsReceived).to.be.gte(parsed.args.amountOutMin);
      expect(await tsla.balanceOf(token.target)).to.equal(evt.args.rewardsReceived);
      expect(await token.pendingRewardsTokens()).to.equal(0n);
      console.log(`      keeper distributed ${ethers.formatEther(evt.args.rewardsReceived)} TSLA with floor ${ethers.formatEther(parsed.args.amountOutMin)} TSLA`);
    });

    it("a token created directly through TokenFactory.createRewardsToken(TSLA) gets the platform path", async function () {
      const { tokenFactory, routes, alice, dave } = await loadFixture(v3RoutesFixture);
      const tslaRoute = routes.find((r) => r.symbol === "TSLA");
      await tokenFactory.connect(alice).createRewardsToken("Direct Stock", "DSTK", E("1000000"), ROBINHOOD.tsla, dave.address, [300, 300, 0, 0]);
      const token = await ethers.getContractAt("RewardsToken", await tokenFactory.allTokens((await tokenFactory.allTokensLength()) - 1n));
      expect((await token.rewardRouteV3()).toLowerCase()).to.equal(tslaRoute.v3Path.toLowerCase());
      expect(await token.v3Router()).to.equal(ROBINHOOD.v3.router);
      const decoded = decodeV3Path(hre, await token.rewardRouteV3());
      console.log(`      direct token path: ${describeV3Hops(decoded.tokens.map((t) => (t === WETH ? "WETH" : t === ROBINHOOD.usdg ? "USDG" : "TSLA")), decoded.fees)}`);
      // The V2 path still describes the first leg only
      expect([...(await token.rewardPath())]).to.deep.equal([token.target, WETH, ROBINHOOD.tsla]);
    });
  });

  // -------------------------------------------------------------- 5. HOODS

  describe("5. HOODS presale, tax swap-back and buyback on the real router", function () {
    it("whitelist gate holds; finalize adds HOODS liquidity through the real router and locks the LP for a year", async function () {
      const ctx = await loadFixture(hoodsaleReadyFixture);
      const { hoodsale, hoodPresale, hoodPair, treasury, locker, deployer, alice, bob, carol } = ctx;
      expect(await hoodPresale.whitelistEnabled()).to.equal(true);
      expect(await hoodPresale.canContribute(carol.address)).to.equal(false);
      expect(await hoodPresale.canContribute(alice.address)).to.equal(true);
      expect(await hoodPresale.totalRaised()).to.equal(E("6"));
      expect(await hoodsale.isExcludedFromFees(hoodPresale.target)).to.equal(true);

      const liqEth = E("3.78");
      const liqTokens = E("3024000");
      const expectedLp = H.firstMintLiquidity(liqTokens, liqEth);

      const tx = hoodPresale.connect(deployer).finalize(0, 0);
      await expect(tx).to.emit(hoodPresale, "Finalized").withArgs(E("0.6"), liqEth, liqTokens, expectedLp);
      await expect(tx).to.changeEtherBalances([treasury, deployer], [E("0.6"), E("1.62")]);

      const r = await H.reservesOf(hoodPair, hoodsale.target);
      expect(r.token).to.equal(liqTokens);
      expect(r.weth).to.equal(liqEth);
      expect(await hoodPair.totalSupply()).to.equal(expectedLp + MINIMUM_LIQUIDITY);
      const lock = await locker.locks(await hoodPresale.lpLockId());
      expect(lock.token).to.equal(hoodPair.target);
      expect(lock.owner).to.equal(deployer.address);
      expect(lock.amount).to.equal(expectedLp);
      expect(lock.unlockTime).to.equal((await hoodPresale.finalizedAt()) + 365n * DAY);

      await expect(hoodPresale.connect(alice).claim()).to.changeTokenBalance(hoodsale, alice, E("4000000"));
      await expect(hoodPresale.connect(bob).claim()).to.changeTokenBalance(hoodsale, bob, E("2000000"));
      expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(0n); // claim is tax free
    });

    it("trading past swapThreshold swaps the 3 percent tax back (marketing ETH + depositBuyback), then executeBuyback burns HOODS via the real router", async function () {
      const ctx = await loadFixture(hoodsaleLaunchedFixture);
      const { hoodsale, hoodPair, router, treasury, marketing, deployer, alice, bob } = ctx;
      const threshold = await hoodsale.swapThreshold();
      expect(threshold).to.equal(E("100000")); // 100M / 1000

      // wallet-to-wallet transfer is tax free
      await hoodsale.connect(alice).transfer(bob.address, E("1000"));
      expect(await hoodsale.balanceOf(hoodsale.target)).to.equal(0n);

      let i = 0;
      while ((await hoodsale.balanceOf(hoodsale.target)) < threshold) {
        const seller = i % 2 === 0 ? alice : bob;
        await sell(router, hoodsale, seller, E("500000")); // each sell accrues 15k of tax
        if (++i > 20) throw new Error("swap threshold never reached");
      }
      const accrued = await hoodsale.balanceOf(hoodsale.target);
      expect(accrued).to.be.gte(threshold);

      const r = await H.reservesOf(hoodPair, hoodsale.target);
      const ethGained = H.getAmountOut(accrued, r.token, r.weth);
      const marketingEth = (ethGained * 5000n) / BPS;
      const buybackEth = ethGained - marketingEth;
      const sellAmount = E("10000");
      const userOut = H.getAmountOut((sellAmount * 9700n) / BPS, r.token + accrued, r.weth - ethGained);
      const mktBefore = await ethers.provider.getBalance(marketing.address);
      const treBefore = await ethers.provider.getBalance(treasury.target);
      const reserveBefore = await treasury.buybackReserve();

      const tx = sell(router, hoodsale, bob, sellAmount);
      await expect(tx).to.emit(hoodsale, "SwapBack").withArgs(accrued, ethGained, marketingEth, buybackEth);
      await expect(tx).to.emit(treasury, "RevenueReceived").withArgs(hoodsale.target, buybackEth, buybackEth);
      await expect(tx).to.changeEtherBalances([bob], [userOut]);
      expect(await ethers.provider.getBalance(marketing.address)).to.equal(mktBefore + marketingEth);
      expect(await ethers.provider.getBalance(treasury.target)).to.equal(treBefore + buybackEth);
      // depositBuyback: every incoming wei counts toward the reserve (not the 30% rule)
      expect(await treasury.buybackReserve()).to.equal(reserveBefore + buybackEth);
      expect(await hoodsale.balanceOf(hoodsale.target)).to.equal((sellAmount * 300n) / BPS);

      // buyback: the whole reserve is swapped to HOODS through the real router and sent to 0xdEaD
      const reserve = await treasury.buybackReserve();
      expect(reserve).to.be.gt(0n);
      const r2 = await H.reservesOf(hoodPair, hoodsale.target);
      const expectedBurn = H.getAmountOut(reserve, r2.weth, r2.token); // DEAD is tax exempt: full amount
      const deadBefore = await hoodsale.balanceOf(DEAD);

      const btx = treasury.connect(deployer).executeBuyback(reserve, 0);
      await expect(btx).to.emit(treasury, "BuybackExecuted").withArgs(reserve, expectedBurn);
      await expect(btx).to.changeEtherBalances([treasury], [-reserve]);
      expect(await hoodsale.balanceOf(DEAD)).to.equal(deadBefore + expectedBurn);
      expect(await treasury.buybackReserve()).to.equal(0n);
      expect(await treasury.totalBoughtBack()).to.equal(expectedBurn);
      expect(await hoodsale.balanceOf(hoodsale.target)).to.equal((sellAmount * 300n) / BPS); // no tax on burn
      const r3 = await H.reservesOf(hoodPair, hoodsale.target);
      expect(r3.weth).to.equal(r2.weth + reserve);
      expect(r3.token).to.equal(r2.token - expectedBurn);
    });
  });

  // -------------------------------------------------------------- 6. griefing

  describe("6. griefing resilience on the real pair before finalize", function () {
    it("finalizes when a third party donates WETH only (deposit, transfer, sync); the donation is captured by the locked LP", async function () {
      const { presale, token, pair, weth, locker, alice, bob, carol } = await loadFixture(readyFixture);
      await weth.connect(carol).deposit({ value: E("0.01") });
      await weth.connect(carol).transfer(pair.target, E("0.01"));
      await pair.connect(carol).sync();
      let r = await H.reservesOf(pair, token.target);
      expect(r.token).to.equal(0n);
      expect(r.weth).to.equal(E("0.01"));

      // The router path would revert with a division by zero in quote; the contract uses the low-level mint.
      // On the first mint the LP is computed only from the amounts the presale deposited (the donation is excluded).
      const expectedLp = H.firstMintLiquidity(E("129600"), E("3.24"));
      await expect(presale.connect(alice).finalize(0, 0))
        .to.emit(presale, "Finalized")
        .withArgs(E("0.6"), E("3.24"), E("129600"), expectedLp);
      expect(await presale.lpAmount()).to.equal(expectedLp);
      expect(await pair.totalSupply()).to.equal(expectedLp + MINIMUM_LIQUIDITY); // the griefer gets no LP
      r = await H.reservesOf(pair, token.target);
      expect(r.token).to.equal(E("129600"));
      expect(r.weth).to.equal(E("3.25"));
      const lock = await locker.locks(await presale.lpLockId());
      expect(lock.amount).to.equal(expectedLp);
      expect(lock.owner).to.equal(alice.address);
      await expect(presale.connect(bob).claim()).to.changeTokenBalance(token, bob, E("150000"));
    });

    it("finalizes when a third party donates both tokens at a skewed ratio; the launch price drifts from the listing rate", async function () {
      const { presale, token, pair, weth, alice, carol } = await loadFixture(readyFixture);
      await token.connect(alice).transfer(carol.address, E("100")); // owner is exempt: goes through in full
      await token.connect(carol).transfer(pair.target, E("100")); // carol -> pair counts as a sell: 0.25% tax, 99.75 arrives
      await weth.connect(carol).deposit({ value: E("1") });
      await weth.connect(carol).transfer(pair.target, E("1"));
      await pair.connect(carol).sync();
      let r = await H.reservesOf(pair, token.target);
      expect(r.token).to.equal(E("99.75"));
      expect(r.weth).to.equal(E("1"));

      const expectedLp = H.firstMintLiquidity(E("129600"), E("3.24"));
      await expect(presale.connect(alice).finalize(0, 0))
        .to.emit(presale, "Finalized")
        .withArgs(E("0.6"), E("3.24"), E("129600"), expectedLp);
      expect(await presale.lpAmount()).to.equal(expectedLp);
      expect(await pair.totalSupply()).to.equal(expectedLp + MINIMUM_LIQUIDITY);
      r = await H.reservesOf(pair, token.target);
      expect(r.token).to.equal(E("129699.75"));
      expect(r.weth).to.equal(E("4.24"));
      // The pool price is no longer the listing rate: 129699.75 / 4.24 = 30590 tokens / ETH (target 40000)
      const tokensPerEth = (r.token * E("1")) / r.weth;
      expect(tokensPerEth).to.be.lt(E("40000"));
      expect(tokensPerEth).to.be.gt(E("30000"));
    });

    // If LP has been minted into the pool and the price deviates from listing, finalize is refused; once the
    // owner pulls the pool back to the listing price (at the attacker's expense) the launch goes through.
    it("a front-runner who MINTS a skewed LP position cannot move the launch price: finalize is refused until the pool is realigned", async function () {
      const { presale, token, pair, router, weth, alice, carol } = await loadFixture(readyFixture);
      await token.connect(alice).transfer(carol.address, E("100"));
      // carol adds 100 tokens (99.75 after tax) + 1 ETH through the real router: a price of ~99.75 tokens / ETH
      await addLiq(router, token, carol, E("100"), E("1"));
      expect(await pair.totalSupply()).to.be.gt(0n);
      expect(await presale.poolPriceDeviationBps()).to.be.gt(500n);
      await expect(presale.connect(alice).finalize(0, 0)).to.be.revertedWith("pool price off listing");

      // The owner (tax exempt) sells tokens into the pool to pull the price to 40000 tokens/ETH.
      // The input amount is found by binary search over the V2 formula: target ratio within 1% of the listing price.
      const LISTING = E("40000");
      let r = await H.reservesOf(pair, token.target);
      let lo = 0n;
      let hi = E("1000000");
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2n;
        const out = H.getAmountOut(mid, r.token, r.weth);
        const ratio = ((r.token + mid) * E("1")) / (r.weth - out);
        if (ratio < LISTING) lo = mid;
        else hi = mid;
      }
      const amountIn = hi;
      await token.connect(alice).approve(router.target, amountIn);
      const deadline = (await time.latest()) + 600;
      const ethBefore = await ethers.provider.getBalance(alice.address);
      await router
        .connect(alice)
        .swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, 0, [token.target, weth.target], alice.address, deadline);
      // The realignment earns the owner money: most of carol's 1 ETH goes to the owner
      expect(await ethers.provider.getBalance(alice.address)).to.be.gt(ethBefore + E("0.9"));
      expect(await presale.poolPriceDeviationBps()).to.be.lte(500n);

      const ts0 = await pair.totalSupply();
      r = await H.reservesOf(pair, token.target);
      const byToken = (E("129600") * ts0) / r.token;
      const byWeth = (E("3.24") * ts0) / r.weth;
      const expectedLp = byToken < byWeth ? byToken : byWeth;
      // feeTo is on: because the realignment swap grew k, this mint first mints LP to the protocol,
      // total supply grows and the presale's LP comes out a touch above the calculation. Compare with tolerance.
      await expect(presale.connect(alice).finalize(0, 0))
        .to.emit(presale, "Finalized")
        .withArgs(E("0.6"), E("3.24"), E("129600"), anyValue);
      const lpAmount = await presale.lpAmount();
      expect(lpAmount).to.be.gte(expectedLp);
      expect(lpAmount).to.be.lte((expectedLp * 10100n) / BPS);

      // The launch price is within 5% of listing and the locked LP is the vast majority of the pool
      const r1 = await H.reservesOf(pair, token.target);
      const tokensPerEth = (r1.token * E("1")) / r1.weth;
      expect(tokensPerEth).to.be.gte((LISTING * 9500n) / BPS);
      expect(tokensPerEth).to.be.lte((LISTING * 10500n) / BPS);
      const ts1 = await pair.totalSupply();
      expect((lpAmount * BPS) / ts1).to.be.gt(9500n);
    });

    // A plain transfer is a contribution on the same terms as contribute(), so a stray one to a
    // sale that has ended reverts instead of being swallowed. Only the router and the v4 launcher
    // may send ETH without contributing, and the real router never refunds on the empty-pair path,
    // so the launch does not lean on that exception here.
    it("the presale refuses a stray ETH transfer once the sale has ended, and still launches through the real router", async function () {
      const { presale, alice, carol } = await loadFixture(readyFixture);
      await expect(carol.sendTransaction({ to: presale.target, value: E("0.001") })).to.be.revertedWith("ended");
      expect(await ethers.provider.getBalance(presale.target)).to.equal(E("6"));
      expect(await presale.totalRaised()).to.equal(E("6"));

      await expect(presale.connect(alice).finalize(0, 0))
        .to.emit(presale, "Finalized")
        .withArgs(E("0.6"), E("3.24"), E("129600"), anyValue);
      expect(await presale.status()).to.equal(Finalized);
    });
  });
}
