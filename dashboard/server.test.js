import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const python = existsSync(new URL("../backtester/venv/bin/python", import.meta.url).pathname)
  ? new URL("../backtester/venv/bin/python", import.meta.url).pathname : "python3";

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
    env: {...process.env, PORT: String(port), HOST: "127.0.0.1", STATUS_PYTHON: python,
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

// A deterministic status.py stand-in: one fixed payload per dashboard view.
function stubStatus(directory, payloads, {sleepSeconds = 0, failWith = null} = {}) {
  const script = join(directory, "status.py");
  writeFileSync(script, [
    "import json, sys, time",
    `payloads = json.loads(${JSON.stringify(JSON.stringify(payloads))})`,
    `time.sleep(${sleepSeconds})`,
    ...(failWith ? [`sys.stderr.write(${JSON.stringify(failWith)})`, "sys.exit(1)"] : []),
    "print(json.dumps(payloads[sys.argv[1]]))",
  ].join("\n") + "\n");
  return script;
}

function tempDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test("root and configured-base routes share the same correct shell", async t => {
  const {child, origin} = await startDashboard({BASE_PATH: "/autobot"});
  t.after(() => stopDashboard(child));

  for (const path of ["/", "/research", "/trading", "/autobot/", "/autobot/research", "/autobot/trading"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /Research/);
    assert.match(html, /Trading/);
    assert.match(html, /const BASE=\"\/autobot\"/);
  }
});

test("there is no auth endpoint and no static serving of dashboard source", async t => {
  const {child, origin} = await startDashboard({BASE_PATH: "/autobot"});
  t.after(() => stopDashboard(child));
  for (const method of ["GET", "POST"]) {
    assert.equal((await fetch(origin + "/autobot/api/auth", {method})).status, 404, `${method} /api/auth`);
  }
  for (const path of ["server.js", "server.test.js", "package.json", "build_research_replay.py",
                      "index.html", "node_modules/express/package.json"]) {
    assert.equal((await fetch(`${origin}/autobot/${path}`)).status, 404, path);
  }
});

test("dashboard APIs pass status payloads through unchanged, without a token", async t => {
  const directory = tempDirectory(t, "autobot-dashboard-api-");
  const payloads = {
    "--dashboard-research": {leader: null, leader_status: {state: "none"}, counts: {valid_attempts: 3}},
    "--dashboard-trading": {lanes: []},
    "--dashboard-replay": {leader: {experiment_id: "exp-stub", candidate_sha256: "a".repeat(64)},
      historical_replay: {availability: "available", periods: {development: {metrics: {annual_return: 0.125}}}}},
  };
  const {child, origin} = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory,
    STATUS_SCRIPT: stubStatus(directory, payloads)});
  t.after(() => stopDashboard(child));

  for (const [view, option] of [["research", "--dashboard-research"], ["trading", "--dashboard-trading"],
                                ["replay", "--dashboard-replay"]]) {
    const response = await fetch(`${origin}/api/dashboard/${view}`);
    assert.equal(response.status, 200, view);
    assert.deepEqual(await response.json(), payloads[option], view);
  }
});

test("status failures become a 500 carrying the status error", async t => {
  const directory = tempDirectory(t, "autobot-dashboard-error-");
  const {child, origin} = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory,
    STATUS_SCRIPT: stubStatus(directory, {}, {failWith: "status exploded"})});
  t.after(() => stopDashboard(child));
  const response = await fetch(origin + "/api/dashboard/research");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {error: "status exploded"});
});

test("a slow status call does not block other requests", async t => {
  const directory = tempDirectory(t, "autobot-dashboard-async-");
  const {child, origin} = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory,
    STATUS_SCRIPT: stubStatus(directory, {"--dashboard-research": {leader: null}}, {sleepSeconds: 1.5})});
  t.after(() => stopDashboard(child));
  const slow = fetch(origin + "/api/dashboard/research");
  await delay(100);
  const started = Date.now();
  assert.equal((await fetch(origin + "/research")).status, 200);
  assert.ok(Date.now() - started < 700, "the shell is served while status.py is still running");
  assert.equal((await slow).status, 200);
});

test("manual refresh reports disabled rebuilding and distinguishes an unverifiable leader", async t => {
  const directory = tempDirectory(t, "autobot-manual-refresh-");
  const noLeader = stubStatus(directory, {"--dashboard-replay": {leader: null,
    historical_replay: {availability: "unavailable"}}});
  let dashboard = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory, STATUS_SCRIPT: noLeader});
  assert.deepEqual(await (await fetch(dashboard.origin + "/api/dashboard/refresh", {method: "POST"})).json(),
    {state: "disabled"});
  assert.deepEqual(await (await fetch(dashboard.origin + "/api/dashboard/refresh-status")).json(),
    {state: "no_leader", leader: null});
  await stopDashboard(dashboard.child);

  const unverifiable = stubStatus(directory, {"--dashboard-replay": {leader: null,
    leader_status: {state: "unavailable", reason: "verifier_failed"},
    historical_replay: {availability: "unavailable"}}});
  dashboard = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory, STATUS_SCRIPT: unverifiable});
  t.after(() => stopDashboard(dashboard.child));
  assert.deepEqual(await (await fetch(dashboard.origin + "/api/dashboard/refresh-status")).json(),
    {state: "leader_unavailable", leader: null});
});

function replayRebuildFixture(directory, {exitCode = 0} = {}) {
  const leader = {experiment_id: "latest", candidate_sha256: "a".repeat(64), leader_type: "qualified"};
  const statusScript = stubStatus(directory, {"--dashboard-replay": {leader,
    historical_replay: {availability: "available", candidate: {experiment_id: "older", sha256: "old-sha"}}}});
  const builderScript = join(directory, "builder.py");
  const marker = join(directory, "builder-runs.txt");
  writeFileSync(builderScript, [
    "import json, os, sys",
    "from pathlib import Path",
    "Path(os.environ['REPLAY_TEST_MARKER']).write_text(json.dumps(sys.argv[1:]))",
    "print('builder stdout line', flush=True)",
    "sys.stderr.write('builder stderr line\\n')",
    `sys.exit(${exitCode})`,
  ].join("\n"));
  return {statusScript, builderScript, marker, log: join(directory, "logs", "build.log")};
}

async function waitFor(predicate, attempts = 200) {
  for (let attempt = 0; attempt < attempts && !predicate(); attempt++) await delay(25);
  return predicate();
}

test("dashboard automatically rebuilds canonical replay when champion identity advances, and logs it", async t => {
  const directory = tempDirectory(t, "autobot-replay-refresh-");
  const {statusScript, builderScript, marker, log} = replayRebuildFixture(directory);
  const {child} = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory,
    STATUS_SCRIPT: statusScript, REPLAY_REFRESH_ENABLED: "true", REPLAY_REFRESH_PYTHON: python,
    REPLAY_REFRESH_SCRIPT: builderScript, REPLAY_TEST_MARKER: marker, REPLAY_REFRESH_LOG: log,
    REPLAY_REFRESH_SETTLE_MS: "0", REPLAY_REFRESH_RETRY_MS: "60000"});
  t.after(() => stopDashboard(child));

  assert.ok(await waitFor(() => existsSync(marker)), "the builder ran");
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), ["--leader-type", "qualified",
    "--experiment-id", "latest", "--candidate-sha256", "a".repeat(64)],
    "the replay builder receives only the exact verifier-selected leader identity");
  assert.ok(await waitFor(() => existsSync(log) && /exit 0/.test(readFileSync(log, "utf8"))));
  const text = readFileSync(log, "utf8");
  assert.match(text, /rebuild latest:a{64}/);
  assert.match(text, /builder stdout line/);
  assert.match(text, /builder stderr line/);
  await delay(100);
  assert.equal((readFileSync(log, "utf8").match(/rebuild latest/g) || []).length, 1,
    "only one rebuild is started during the retry cooldown");
});

test("a failed replay build leaves its output and exit code in the build log", async t => {
  const directory = tempDirectory(t, "autobot-replay-failure-");
  const {statusScript, builderScript, marker, log} = replayRebuildFixture(directory, {exitCode: 3});
  const {child, origin} = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory,
    STATUS_SCRIPT: statusScript, REPLAY_REFRESH_ENABLED: "true", REPLAY_REFRESH_PYTHON: python,
    REPLAY_REFRESH_SCRIPT: builderScript, REPLAY_TEST_MARKER: marker, REPLAY_REFRESH_LOG: log,
    REPLAY_REFRESH_SETTLE_MS: "0", REPLAY_REFRESH_RETRY_MS: "60000"});
  t.after(() => stopDashboard(child));
  assert.ok(await waitFor(() => existsSync(log) && /exit 3/.test(readFileSync(log, "utf8"))));
  assert.match(readFileSync(log, "utf8"), /builder stderr line/);
  assert.deepEqual(await (await fetch(origin + "/api/dashboard/refresh-status")).json(),
    {state: "failed", leader: `latest:${"a".repeat(64)}`});
});

test("a newly observed leader settles before its first rebuild", async t => {
  const directory = tempDirectory(t, "autobot-replay-settle-");
  const {statusScript, builderScript, marker, log} = replayRebuildFixture(directory);
  const {child, origin} = await startDashboard({BASE_PATH: "", AUTOBOT_ROOT: directory,
    STATUS_SCRIPT: statusScript, REPLAY_REFRESH_ENABLED: "true", REPLAY_REFRESH_PYTHON: python,
    REPLAY_REFRESH_SCRIPT: builderScript, REPLAY_TEST_MARKER: marker, REPLAY_REFRESH_LOG: log,
    REPLAY_REFRESH_SETTLE_MS: "1500"});
  t.after(() => stopDashboard(child));
  await delay(400);
  assert.deepEqual(await (await fetch(origin + "/api/dashboard/refresh", {method: "POST"})).json(),
    {state: "settling"});
  assert.equal(existsSync(marker), false, "no build while the new leader is settling");
  await delay(1300);
  assert.deepEqual(await (await fetch(origin + "/api/dashboard/refresh", {method: "POST"})).json(),
    {state: "building"});
  assert.ok(await waitFor(() => existsSync(marker)));
});
