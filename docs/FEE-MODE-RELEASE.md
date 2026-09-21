# Releasing the Uniswap v4 fee mode on mainnet

One ordered checklist for the founder. It covers the deployment, the inspection, the
verification, `TokenFactory.setDeployers`, the rehearsal sale, the Uniswap app check, the keeper,
the site and the rollback. The plan behind it is `docs/fee-mode-plan.md` (section 9 wins over the
earlier ones); the script is `scripts/deploy-v4-fee.js`.

Two things decide the order:

- **`TokenFactory.setDeployers` is the only step that touches the live platform**, so everything
  that can be inspected and verified is inspected and verified before it.
- **The released site must know the fee mode addresses before anyone but the founder can create a
  fee mode token.** Until `frontend/src/config/v4.js` carries them, the site reads a fee mode sale
  through the hook mode contracts: a Lock sale's lock card would show `V4PositionLocker` lock 0,
  which is another sale's lock, the tax would read as unknown and the trade box would revert. The
  launcher's creation brake (`setCreationOpen`) is therefore closed together with `setDeployers`
  and opened last, after the site release. The brake stops `createToken` only. It never touches
  a launch: a token that exists still opens its pool with the brake on, which is what lets the
  rehearsal sale run while the public is kept out.

## The deployer key

Every command that signs is written in one form. The key is read without an echo, so it reaches
neither the screen nor the shell history, and the line after it only says how long it is (a key is
66 characters with its `0x`, 64 without):

```bash
cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && <command>
```

Paste the key after pressing Enter, then press Enter again. Never type `DEPLOYER_KEY=0x...` in
front of a command: typed that way the key of the wallet that owns TokenFactory, PresaleFactory
and both launchers stays in `~/.zsh_history`. When the release is done, close that terminal (or
`unset DEPLOYER_KEY`). The commands below that read the chain and send nothing need no key and are
shown without it.

## Before the first command

- `cd ~/hoodsale/contracts && npx hardhat compile` reports nothing to compile, or
  compiles cleanly. What is deployed is what is verified afterwards, so the sources must not
  change between step 1 and step 3.
- `npx hardhat test` is green, `test/v4fee/deploy-script.test.js` included: it runs this very
  script through every path used below.
- `npm run test:fork:v4fee` is green against a fresh fork block: the same script rehearsed against
  the live contracts.
- The deployer wallet holds the gas for the thirteen transactions of steps 1, 4 and 10 (seven of
  them deploy a contract) plus about 0.025 ETH for the rehearsal sale of step 5 (0.02 ETH hard cap,
  0.002 ETH test buy, gas). Of the hard cap about 0.012 ETH goes into the rehearsal pool and stays
  there for good: fee mode never gives liquidity back. `HARD_CAP=0.01` halves it.

## The checklist

### 1. Deploy, holding `setDeployers` back

```bash
cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && SKIP_SET_DEPLOYERS=1 npx hardhat run scripts/deploy-v4-fee.js --network robinhood
```

The variable is `SKIP_SET_DEPLOYERS`. `SKIP_DEPLOYERS`, the name `scripts/deploy-v4.js` reads, is
refused by this script before it does anything.

It sends ten transactions: V4FeeLauncher, HoodSaleV4FeeHook at a mined address, `setHook`, the
second HoodSaleV4Lens, `setLens`, the second HoodSaleV4Router, `setKeeper` and the three Fee
deployers. Nothing of it is reachable from the live platform yet. If it stops half way, run the
same command again: every finished step is found in `deployments/robinhood.json` and skipped.

Expect at the end:

- `Wiring, before TokenFactory.setDeployers` with every line `ok`, the nine
  `... deployer builds its token for ..., asked as TokenFactory` lines among them. No `FAIL`.
- `TokenFactory.setDeployers: not sent (SKIP_SET_DEPLOYERS)` followed by `to`, `call`, `data` and
  `now: setDeployers(...)   (the rollback, recorded as previous*)`.
- `deployments/robinhood.json` has `v4FeeLauncher`, `v4FeeFromBlock`, `v4FeeHook`, `v4FeeHookSalt`,
  `v4FeeLens`, `v4FeeRouter` and the three `v4Fee*Deployer` keys. `previousStandardDeployer`,
  `previousTaxDeployer` and `previousRewardsDeployer` now name the V4 generation the factory uses
  today (`0x9Bfd...ED1E`, `0x65A1...1226`, `0xEc7d...4EC3`): that is the rollback target, recorded
  before anything can replace it. What those three keys named before is kept under
  `deployersBeforeV4`, and `deployersBeforeV4Generation` says what each of them is (the rewards
  one is an earlier V4 deployer that `scripts/deploy-v4-fixes.js` replaced, not one from before v4).

### 2. Inspect

```bash
cd ~/hoodsale/contracts && npx hardhat run scripts/check-deployment.js --network robinhood
```

Expect `v4Fee_wiringMatches true`, `v4FeeHook_flags 0x2800 (0x2800 expected)`,
`v4FeeLauncher_creationOpen true`, `v4FeeLauncher_matchesBuild`, `v4FeeHook_matchesBuild`,
`v4FeeLens_matchesBuild` and `v4FeeRouter_matchesBuild` all `true`, the three `*_generation` lines
still `V4`, `v4Fee_creationWired false` (the factory does not use the Fee deployers yet) and no
`*_recordIsStale` line. Look at the new contracts on the explorer if you want to: the fee launcher's
owner is the deployer wallet, its keeper is the launch keeper `0x2643...caff0`.

Nothing on the platform has changed so far. Stopping here costs nothing but the gas already spent.

### 3. Verify on Sourcify

```bash
cd ~/hoodsale/contracts && npx hardhat run scripts/verify-platform.js --network robinhood
```

The summary must list `v4FeeLauncher`, `v4FeeHook`, `v4FeeLens`, `v4FeeRouter`,
`v4FeeStandardDeployer`, `v4FeeTaxDeployer` and `v4FeeRewardsDeployer` as verified (or already
verified). This comes before the site release on purpose: the Trust page shows the four fee mode
rows as verified the moment it has their addresses, so they must really be. `docs/VERIFY.md` has
the fallbacks when Sourcify or Blockscout is down.

### 4. `setDeployers`, with creation closed

```bash
cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && CLOSE_CREATION=1 npx hardhat run scripts/deploy-v4-fee.js --network robinhood
```

Two transactions, in this order: `V4FeeLauncher.setCreationOpen(false)`, then
`TokenFactory.setDeployers(<the three Fee deployers>)`. From here on every token the factory makes
comes from the Fee deployers. For a wallet, for QuickLaunch and for the hook mode launcher they
build the same token as before, which the script has simulated before sending and checks again
after.

Expect:

- `V4FeeLauncher: creation closed (CLOSE_CREATION)` before `TokenFactory: deployers set to ...`.
- `Token creation` with `ok` for the three `hook mode launcher can still create ...` lines and for
  `an ordinary creator still gets a V2 token`, then
  `note fee launcher creation is closed, so its three creations were not simulated here`. That
  note is not a failure.
- The rollback, printed as `to`, `call` and `data`. Keep that output.

If a line says `FAIL`, the reason is in brackets next to it, and the error at the end says where
the run stands: `setDeployers` has landed and is recorded, running the command again repeats only
the checks, and the rollback call is named. A `FAIL` whose reason reads like a network error
(timeout, socket) is answered by running the command again; anything else by the Rollback section
below.

Without `CLOSE_CREATION=1` the same run leaves creation open to every caller from the moment
`setDeployers` lands. The script prints the warning and the exact `setCreationOpen(false)` call in
that case; do not release that way.

### 5. The rehearsal sale

```bash
cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && OPEN_TO_CREATE=1 npx hardhat run scripts/test-v4-fee-launch.js --network robinhood
```

With the brake on, `OPEN_TO_CREATE=1` lets the launcher's owner open creation for the one
`createToken` and close it again right after (three transactions; the script closes it even when
the creation fails). Then it opens a 0.02 ETH sale for the token, waits a minute for it to start,
fills it, finalizes it into a Uniswap v4 pool whose fee is the tax (3.25%), buys 0.002 ETH and sells
half of it through the fee mode router, and handles the fees the way the keeper does: `collect`,
`convert` with a floor 1% below the V4Quoter's quote, `flush`, `flushPlatform`. It prints every
figure. If it stops after the token or the sale exists, run it again with `TOKEN=0x...` and
`PRESALE=0x...` in front of `npx` so it continues instead of creating another.

Expect:

- the launch position `held by <the fee hook>`, `lpLockId is 0`;
- `waiting in the launch position: ... ETH and ... HSFEE`, and under it
  `of which these two trades paid ... ETH (3.25% of the buy) and ... HSFEE (3.25% of the sell)`;
- the conversion at 99% of the quote or better;
- the marketing share back in the deployer wallet, the platform share in the Treasury;
- afterwards `npx hardhat run scripts/check-deployment.js --network robinhood` reads
  `v4FeeLauncher_creationOpen false` and `v4FeeLauncher_tokens 1` (one per rehearsal run):
  creation was open for the few seconds between two of the script's transactions, and nobody
  else used them. One token more would be a stranger's, whose sale the released site cannot read
  yet; hide that sale in `hidden.js` with the rehearsal one if it ever opens.

Write down the token, the sale and the pool id it prints at the end. The same command with
`KIND=rewards ACTION=burn` added in front of `OPEN_TO_CREATE=1` rehearses a Rewards token (1%
marketing, 2% to the holders in WETH) if you want that on mainnet too; it costs another pool's
worth of locked ETH.

### 6. The Uniswap app

About 15 minutes after the pool opened, open
`https://app.uniswap.org/explore/pools/robinhood/<pool id>` and swap a little ETH for the token
and back, from any wallet. The app must quote the pool and both swaps must execute. Check
DexScreener (`https://dexscreener.com/robinhood/<pool id>`) as well.

If the app does not route the pool, stop here. Creation stays closed, the platform runs as before,
and what to do next is a decision of its own (plan section 8, "Routing is unproven").

### 7. The keeper on the server

The keeper runs on the server, not on this Mac. To look after fee mode pools it needs two things
there: the new `scripts/launch-keeper.js`, and a `deployments/robinhood.json` that has
`v4FeeLauncher`, `v4FeeHook` and `v4Quoter` (the last one has been in the file since hook mode).
Optional settings are in `keeper/keeper.env.example` (`V4_FEE_CONVERT_MIN_ETH`,
`V4_FEE_BACKLOG_MIN_ETH`, `V4_FEE_SLIPPAGE_BPS` and the shared `V4_FLUSH_MIN_ETH`), and the
defaults there are the ones the keeper uses.

How those two files reach the server, and how the service is restarted, is for the founder to
confirm before this step; nothing here assumes it. The repository's own `keeper/update.sh` resets
the server's clone to `origin/main`, reinstalls, compiles and restarts `hoodsale-keeper`. If that
is still how the server is updated, the keeper sees fee mode only after the new
`deployments/robinhood.json` and the new keeper script are committed and pushed to `main`.
Confirm:

1. Is `bash /opt/hoodsale/contracts/keeper/update.sh` still the way the server is updated?
2. If so, are `deployments/robinhood.json` (with the `v4Fee*` keys of step 1) and
   `scripts/launch-keeper.js` on `origin/main`?
3. If not, how do the two files get there, and what restarts the service?

After the restart the keeper's log (`journalctl -u hoodsale-keeper -f` with that unit) must have a
line `uniswap v4 modes:` that names both `hook` and `fee` with the launcher and hook addresses of
step 1, and no `warning: no Uniswap v4 quoter is set`. That line is the check. The rehearsal pool
itself will not make the keeper send anything: by default it collects from 0.005 ETH of waiting
fees on (`V4_FLUSH_MIN_ETH`) and converts from a quote of 0.0005 ETH on
(`V4_FEE_CONVERT_MIN_ETH`), and the swaps of steps 5 and 6 leave far less. Until the keeper is
updated nothing is lost: fees wait in the launch position and in the hook, and anyone can call
`collect`, `convert` and `flush`.

### 8. The site configuration

In `~/hoodsale/frontend/src/config`. The closing output of step 4 prints every address
below in the form it is pasted in.

1. **`v4.js`**, the `4663` entry: replace `fee: NO_FEE_MODE` with

   ```js
   fee: {
     launcher: '<v4FeeLauncher>',
     hook: '<v4FeeHook>',
     lens: '<v4FeeLens>',
     router: '<v4FeeRouter>',
     // The fee launcher's first block: where its TaxConfigUpdated events start
     fromBlock: <v4FeeFromBlock>n,
   },
   ```

   `fromBlock` is a bigint: the number from `deployments/robinhood.json` with an `n` behind it,
   no quotes. Without it the site reads the launcher's logs from block 0.
2. **`contracts.js`**: in `MAINNET_EXTRA` set `standardDeployer`, `taxDeployer` and
   `rewardsDeployer` to `v4FeeStandardDeployer`, `v4FeeTaxDeployer` and `v4FeeRewardsDeployer`, and
   rename the three rows `StandardTokenDeployerV4`, `TaxTokenDeployerV4` and
   `RewardsTokenDeployerV4` to `StandardTokenDeployerFee`, `TaxTokenDeployerFee` and
   `RewardsTokenDeployerFee` (their role text: a plain token for a Uniswap v4 launch of either
   mode). TokenFactory stopped using the V4 generation in step 4, so the Trust page would
   otherwise show three contracts that no longer deploy anything.
3. **`contracts.js`**: `OFFLINE_TEST_COUNT` already reads 711, the `passing` number of the suite
   with fee mode in it. Check it against the run from "Before the first command" and correct it if
   the suite has grown since.
4. **`hidden.js`**: add the rehearsal sale (or sales) of step 5 to the `4663` list.
5. Build the site and look at the rehearsal sale's page locally against mainnet: the card says the
   liquidity is locked forever and names the fee hook as the holder, the tax reads 3.25%, the trade
   box quotes. The four fee mode rows of the Trust page now read verified, which step 3 made true.

### 9. Release the site

With the usual upload command. Afterwards open the rehearsal sale's page on the live site once
more, and the Trust page.

### 10. Open creation

```bash
cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && OPEN_CREATION=1 npx hardhat run scripts/deploy-v4-fee.js --network robinhood
```

One transaction, `V4FeeLauncher.setCreationOpen(true)`, sent only after the wiring, the hook mode
creations and the V2 creation have been checked once more. Right after it the script simulates the
three fee launcher creations for real: expect `ok   fee launcher can create a Standard token`, the
same for Tax and Rewards, and no `FAIL`. Fee mode is public from this transaction on. The script
closes with its warning about an open launcher and its list of next steps, as on every run on a
real chain; both speak of the time before the site release, which is behind you here.

The brake stays available: the same command with `CLOSE_CREATION=1` instead closes creation again
at any time, and touches no launch.

### 11. Afterwards

- Close the terminal that holds the key, or `unset DEPLOYER_KEY`.
- `deployments/robinhood.json` now differs from the last commit. It is the record the rollback and
  every later script read: keep it with the release.
- `npx hardhat run scripts/check-deployment.js --network robinhood` now reads
  `v4Fee_creationWired true`, the three `*_generation` lines `Fee`, `v4FeeLauncher_creationOpen
  true`, and still no `*_recordIsStale` line.

## Rollback

Fee mode is switched off by giving TokenFactory back the V4 generation:

```
TokenFactory (0x7BD7c2d1f37215de6DE59bC7fD92eA3649d3Cdbf)
  .setDeployers(previousStandardDeployer, previousTaxDeployer, previousRewardsDeployer)
```

with the three values from `deployments/robinhood.json`. Every run of `scripts/deploy-v4-fee.js`
from step 4 on prints this call with its addresses and its calldata (`Rollback, should it ever be
needed`), and warns instead when the record does not name three deployers that answer
`launcher()` with the live V4Launcher. As the platform stands today the call is

```
setDeployers(0x9Bfda553971163AB5667f987AdD8124fa86FED1E, 0x65A15D6784E3d154fDDa10B6c40cAeC88cf41226, 0xEc7d7EF2C9b56f019e96dF04E798cAf38E6E4EC3)
```

but the printed one is the authority. Do not use `deployersBeforeV4` for it: those are from before
hook mode, and with them the hook mode launcher would be handed V2 tokens.

The owner wallet sends it, either from TokenFactory's verified page on the explorer (Write
contract, `setDeployers`, the three addresses) or from the Hardhat console:

```bash
cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && npx hardhat console --network robinhood
```

```js
const d = require("./deployments/robinhood.json");
const factory = await ethers.getContractAt("TokenFactory", d.tokenFactory);
await (await factory.setDeployers(d.previousStandardDeployer, d.previousTaxDeployer, d.previousRewardsDeployer)).wait();
```

After it, creating a fee mode token reverts `NotFeeToken`. Hook mode, V2 and QuickLaunch create
tokens as before, and every fee mode token, sale and pool that exists keeps working: trading, the
keeper's collect, convert and flush, the holders' rewards. When the aim is only to stop new fee
mode tokens, the creation brake of step 10 does that without touching TokenFactory, and it is the
first thing to reach for. On the site, clearing the fee entry of `config/v4.js` takes the option
away, but check first what that does to the pages of the fee mode sales that exist. Running
`scripts/deploy-v4-fee.js` again without `SKIP_SET_DEPLOYERS` sends `setDeployers` with the Fee
deployers again: that is how fee mode comes back, and why that command is not run by habit.

## The other deploy scripts, once fee mode is live

`scripts/deploy-v4-fixes.js`, `scripts/deploy-v4.js` and `scripts/deploy-token-deployers.js` build
deployers that do not know the fee launcher. Each of them now stops before it deploys or sends
anything when TokenFactory uses the Fee deployers, and says which variable overrides that. A new
PresaleCode alone is shipped by `scripts/upgrade-presale-code.js`.
