// Long-running verification bot: watches the TokenFactory.TokenCreated events (every Standard,
// Tax and Rewards token, including the tokens QuickLaunch creates through the factory and the
// Uniswap v4 tokens of both launchers, hook mode's V4Launcher and fee mode's V4FeeLauncher, which
// create through the same factory), waits for enough confirmations and verifies every new
// contract on Sourcify (Blockscout as the secondary target) with retries + exponential backoff. Presale contracts and the platform
// contracts are verified as well unless VERIFY_PRESALES=0 (the platform contracts are verified
// once, by hand, with scripts/verify-contract.js).
// A single failure never brings the process down. Progress is kept in verify-state/<network>.json.
//
//   npx hardhat run scripts/auto-verify.js --network robinhood      (npm run auto-verify -- --network robinhood)
//   The launch keeper (npm run keeper) runs this watcher in its own process unless AUTO_VERIFY=0.
//
// Environment variables:
//   CONFIRMATIONS=12       no verification is attempted before event block + this many blocks
//   POLL_INTERVAL_MS=15000 interval between rounds
//   LOG_CHUNK=2000         eth_getLogs window size
//   START_BLOCK=n          block to start scanning from on the first run (default: the current block)
//   MAX_ATTEMPTS=8         number of attempts per contract
//   BACKOFF_BASE_MS=30000  first retry delay (doubles on every attempt, capped at BACKOFF_MAX_MS)
//   BACKOFF_MAX_MS=3600000
//   VERIFY_PRESALES=0      skip PresaleCreated contracts (verified by default)
//   ONCE=1                 runs a single round and exits (for use with cron)
//   DRY_RUN=1              does not write the state file, does not hit the API, prints what it would do
//   SOURCIFY=0 / SOURCIFY_URL / FORCE_MANUAL=1 / VERIFY_OUT / BLOCKSCOUT_API_KEY: see verify-contract.js

const fs = require("fs");
const path = require("path");
const { verifyOne, loadDeployments, envFlag, STATUS } = require("./verify-contract");
const { ensureIgnoredDir, DEFAULT_OUT_DIR } = require("./verify-standard-json");
const { TOPIC } = require("./lib/constructorArgs");

const DEFAULT_STATE_DIR = path.join(__dirname, "..", "verify-state");
const TERMINAL = new Set([STATUS.VERIFIED, STATUS.ALREADY, STATUS.MANUAL, STATUS.DRY_RUN]);

function envInt(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== "" ? v : def;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sameAddr(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function shortName(fqn) {
  return fqn ? fqn.slice(fqn.lastIndexOf(":") + 1) : "?";
}

function createWatcher(hre, options = {}) {
  const log = options.log || ((...a) => console.log(`[auto-verify ${stamp()}]`, ...a));
  const cfg = {
    confirmations: options.confirmations ?? envInt("CONFIRMATIONS", 12),
    pollIntervalMs: options.pollIntervalMs ?? envInt("POLL_INTERVAL_MS", 15000),
    logChunk: options.logChunk ?? envInt("LOG_CHUNK", 2000),
    startBlock: options.startBlock ?? (process.env.START_BLOCK !== undefined ? envInt("START_BLOCK", 0) : undefined),
    maxAttempts: options.maxAttempts ?? envInt("MAX_ATTEMPTS", 8),
    backoffBaseMs: options.backoffBaseMs ?? envInt("BACKOFF_BASE_MS", 30000),
    backoffMaxMs: options.backoffMaxMs ?? envInt("BACKOFF_MAX_MS", 3600000),
    dryRun: options.dryRun ?? envFlag("DRY_RUN"),
    forceManual: options.forceManual ?? envFlag("FORCE_MANUAL"),
    // Presales (and with them the platform's own Presale source) are opt-in
    verifyPresales: options.verifyPresales ?? process.env.VERIFY_PRESALES !== "0",
    sourcify: options.sourcify ?? process.env.SOURCIFY !== "0",
    outDir: options.outDir || process.env.VERIFY_OUT || DEFAULT_OUT_DIR,
    stateDir: options.stateDir || DEFAULT_STATE_DIR,
    maxBlocksPerTick: options.maxBlocksPerTick ?? envInt("MAX_BLOCKS_PER_TICK", 200000),
  };
  const deployments = options.deployments || loadDeployments(hre, { required: true });
  if (!deployments.tokenFactory || !deployments.presaleFactory) {
    throw new Error("deployments file must contain tokenFactory and presaleFactory");
  }
  const stateFile = options.stateFile || path.join(cfg.stateDir, `${hre.network.name}.json`);
  const provider = hre.ethers.provider;
  // Tests can inject a fake verifier (for retry/backoff)
  const verifyFn = options.verifyFn || verifyOne;
  const verifyOptions = {
    dryRun: cfg.dryRun,
    forceManual: cfg.forceManual,
    sourcify: cfg.sourcify,
    sourcifyOptions: options.sourcifyOptions || {},
    outDir: cfg.outDir,
    deployments,
    // API status (Cloudflare / reachable) is probed again at this interval
    probeTtlMs: options.probeTtlMs ?? envInt("PROBE_TTL_MS", 600000),
    log: (...a) => log(...a),
  };

  let state = loadState();
  let stopped = false;

  function emptyState() {
    return {
      version: 1,
      network: hre.network.name,
      tokenFactory: deployments.tokenFactory,
      presaleFactory: deployments.presaleFactory,
      cursor: null,
      pending: {},
      done: {},
      updatedAt: null,
    };
  }

  function loadState() {
    try {
      if (fs.existsSync(stateFile)) {
        const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        const sameFactories =
          String(s.tokenFactory).toLowerCase() === String(deployments.tokenFactory).toLowerCase() &&
          String(s.presaleFactory).toLowerCase() === String(deployments.presaleFactory).toLowerCase();
        if (!sameFactories) {
          log(`state file ${stateFile} belongs to a different deployment; starting a fresh cursor`);
          return { ...emptyState(), done: s.done || {} };
        }
        return { ...emptyState(), ...s, pending: s.pending || {}, done: s.done || {} };
      }
    } catch (e) {
      log(`could not read state file (${e.message}); starting fresh`);
    }
    return emptyState();
  }

  function saveState() {
    if (cfg.dryRun) return;
    try {
      ensureIgnoredDir(path.dirname(stateFile));
      state.updatedAt = new Date().toISOString();
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      log(`could not save state: ${e.message}`);
    }
  }

  function enqueue(kind, address, logEntry) {
    const key = address.toLowerCase();
    if (state.done[key] || state.pending[key]) return false;
    state.pending[key] = {
      address,
      kind,
      creation: { blockNumber: Number(logEntry.blockNumber), transactionHash: logEntry.transactionHash },
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      firstSeenAt: new Date().toISOString(),
    };
    log(`new ${kind} ${address} (block ${logEntry.blockNumber})`);
    return true;
  }

  /** Enqueues the creation events in the [from, to] range. */
  async function scan(from, to) {
    let found = 0;
    // Presales are only requested when they are opted in; the token factory's TokenCreated
    // covers every Standard, Tax and Rewards token, QuickLaunch tokens and the v4 tokens of both
    // launchers included. A fee mode token is the same contract as a hook mode one and names the
    // fee launcher, which the reconstruction reads back from the token itself.
    const addresses = cfg.verifyPresales ? [deployments.tokenFactory, deployments.presaleFactory] : [deployments.tokenFactory];
    const topics = cfg.verifyPresales ? [TOPIC.TokenCreated, TOPIC.PresaleCreated] : [TOPIC.TokenCreated];
    for (let start = from; start <= to; start += cfg.logChunk) {
      const end = Math.min(start + cfg.logChunk - 1, to);
      const logs = await provider.getLogs({ address: addresses, topics: [topics], fromBlock: start, toBlock: end });
      for (const l of logs) {
        const created = hre.ethers.getAddress(hre.ethers.dataSlice(l.topics[1], 12));
        const isToken = l.topics[0] === TOPIC.TokenCreated;
        // Each event is taken from its own factory only (keeps the queue honest on a bad deployments file)
        if (isToken !== sameAddr(l.address, deployments.tokenFactory)) continue;
        if (!isToken && !cfg.verifyPresales) continue;
        if (enqueue(isToken ? "token" : "presale", created, l)) found++;
      }
      state.cursor = end;
      saveState();
    }
    return found;
  }

  function backoffMs(attempts) {
    return Math.min(cfg.backoffBaseMs * 2 ** Math.max(0, attempts - 1), cfg.backoffMaxMs);
  }

  /** Verifies the pending items that are due. */
  async function processPending(safeHead) {
    const now = Date.now();
    // Only blocks scanned up to safeHead enter the queue; still, if the confirmation count
    // was raised later, the ones that are not yet confirmed enough stay pending.
    const due = Object.values(state.pending).filter(
      (p) => p.nextAttemptAt <= now && p.creation.blockNumber <= safeHead
    );
    for (const item of due) {
      if (stopped) break;
      const key = item.address.toLowerCase();
      item.attempts += 1;
      let r;
      try {
        r = await verifyFn(hre, { address: item.address, creation: item.creation }, verifyOptions);
      } catch (e) {
        r = { status: STATUS.FAILED, message: e.message, retryable: true };
      }
      if (TERMINAL.has(r.status) || r.status === STATUS.UNSUPPORTED) {
        delete state.pending[key];
        state.done[key] = {
          address: item.address,
          kind: item.kind,
          contract: r.contract || null,
          status: r.status,
          message: r.message || "",
          target: r.target || null,
          match: r.match || null,
          sourcifyUrl: r.sourcifyUrl && (r.status === STATUS.VERIFIED || r.status === STATUS.ALREADY) && r.target === "sourcify" ? r.sourcifyUrl : null,
          packagePath: r.packagePath || null,
          attempts: item.attempts,
          at: new Date().toISOString(),
        };
        if (state.done[key].sourcifyUrl) {
          // one line per verified contract, with the public link to the sources
          log(`${item.kind} ${item.address} (${shortName(r.contract)}): ${r.status} on Sourcify, ${r.match || "match"}, ${state.done[key].sourcifyUrl}`);
        } else {
          log(`${item.kind} ${item.address}: ${r.status}${r.message ? " (" + r.message + ")" : ""}`);
        }
      } else if (item.attempts >= cfg.maxAttempts) {
        delete state.pending[key];
        state.done[key] = {
          address: item.address,
          kind: item.kind,
          contract: r.contract || null,
          status: "gave-up",
          message: r.message || "",
          attempts: item.attempts,
          at: new Date().toISOString(),
        };
        log(`${item.kind} ${item.address}: gave up after ${item.attempts} attempts (${r.message}); retry later with scripts/verify-contract.js`);
      } else {
        const delay = backoffMs(item.attempts);
        item.nextAttemptAt = Date.now() + delay;
        item.lastError = r.message || null;
        log(`${item.kind} ${item.address}: attempt ${item.attempts} failed (${r.message}); retry in ${Math.round(delay / 1000)}s`);
      }
      saveState();
    }
  }

  /** Single round: scan new blocks, process pending items. Never throws. */
  async function tick() {
    const summary = { scannedFrom: null, scannedTo: null, found: 0, pending: 0, done: 0, error: null };
    try {
      const latest = await provider.getBlockNumber();
      const safeHead = Math.max(0, latest - cfg.confirmations);
      if (state.cursor === null) {
        state.cursor = cfg.startBlock !== undefined ? Math.max(0, cfg.startBlock - 1) : safeHead;
        log(`cursor initialised at block ${state.cursor} (latest ${latest}, confirmations ${cfg.confirmations})`);
        saveState();
      }
      if (safeHead > state.cursor) {
        const from = state.cursor + 1;
        const to = Math.min(safeHead, from + cfg.maxBlocksPerTick - 1);
        summary.scannedFrom = from;
        summary.scannedTo = to;
        summary.found = await scan(from, to);
      }
      await processPending(safeHead);
    } catch (e) {
      summary.error = e.message;
      log(`tick error: ${e.message}`);
    }
    summary.pending = Object.keys(state.pending).length;
    summary.done = Object.keys(state.done).length;
    return summary;
  }

  async function run({ once = false } = {}) {
    const what = cfg.verifyPresales
      ? `TokenFactory ${deployments.tokenFactory} and PresaleFactory ${deployments.presaleFactory}`
      : `TokenFactory ${deployments.tokenFactory} (presales are not verified, VERIFY_PRESALES=0)`;
    log(`watching ${what} on ${hre.network.name}, target ${cfg.sourcify ? "Sourcify then Blockscout" : "Blockscout only"}${cfg.dryRun ? " (DRY_RUN)" : ""}`);
    while (!stopped) {
      const s = await tick();
      if (s.scannedTo !== null) log(`scanned ${s.scannedFrom}-${s.scannedTo}: ${s.found} new, pending ${s.pending}, done ${s.done}`);
      if (once) break;
      await sleep(cfg.pollIntervalMs);
    }
    saveState();
  }

  function stop() {
    stopped = true;
    saveState();
  }

  return {
    tick,
    run,
    stop,
    saveState,
    get state() {
      return state;
    },
    cfg,
    stateFile,
  };
}

async function main() {
  const hre = require("hardhat");
  const watcher = createWatcher(hre);
  const onSignal = (sig) => {
    console.log(`[auto-verify] ${sig} received, saving state and exiting`);
    watcher.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  await watcher.run({ once: envFlag("ONCE") });
}

module.exports = { main, createWatcher, DEFAULT_STATE_DIR };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
