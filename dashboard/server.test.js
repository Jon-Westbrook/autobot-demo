import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startDashboard(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: {...process.env, PORT: String(port), HOST: "127.0.0.1",
      REPLAY_REFRESH_ENABLED: "false", ...env},
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Dashboard exited: ${child.exitCode}`);
    try {
      const response = await fetch(origin + "/");
      if (response.ok) return {child, origin};
    } catch {}
    await delay(50);
  }
  child.kill();
  throw new Error("Dashboard did not start");
}

async function stopDashboard(child) {
  child.kill();
  await new Promise(resolve => child.once("exit", resolve));
}

test("auth config fails closed and tokens expire on protected requests", async t => {
  const directory = mkdtempSync(join(tmpdir(), "autobot-dashboard-"));
  const authFile = join(directory, "auth.json");
  const {child, origin} = await startDashboard({AUTH_FILE: authFile, BASE_PATH: "",
    AUTOBOT_ROOT: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
    STATUS_PYTHON: new URL("../backtester/venv/bin/python", import.meta.url).pathname});
  t.after(async () => { await stopDashboard(child); rmSync(directory, {recursive: true, force: true}); });

  const absent = await fetch(origin + "/api/auth", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({code: "anything"})});
  assert.equal(absent.status, 503);
  writeFileSync(authFile, "not-json");
  const malformed = await fetch(origin + "/api/auth", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({code: "anything"})});
  assert.equal(malformed.status, 503);

  writeFileSync(authFile, JSON.stringify({code: "secret", cookieMaxAge: 1}));
  const login = await fetch(origin + "/api/auth", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({code: "secret"})});
  assert.equal(login.status, 200);
  const {token} = await login.json();
  assert.ok(token);
  await delay(1100);
  const expired = await fetch(origin + "/api/dashboard/research", {headers: {authorization: `Bearer ${token}`}});
  assert.equal(expired.status, 401);
});

test("root and configured-base routes share the same correct shell", async t => {
  const directory = mkdtempSync(join(tmpdir(), "autobot-dashboard-"));
  const authFile = join(directory, "auth.json");
  writeFileSync(authFile, JSON.stringify({code: "secret"}));
  const {child, origin} = await startDashboard({AUTH_FILE: authFile, BASE_PATH: "/autobot"});
  t.after(async () => { await stopDashboard(child); rmSync(directory, {recursive: true, force: true}); });

  for (const path of ["/", "/research", "/trading", "/autobot/", "/autobot/research", "/autobot/trading"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /Research/);
    assert.match(html, /Trading/);
    assert.match(html, /const BASE=\"\/autobot\"/);
  }
});


test("descriptive replay endpoint remains authenticated and serves only verified evidence", async t => {
  const directory = mkdtempSync(join(tmpdir(), "autobot-dashboard-replay-"));
  const authFile = join(directory, "auth.json");
  writeFileSync(authFile, JSON.stringify({code: "secret"}));
  const {child, origin} = await startDashboard({AUTH_FILE: authFile, BASE_PATH: "",
    AUTOBOT_ROOT: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
    STATUS_PYTHON: new URL("../backtester/venv/bin/python", import.meta.url).pathname});
  t.after(async () => { await stopDashboard(child); rmSync(directory, {recursive: true, force: true}); });

  const denied = await fetch(origin + "/api/dashboard/replay");
  assert.equal(denied.status, 401);
  const login = await fetch(origin + "/api/auth", {method: "POST",
    headers: {"content-type": "application/json"}, body: JSON.stringify({code: "secret"})});
  const {token} = await login.json();
  const response = await fetch(origin + "/api/dashboard/replay", {
    headers: {authorization: `Bearer ${token}`},
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.historical_replay.availability, "unavailable",
    "local test has no pinned candidate/replay artifact and must fail closed");
});

test("dashboard automatically rebuilds canonical replay when champion identity advances", async t => {
  const directory = mkdtempSync(join(tmpdir(), "autobot-replay-refresh-"));
  const authFile = join(directory, "auth.json");
  const statusScript = join(directory, "status.py");
  const builderScript = join(directory, "builder.py");
  const marker = join(directory, "builder-runs.txt");
  writeFileSync(authFile, JSON.stringify({code: "secret"}));
  writeFileSync(statusScript, [
    "import json",
    "print(json.dumps({'champion': {'experiment_id': 'latest', 'candidate_sha256': 'new-sha'},",
    "'historical_replay': {'availability': 'available',",
    "'candidate': {'experiment_id': 'older', 'sha256': 'old-sha'}}}))",
  ].join("\n"));
  writeFileSync(builderScript, [
    "import os",
    "from pathlib import Path",
    "p = Path(os.environ['REPLAY_TEST_MARKER'])",
    "p.write_text(p.read_text() + 'ran\\n' if p.exists() else 'ran\\n')",
  ].join("\n"));
  const python = new URL("../backtester/venv/bin/python", import.meta.url).pathname;
  const {child} = await startDashboard({AUTH_FILE: authFile, BASE_PATH: "",
    AUTOBOT_ROOT: directory, STATUS_PYTHON: python, STATUS_SCRIPT: statusScript,
    REPLAY_REFRESH_ENABLED: "true", REPLAY_REFRESH_PYTHON: python,
    REPLAY_REFRESH_SCRIPT: builderScript, REPLAY_TEST_MARKER: marker,
    REPLAY_REFRESH_RETRY_MS: "60000"});
  t.after(async () => { await stopDashboard(child); rmSync(directory, {recursive: true, force: true}); });

  for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await delay(25);
  assert.equal(readFileSync(marker, "utf8"), "ran\n",
    "stale replay identity starts one background canonical rebuild");
  await delay(100);
  assert.equal(readFileSync(marker, "utf8"), "ran\n",
    "only one rebuild is started during the retry cooldown");
});
