import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { demoPayload, rebase } from "./demo-source.js";

const HOUR = 3600000;

test("rebase moves activity timestamps and experiment-id dates, never market dates", () => {
  const shifted = rebase({
    at: "2026-01-15T15:00:00Z", window: {start: "2014-01-02", end: "2020-12-31"},
    experiment_id: "20260114_093000_abc123", label: "Momentum A", n: 3,
  }, 48 * HOUR);
  assert.equal(shifted.at, "2026-01-17T15:00:00Z");
  assert.deepEqual(shifted.window, {start: "2014-01-02", end: "2020-12-31"});
  assert.equal(shifted.experiment_id, "20260116_093000_abc123");
  assert.equal(shifted.label, "Momentum A");
  assert.equal(shifted.n, 3);
});

test("a demo payload reads as current and drops its generation stamp", () => {
  const root = mkdtempSync(join(tmpdir(), "autobot-demo-"));
  mkdirSync(join(root, "api"));
  writeFileSync(join(root, "api", "research.json"), JSON.stringify({
    generated_at: "2026-01-15T15:00:00Z", activity: {wake_at: "2026-01-15T17:00:00Z"}}));
  const now = Date.parse("2026-03-01T12:00:00Z");
  const payload = demoPayload(root, "research", now);
  assert.equal(payload.generated_at, undefined);
  assert.equal(Date.parse(payload.activity.wake_at) - now, 2 * HOUR);
});

async function freePort() {
  return new Promise(resolve => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("without status.py the server serves the bundled demo snapshot", async t => {
  const port = await freePort();
  const env = {...process.env, PORT: String(port), HOST: "127.0.0.1", BASE_PATH: ""};
  delete env.AUTOBOT_ROOT;
  delete env.STATUS_SCRIPT;
  const child = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {env, stdio: "ignore"});
  t.after(() => child.kill());
  const origin = `http://127.0.0.1:${port}`;
  let research;
  for (let i = 0; i < 50 && !research; i++) {
    research = await fetch(`${origin}/api/dashboard/research`).then(r => r.json()).catch(() => null);
    if (!research) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(research.demo, true);
  assert.ok(research.populations.length >= 2);
  const replay = await fetch(`${origin}/api/dashboard/replay`).then(r => r.json());
  assert.equal(replay.historical_replay.candidate.experiment_id, replay.leader.experiment_id);
  const refresh = await fetch(`${origin}/api/dashboard/refresh`, {method: "POST"}).then(r => r.json());
  assert.equal(refresh.state, "disabled");
});
