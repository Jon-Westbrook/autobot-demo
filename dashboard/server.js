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
  return safeReadJson(AUTH_FILE, { code: "000000" });
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = auth.slice(7);
  if (!validTokens.has(token)) return res.status(401).json({ error: "Unauthorized" });
  next();
}


function runDashboardJson() {
  const result = spawnSync("python3", [STATUS_SCRIPT, "--json", "--with-charts"], {
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

if (BASE_PATH) {
  app.get("/", (req, res) => res.redirect(BASE_PATH));
}

app.use(BASE_PATH || "/", express.static(__dirname));

app.post(routePath("/api/auth"), (req, res) => {
  const { code } = req.body;
  const config = getAuthConfig();
  if (code !== config.code) return res.status(403).json({ error: "Nope." });

  const token = randomUUID();
  validTokens.set(token, { created: Date.now() });

  const maxAge = (config.cookieMaxAge || 2592000) * 1000;
  for (const [currentToken, value] of validTokens) {
    if (Date.now() - value.created > maxAge) validTokens.delete(currentToken);
  }

  res.json({ token, maxAge: config.cookieMaxAge });
});

app.get(routePath("/api/dashboard"), requireAuth, (req, res) => {
  try {
    res.json(runDashboardJson());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.listen(PORT, HOST, () => {
  const suffix = BASE_PATH || "/";
  console.log(`Autobot dashboard running on http://${HOST}:${PORT}${suffix}`);
});
