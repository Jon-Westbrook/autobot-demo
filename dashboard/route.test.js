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
  const nav = ["research", "trading"].map(route => ({dataset: {route}, active: false, classList: {toggle(name, value) { if (name === "active") this.active = value; }}, addEventListener() {}}));
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
    fetch: (url, options) => url.endsWith("/api/dashboard/replay")
      ? Promise.resolve(response({champion: null, historical_replay: {availability: "unavailable"}}))
      : new Promise(resolve => requests.push({url, options, resolve})),
    history: {pushState(_state, _title, url) { location.pathname = url; }},
    location,
    localStorage: storage,
    window: {addEventListener() {}},
    setInterval() {},
  };
  runInNewContext(script, context);
  return {context, nodes, requests, storage, nav};
}

const response = data => ({ok: true, json: async () => data});

test("Research and Trading are separate authenticated routes with independent requests and active nav", async () => {
  const {context, nodes, requests, nav} = dashboard();
  assert.equal(requests.length, 1);
  assert.equal(nav[0].classList.active, true);
  assert.equal(nav[1].classList.active, false);
  assert.match(requests[0].url, /\/api\/dashboard\/research$/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  requests[0].resolve(response({champion: null, chart: {}, counts: {}, activity: {}, recent: []}));
  await new Promise(resolve => setImmediate(resolve));
  const researchHtml = nodes.get("view").innerHTML;
  assert.match(researchHtml, /<h1>Research<\/h1>/);
  assert.match(researchHtml, /Current Champion|Recent Experiments/);
  assert.match(researchHtml, /Development Replay/);
  assert.doesNotMatch(researchHtml, /No Active Strategies|Example Strategy Component/);

  context.navigate("trading");
  assert.equal(requests.length, 2, "Trading navigation makes one route-specific request");
  assert.match(requests[1].url, /\/api\/dashboard\/trading$/);
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-token");
  requests[1].resolve(response({lanes: []}));
  await new Promise(resolve => setImmediate(resolve));
  const tradingHtml = nodes.get("view").innerHTML;
  assert.equal(nav[0].classList.active, false);
  assert.equal(nav[1].classList.active, true);
  assert.match(tradingHtml, /Strategy Component/);
  assert.equal((tradingHtml.match(/class="tile"/g) || []).length, 0, "Trading omits low-value global status tiles");
  assert.doesNotMatch(tradingHtml, /READY|\$0|0\.00%/);
  assert.match(tradingHtml, /Historical[\s\S]*Modeled[\s\S]*Paper[\s\S]*Trivial Capital[\s\S]*Live/);
  assert.match(tradingHtml, /disabled title='Unavailable: no verified stage evidence'/);
  assert.match(tradingHtml, /Historical unavailable until exact candidate and contract identity match/);
  assert.doesNotMatch(tradingHtml, /<form|type="submit"|api\/(?:orders|promote)/i);
  assert.equal(runInContext("route", context), "trading");
});

test("rapid navigation aborts stale route requests and does not render stale responses", async () => {
  const {context, nodes, requests} = dashboard();
  context.navigate("trading");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.signal.aborted, true);
  requests[1].resolve(response({lanes: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get("view").innerHTML, /Strategy Component/);
  requests[0].resolve(response({champion: {score: 0.25}, counts: {}, activity: {}, recent: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(nodes.get("view").innerHTML, /Current champion/);
});

for (const failedRoute of ["research", "trading"]) {
  test(`${failedRoute} endpoint failures remain route-local and authenticated`, async () => {
    const {context, nodes, requests} = dashboard();
    if (failedRoute === "trading") context.navigate("trading");
    const request = requests.at(-1);
    request.resolve({ok: false, status: 503});
    await new Promise(resolve => setImmediate(resolve));
    assert.match(nodes.get("view").innerHTML, new RegExp(`${failedRoute === "trading" ? "Trading" : "Research"} unavailable`));
    assert.equal(request.options.headers.Authorization, "Bearer test-token");
    assert.equal(requests.length, failedRoute === "trading" ? 2 : 1);
  });
}

test("route styling is responsive without a combined Research/Trading layout", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /dashboard-grid|dashboard-panel|renderDashboard/);
  assert.match(html, /\.tiles\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:620px\)[\s\S]*?\.tiles\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.metrics\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(html, /\.template-inner\{margin-top:13px/);
  assert.doesNotMatch(html, /\.example-chart|\.example-metrics/);
});

test("Research separates process tiles, champion identity and development score card", () => {
  const {context} = dashboard();
  const payload = {champion: {experiment_id: "run-7", candidate_sha256: "a".repeat(64),
      dataset_manifest_sha256: "b".repeat(64), contract_version: "1.2.2", evaluator_version: "e1",
      development_start: "2016-01-04", development_end: "2024-08-01"},
    chart: {availability: "unavailable", points: []}, score_label: "Objective label",
    counts: {valid_attempts: 2, scored: 1}, activity: {state: "active"},
    recent: [{experiment_id: "run-7", score: 0.91, development_annual_return: 0.082}]};
  const html = context.renderResearch(payload);
  assert.match(html, /Process/);
  assert.match(html, /Experiments/);
  assert.match(html, /Scored/);
  assert.match(html, /Current Champion/);
  assert.match(html, /Candidate SHA-256/);
  const identityCard = html.slice(html.indexOf('<article class="card champion-card"'), html.indexOf('<article class="card replay-card"'));
  assert.doesNotMatch(identityCard, /Manifest SHA-256|Evaluator|Development window|Curve integrity|<svg|Annual return|Sharpe/);
  assert.doesNotMatch(html, /Best Annual return|<th>Score<\/th>|0\.9100|91\.00%/);
  assert.match(html, /Development Replay/);
  assert.match(html, /Recent Experiments/);
  assert.match(html, /8\.20%/);
  assert.equal((html.match(/<svg /g)||[]).length,0,"no replay chart appears without verified evidence");
});

test("independent replay cards render only their own canonical period and Details", () => {
  const {context} = dashboard();
  const replay = {availability: "available", label: "POST-SELECTION / THROUGH-PRESENT",
    candidate: {experiment_id: "frozen-id", sha256: "a".repeat(64)},
    contract: {version: "1.2.2", sha256: "b".repeat(64)},
    dataset: {manifest_sha256: "c".repeat(64), latest: "2026-09-25"},
    configuration: {starting_capital: "10000", slippage: "0.001", state_initialization: "Full history", objective: "existing objective", strategy_config: {}, strategy_config_sha256: "d"},
    development_objective: {window: {start: "2023-01-01", end: "2024-08-01"}, score: 0.25},
    periods: {development: {metrics: {start_date: "2023-01-01", end_date: "2024-08-01", anchor_date: "2022-12-30", start_equity: 10000, total_return: 0.2, net_profit: 2000, sharpe: 1.2, annual_return: 0.1, total_return: 0.2, net_profit: 2000, sharpe: 1.1, start_equity: 10000, anchor_date: "2022-12-30",
      max_drawdown: -0.2, ending_equity: 12000, priced_sessions: 400, missing_marks: 1},
      points: [{date: "2023-01-03", equity: 10000}, {date: "2024-08-01", equity: 12000}]},
      five_year: {metrics: {start_date: "2021-09-24", end_date: "2026-09-25", annual_return: 0.1, total_return: 0.5, net_profit: 5000, sharpe: 1.1, start_equity: 10000, anchor_date: "2021-09-24",
      max_drawdown: -0.2, ending_equity: 15000, priced_sessions: 1200, missing_marks: 1},
      points: [{date: "2021-09-27", equity: 10000}, {date: "2026-09-25", equity: 15000}]}}};
  const card = context.replayCard(replay, "five_year", "Five-year Replay", "Five years", false);
  assert.match(card, /POST-SELECTION/);
  assert.match(card, /2021-09-24 → 2026-09-25/);
  assert.match(card, /\$15,000/);
  assert.match(card, /Candidate SHA-256|a{64}/);
  assert.match(card, /fresh ledger from 2021-09-24/);
  assert.match(card, /LINEAR/);
  assert.match(card, /LOG/);
  assert.match(card, /sample deviation/);
  assert.equal((card.match(/<details class="replay-details"/g)||[]).length, 1);
  assert.equal((card.match(/<article class="card replay-card/g)||[]).length,1,"Details never nests another replay card");
  assert.match(context.replayCard(replay,"development","Development Replay","Dev",true),/Development Score/);
  assert.match(context.replayCard(replay,"development","Development Replay","Dev",true),/2023-01-01 → 2024-08-01/);
  assert.match(context.renderTrading({lanes:[],champion:{experiment_id:"frozen-id",candidate_sha256:"a".repeat(64),contract_version:"1.2.2",contract_sha256:"b".repeat(64)},historical_replay:{availability:"available",candidate:{experiment_id:"frozen-id",sha256:"a".repeat(64)},contract:{version:"1.2.2",sha256:"b".repeat(64)},periods:{through_present:replay.periods.five_year},development_objective:replay.development_objective,dataset:replay.dataset,configuration:replay.configuration}}),/PREVIEW — NOT PROMOTED[\s\S]*NO CAPITAL AT RISK[\s\S]*no orders or promotion/);
  assert.doesNotMatch(context.replayCard(replay,"five_year","Five-year Replay","5y",false),/Development Score/);
});

test("Research renders concise recent Annual return rows and an honest empty state", () => {
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
  assert.match(html, /<th>Development Annual return<\/th>/);
  assert.doesNotMatch(html, /<th>Score<\/th>/);
  assert.match(html, /title="Experiment ID: fixture-run"/);
  assert.match(html, /<span class="run-index">01<\/span>/);
  assert.doesNotMatch(html, /0\.2000|20\.00%/, "scores stay out of experiment listings");
  assert.doesNotMatch(html, /table is not defined/);

  html = context.renderResearch({...fixture, recent: []});
  assert.match(html, /No recent experiments\./);
  assert.match(html, /colspan="4"/);
  assert.doesNotMatch(html, /table is not defined/);
});

test("Research keeps full champion evidence collapsed and omits noisy recent identities", () => {
  const {context} = dashboard();
  const fullSha = "a".repeat(64);
  const fixture = {
    champion: {experiment_id: "champion-run", candidate_sha256: fullSha,
      dataset_manifest_sha256: "b".repeat(64), annual_return: 0.12, development_start: "2016-01-04",
      development_end: "2024-08-01"},
    chart: {availability: "unavailable", points: []},
    counts: {valid_attempts: 1}, activity: {state: "unknown"},
    recent: [{experiment_id: "legacy-run", candidate_sha: "c".repeat(12),
      candidate_identity: "SHA-12 prefix", full_source_sha_available: false,
      status: "keep", score: 0.2, development_annual_return: 0.1}],
  };
  const html = context.renderResearch(fixture);
  assert.match(html, /title="Experiment ID: legacy-run"/);
  assert.doesNotMatch(html, /<td>legacy-run<\/td>/);
  assert.match(html, /legacy rows may not have full source SHA-256/);
  assert.doesNotMatch(html, /20\.00%/);
  assert.ok(html.includes(`<dt>Candidate SHA-256</dt><dd><code>${fullSha}</code></dd>`),
    "full champion identity remains available behind the collapsed Details disclosure");
  assert.equal((html.match(/<summary>Champion identity<\/summary>/g) || []).length, 1);
});

test("equity parser accepts finite positive numbers and strict ASCII decimal/exponent strings", () => {
  const {context} = dashboard();
  assert.equal(runInContext("equityNumber('1234.50')", context), 1234.5);
  assert.equal(runInContext("equityNumber('.5')", context), 0.5);
  assert.equal(runInContext("equityNumber('1e3')", context), 1000);
  assert.equal(runInContext("equityNumber('1.2E+4')", context), 12000);
  assert.equal(runInContext("equityNumber(12)", context), 12);
  for (const value of ["true", "' 12'", "'12 '", "'12\\n'", "'1e'", "'1e+'", "'1e9999'", "'1e-9999'", "'abc'", "'0'", "'-1'", "Infinity", "NaN"]) {
    assert.equal(runInContext(`equityNumber(${value})`, context), null, `${value} must be rejected`);
  }
  assert.equal(runInContext("equityNumber(true)", context), null);
});

test("chart uses a positive log axis and never bridges invalid or out-of-range gaps", () => {
  const {context} = dashboard();
  const data = {
    availability: "available",
    gap_count: 3,
    development_start: "2024-01-01",
    development_end: "2024-01-05",
    ending_equity: "14000.5",
    score_label: "fixture",
    points: [
      {date: "2024-01-01", equity: "1e4"},
      {date: "2024-01-02", equity: "1.1E+4"},
      {date: "2024-01-03", equity: null},
      {date: "2024-01-04", equity: "1e9999"},
      {date: "2024-01-05", equity: "1e-9999"},
      {date: "2024-01-06", equity: "1.4e4"},
      {date: "2024-01-07", equity: "1.5E+4"},
    ],
  };

  const html = context.chart({...data, score_label: "fixture score window"});
  const paths = [...html.matchAll(/<polyline[^>]* points="([^"]*)"/g)];
  assert.equal(paths.length, 1, "post-cutoff marks are excluded before geometry is built");
  assert.equal(paths[0][1].split(" ").length, 2);
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.match(html, /Equity \(USD · log\)/, "axis interpretation is explicit");
  assert.match(html, /logarithmic scale/, "chart accessibility description names its scale");
  const axisValues = [...html.matchAll(/data-axis-value="([^"]+)"/g)].map(match => Number(match[1]));
  assert.equal(axisValues.length, 5, "the restrained axis renders five ticks");
  assert.ok(axisValues.every(value => Number.isFinite(value) && value > 0), "log ticks are finite and positive");
  assert.doesNotMatch(html, /-\$|\$-\d/, "positive equity series has no negative currency tick labels");
  assert.ok(axisValues.every(value => value >= 9500 && value <= 15750), "tick range is derived from finite positive marks");
  assert.doesNotMatch(html, /3 missing marks shown as gaps/,
    "chart provenance prose stays out of the default chart view");
  const details = context.renderResearch({champion: {experiment_id: "champ", candidate_sha256: "sha",
    dataset_manifest_sha256: "manifest", development_start: "2024-01-01", development_end: "2024-01-05",
    score: .25}, chart: {...data, development_start: "2024-01-01", development_end: "2024-01-05"},
    counts: {}, activity: {}, recent: []});
  assert.match(details, /<summary>Champion identity<\/summary>/);
  assert.doesNotMatch(details, /3 missing marks|Manifest SHA-256|Curve integrity/,
    "chart provenance and performance stay out of the champion identity card");
  assert.doesNotMatch(html, /Objective score|fixture score window/);
  assert.equal(data.points[0].equity, "1e4", "chart geometry parsing does not rewrite source values");
});

test("full-history and replay charts expose nearest-point hover and keyboard inspection", () => {
  const {context} = dashboard();
  const rendered = context.chart({availability: "available", development_start: "2024-01-01",
    development_end: "2024-01-03", ending_equity: 12000, gap_count: 0,
    points: [{date: "2024-01-01", equity: 10000}, {date: "2024-01-02", equity: null},
      {date: "2024-01-03", equity: 12000}]});
  assert.match(rendered, /class="chart-hitarea"[^>]*tabindex="0" role="slider"/);
  assert.match(rendered, /onpointermove="chartPointer\(event,this\)"/);
  assert.match(rendered, /onkeydown="chartKey\(event,this\)"/);
  assert.match(rendered, /onfocus="chartPoint/);
  assert.match(rendered, /class="chart-crosshair"/);
  assert.match(rendered, /role="tooltip" aria-live="polite"/);
  assert.match(rendered, /aria-valuenow="0"/);

  const attrs = {"data-points": JSON.stringify([
    {x: 78, y: 80, date: "2024-01-01", equity: 10000},
    {x: 510, y: null, date: "2024-01-02", equity: null},
    {x: 942, y: 40, date: "2024-01-03", equity: 12000},
  ]), "data-index": "0"};
  const values = {};
  const makeNode = () => ({setAttribute(key, value) { this[key] = String(value); }});
  const elements = Object.fromEntries([".chart-crosshair", ".chart-point", ".chart-tip-bg",
    ".chart-tip-date", ".chart-tip-equity"].map(key => [key, makeNode()]));
  const group = {...makeNode(), querySelector: key => elements[key]};
  const live = {textContent: "", hidden: true};
  const parentNode = {querySelector: key => key === ".chart-inspection" ? group : live};
  const svg = {...makeNode(), parentNode,
    ownerSVGElement: {getBoundingClientRect: () => ({left: 0, width: 960})},
    getAttribute(key) { return attrs[key]; }, setAttribute(key, value) { attrs[key] = String(value); }};
  context.chartPointer({clientX: 510}, svg);
  assert.equal(attrs["data-index"], "1", "pointer hover inspects the nearest plotted date");
  assert.equal(attrs["aria-valuetext"], "2024-01-02, Equity unavailable (missing mark)");
  assert.equal(elements[".chart-crosshair"].x1, "510");
  const keyEvent = {key: "ArrowRight", preventDefault() { this.prevented = true; }};
  context.chartKey(keyEvent, svg);
  assert.equal(keyEvent.prevented, true);
  assert.equal(attrs["data-index"], "2");
  assert.equal(attrs["aria-valuetext"], "2024-01-03, $12,000.00");
  assert.equal(elements[".chart-point"].cx, "942");
  context.chartKey({key: "Home", preventDefault() {}}, svg);
  assert.equal(attrs["aria-valuetext"], "2024-01-01, $10,000.00");
});

test("full-history chart excludes post-development-cutoff equity before reading it", () => {
  const {context} = dashboard();
  const forbidden = {date: "2024-08-02"};
  Object.defineProperty(forbidden, "equity", {get() { throw new Error("post-cutoff mark must not be read"); }});
  const html = context.chart({availability: "available", development_end: "2024-08-01", gap_count: 0,
    points: [{date: "2024-07-30", equity: 9900}, {date: "2024-07-31", equity: 10000}, forbidden]});
  assert.match(html, /2024-07-31/);
  assert.doesNotMatch(html, /2024-08-02/);
});

test("chart bounds extreme positive equities and formats their ticks without inventing data", () => {
  const {context} = dashboard();
  const points = [
    {date: "min-a", equity: Number.MIN_VALUE},
    {date: "min-b", equity: Number.MIN_VALUE},
    {date: "gap", equity: null},
    {date: "max-a", equity: Number.MAX_VALUE},
    {date: "max-b", equity: Number.MAX_VALUE},
  ];
  const html = context.chart({availability: "available", points, gap_count: 1,
    development_start: "min-a", development_end: "max-b", ending_equity: Number.MAX_VALUE,
    score_label: "extreme fixture"});

  assert.match(html, /<svg/, "extreme finite marks still render a chart");
  const axisValues = [...html.matchAll(/data-axis-value="([^"]+)"/g)].map(match => Number(match[1]));
  assert.ok(axisValues.length > 0, "at least one representable tick remains");
  assert.ok(axisValues.every(value => Number.isFinite(value) && value > 0),
    "all rendered ticks are finite and positive");
  assert.doesNotMatch(html, /\$0(?:\b|\.)|Infinity|NaN/,
    "tiny/huge positive values must not be mislabeled as zero or non-finite");
  assert.match(html, /\$4\.94e-324/, "sub-dollar tick labels use scientific notation");
  assert.match(html, /\$[0-9.]+e\+[0-9]+/, "large tick labels use scientific notation");
  const paths = [...html.matchAll(/<polyline[^>]* points="([^"]*)"/g)];
  assert.equal(paths.length, 2, "the null mark splits the original series into two segments");
  assert.ok(paths.every(([, path]) => path.split(" ").length === 2),
    "only the two source marks per segment are plotted");
  assert.equal(points[0].equity, Number.MIN_VALUE);
  assert.equal(points[2].equity, null, "the source null gap stays null");
  assert.equal(points[4].equity, Number.MAX_VALUE);
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
  assert.match(nodes.get("view").innerHTML, /Strategy Component/);
  assert.equal(runInContext("route", context), "trading");
});

test("Trading keeps a champion preview and disables unsupported capital stages", () => {
  const {context} = dashboard();
  const html = context.renderTrading({lanes: [], champion: null,
    historical_replay: {availability: "unavailable"}});
  assert.match(html, /Strategy Component/);
  assert.equal((html.match(/role="tab"/g) || []).length, 5);
  assert.equal((html.match(/disabled title='Unavailable: no verified stage evidence'/g)||[]).length,5);
  assert.doesNotMatch(html, /submit|place order|enable live/i);
  assert.doesNotMatch(html, /\$[0-9]|[0-9]+\.[0-9]+%|READY/);
});
