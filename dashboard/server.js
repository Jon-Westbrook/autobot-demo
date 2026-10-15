import express from "express";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_PATH = (() => {
  const raw = (process.env.BASE_PATH || "").trim();
  if (!raw || raw === "/") return "";
  const normalized = raw.startsWith("/") ? raw : "/" + raw;
  return normalized.replace(/\/$/, "");
})();
const AUTOBOT_ROOT = process.env.AUTOBOT_ROOT || "/srv/autobot";
const STATUS_PYTHON = process.env.STATUS_PYTHON || "python3";
const STATUS_SCRIPT = process.env.STATUS_SCRIPT || `${AUTOBOT_ROOT}/status.py`;
const PYTHON_MAX_BUFFER = 16 * 1024 * 1024;
const REPLAY_REFRESH_ENABLED = process.env.REPLAY_REFRESH_ENABLED !== "false";
const REPLAY_REFRESH_PYTHON = process.env.REPLAY_REFRESH_PYTHON
  || (existsSync(`${AUTOBOT_ROOT}/backtester/venv/bin/python`)
    ? `${AUTOBOT_ROOT}/backtester/venv/bin/python` : STATUS_PYTHON);
const REPLAY_REFRESH_SCRIPT = process.env.REPLAY_REFRESH_SCRIPT
  || `${AUTOBOT_ROOT}/dashboard/build_research_replay.py`;
const REPLAY_REFRESH_INTERVAL_MS = Math.max(10000, Number(process.env.REPLAY_REFRESH_INTERVAL_MS) || 60000);
const REPLAY_REFRESH_RETRY_MS = Math.max(REPLAY_REFRESH_INTERVAL_MS,
  Number(process.env.REPLAY_REFRESH_RETRY_MS) || 120000);
// A new leader's artifacts are written in several steps; wait before the first rebuild.
const REPLAY_REFRESH_SETTLE_MS = Math.max(0, Number(process.env.REPLAY_REFRESH_SETTLE_MS ?? 30000) || 0);
// Builder stdout/stderr, appended per build. Never a research artifact.
const REPLAY_REFRESH_LOG = process.env.REPLAY_REFRESH_LOG
  || "/srv/data/autobot-dashboard-replay/build.log";
const REPLAY_REFRESH_LOG_MAX_BYTES = 5 * 1024 * 1024;

let replayRefreshCheckRunning = false;
let replayRefreshRunning = false;
let lastReplayRefreshAttempt = 0;
let replayRefreshOutcome = "idle";
let replayRefreshLeaderIdentity = null;
let settlingLeaderIdentity = null;
let settlingSince = 0;

function routePath(path) {
  return BASE_PATH + path;
}

function asyncJson(python, script, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], {stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > PYTHON_MAX_BUFFER) child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > PYTHON_MAX_BUFFER) child.kill("SIGTERM");
    });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error((stderr || stdout || `${script} exited ${code}`).trim()));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`invalid JSON from ${script}: ${error.message}`)); }
    });
  });
}

function runDashboardJson(view) {
  const option = view === "trading" ? "--dashboard-trading" : view === "replay" ? "--dashboard-replay" : "--dashboard-research";
  return asyncJson(STATUS_PYTHON, STATUS_SCRIPT, [option]);
}

function replayMatchesLeader(payload) {
  const champion = payload?.leader;
  const replay = payload?.historical_replay;
  return Boolean(champion?.experiment_id && champion?.candidate_sha256
    && replay?.availability === "available"
    && replay?.candidate?.experiment_id === champion.experiment_id
    && replay?.candidate?.sha256 === champion.candidate_sha256);
}

function missingLeaderState(payload) {
  return payload?.leader_status?.state === "unavailable" ? "leader_unavailable" : "no_leader";
}

function openBuildLog(identity) {
  try {
    mkdirSync(dirname(REPLAY_REFRESH_LOG), {recursive: true});
    if (existsSync(REPLAY_REFRESH_LOG) && statSync(REPLAY_REFRESH_LOG).size > REPLAY_REFRESH_LOG_MAX_BYTES) {
      renameSync(REPLAY_REFRESH_LOG, `${REPLAY_REFRESH_LOG}.1`);
    }
    appendFileSync(REPLAY_REFRESH_LOG, `\n=== ${new Date().toISOString()} rebuild ${identity} ===\n`);
    return openSync(REPLAY_REFRESH_LOG, "a");
  } catch (error) {
    console.error(`[replay-refresh] build log unavailable: ${error.message}`);
    return null;
  }
}

function noteBuildLog(line) {
  try { appendFileSync(REPLAY_REFRESH_LOG, `=== ${new Date().toISOString()} ${line} ===\n`); }
  catch {}
}

async function refreshReplayIfStale(force = false) {
  if (!REPLAY_REFRESH_ENABLED) return "disabled";
  if (replayRefreshRunning) return "building";
  if (replayRefreshCheckRunning) return "checking";
  if (!force && Date.now() - lastReplayRefreshAttempt < REPLAY_REFRESH_RETRY_MS) return "cooldown";
  replayRefreshCheckRunning = true;
  try {
    const payload = await asyncJson(STATUS_PYTHON, STATUS_SCRIPT, ["--dashboard-replay"]);
    if (replayMatchesLeader(payload)) {
      lastReplayRefreshAttempt = 0;
      replayRefreshOutcome = "ready";
      replayRefreshLeaderIdentity = `${payload.leader.experiment_id}:${payload.leader.candidate_sha256}`;
      return "ready";
    }
    const leader = payload?.leader;
    if (!leader?.experiment_id || !leader?.candidate_sha256 || !leader?.leader_type) {
      replayRefreshOutcome = missingLeaderState(payload);
      return replayRefreshOutcome;
    }
    const identity = `${leader.experiment_id}:${leader.candidate_sha256}`;
    if (identity !== settlingLeaderIdentity) {
      settlingLeaderIdentity = identity;
      settlingSince = Date.now();
    }
    if (Date.now() - settlingSince < REPLAY_REFRESH_SETTLE_MS) {
      replayRefreshOutcome = "settling";
      replayRefreshLeaderIdentity = identity;
      return "settling";
    }
    replayRefreshRunning = true;
    lastReplayRefreshAttempt = Date.now();
    replayRefreshOutcome = "building";
    replayRefreshLeaderIdentity = identity;
    console.log(`[replay-refresh] rebuilding canonical evidence for ${leader.experiment_id}`);
    const log = openBuildLog(identity);
    const output = log === null ? "ignore" : log;
    const child = spawn(REPLAY_REFRESH_PYTHON, [REPLAY_REFRESH_SCRIPT,
      "--leader-type", leader.leader_type,
      "--experiment-id", leader.experiment_id,
      "--candidate-sha256", leader.candidate_sha256], {
      cwd: AUTOBOT_ROOT,
      stdio: ["ignore", output, output],
    });
    if (log !== null) closeSync(log);
    child.once("error", error => {
      replayRefreshRunning = false;
      replayRefreshOutcome = "failed";
      noteBuildLog(`failed to start: ${error.message}`);
      console.error(`[replay-refresh] failed to start: ${error.message}`);
    });
    child.once("close", code => {
      replayRefreshRunning = false;
      noteBuildLog(`exit ${code} for ${identity}`);
      if (code === 0) {
        lastReplayRefreshAttempt = 0;
        replayRefreshOutcome = "built";
        console.log(`[replay-refresh] canonical evidence build completed for ${leader.experiment_id}`);
      } else {
        replayRefreshOutcome = "failed";
        console.error(`[replay-refresh] canonical evidence build exited ${code}; see ${REPLAY_REFRESH_LOG}`);
      }
    });
    return "building";
  } catch (error) {
    lastReplayRefreshAttempt = Date.now();
    replayRefreshOutcome = "failed";
    console.error(`[replay-refresh] freshness check failed: ${error.message}`);
    return "failed";
  } finally {
    replayRefreshCheckRunning = false;
  }
}

async function replayRefreshStatus() {
  if (replayRefreshRunning) return {state: "building", leader: replayRefreshLeaderIdentity};
  if (replayRefreshCheckRunning) return {state: "checking", leader: replayRefreshLeaderIdentity};
  try {
    const payload = await asyncJson(STATUS_PYTHON, STATUS_SCRIPT, ["--dashboard-replay"]);
    const leader = payload?.leader;
    const identity = leader?.experiment_id && leader?.candidate_sha256
      ? `${leader.experiment_id}:${leader.candidate_sha256}` : null;
    if (replayMatchesLeader(payload)) {
      replayRefreshOutcome = "ready";
      replayRefreshLeaderIdentity = identity;
      return {state: "ready", leader: identity};
    }
    if (!identity) return {state: missingLeaderState(payload), leader: null};
    if (replayRefreshOutcome === "failed" && identity === replayRefreshLeaderIdentity) {
      return {state: "failed", leader: identity};
    }
    if (replayRefreshOutcome === "built" && identity === replayRefreshLeaderIdentity) {
      return {state: "stale", leader: identity};
    }
    return {state: await refreshReplayIfStale(true), leader: identity};
  } catch (error) {
    replayRefreshOutcome = "failed";
    console.error(`[replay-refresh] freshness check failed: ${error.message}`);
    return {state: "failed", leader: replayRefreshLeaderIdentity};
  }
}

const shell = readFileSync(`${__dirname}/index.html`, "utf8")
  .replaceAll("'__AUTOBOT_BASE_PATH__'", JSON.stringify(BASE_PATH));
const sendShell = (_req, res) => res.type("html").send(shell);
for (const route of new Set(["/", "/research", "/trading", routePath("/"),
                             routePath("/research"), routePath("/trading")])) {
  app.get(route, sendShell);
}

for (const view of ["research", "trading", "replay"]) {
  app.get(routePath(`/api/dashboard/${view}`), async (_req, res) => {
    try {
      res.json(await runDashboardJson(view));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

app.post(routePath("/api/dashboard/refresh"), async (_req, res) => {
  const state = await refreshReplayIfStale(true);
  res.json({state});
});

app.get(routePath("/api/dashboard/refresh-status"), async (_req, res) => {
  res.json(await replayRefreshStatus());
});


app.listen(PORT, HOST, () => {
  const suffix = BASE_PATH || "/";
  console.log(`Autobot dashboard running on http://${HOST}:${PORT}${suffix}`);
  if (REPLAY_REFRESH_ENABLED) {
    void refreshReplayIfStale();
    const timer = setInterval(() => void refreshReplayIfStale(), REPLAY_REFRESH_INTERVAL_MS);
    timer.unref();
  }
});
