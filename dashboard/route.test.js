import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInContext, runInNewContext } from "node:vm";

function dashboard() {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {style: {}, classList: {toggle() {}}, addEventListener() {}, innerHTML: "", disabled: false});
    return nodes.get(id);
  };
  const nav = ["research", "trading"].map(route => ({dataset: {route}, classList: {toggle() {}}, addEventListener() {}}));
  const location = {pathname: "/research"};
  const requests = [];
  let storedToken = "test-token";
  const storage = {
    getItem: () => storedToken,
    removeItem: () => { storedToken = null; },
    setItem: (_key, value) => { storedToken = value; },
  };
  const context = {
    AbortController,
    document: {
      getElementById: node,
      querySelector: () => ({set href(value) { this.hrefValue = value; }}),
      querySelectorAll: selector => selector === ".nav a" ? nav : [],
    },
    fetch: (url, options) => new Promise(resolve => requests.push({url, options, resolve})),
    history: {pushState(_state, _title, url) { location.pathname = url; }},
    location,
    localStorage: storage,
    window: {addEventListener() {}},
    setInterval() {},
  };
  runInNewContext(script, context);
  return {context, nodes, requests, storage};
}

const response = data => ({ok: true, json: async () => data});

test("rapid navigation fetches and renders only the newest route response", async () => {
  const {context, nodes, requests} = dashboard();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/dashboard\/research$/);

  context.navigate("trading");
  assert.equal(requests.length, 2, "navigation must start a new fetch while the old one is pending");
  assert.match(requests[1].url, /\/api\/dashboard\/trading$/);
  assert.equal(requests[0].options.signal.aborted, true, "superseded request is aborted");

  requests[1].resolve(response({lanes: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get("view").innerHTML, /No promoted strategy lanes/);

  requests[0].resolve(response({champion: {score: 0.25}, counts: {}, activity: {}, recent: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get("view").innerHTML, /No promoted strategy lanes/,
    "late old-route response must not overwrite the current view");
});

test("refresh/poll invocation captures the route and is superseded by later navigation", async () => {
  const {context, nodes, requests} = dashboard();
  requests[0].resolve(response({champion: null, counts: {}, activity: {}, recent: []}));
  await new Promise(resolve => setImmediate(resolve));
  context.loadRoute("research");
  context.navigate("trading");
  assert.match(requests[1].url, /\/api\/dashboard\/research$/);
  assert.match(requests[2].url, /\/api\/dashboard\/trading$/);
  requests[1].resolve(response({champion: {score: 0.5}, counts: {}, activity: {}, recent: []}));
  requests[2].resolve(response({lanes: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get("view").innerHTML, /No promoted strategy lanes/);
});

test("Research renders safe recent rows and an honest empty state", () => {
  const {context} = dashboard();
  const fixture = {
    champion: null,
    chart: {availability: "unavailable", points: []},
    counts: {valid_attempts: 1, scored: 1, distinct_candidates: 1},
    activity: {state: "unknown", heartbeat: null},
    score_label: "Development-only fixture",
    recent: [{experiment_id: "fixture-run", status: "keep", score: 0.2,
      development_annual_return: 0.1}],
  };
  let html = context.renderResearch(fixture);
  assert.match(html, /fixture-run/);
  assert.match(html, /Development Annual return/);
  assert.doesNotMatch(html, /table is not defined/);

  html = context.renderResearch({...fixture, recent: []});
  assert.match(html, /No verified recent experiments\./);
  assert.match(html, /colspan="4"/);
  assert.doesNotMatch(html, /table is not defined/);
});

test("a stale 401 cannot clear a reauthenticated session or replace its route", async () => {
  const {context, nodes, requests, storage} = dashboard();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");

  runInContext("TOKEN = 'new-token'", context);
  storage.setItem("autobot_token", "new-token");
  context.navigate("trading");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.Authorization, "Bearer new-token");

  requests[0].resolve({status: 401, ok: false});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runInContext("TOKEN", context), "new-token");
  assert.equal(storage.getItem("autobot_token"), "new-token");
  assert.equal(nodes.get("app").style.display, "block");
  assert.equal(nodes.get("login").style.display, "none");

  requests[1].resolve(response({lanes: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get("view").innerHTML, /No promoted strategy lanes/);
  assert.equal(runInContext("route", context), "trading");
});

test("lifecycle tabs stay inside each lane and selections are independent", () => {
  const {context} = dashboard();
  const lanes = [
    {lane_id: "lane-a", display_name: "Lane A", modeled_enabled: true, paper_enabled: true,
      live_enabled: true, last_run_ts: "2026-10-01T15:40:00Z", current_asset: "CASH",
      target_asset: "ASSET_B", decision_reason: "verified runtime record"},
    {lane_id: "lane-b", display_name: "Lane B", modeled_enabled: true, paper_enabled: true,
      live_enabled: true},
  ];
  context.fixtures = {lanes};
  runInContext("trading = fixtures", context);
  let html = context.renderTrading({lanes});
  assert.equal((html.match(/role="tablist"/g) || []).length, 2);
  assert.equal((html.match(/No verified data for this stage/g) || []).length, 2);
  runInContext("selectLaneStage(0, 'modeled')", context);
  html = context.renderTrading(context.fixtures);
  assert.match(html, /verified runtime record/);

  runInContext("selectLaneStage(0, 'paper')", context);
  html = context.renderTrading(context.fixtures);
  const laneA = html.slice(html.indexOf("Lane A"), html.indexOf("Lane B"));
  const laneB = html.slice(html.indexOf("Lane B"));
  assert.match(laneA, /role="tab" aria-selected="true" class="active" onclick="selectLaneStage\(0,'paper'\)">Paper/);
  assert.match(laneB, /role="tab" aria-selected="true" class="active" onclick="selectLaneStage\(1,'historical'\)">Historical/);
  assert.match(laneB, /No verified data for this stage/);
});
