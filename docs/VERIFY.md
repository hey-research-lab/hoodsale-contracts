# Source verification

How HoodSale contracts (the platform itself and every token / presale the platform
creates) get their source code verified, what to run, and what happens when an API is
not reachable.

Targets, in order:

| target | chains | API | notes |
|--------|--------|-----|-------|
| Sourcify (primary) | 4663, 46630 | `https://sourcify.dev/server` v2 (`SOURCIFY_URL` overrides) | Standard JSON input, job polling; verified sources at `https://repo.sourcify.dev/<chainId>/<address>` |
| Blockscout (secondary) | 4663 `https://robinhoodchain.blockscout.com`, 46630 `https://explorer.testnet.chain.robinhood.com` | `<explorer>/api` (from `hardhat.config.js`, do not edit it) | only when the API answers JSON; mainnet answers non-browser clients with a Cloudflare challenge (403) and its verification service returned 500 on 2026-09-05 |

`BLOCKSCOUT_API_KEY` is optional; the config falls back to the literal `blockscout`. The
hardhat `sourcify` plugin setting stays disabled: `scripts/lib/sourcify.js` talks to the v2
API directly, the plugin only knows the legacy endpoint.

## Pieces

| file | role |
|------|------|
| `scripts/lib/constructorArgs.js` | Pure module. `reconstructConstructorArgs(provider, address, opts)` detects what an address is and rebuilds its exact constructor arguments from chain state. Returns `{ contract, args, kind, name, address, meta }` where `contract` is the fully qualified name (`contracts/tokens/TaxToken.sol:TaxToken`) and `meta.sources` / `meta.warnings` say where each value came from. |
| `scripts/lib/sourcify.js` | Sourcify v2 client on the global `fetch`: `submitStandardJson`, `pollJob`, `getContractStatus`, `verifyStandardJson` (the three in one), `supportsChain`, `repoUrl`. Errors are `SourcifyError { code, httpStatus, customCode, retryable }`; "already verified" answers are success. |
| `scripts/verify-standard-json.js` | Builds the verification package (Standard JSON Input taken from the Hardhat build-info, compiler version, ABI encoded constructor args); the same package is what Sourcify receives and what `verify-out/<network>/` gets for a manual upload. Also a CLI. |
| `scripts/verify-contract.js` | Verifies one or more addresses (`ADDRESSES=` env). Shared core (`verifyOne`: Sourcify first, Blockscout second; `verifyAddresses`, Cloudflare detection, summary table) used by the two scripts below. |
| `scripts/verify-platform.js` | Verifies every contract in `deployments/<network>.json` plus the three token deployers read from `TokenFactory`, then the Uniswap v4 contracts of both modes for the keys the file has (hook mode: `v4Locker`, `v4Launcher`, `v4Hook`, `v4Lens`, `v4Router`, `rewardsTokenCodeV4`; fee mode: `v4FeeLauncher`, `v4FeeHook`, `v4FeeLens`, `v4FeeRouter` and the three `v4Fee*Deployer` keys while the factory does not name them yet). Run it after a platform deployment; the platform contracts are published and verified (see the Trust page of the site). |
| `scripts/check-deployment.js` | Read-only wiring report. For verification it says which generation each token deployer is (`V2`, `V4`, `Fee`), whether every replaceable contract and the fee mode contracts match the current build, and whether fee mode is wired (`v4Fee_wiringMatches`, `v4Fee_creationWired`). All three deployers are the ones TokenFactory uses, never the record's; a record that names another one gets a `<slot>Deployer_recordIsStale` line (after a `setDeployers` sent by hand, or a rollback). |
| `scripts/auto-verify.js` | Long running watcher: follows `TokenCreated` (and `PresaleCreated` with `VERIFY_PRESALES=1`), waits for confirmations, verifies with retries and exponential backoff, persists a cursor in `verify-state/<network>.json`. Tokens of both v4 launchers come through the same event. `scripts/launch-keeper.js` runs it in the keeper process unless `AUTO_VERIFY=0`. |
| `test/verify-args.test.js`, `test/auto-verify.test.js` | Offline tests for all of the above (in-process Hardhat network, `MockDex`, a mocked Sourcify server on a random port). |

`verify-state/` and `verify-out/` carry their own `.gitignore` (`*`, `!.gitignore`), the
scripts recreate it if the folder is missing, so nothing generated is ever committed.

## Commands

```bash
# 1. the keeper: launches, deliveries and the verification of every factory token in one process
#    (it signs with KEEPER_KEY, which it takes from the environment: on the server from the
#    service's environment file, never typed in front of the command)
npm run keeper -- --network robinhood
AUTO_VERIFY=0 npm run keeper -- --network robinhood      # without verification

# 2. the watcher on its own (same behaviour, no transactions)
npm run auto-verify -- --network robinhood
VERIFY_PRESALES=0 npm run auto-verify -- --network robinhood              # tokens only

# 3. arbitrary addresses (tokens, presales, deployers, platform contracts)
ADDRESSES=0xTOKEN,0xPRESALE npx hardhat run scripts/verify-contract.js --network robinhood

# 4. platform contracts (after every deployment or replacement, scripts/deploy-v4-fee.js included)
npx hardhat run scripts/verify-platform.js --network robinhood

# 5. manual packages only, no API call at all
PLATFORM=1 npx hardhat run scripts/verify-standard-json.js --network robinhood
ADDRESSES=0xTOKEN npx hardhat run scripts/verify-standard-json.js --network robinhood

# offline tests
npx hardhat test test/verify-args.test.js test/auto-verify.test.js
```

None of the verification commands signs anything, so none needs a key. A command that does (the
deploy scripts) reads it without an echo, so it reaches neither the screen nor the shell history:

```bash
cd ~/hoodsale/contracts && read -s DEPLOYER_KEY && export DEPLOYER_KEY="$(printf %s "$DEPLOYER_KEY" | tr -d '[:space:]')" && echo "key loaded, ${#DEPLOYER_KEY} characters" && <command>
```

Never type `DEPLOYER_KEY=0x...` in front of a command. Where verification sits in the fee mode
release (after the deployment, before `TokenFactory.setDeployers` and before the site release) is
laid out step by step in `docs/FEE-MODE-RELEASE.md`.

Environment variables understood by the scripts:

| variable | scripts | meaning |
|----------|---------|---------|
| `DRY_RUN=1` | all | print the exact submission (fqn, compiler, decoded and ABI encoded args, source count, the Sourcify request) and never touch the network or the state file |
| `SOURCIFY=0` | verify-contract, verify-platform, auto-verify, keeper | skip Sourcify, Blockscout only (the pre-Sourcify behaviour, manual packages on a Cloudflare answer) |
| `SOURCIFY_URL` (`https://sourcify.dev/server`) | all | Sourcify server; a custom URL is accepted for every chain (the tests point it at a mock) |
| `SOURCIFY_CHAINS` (`4663,46630`) | all | chains Sourcify is tried for |
| `SOURCIFY_TIMEOUT_MS` (60000), `SOURCIFY_JOB_TIMEOUT_MS` (300000), `SOURCIFY_POLL_MS` (2000) | all | request timeout, how long to wait for a submitted job, polling interval |
| `SOURCIFY_REPO_URL` (`https://repo.sourcify.dev`) | all | base of the links printed for verified contracts |
| `VERIFY_PRESALES=0` | auto-verify, keeper | skip `PresaleCreated` contracts (verified by default) |
| `AUTO_VERIFY=0` | keeper | do not run the watcher inside the keeper process |
| `FORCE_MANUAL=1` | verify-contract, verify-platform, auto-verify | skip both APIs and write `verify-out/<network>/<address>.json` packages directly |
| `VERIFY_OUT=dir` | all | package directory (default `verify-out`) |
| `DEPLOYMENTS_FILE=path` | all | use another deployments json instead of `deployments/<network>.json` |
| `FROM_BLOCK=n` | verify-contract, verify-standard-json | hint for log scans (platform deployment block); keeps creation lookups cheap on RPCs with `eth_getLogs` range limits |
| `BLOCKSCOUT_API_KEY` | all (via hardhat.config.js) | sent as `apikey` to the API and to the pre-flight probe; set it if Robinhood hands out an allowlisted key |
| `ADDRESSES=a,b` | verify-contract, verify-standard-json | comma separated targets |
| `PLATFORM=1` | verify-standard-json | package every platform contract |
| `CONFIRMATIONS` (12) | auto-verify | blocks to wait after the creation block before the first attempt, gives Blockscout time to index the creation |
| `POLL_INTERVAL_MS` (15000), `LOG_CHUNK` (2000), `MAX_BLOCKS_PER_TICK` (200000) | auto-verify | scan pacing |
| `START_BLOCK` | auto-verify | first run only: scan from this block; without it the watcher starts at the current head and only sees new creations |
| `MAX_ATTEMPTS` (8), `BACKOFF_BASE_MS` (30000), `BACKOFF_MAX_MS` (3600000) | auto-verify | retry policy: delay = min(base * 2^(attempt-1), max) |
| `PROBE_TTL_MS` (600000) | auto-verify | how often the API reachability probe is repeated |
| `ONCE=1` | auto-verify | one scan + one processing pass, then exit (cron friendly) |

Exit code is 1 when at least one target ended in `failed`; `manual-package`,
`already-verified`, `verified`, `dry-run` and `skipped` are all success.

## How a single verification works (`verifyOne`)

1. **Reconstruct constructor args** with `lib/constructorArgs.js` (details below).
2. **Sourcify** (unless `SOURCIFY=0` or the chain is not in `SOURCIFY_CHAINS`): the
   package is built from build-info (`standardJsonInput`, `compilerVersion`
   `0.8.26+commit.8a97fa7a`, `contractIdentifier` = fully qualified name) and the current
   status is read (`GET /v2/contract/{chainId}/{address}`; `exact_match` is
   `already-verified`). Then `POST /v2/verify/{chainId}/{address}` with the creation
   transaction hash when it is known (for factory tokens that is the factory / QuickLaunch
   transaction) and `GET /v2/verify/{verificationId}` until `isJobCompleted`. A job whose
   `runtimeMatch` is `exact_match` while `creationMatch` is null is a success: contracts
   created inside another contract's transaction have no top-level creation tx to compare
   with. `409 already_verified` is success. A success here is terminal (`verified`,
   `target: "sourcify"`, `sourcifyUrl`, `match`).
3. **Blockscout**, only if Sourcify was skipped or failed. **Probe the explorer API once**
   (`GET <api>?module=block&action=eth_block_number`). `ok` continues; `cloudflare` (HTML
   challenge page, HTTP 403/503), `http-error` (500) and `unreachable` never block: after
   a Sourcify attempt the address stays a retryable `failed` (the watcher backs off and
   tries Sourcify again), without Sourcify a Cloudflare answer writes the manual package as
   before; `unsupported` (no explorer configured for the chain, e.g. the `hardhat`
   network) is `unsupported-network` without Sourcify and a retryable `failed` after it.
4. **Already verified check** through the plugin's `Etherscan.isVerified`; a positive
   answer is reported as `already-verified` and counted as success.
5. `hre.run("verify:verify", { address, contract, constructorArguments })`. The plugin
   first submits the minimal Standard JSON input, then the full one. Any "Already
   Verified" / "Smart-contract already verified" answer is treated as success.
6. Every error is classified (`classifyVerifyError`): `blocked` (HTML/403/JSON parse
   error, i.e. Cloudflare) writes the manual package instead of failing (Sourcify off) or
   keeps the retryable failure (Sourcify on); `not-indexed` (explorer has no bytecode yet)
   and `network` are retryable; the rest is `failed`.

The plugin prints a yellow `[WARNING] Network and explorer-specific api keys are
deprecated...` line on every run because the config keys the API key per network.
It is harmless, Blockscout does not support the Etherscan v2 endpoint anyway.

## Constructor argument reconstruction

Detection order in `reconstructConstructorArgs`:

1. address listed in the deployments json (`treasury`, `locker`, `tokenFactory`,
   `presaleFactory`, `hoodsale`, `metadataRegistry`, `lens`, the hook mode keys `v4Hook`,
   `v4Launcher`, `v4Locker`, `v4Lens`, `v4Router`, `rewardsTokenCodeV4`, and the fee mode keys
   `v4FeeLauncher`, `v4FeeHook`, `v4FeeLens`, `v4FeeRouter`, `v4FeeStandardDeployer`,
   `v4FeeTaxDeployer`, `v4FeeRewardsDeployer`; two keys may name the same contract, as the two
   lens and the two router instances do);
2. platform token: the address answers `tokenFactory()` and that factory's
   `tokenInfo(address).token == address`; type from `tokenType`;
3. `factory()` answers: `PresaleFactory.isPresale(address)` (Presale) or
   `TokenFactory.standardDeployer()/taxDeployer()/rewardsDeployer() == address` (deployer).
   The slot says which of the three it is, its own getters say which generation:
   `feeLauncher()` answers for the Fee generation, `launcher()` alone for the V4 generation,
   neither for the V2 one;
4. deployed bytecode compared with the local artifacts (metadata hash and immutable
   slots masked), used when no deployments json is available. This is also how a deployer is
   found that the factory does not name: a replaced generation, or the Fee deployers between
   their deployment and `TokenFactory.setDeployers`;
5. otherwise `UNRECOGNIZED` (EOAs give `NO_CODE`).

Immutable values are read from the contract (`platformTreasury`, `tokenFactory`,
`router`, `platformTaxBps`, `rewardToken`, presale `saleOwner/router/locker/treasury/
platformFeeBps/exitPenaltyBps`, the whole `PresaleParams` struct which is written only in
the constructor, lens and registry immutables, deployer `factory`). `name`/`symbol`/
`creator` come from `TokenFactory.tokenInfo`. Owners of Ownable platform contracts come
from the `OwnershipTransferred(address(0), owner)` log of the creation block, never from
the current `owner()`.

Values the owner can change later (`marketingWallet`, `buyTaxBps`, `sellTaxBps`, the
four Rewards taxes, and `treasury/router/locker/marketingWallet` on TokenFactory,
PresaleFactory and HoodSaleToken) are resolved in this order, the first hit wins, and
`meta.sources` records which one it was:

| source | how | exactness / limits |
|--------|-----|--------------------|
| `creation-calldata` (tokens) | find the `TokenCreated(token)` log, load its transaction, decode `createStandardToken/createTaxToken/createRewardsToken` from `tx.data`, cross-check name and symbol | exact; only when the creator called TokenFactory directly (`tx.to == TokenFactory`). A Safe or another contract in between hides the calldata. |
| `creation-receipt` (tokens) | the `Transfer(address(0), creator, amount)` log the constructor's `_mint` emitted in the creation transaction gives `totalSupply` | exact, needs no archive node, works for tokens created inside another contract's call (QuickLaunch, a Safe). Covers everything a StandardToken needs; taxes and marketing wallet of Tax / Rewards tokens continue with the next rows. |
| `creation-tx` (platform) | the deployment transaction (`tx.to == null`, receipt `contractAddress` matches); the constructor args are the last `32 * N` bytes of the init code (all platform constructors are static types), owner cross-checked with the event | exact for EOA deployments (this is how `scripts/deploy.js` deploys). A local artifact whose init code differs (metadata drift) only produces a warning. |
| `creation-state` | `eth_call` with `blockTag = creation block` | exact unless the value was changed inside the creation block itself (detected through `TaxesUpdated` / `MarketingWalletUpdated` logs in that block; `RewardsToken.setMarketingWallet` emits nothing so it cannot be detected). Needs an RPC that serves historical state for that block. |
| `events` | no `TaxesUpdated` / `MarketingWalletUpdated` log since creation means the current value is the original | proves "unchanged" only. If a change happened the original value is NOT recoverable this way (`current-CHANGED` + warning). `RewardsToken.marketingWallet` can never be confirmed (`current-UNVERIFIED`). |
| `current` | current state | last resort, always accompanied by a warning |

`totalSupply` is immutable in practice (OZ ERC20 without a burn entry point; the tokens
never mint after the constructor), it is still taken from calldata or the creation block
when available and from current state otherwise.

The creation log is found with a single full-range `eth_getLogs`; if the RPC rejects the
range the module binary-searches `eth_getCode` for the creation block and reads that one
block, and as a last resort scans in `logChunk` windows (bounded by `maxChunks`). Passing
`creation: { blockNumber, transactionHash }` (the watcher does) skips the search.

`opts.strategies` (for example `["creation-state"]` or `["events", "current"]`) restricts
the resolution order; the tests use it to prove every path independently.

### Tokens for Uniswap v4 pools

A token the V4Launcher created is registered in the TokenFactory like any other, but it is a
different contract. Before the V2 name is picked from `tokenType`, the token is asked for
`poolVersion()`: `4` means a v4 token, a revert means V2 (only when the call fails for another
reason, such as an RPC error, is the runtime code searched for the selector instead). A v4
token is `HoodSaleTokenV4` for `tokenType` 0 or 1 and `RewardsTokenV4` for 2, with the
arguments

- `HoodSaleTokenV4(name, symbol, totalSupply, launcher, tokenFactory, tokenType)`
- `RewardsTokenV4(name, symbol, totalSupply, launcher, tokenFactory, rewardToken, weth, v3Router, v3Quoter, v3Path)`

`name` and `symbol` come from the factory record, the addresses and `tokenType` are immutables
read back, `totalSupply` comes from the mint in the creation receipt, and `v3Path` (the route
the platform's QuickLaunch stored for the reward when the token was created; empty for WETH)
from the `RewardRouteV3Updated` log of the creation receipt, so a route the owner set later
does not matter. The same fallbacks as above apply when the receipt cannot be read.

A fee mode token (created through the V4FeeLauncher, where the tax is the pool's own fee) is the
same `HoodSaleTokenV4` or `RewardsTokenV4`, byte for byte. Only its `launcher` argument differs:
it is the fee launcher, read back from the token like every other immutable, so nothing else
changes and the watcher needs no setting for it. `meta.launchMode` says which launcher made the
token: `"fee"` or `"hook"` by the `v4FeeLauncher` and `v4Launcher` keys of the deployments json,
and without them by the hook the launcher names, since a Uniswap v4 hook carries its
permissions in the low 14 bits of its address and only the fee hook's are exactly `0x2800`. A
launcher that is neither key of a deployments json that has one produces a warning, not an error.

### Fee mode platform contracts

`scripts/deploy-v4-fee.js` deploys them and records them under the keys above. Every argument is
an immutable and is read back, except the launcher's owner: the launcher is Ownable and `owner()`
answers with whoever holds it now, so the deploying owner is taken from the
`OwnershipTransferred(0, owner)` log of its creation (`meta.sources.owner = "ownership-event"`,
and `meta.creation` carries the deployment transaction, which Sourcify is given). The explorers
are sent these arguments, so they stay right after ownership has moved to a multisig or a
timelock. Only when that log cannot be found is the current owner used
(`meta.sources.owner = "current-owner"`), with a warning that it is wrong if ownership was handed
on. `V4Launcher` and `V4PositionLocker` are reconstructed the same way.

- `V4FeeLauncher(owner, poolManager, positionManager, permit2, tokenFactory, presaleFactory, treasury)`
  (the hook mode launcher without its locker argument)
- `HoodSaleV4FeeHook(poolManager, positionManager, launcher, platformTreasury)`. It is deployed
  through the CREATE2 proxy at a mined address, so it has no deployment transaction of its own;
  the salt is kept as `v4FeeHookSalt`, and mining again from the artifact's creation code plus
  the reconstructed arguments lands on the same address (the tests do exactly that).
- `HoodSaleV4Lens(feeLauncher, stateView)` and `HoodSaleV4Router(poolManager, feeLauncher)`: second
  instances of the hook mode contracts, under `v4FeeLens` and `v4FeeRouter`
- `StandardTokenDeployerFee(factory, launcher, feeLauncher)`,
  `TaxTokenDeployerFee(factory, launcher, feeLauncher)` and
  `RewardsTokenDeployerFee(factory, v3Router, v3Quoter, rewardsTokenCode, rewardsTokenCodeV4, launcher, feeLauncher)`,
  where `launcher` is the hook mode V4Launcher. RewardsTokenCode and RewardsTokenCodeV4 are the
  holders already on chain; fee mode deploys no new one.

`verify-platform.js` lists the Fee deployers once: as `standardDeployer`, `taxDeployer` and
`rewardsDeployer` when TokenFactory names them, under their `v4Fee*Deployer` keys before that
(a run with `SKIP_SET_DEPLOYERS=1`) and after a rollback. The V4 generation they replace stays
verifiable by address, found by its bytecode.

### Presales from an earlier `Presale.sol`

`verify-contract.js` and the watcher build every submission from the current build. A presale
the factory created from an earlier PresaleCode holder runs the code of the `Presale.sol` of
that time, so it only matches when submitted with that source: compile the file from the
commit the holder was deployed from with the same settings, check that its creation code
equals the holder's `creationCode()`, and submit that Standard JSON input with the
reconstructed arguments. The presales of 18 September 2026 and earlier were verified this way
(`de11729` and `51db1cd`).

## Mainnet: Cloudflare in front of the API

Verified on 2026-09-01: `https://robinhoodchain.blockscout.com/api` answers non-browser
clients (curl, undici, therefore hardhat-verify) with HTTP 403 and a Cloudflare "Just a
moment" HTML page. The testnet API answers normally. Until Robinhood allowlists a key or
lifts the challenge, mainnet verification is a browser upload:

1. `PLATFORM=1 npx hardhat run scripts/verify-standard-json.js --network robinhood`
   (or let `verify-platform.js` / `verify-contract.js` / `auto-verify.js` hit the
   challenge; they detect it and write the same packages instead of failing).
2. For every `verify-out/robinhood/<address>.json` open
   `https://robinhoodchain.blockscout.com/address/<address>/contract-verification`,
   choose **Solidity (Standard JSON input)**, compiler version from the package
   (`v0.8.26+commit.8a97fa7a`), EVM version `paris`, upload `<address>.input.json`,
   contract name from `contractShortName` / `contractName`, and if the form asks for
   constructor arguments paste `constructorArguments.abiEncodedNoPrefix`.
3. `verify-out/robinhood/README.md` repeats these steps next to the files.

Package contents: `contractName` (fully qualified), `compilerVersion`, `evmVersion`,
`optimizer`, `viaIR`, `constructorArguments` (`decoded`, `abiEncoded`,
`abiEncodedNoPrefix`), `explorer` URLs, `reconstruction` (sources, warnings, creation
tx), `readme`, and `standardJsonInput`. The Standard JSON Input is the build-info input
of the artifact with the sources pruned to the import closure of the contract's file
(same idea as hardhat-verify's minimal input); `settings` are copied verbatim, so the
metadata hash matches and Blockscout reports a full match.

If Robinhood provides an API key: `export BLOCKSCOUT_API_KEY=...` and rerun the normal
commands; the probe sends the key, and when the API answers JSON the scripts go back to
automatic verification without any code change.

## Running the watcher as a service

The launch keeper is the service: `npm run keeper -- --network robinhood` launches sales,
delivers tokens and runs this watcher in the same process (`AUTO_VERIFY=0` leaves
verification out). The standalone form is the same watcher without the keeper:

```bash
cd contracts
# the keeper signs: KEEPER_KEY comes from the service's environment file (keeper/keeper.env.example),
# never from the command line
CONFIRMATIONS=12 START_BLOCK=<platform deploy block> npm run keeper -- --network robinhood
# the watcher alone signs nothing and needs no key
CONFIRMATIONS=12 POLL_INTERVAL_MS=15000 START_BLOCK=<platform deploy block> \
  npm run auto-verify -- --network robinhood
```

Behaviour:

- cursor in `verify-state/<network>.json` (atomic write, `SIGINT`/`SIGTERM` flush it);
  the file also stores `pending` (attempts, next attempt time, last error) and `done`
  (status, target, match, `sourcifyUrl`, package path); it resets the cursor automatically
  when the deployments file points at other factories;
- each tick scans `[cursor + 1, head - CONFIRMATIONS]` for `TokenCreated` (every
  Standard, Tax and Rewards token; QuickLaunch tokens are factory tokens and come through
  the same event) and `PresaleCreated` unless `VERIFY_PRESALES=0`, then verifies due
  entries; one failure never stops the loop, it is logged and retried with exponential
  backoff until `MAX_ATTEMPTS`, after which the address is kept under `done` as `gave-up`
  (retry later with `verify-contract.js`);
- every verified contract gets one log line with its link,
  `token 0x... (StandardToken): verified on Sourcify, exact_match, https://repo.sourcify.dev/4663/0x...`;
- a Sourcify 500 / 429 / timeout keeps the address in the queue (backoff, then a new
  Sourcify attempt); Blockscout is probed only after a Sourcify failure and a Cloudflare
  or 500 answer there never blocks. With `SOURCIFY=0` a Cloudflare answer turns each new
  contract into a manual package (status `manual-package`) instead of burning retries; the
  probe is repeated every `PROBE_TTL_MS` so a later allowlisting is picked up without a
  restart;
- `ONCE=1` (or `KEEPER_ONCE=1` for the keeper) makes it cron friendly (`*/5 * * * *`),
  `DRY_RUN=1` shows what it would do.

A systemd unit only needs `WorkingDirectory=/path/to/contracts`, the environment
variables above, `Restart=always` and `ExecStart=/usr/bin/npm run keeper -- --network
robinhood`. The standalone watcher needs no key: it never sends transactions.

## What is proven offline

`npx hardhat test test/verify-args.test.js` (41 tests) deploys the
platform with `MockDex`, creates one token of each type with distinctive parameters and a
whitelisted presale with `launchTime`, then lets the owners call `setTaxes`,
`setMarketingWallet`, `setRouter`, `setTreasury`, `setLocker` and `transferOwnership`,
and asserts that the reconstruction still returns the original constructor arguments
and the correct fully qualified names for tokens, presale, deployers, Treasury,
LiquidityLocker, TokenFactory, PresaleFactory, HoodSaleToken, TokenMetadataRegistry and
HoodSaleLens, via the default path, the archive (`creation-state`) path and the
events/current fallback (with its warnings); it checks bytecode identification without a
deployments file, that the ABI encoding of the reconstructed args equals the tail of the
real deployment transactions, the Standard JSON package (settings identical to
build-info, dependency closure only, encoded args decode back), Cloudflare detection
against a local HTTP server, error classification, the `DRY_RUN` output of
`verify-contract.js` and `verify-platform.js`, `FORCE_MANUAL` package writing, and the
watcher (cursor, confirmations, persistence and resume, backoff and give-up). On the v4
platform fixture it also builds a v4 Standard, a v4 Tax and two v4 Rewards tokens (one paying
WETH, one paying a stock along a V3 route its owner changed later) and proves the rebuilt
arguments reproduce each deployment, with V2 tokens from the same deployers as controls. On
the fixture with both v4 modes it creates a fee mode Standard, Tax and Rewards token next to a
hook mode and a V2 token from the same Fee deployers and proves: the fee launcher as the
launcher argument and `meta.launchMode` with and without a deployments json, a redeployment
from the reconstructed arguments giving the identical runtime code, the arguments of the fee
launcher, the fee hook (mined again to its own address), both lens and router instances, the
Fee deployers and the replaced V4 generation against their deployment transactions, the
deploying owner of both launchers and the locker after `transferOwnership` (and the warned
fallback to the current owner when the creation log cannot be found), and the
`verify-platform.js` list before and after `TokenFactory.setDeployers`.

`npx hardhat test test/v4fee/deploy-script.test.js` (13 tests) runs `scripts/deploy-v4-fee.js`
itself in-process on the hook mode fixture: the `SKIP_SET_DEPLOYERS` run (ten transactions, the
factory untouched, the rollback target recorded), the run after it (one transaction) and the
rerun (none), `setDeployers` sent by hand in between, a record left by an earlier version of the
script, a factory that names a mix of generations (never recorded as the rollback target), the
refusal of `SKIP_DEPLOYERS`, swapped deployer overrides stopped before `setDeployers`
by the simulated creations, every override reused and written down only after the wiring check, a
recorded address without code, the creation brake (`CLOSE_CREATION`, `OPEN_CREATION`), a dropped
read tried again, a failing check reported with its reason and the state of the run, and a run
that dies at any of its eleven transactions and is started again.

`npx hardhat test test/auto-verify.test.js` (19 tests) starts a Sourcify look-alike on a
random port (`SOURCIFY_URL` points at it), creates a Standard, a Tax and a Rewards token
through the factory plus a QuickLaunch token and a normal presale, and checks: the client
(202 + job polling, 409 and 404 handling, 500 retryable / 400 final, failed jobs,
unreachable server, chain list, repository links), `verifyOne` (package built from
build-info with the right `contractIdentifier`, compiler version and creation tx; already
verified as success; a 500 stays retryable without a manual package; `SOURCIFY=0` keeps
the old behaviour; `DRY_RUN` prints the request), the QuickLaunch token (exact constructor
args from the creation receipt, verified with the launch transaction as creation tx), and
the watcher (all four tokens and both presales verified by default, `VERIFY_PRESALES=0`
skipping the presales, v4 tokens of hook mode and of fee mode submitted under the v4 contract
they share, backoff after a 500 and success on the next attempt, `ONCE` mode, the keeper
integration and `AUTO_VERIFY=0`).

Not proven offline: a real Sourcify round trip (the platform token was verified by hand
with `exact_match` through the same v2 calls on 2026-09-05), an actual `verify:verify`
round trip on Blockscout (needs a testnet deployment) and the real mainnet challenge page
(only its detection is tested).
