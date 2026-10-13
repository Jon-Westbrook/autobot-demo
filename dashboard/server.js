import express from "express";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { spawnSync } from "child_process";

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
const STATUS_SCRIPT = `${AUTOBOT_ROOT}/status.py`;
const PYTHON_MAX_BUFFER = 16 * 1024 * 1024;

const validTokens = new Map();

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
});
