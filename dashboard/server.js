import express from "express";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { spawn, spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_PATH = (() => {
  const raw = (process.env.BASE_PATH || "").trim();
  if (!raw || raw === "/") return "";
  const normalized = raw.startsWith("/") ? raw : "/" + raw;
  return normalized.replace(/\/$/, "");
})();
const AUTH_FILE = process.env.AUTH_FILE || "/srv/data/todo-auth.json";
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

const validTokens = new Map();
let replayRefreshCheckRunning = false;
let replayRefreshRunning = false;
let lastReplayRefreshAttempt = 0;

function routePath(path) {
  return BASE_PATH + path;
}

function safeReadJson(file, defaultVal = {}) {
  try {
    if (!existsSync(file)) return defaultVal;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return defaultVal;
  }
}

function getAuthConfig() {
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    if (!auth || typeof auth !== "object" || Array.isArray(auth)
        || typeof auth.code !== "string" || !auth.code.trim()) return null;
    const seconds = Number(auth.cookieMaxAge);
    return {...auth, cookieMaxAge: Number.isFinite(seconds) && seconds > 0 ? seconds : 2592000};
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = auth.slice(7);
  const session = validTokens.get(token);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  const config = getAuthConfig();
  if (!config) return res.status(503).json({ error: "Authentication unavailable" });
  if (Date.now() - session.created >= config.cookieMaxAge * 1000) {
    validTokens.delete(token);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}


function runDashboardJson(view) {
  const option = view === "trading" ? "--dashboard-trading" : view === "replay" ? "--dashboard-replay" : "--dashboard-research";
  const result = spawnSync(STATUS_PYTHON, [STATUS_SCRIPT, option], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: PYTHON_MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `status.py exited ${result.status}`).trim());
  }
  return JSON.parse(result.stdout);
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
      if (code !== 0) return reject(new Error((stderr || `process exited ${code}`).trim()));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`invalid JSON from ${script}: ${error.message}`)); }
    });
  });
}

function replayMatchesChampion(payload) {
  const champion = payload?.champion;
  const replay = payload?.historical_replay;
  return Boolean(champion?.experiment_id && champion?.candidate_sha256
    && replay?.availability === "available"
    && replay?.candidate?.experiment_id === champion.experiment_id
    && replay?.candidate?.sha256 === champion.candidate_sha256);
}

async function refreshReplayIfStale() {
  if (!REPLAY_REFRESH_ENABLED || replayRefreshCheckRunning || replayRefreshRunning
      || Date.now() - lastReplayRefreshAttempt < REPLAY_REFRESH_RETRY_MS) return;
  replayRefreshCheckRunning = true;
  try {
    const payload = await asyncJson(STATUS_PYTHON, STATUS_SCRIPT, ["--dashboard-replay"]);
    if (replayMatchesChampion(payload)) {
      lastReplayRefreshAttempt = 0;
      return;
    }
    if (!payload?.champion?.experiment_id || !payload?.champion?.candidate_sha256) return;
    replayRefreshRunning = true;
    lastReplayRefreshAttempt = Date.now();
    console.log(`[replay-refresh] rebuilding canonical evidence for ${payload.champion.experiment_id}`);
    const child = spawn(REPLAY_REFRESH_PYTHON, [REPLAY_REFRESH_SCRIPT], {
      cwd: AUTOBOT_ROOT,
      stdio: "ignore",
    });
    child.once("error", error => {
      replayRefreshRunning = false;
      console.error(`[replay-refresh] failed to start: ${error.message}`);
    });
    child.once("close", code => {
      replayRefreshRunning = false;
      if (code === 0) {
        lastReplayRefreshAttempt = 0;
        console.log(`[replay-refresh] canonical evidence build completed for ${payload.champion.experiment_id}`);
      } else {
        console.error(`[replay-refresh] canonical evidence build exited ${code}`);
      }
    });
  } catch (error) {
    lastReplayRefreshAttempt = Date.now();
    console.error(`[replay-refresh] freshness check failed: ${error.message}`);
  } finally {
    replayRefreshCheckRunning = false;
  }
}

const shell = readFileSync(`${__dirname}/index.html`, "utf8")
  .replaceAll("'__AUTOBOT_BASE_PATH__'", JSON.stringify(BASE_PATH));
const sendShell = (_req, res) => res.type("html").send(shell);
for (const route of new Set(["/", "/research", "/trading", routePath("/"),
                             routePath("/research"), routePath("/trading")])) {
  app.get(route, sendShell);
}

app.use(BASE_PATH || "/", express.static(__dirname));

app.post(routePath("/api/auth"), (req, res) => {
  const { code } = req.body;
  const config = getAuthConfig();
  if (!config) return res.status(503).json({ error: "Authentication unavailable" });
  if (code !== config.code) return res.status(403).json({ error: "Nope." });

  const token = randomUUID();
  validTokens.set(token, { created: Date.now() });

  const maxAge = config.cookieMaxAge * 1000;
  for (const [currentToken, value] of validTokens) {
    if (Date.now() - value.created > maxAge) validTokens.delete(currentToken);
  }

  res.json({ token, maxAge: config.cookieMaxAge });
});

app.get(routePath("/api/dashboard/research"), requireAuth, (req, res) => {
  try {
    res.json(runDashboardJson("research"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(routePath("/api/dashboard/trading"), requireAuth, (req, res) => {
  try {
    res.json(runDashboardJson("trading"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(routePath("/api/dashboard/replay"), requireAuth, (req, res) => {
  try {
    res.json(runDashboardJson("replay"));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
