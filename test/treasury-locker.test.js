const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployPlatform } = require("./helpers");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const MAX = ethers.MaxUint256;

async function createStandardToken(tokenFactory, signer, name, symbol, supply) {
  const tx = await tokenFactory.connect(signer).createStandardToken(name, symbol, supply);
  const rc = await tx.wait();
  const ev = rc.logs
    .map((l) => {
      try {
        return tokenFactory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "TokenCreated");
  return ethers.getContractAt("StandardToken", ev.args.token);
}

/** Platform + HOODS/WETH liquidity on the mock DEX. */
async function hoodsaleMarketFixture() {
  const env = await deployPlatform();
  const { deployer, router, hoodsale } = env;
  await hoodsale.connect(deployer).approve(router.target, MAX);
  await router
    .connect(deployer)
    .addLiquidityETH(hoodsale.target, ethers.parseEther("10000000"), 0, 0, deployer.address, MAX, {
      value: ethers.parseEther("100"),
    });
  return env;
}

/** Market + funded buyback reserve (5 ETH via depositBuyback). */
async function buybackReadyFixture() {
  const env = await hoodsaleMarketFixture();
  await env.treasury.connect(env.alice).depositBuyback({ value: ethers.parseEther("5") });
  return env;
}

/** Platform + a Standard platform token with liquidity; treasury holds 10k of it. */
async function platformTokenFixture() {
  const env = await deployPlatform();
  const { alice, router, treasury, tokenFactory } = env;
  const token = await createStandardToken(tokenFactory, alice, "Test", "TST", ethers.parseEther("1000000"));
  await token.connect(alice).approve(router.target, MAX);
  await router
    .connect(alice)
    .addLiquidityETH(token.target, ethers.parseEther("500000"), 0, 0, alice.address, MAX, {
      value: ethers.parseEther("50"),
    });
  await token.connect(alice).transfer(treasury.target, ethers.parseEther("10000"));
  return { ...env, token };
}

/** Trades HOODS past the swap threshold, then a sell triggers the swapback. */
async function swapbackFixture() {
  const env = await hoodsaleMarketFixture();
  const { alice, bob, marketing, weth, router, treasury, hoodsale } = env;
  const buyPath = [weth.target, hoodsale.target];
  const threshold = await hoodsale.swapThreshold();

  let i = 0;
  while ((await hoodsale.balanceOf(hoodsale.target)) < threshold) {
    const buyer = i % 2 === 0 ? alice : bob;
    await router
      .connect(buyer)
      .swapExactETHForTokens(0, buyPath, buyer.address, MAX, { value: ethers.parseEther("20") });
    if (++i > 50) throw new Error("swap threshold never reached");
  }
  // one extra buy so bob definitely holds tokens to sell
  await router
    .connect(bob)
    .swapExactETHForTokens(0, buyPath, bob.address, MAX, { value: ethers.parseEther("20") });

  const accruedBeforeSell = await hoodsale.balanceOf(hoodsale.target);
  const marketingBefore = await ethers.provider.getBalance(marketing.address);
  const reserveBefore = await treasury.buybackReserve();
  const treasuryEthBefore = await ethers.provider.getBalance(treasury.target);

  const sellAmount = ethers.parseEther("1000");
  await hoodsale.connect(bob).approve(router.target, MAX);
  const sellTx = await router
    .connect(bob)
    .swapExactTokensForETHSupportingFeeOnTransferTokens(
      sellAmount,
      0,
      [hoodsale.target, weth.target],
      bob.address,
      MAX
    );

  return {
    ...env,
    sellTx,
    sellAmount,
    accruedBeforeSell,
    marketingBefore,
    reserveBefore,
    treasuryEthBefore,
  };
}

async function lockerFixture() {
  const env = await deployPlatform();
  const { alice, bob, weth } = env;
  await weth.connect(alice).deposit({ value: ethers.parseEther("100") });
  await weth.connect(alice).approve(env.locker.target, MAX);
  await weth.connect(bob).deposit({ value: ethers.parseEther("100") });
  await weth.connect(bob).approve(env.locker.target, MAX);
  return env;
}

describe("Treasury", function () {
  describe("revenue intake", function () {
    it("receive() earmarks exactly buybackBps (30%) to buybackReserve and emits RevenueReceived", async function () {
      const { treasury, alice } = await loadFixture(deployPlatform);
      const amount = ethers.parseEther("10");
      await expect(alice.sendTransaction({ to: treasury.target, value: amount }))
        .to.emit(treasury, "RevenueReceived")
        .withArgs(alice.address, amount, ethers.parseEther("3"));
      expect(await treasury.buybackReserve()).to.equal(ethers.parseEther("3"));
      expect(await ethers.provider.getBalance(treasury.target)).to.equal(amount);
    });

    it("accumulates buybackReserve across multiple plain transfers", async function () {
      const { treasury, alice, bob } = await loadFixture(deployPlatform);
      await alice.sendTransaction({ to: treasury.target, value: ethers.parseEther("10") });
      await bob.sendTransaction({ to: treasury.target, value: ethers.parseEther("1") });
      expect(await treasury.buybackReserve()).to.equal(ethers.parseEther("3.3"));
    });

    it("depositBuyback() earmarks 100% to buybackReserve", async function () {
      const { treasury, alice } = await loadFixture(deployPlatform);
      const amount = ethers.parseEther("2");
      await expect(treasury.connect(alice).depositBuyback({ value: amount }))
        .to.emit(treasury, "RevenueReceived")
        .withArgs(alice.address, amount, amount);
      expect(await treasury.buybackReserve()).to.equal(amount);
    });
  });

  describe("setBuybackBps", function () {
    it("owner updates bps and future revenue uses the new rate", async function () {
      const { treasury, deployer, alice } = await loadFixture(deployPlatform);
      expect(await treasury.buybackBps()).to.equal(3000);
      await expect(treasury.connect(deployer).setBuybackBps(5000))
        .to.emit(treasury, "BuybackBpsUpdated")
        .withArgs(5000);
      await alice.sendTransaction({ to: treasury.target, value: ethers.parseEther("10") });
      expect(await treasury.buybackReserve()).to.equal(ethers.parseEther("5"));
    });

    it("rejects bps above 10000", async function () {
      const { treasury } = await loadFixture(deployPlatform);
      await expect(treasury.setBuybackBps(10001)).to.be.revertedWith("bps too high");
      await treasury.setBuybackBps(10000); // exactly the cap is allowed
      expect(await treasury.buybackBps()).to.equal(10000);
    });

    it("rejects non-owner", async function () {
      const { treasury, alice } = await loadFixture(deployPlatform);
      await expect(treasury.connect(alice).setBuybackBps(1000)).to.be.revertedWithCustomError(
        treasury,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("withdrawEth", function () {
    it("withdraws everything except the buyback reserve", async function () {
      const { treasury, alice, carol } = await loadFixture(deployPlatform);
      await alice.sendTransaction({ to: treasury.target, value: ethers.parseEther("10") });
      const free = ethers.parseEther("7"); // 10 - 30% reserve
      const before = await ethers.provider.getBalance(carol.address);
      await treasury.withdrawEth(carol.address, free);
      expect((await ethers.provider.getBalance(carol.address)) - before).to.equal(free);
      expect(await ethers.provider.getBalance(treasury.target)).to.equal(ethers.parseEther("3"));
      expect(await treasury.buybackReserve()).to.equal(ethers.parseEther("3"));
    });

    it("reverts when the amount would dip into the reserve", async function () {
      const { treasury, alice, carol } = await loadFixture(deployPlatform);
      await alice.sendTransaction({ to: treasury.target, value: ethers.parseEther("10") });
      await expect(
        treasury.withdrawEth(carol.address, ethers.parseEther("7") + 1n)
      ).to.be.revertedWith("reserve locked");
      await treasury.withdrawEth(carol.address, ethers.parseEther("7"));
      await expect(treasury.withdrawEth(carol.address, 1n)).to.be.revertedWith("reserve locked");
    });

    it("rejects non-owner and zero recipient", async function () {
      const { treasury, alice } = await loadFixture(deployPlatform);
      await alice.sendTransaction({ to: treasury.target, value: ethers.parseEther("1") });
      await expect(
        treasury.connect(alice).withdrawEth(alice.address, 1n)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
      await expect(treasury.withdrawEth(ethers.ZeroAddress, 1n)).to.be.revertedWith("zero to");
    });
  });

  describe("executeBuyback", function () {
    it("buys HOODS with reserve ETH and burns it to 0xdead", async function () {
      const { treasury, hoodsale } = await loadFixture(buybackReadyFixture);
      const spend = ethers.parseEther("2");
      const deadBefore = await hoodsale.balanceOf(DEAD);

      const tx = await treasury.executeBuyback(spend, 0);
      const burned = (await hoodsale.balanceOf(DEAD)) - deadBefore;

      expect(burned).to.be.gt(0);
      expect(await treasury.totalBoughtBack()).to.equal(burned);
      expect(await treasury.buybackReserve()).to.equal(ethers.parseEther("3"));
      expect(await ethers.provider.getBalance(treasury.target)).to.equal(ethers.parseEther("3"));
      await expect(tx).to.emit(treasury, "BuybackExecuted").withArgs(spend, burned);
    });

    it("reverts on zero amount or amount exceeding the reserve", async function () {
      const { treasury } = await loadFixture(buybackReadyFixture);
      await expect(treasury.executeBuyback(0, 0)).to.be.revertedWith("bad amount");
      await expect(
        treasury.executeBuyback(ethers.parseEther("5") + 1n, 0)
      ).to.be.revertedWith("bad amount");
    });

    it("rejects non-owner", async function () {
      const { treasury, alice } = await loadFixture(buybackReadyFixture);
      await expect(
        treasury.connect(alice).executeBuyback(ethers.parseEther("1"), 0)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("reverts when router/hoodsale are not configured", async function () {
      const { deployer, alice } = await loadFixture(deployPlatform);
      const fresh = await ethers.deployContract("Treasury", [deployer.address]);
      await fresh.connect(alice).depositBuyback({ value: ethers.parseEther("1") });
      await expect(fresh.executeBuyback(ethers.parseEther("1"), 0)).to.be.revertedWith(
        "not configured"
      );
    });
  });

  describe("liquidateToken / withdrawToken", function () {
    it("liquidateToken sells held platform tokens for ETH and the 30% rule applies via receive()", async function () {
      const { treasury, token } = await loadFixture(platformTokenFixture);
      const held = ethers.parseEther("10000");
      expect(await token.balanceOf(treasury.target)).to.equal(held);

      const ethBefore = await ethers.provider.getBalance(treasury.target);
      const tx = await treasury.liquidateToken(token.target, 0, 0); // 0 = sell entire balance
      const ethGained = (await ethers.provider.getBalance(treasury.target)) - ethBefore;

      expect(ethGained).to.be.gt(0);
      expect(await token.balanceOf(treasury.target)).to.equal(0);
      expect(await treasury.buybackReserve()).to.equal((ethGained * 3000n) / 10000n);
      await expect(tx).to.emit(treasury, "TokenLiquidated").withArgs(token.target, held, ethGained);
      await expect(tx).to.emit(treasury, "RevenueReceived");
    });

    it("liquidateToken reverts with nothing to sell and when router is not configured", async function () {
      const { treasury, deployer, hoodsale } = await loadFixture(deployPlatform);
      await expect(treasury.liquidateToken(hoodsale.target, 0, 0)).to.be.revertedWith(
        "nothing to sell"
      );
      const fresh = await ethers.deployContract("Treasury", [deployer.address]);
      await expect(fresh.liquidateToken(hoodsale.target, 0, 0)).to.be.revertedWith(
        "not configured"
      );
    });

    it("withdrawToken transfers raw tokens out (owner only)", async function () {
      const { treasury, token, alice, carol } = await loadFixture(platformTokenFixture);
      const amount = ethers.parseEther("4000");
      await treasury.withdrawToken(token.target, carol.address, amount);
      expect(await token.balanceOf(carol.address)).to.equal(amount);
      expect(await token.balanceOf(treasury.target)).to.equal(ethers.parseEther("6000"));
      await expect(
        treasury.connect(alice).withdrawToken(token.target, alice.address, 1n)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });
});

describe("HOODS + Treasury integration", function () {
  it("AMM trading accrues 3% tax; a sell past swapThreshold swaps back and splits marketing/buyback", async function () {
    const {
      hoodsale,
      treasury,
      marketing,
      sellTx,
      sellAmount,
      accruedBeforeSell,
      marketingBefore,
      reserveBefore,
      treasuryEthBefore,
    } = await loadFixture(swapbackFixture);

    expect(accruedBeforeSell).to.be.gte(await hoodsale.swapThreshold());
    await expect(sellTx).to.emit(hoodsale, "SwapBack");

    // whole accrual was swapped; only the 3% fee of the triggering sell remains
    expect(await hoodsale.balanceOf(hoodsale.target)).to.equal((sellAmount * 300n) / 10000n);

    const marketingGain = (await ethers.provider.getBalance(marketing.address)) - marketingBefore;
    const reserveGain = (await treasury.buybackReserve()) - reserveBefore;
    const treasuryEthGain =
      (await ethers.provider.getBalance(treasury.target)) - treasuryEthBefore;

    expect(marketingGain).to.be.gt(0);
    expect(reserveGain).to.be.gt(0);
    // depositBuyback path: every treasury wei is earmarked
    expect(treasuryEthGain).to.equal(reserveGain);
    // 50/50 split (buyback side gets the rounding wei)
    expect(reserveGain).to.be.gte(marketingGain);
    expect(reserveGain - marketingGain).to.be.lte(1n);
  });

  it("executeBuyback then burns the reserve into HOODS at 0xdead", async function () {
    const { treasury, hoodsale } = await loadFixture(swapbackFixture);
    const reserve = await treasury.buybackReserve();
    expect(reserve).to.be.gt(0);

    const deadBefore = await hoodsale.balanceOf(DEAD);
    await treasury.executeBuyback(reserve, 0);
    const burned = (await hoodsale.balanceOf(DEAD)) - deadBefore;

    expect(burned).to.be.gt(0);
    expect(await treasury.buybackReserve()).to.equal(0);
    expect(await treasury.totalBoughtBack()).to.equal(burned);
  });
});

describe("LiquidityLocker", function () {
  describe("lock", function () {
    it("transfers tokens in, records LockInfo and emits Locked", async function () {
      const { locker, weth, alice } = await loadFixture(lockerFixture);
      const amount = ethers.parseEther("10");
      const unlockAt = (await time.latest()) + 30 * 24 * 3600;

      await expect(locker.connect(alice).lock(weth.target, amount, unlockAt, alice.address))
        .to.emit(locker, "Locked")
        .withArgs(0, weth.target, alice.address, amount, unlockAt);

      expect(await weth.balanceOf(locker.target)).to.equal(amount);
      const info = await locker.locks(0);
      expect(info.token).to.equal(weth.target);
      expect(info.owner).to.equal(alice.address);
      expect(info.amount).to.equal(amount);
      expect(info.unlockTime).to.equal(unlockAt);
      expect(info.withdrawn).to.equal(false);
      expect(await locker.lockCount()).to.equal(1);
    });

    it("reverts on zero amount", async function () {
      const { locker, weth, alice } = await loadFixture(lockerFixture);
      const unlockAt = (await time.latest()) + 3600;
      await expect(
        locker.connect(alice).lock(weth.target, 0, unlockAt, alice.address)
      ).to.be.revertedWith("zero amount");
    });

    it("reverts on unlockTime in the past", async function () {
      const { locker, weth, alice } = await loadFixture(lockerFixture);
      const past = (await time.latest()) - 10;
      await expect(
        locker.connect(alice).lock(weth.target, 1n, past, alice.address)
      ).to.be.revertedWith("unlock in past");
    });

    it("reverts on zero token or zero owner", async function () {
      const { locker, weth, alice } = await loadFixture(lockerFixture);
      const unlockAt = (await time.latest()) + 3600;
      await expect(
        locker.connect(alice).lock(ethers.ZeroAddress, 1n, unlockAt, alice.address)
      ).to.be.revertedWith("zero addr");
      await expect(
        locker.connect(alice).lock(weth.target, 1n, unlockAt, ethers.ZeroAddress)
      ).to.be.revertedWith("zero addr");
    });
  });

  describe("unlock", function () {
    async function lockedFixture() {
      const env = await lockerFixture();
      const amount = ethers.parseEther("10");
      const unlockAt = (await time.latest()) + 30 * 24 * 3600;
      await env.locker.connect(env.alice).lock(env.weth.target, amount, unlockAt, env.alice.address);
      return { ...env, amount, unlockAt };
    }

    it("reverts before unlockTime", async function () {
      const { locker, alice } = await loadFixture(lockedFixture);
      await expect(locker.connect(alice).unlock(0)).to.be.revertedWith("still locked");
    });

    it("reverts for non lock owner even after the time", async function () {
      const { locker, bob, unlockAt } = await loadFixture(lockedFixture);
      await time.increaseTo(unlockAt);
      await expect(locker.connect(bob).unlock(0)).to.be.revertedWith("not lock owner");
    });

    it("releases the tokens back to the lock owner after the time", async function () {
      const { locker, weth, alice, amount, unlockAt } = await loadFixture(lockedFixture);
      await time.increaseTo(unlockAt);
      const before = await weth.balanceOf(alice.address);
      await expect(locker.connect(alice).unlock(0))
        .to.emit(locker, "Unlocked")
        .withArgs(0, alice.address, amount);
      expect((await weth.balanceOf(alice.address)) - before).to.equal(amount);
      expect((await locker.locks(0)).withdrawn).to.equal(true);
    });

    it("cannot be unlocked twice", async function () {
      const { locker, alice, unlockAt } = await loadFixture(lockedFixture);
      await time.increaseTo(unlockAt);
      await locker.connect(alice).unlock(0);
      await expect(locker.connect(alice).unlock(0)).to.be.revertedWith("already withdrawn");
    });

    it("extendLock only moves the unlock time forward and only for the owner", async function () {
      const { locker, alice, bob, unlockAt } = await loadFixture(lockedFixture);
      await expect(
        locker.connect(alice).extendLock(0, unlockAt - 3600)
      ).to.be.revertedWith("can only extend");
      await expect(locker.connect(alice).extendLock(0, unlockAt)).to.be.revertedWith(
        "can only extend"
      );
      await expect(locker.connect(bob).extendLock(0, unlockAt + 3600)).to.be.revertedWith(
        "not lock owner"
      );

      await expect(locker.connect(alice).extendLock(0, unlockAt + 3600))
        .to.emit(locker, "LockExtended")
        .withArgs(0, unlockAt + 3600);
      expect((await locker.locks(0)).unlockTime).to.equal(unlockAt + 3600);

      // still locked at the old time
      await time.increaseTo(unlockAt);
      await expect(locker.connect(alice).unlock(0)).to.be.revertedWith("still locked");
    });

    it("extendLock reverts after withdrawal", async function () {
      const { locker, alice, unlockAt } = await loadFixture(lockedFixture);
      await time.increaseTo(unlockAt);
      await locker.connect(alice).unlock(0);
      await expect(
        locker.connect(alice).extendLock(0, unlockAt + 7200)
      ).to.be.revertedWith("already withdrawn");
    });

    it("transferLockOwnership hands control to the new owner", async function () {
      const { locker, weth, alice, bob, carol, amount, unlockAt } = await loadFixture(lockedFixture);
      await expect(
        locker.connect(carol).transferLockOwnership(0, carol.address)
      ).to.be.revertedWith("not lock owner");
      await expect(
        locker.connect(alice).transferLockOwnership(0, ethers.ZeroAddress)
      ).to.be.revertedWith("zero owner");

      await expect(locker.connect(alice).transferLockOwnership(0, bob.address))
        .to.emit(locker, "LockOwnershipTransferred")
        .withArgs(0, bob.address);
      expect((await locker.locks(0)).owner).to.equal(bob.address);
      expect(await locker.locksOfOwner(bob.address)).to.deep.equal([0n]);

      await time.increaseTo(unlockAt);
      await expect(locker.connect(alice).unlock(0)).to.be.revertedWith("not lock owner");
      const before = await weth.balanceOf(bob.address);
      await locker.connect(bob).unlock(0);
      expect((await weth.balanceOf(bob.address)) - before).to.equal(amount);
    });

    it("locksOfOwner lists a lock once after it is handed back or to its own owner", async function () {
      const { locker, alice, bob } = await loadFixture(lockedFixture);

      await locker.connect(alice).transferLockOwnership(0, bob.address);
      await locker.connect(bob).transferLockOwnership(0, alice.address);
      expect(await locker.locksOfOwner(alice.address)).to.deep.equal([0n]);
      expect(await locker.locksOfOwner(bob.address)).to.deep.equal([]);

      await locker.connect(alice).transferLockOwnership(0, alice.address);
      expect(await locker.locksOfOwner(alice.address)).to.deep.equal([0n]);
      const [ids, total] = await locker.locksOfOwnerPaged(alice.address, 0, 10);
      expect(ids).to.deep.equal([0n]);
      expect(total).to.equal(1n);
    });
  });

  describe("views", function () {
    it("lockCount / locksOfOwner / locksOfToken index multiple locks", async function () {
      const { locker, weth, hoodsale, deployer, alice, bob } = await loadFixture(lockerFixture);
      const unlockAt = (await time.latest()) + 3600;

      await locker.connect(alice).lock(weth.target, ethers.parseEther("1"), unlockAt, alice.address);
      await locker.connect(alice).lock(weth.target, ethers.parseEther("2"), unlockAt, alice.address);

      await hoodsale.connect(deployer).transfer(bob.address, ethers.parseEther("5"));
      await hoodsale.connect(bob).approve(locker.target, MAX);
      await locker.connect(bob).lock(hoodsale.target, ethers.parseEther("5"), unlockAt, bob.address);

      expect(await locker.lockCount()).to.equal(3);
      expect(await locker.locksOfOwner(alice.address)).to.deep.equal([0n, 1n]);
      expect(await locker.locksOfOwner(bob.address)).to.deep.equal([2n]);
      expect(await locker.locksOfToken(weth.target)).to.deep.equal([0n, 1n]);
      expect(await locker.locksOfToken(hoodsale.target)).to.deep.equal([2n]);
    });
  });
});
