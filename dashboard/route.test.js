import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInContext, runInNewContext } from "node:vm";

function dashboard({innerWidth} = {}) {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {style: {}, attributes: {}, classList: {toggle() {}}, addEventListener() {},
      setAttribute(key, value) { this.attributes[key] = String(value); }, innerHTML: "", disabled: false});
    return nodes.get(id);
  };
  const nav = ["research", "trading"].map(route => ({dataset: {route}, active: false, classList: {toggle(name, value) { if (name === "active") this.active = value; }}, addEventListener() {}}));
  const location = {pathname: "/research"};
  const requests = [];
  const context = {
    AbortController,
    document: {
      getElementById: node,
      querySelector: () => ({set href(value) { this.hrefValue = value; }}),
      querySelectorAll: selector => selector === ".nav a" ? nav : [],
    },
    fetch: (url, options) => url.endsWith("/api/dashboard/replay")
      ? Promise.resolve(response({leader: null, historical_replay: {availability: "unavailable"}}))
      : new Promise(resolve => requests.push({url, options, resolve})),
    history: {pushState(_state, _title, url) { location.pathname = url; }},
    location,
    window: {addEventListener() {}, innerWidth},
    setInterval() {},
  };
  runInNewContext(script, context);
  return {context, nodes, requests, nav};
}

const response = data => ({ok: true, json: async () => data});
const settle = () => new Promise(resolve => setImmediate(resolve));
const emptyResearch = {leader: null, counts: {}, activity: {}, recent: []};

function overlayReplay({assetBAvailable = true} = {}) {
  const start = "2021-09-27", end = "2021-09-28";
  const benchmark = (symbol, values, available) => ({availability: available ? "available" : "unavailable",
    points: values.map((equity, index) => ({date: [start, end][index], equity: available ? equity : null})),
    metrics: available ? {} : {unavailable_reason: "NO_VALID_FULL_SESSION_EXECUTION_FILL_IN_WINDOW"}});
  return {availability: "available", candidate: {experiment_id: "fixture", sha256: "a".repeat(64)},
    contract: {version: "1.2.2", sha256: "b".repeat(64)}, dataset: {manifest_sha256: "c".repeat(64), latest: end},
    configuration: {starting_capital: "10000", slippage: "0.001", state_initialization: "Fresh capital",
      objective: "reporting", strategy_config: {}, strategy_config_sha256: "d".repeat(64)},
    development_objective: {window: {start: "2016-09-01", end: "2024-08-01"}, score: 0.1},
    periods: {five_year: {metrics: {start_date: start, end_date: end, annual_return: 0.1, total_return: 0.2,
      net_profit: 2000, sharpe: 1, max_drawdown: 0, ending_equity: 12000, starting_capital: 10000,
      priced_sessions: 2, missing_marks: 0, executed_fills: 2, executed_fills_by_symbol: {ASSET_A: 2}},
      points: [{date: start, equity: 10000}, {date: end, equity: 12000}],
      benchmarks: {ASSET_A: benchmark("ASSET_A", [10000, 11000], true),
        ASSET_B: benchmark("ASSET_B", [10000, 9000], assetBAvailable)}}}};
}

test("the dashboard loads Research directly, showing a loading state until data arrives", async () => {
  const {nodes, requests} = dashboard();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/dashboard\/research$/);
  assert.equal(requests[0].options.headers.Authorization, undefined, "no authentication layer");
  assert.equal(nodes.has("login"), false, "there is no login screen");
  const loading = nodes.get("view").innerHTML;
  assert.match(loading, /<h1>Research<\/h1>/);
  assert.match(loading, /role="status"[\s\S]*Loading research data/);
  assert.equal(nodes.get("view").attributes["aria-busy"], "true");
  requests[0].resolve(response(emptyResearch));
  await settle();
  assert.doesNotMatch(nodes.get("view").innerHTML, /Loading research data/);
  assert.match(nodes.get("view").innerHTML, /Current Research Leader/);
  assert.equal(nodes.get("view").attributes["aria-busy"], "false");
});

test("navigation shows the new route loading at once; a same-route refresh keeps current content", async () => {
  const {context, nodes, requests} = dashboard();
  requests[0].resolve(response(emptyResearch));
  await settle();
  context.loadRoute("research");
  assert.equal(requests.length, 2);
  assert.match(nodes.get("view").innerHTML, /Current Research Leader/,
    "auto-refresh does not blank the page it is refreshing");
  assert.equal(nodes.get("view").attributes["aria-busy"], "true");
  context.navigate("trading");
  assert.match(nodes.get("view").innerHTML, /<h1>Trading<\/h1>[\s\S]*Loading trading data/,
    "the previous route never stays on screen under the new route's navigation");
  assert.doesNotMatch(nodes.get("view").innerHTML, /Current Research Leader/);
  requests[2].resolve(response({lanes: []}));
  await settle();
  assert.match(nodes.get("view").innerHTML, /Research · Current Leader/);
});

test("route and replay requests start together and replay failure stays route-local", async () => {
  const {context, nodes, requests} = dashboard();
  const urls = [];
  context.fetch = (url, options) => { urls.push(url); return url.endsWith("/api/dashboard/replay")
    ? Promise.reject(new Error("replay down")) : new Promise(resolve => requests.push({url, options, resolve})); };
  context.loadRoute("research");
  assert.deepEqual(urls.map(url => url.replace(/^.*\/api/, "/api")),
    ["/api/dashboard/replay", "/api/dashboard/research"], "both requests are in flight before either resolves");
  requests.at(-1).resolve(response(emptyResearch));
  await settle();
  assert.match(nodes.get("view").innerHTML, /Current Research Leader/);
  assert.match(nodes.get("view").innerHTML, /Unavailable: no verified canonical replay evidence/);
});

test("Research and Trading are separate routes with independent requests and active nav", async () => {
  const {context, nodes, requests, nav} = dashboard();
  assert.equal(requests.length, 1);
  assert.equal(nav[0].classList.active, true);
  assert.equal(nav[1].classList.active, false);
  assert.match(requests[0].url, /\/api\/dashboard\/research$/);
  requests[0].resolve(response({leader: null, chart: {}, counts: {}, activity: {}, recent: []}));
  await new Promise(resolve => setImmediate(resolve));
  const researchHtml = nodes.get("view").innerHTML;
  assert.match(researchHtml, /<h1>Research<\/h1>/);
  assert.match(researchHtml, /Current Research Leader|Recent Experiments/);
  assert.match(researchHtml, /Development Replay/);
  assert.doesNotMatch(researchHtml, /No Active Strategies|Example Strategy Component/);

  context.navigate("trading");
  assert.equal(requests.length, 2, "Trading navigation makes one route-specific request");
  assert.match(requests[1].url, /\/api\/dashboard\/trading$/);
  requests[1].resolve(response({lanes: []}));
  await new Promise(resolve => setImmediate(resolve));
  const tradingHtml = nodes.get("view").innerHTML;
  assert.equal(nav[0].classList.active, false);
  assert.equal(nav[1].classList.active, true);
  assert.match(tradingHtml, /Research · Current Leader/);
  assert.equal((tradingHtml.match(/class="tile"/g) || []).length, 0, "Trading omits low-value global status tiles");
  assert.doesNotMatch(tradingHtml, /READY|\$0|0\.00%/);
  assert.match(tradingHtml, /Historical[\s\S]*Modeled[\s\S]*Paper[\s\S]*Trivial Capital[\s\S]*Live/);
  assert.match(tradingHtml, /disabled title='Unavailable: no verified stage evidence'/);
  assert.match(tradingHtml, /Replay unavailable until exact current leader and contract identity match/);
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
  assert.match(nodes.get("view").innerHTML, /Research · Current Leader/);
  requests[0].resolve(response({leader: {score: 0.25}, counts: {}, activity: {}, recent: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(nodes.get("view").innerHTML, /Current leader/);
});

for (const failedRoute of ["research", "trading"]) {
  test(`${failedRoute} endpoint failures remain route-local`, async () => {
    const {context, nodes, requests} = dashboard();
    if (failedRoute === "trading") context.navigate("trading");
    const request = requests.at(-1);
    request.resolve({ok: false, status: 503});
    await new Promise(resolve => setImmediate(resolve));
    assert.match(nodes.get("view").innerHTML, new RegExp(`${failedRoute === "trading" ? "Trading" : "Research"} unavailable`));
    assert.equal(requests.length, failedRoute === "trading" ? 2 : 1);
  });
}

test("route styling is responsive without a combined Research/Trading layout", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /dashboard-grid|dashboard-panel|renderDashboard/);
  assert.match(html, /\.tiles\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /@media\(max-width:620px\)[\s\S]*?\.tiles\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.metrics\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(html, /\.chart-controls\{display:flex;justify-content:flex-end;gap:8px/);
  assert.doesNotMatch(html, /\.example-chart|\.example-metrics/);
});

test("Research separates process tiles, champion identity and development score card", () => {
  const {context} = dashboard();
  const payload = {leader: {experiment_id: "run-7", candidate_sha256: "a".repeat(64),
      dataset_manifest_sha256: "b".repeat(64), contract_version: "1.2.2", evaluator_version: "e1",
      development_start: "2016-01-04", development_end: "2024-08-01"},
    chart: {availability: "unavailable", points: []}, score_label: "Objective label",
    counts: {valid_attempts: 2, scored: 1}, activity: {state: "active"},
    recent: [{experiment_id: "run-7", score: 0.91, development_annual_return: 0.082}]};
  const html = context.renderResearch(payload);
  assert.match(html, /Process/);
  assert.match(html, /Experiments/);
  assert.match(html, /V4 Experiments/);
  assert.match(html, /Scored/);
  assert.match(html, /Research Cycles/);
  assert.match(html, /Development Window/);
  assert.match(html, /Last Active Cycle/);
  assert.match(html, /Current evaluator · pinned summaries/);
  assert.match(html, /Current Research Leader/);
  assert.match(html, /Candidate SHA-256/);
  const identityCard = html.slice(html.indexOf('<article class="card champion-card"'), html.indexOf('<article class="card replay-card"'));
  assert.doesNotMatch(identityCard, /Manifest SHA-256|Development window|Curve integrity|<svg|Sharpe/);
  assert.match(identityCard, /Full-development Annual return|Regimes passed/);
  assert.doesNotMatch(html, /Best Annual return|<th>Score<\/th>|0\.9100|91\.00%/);
  assert.match(html, /Development Replay/);
  assert.match(html, /Recent Experiments/);
  assert.match(html, /8\.20%/);
  assert.equal((html.match(/<svg /g)||[]).length,0,"no replay chart appears without verified evidence");
});

test("sleeping state shows sleep start, scheduled wake, and live countdown without guessing", () => {
  const {context} = dashboard();
  const html = context.renderResearch({leader: null, counts: {}, recent: [],
    activity: {state: "sleeping", cycle: 65,
      sleep_started_at: "2026-10-15T16:40:00+00:00",
      wake_at: "2026-10-15T17:00:36+00:00", completed_cycles: 64}});
  assert.match(html, /sleeping since/);
  assert.match(html, /wakes/);
  assert.match(html, /Research Cycles/);
  assert.match(html, /64/);
  assert.match(html, /sleeping since Oct 15/);
});

test("last cycle tile reports completed experiments and distinguishes timeout from proven quota", () => {
  const {context} = dashboard();
  const html = context.renderResearch({leader: null, counts: {}, recent: [],
    activity: {state: "sleeping", completed_cycles: 66,
      last_cycle: {cycle: 66, started_at: "2026-10-15T17:00:00Z", ended_at: "2026-10-15T17:40:00Z",
        experiments_completed: 20, elapsed_seconds: 2400.4,
        stop_reason: "provider_or_model_limit", command_timeout_seconds: 120.5}}});
  assert.match(html, /20 experiments/);
  assert.match(html, /Oct 15/);
  assert.match(html, /\d{1,2}:00 [AP]M [A-Z]{2,5} – Oct 15, \d{1,2}:40 [AP]M [A-Z]{2,5}/);
  assert.match(html, /40 min/);
  assert.match(html, /Final iteration timed out/);
  assert.match(html, /quota not confirmed/);
  assert.doesNotMatch(html, /Promoted Lanes/);
});

test("main navigation exposes an accessible refresh control and status", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /id="refresh-button"[^>]*aria-label="Check for the latest research leader and refresh replay charts"/);
  assert.match(html, /id="refresh-status" aria-live="polite"/);
  assert.match(html, /api\/dashboard\/refresh-status/);
});

test("legacy v3 champion fields are never a dashboard leader fallback", () => {
  const {context} = dashboard();
  const legacy = {experiment_id: "stale-v3", candidate_sha256: "a".repeat(64)};
  assert.match(context.renderResearch({champion: legacy, counts: {}, activity: {}, recent: []}),
    /No current v4 leader/);
  assert.match(context.renderTrading({lanes: [], champion: legacy}),
    /No current v4 research leader/);
  assert.doesNotMatch(context.renderResearch({champion: legacy, counts: {}, activity: {}, recent: []}),
    /stale-v3/);
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
      max_drawdown: -0.2, ending_equity: 15000, priced_sessions: 1200, missing_marks: 1,
      executed_fills: 7, executed_fills_by_symbol: {ASSET_A: 5, ASSET_E: 2}},
      points: [{date: "2021-09-27", equity: 10000}, {date: "2026-09-25", equity: 15000}],
      benchmarks: {ASSET_A: {availability: "available", metrics: {}},
        ASSET_B: {availability: "unavailable", metrics: {
          unavailable_reason: "NO_VALID_FULL_SESSION_EXECUTION_FILL_IN_WINDOW"}}}}}};
  const card = context.replayCard(replay, "five_year", "Five-year Replay", "Five years", false);
  assert.match(card, /POST-SELECTION/);
  assert.match(card, /2021-09-24 → 2026-09-25/);
  assert.match(card, /\$15,000/);
  assert.match(card, /Candidate SHA-256|a{64}/);
  assert.match(card, /fresh ledger from 2021-09-24/);
  assert.match(card, /LINEAR/);
  assert.match(card, /LOG/);
  assert.match(card, /Starting Capital/);
  assert.match(card, /Mark Coverage/);
  assert.match(card, /1,200 priced · 1 missing/);
  assert.match(card, /value="none"/);
  assert.match(card, /value="ASSET_A"/);
  assert.match(card, /value="ASSET_B"/);
  assert.match(card, /ASSET_B unavailable/);
  assert.match(card, /NO_VALID_FULL_SESSION_EXECUTION_FILL_IN_WINDOW/);
  assert.match(card, /disabled title=/);
  assert.match(card, /Executed Fills/);
  assert.match(card, /Executed fills by symbol[\s\S]*ASSET_A[\s\S]*ASSET_E/);
  assert.match(card, /strategy curve remains primary/i);
  assert.match(card, /sample deviation/);
  assert.equal((card.match(/<details class="replay-details"/g)||[]).length, 1);
  assert.equal((card.match(/<article class="card replay-card/g)||[]).length,1,"Details never nests another replay card");
  assert.match(context.replayCard(replay,"development","Development Replay","Dev",true),/Development Score/);
  assert.match(context.replayCard(replay,"development","Development Replay","Dev",true),/2023-01-01 → 2024-08-01/);
   const tradingView=context.renderTrading({lanes:[],leader:{leader_type:"qualified",experiment_id:"frozen-id",candidate_sha256:"a".repeat(64),contract_version:"1.2.2",contract_sha256:"b".repeat(64)},historical_replay:{availability:"available",candidate:{experiment_id:"frozen-id",sha256:"a".repeat(64)},contract:{version:"1.2.2",sha256:"b".repeat(64)},periods:{through_present:replay.periods.five_year},development_objective:replay.development_objective,dataset:replay.dataset,configuration:replay.configuration}});
  assert.match(tradingView,/Research · Current Leader/);
  assert.match(tradingView,/QUALIFIED CHAMPION · 4\/4 REGIMES[\s\S]*NOT PROMOTED[\s\S]*NO CAPITAL AT RISK[\s\S]*no orders or promotion/);
  assert.doesNotMatch(tradingView,/Strategy Component|template-inner/);
  assert.doesNotMatch(context.replayCard(replay,"five_year","Five-year Replay","5y",false),/Development Score/);
});

test("replay benchmark selector toggles one overlay, preserves data and scale, and keeps strategy on top", () => {
  const {context} = dashboard();
  const start = "2021-09-27", end = "2021-09-28";
  const strategyPoints = [{date: start, equity: 10000}, {date: end, equity: 12000}];
  const benchmarkPoints = {
    ASSET_A: [{date: start, equity: 10000}, {date: end, equity: 11000}],
    ASSET_B: [{date: start, equity: 10000}, {date: end, equity: 9000}],
  };
  const benchmarkMeta = symbol => ({availability: "available", symbol,
    starting_capital: "10000", opening_capital: {date: start, equity: "10000"},
    window: {start, end}, first_fill: start, origin: start, executed_fills: 1,
    executed_fills_by_symbol: {[symbol]: 1}, slippage: "0.001",
    entry_price_basis: "exact_execution_bar_open",
    entry_convention: "Buy at the open of exact 15:55 minute bar.",
    mark_basis: "unadjusted_close_at_exact_regular_session_terminal_minute",
    mark_convention: "Unadjusted exact 15:59 close.", share_precision: "0.000001",
    corporate_action_treatment: {splits: "Apply split ratio.",
      dividends: "Carry cash receivable and do not reinvest."},
    priced_sessions: 2, missing_marks: 0, ending_equity: benchmarkPoints[symbol][1].equity,
    unavailable_reason: null});
  const replay = {
    availability: "available", label: "POST-SELECTION",
    candidate: {experiment_id: "fixture", sha256: "a".repeat(64)},
    contract: {version: "1.2.2", sha256: "b".repeat(64)},
    dataset: {manifest_sha256: "c".repeat(64), latest: end},
    configuration: {starting_capital: "10000", slippage: "0.001",
      state_initialization: "Fresh capital", objective: "reporting", strategy_config: {},
      strategy_config_sha256: "d".repeat(64)},
    development_objective: {window: {start, end}, score: 0.1},
    periods: {five_year: {metrics: {start_date: start, end_date: end, annual_return: 0.1,
      total_return: 0.2, net_profit: 2000, sharpe: 1, max_drawdown: 0,
      ending_equity: 12000, starting_capital: 10000, priced_sessions: 2,
      missing_marks: 0, executed_fills: 2, executed_fills_by_symbol: {ASSET_A: 2}},
      points: strategyPoints,
      benchmarks: Object.fromEntries(["ASSET_A", "ASSET_B"].map(symbol => [symbol, {
        availability: "available", points: benchmarkPoints[symbol], metrics: benchmarkMeta(symbol),
      }]))}},
  };

  const card = context.replayCard(replay, "five_year", "Fixture Replay", "", false);
  assert.match(card, /<option value="ASSET_A" >ASSET_A buy &amp; hold/);
  assert.match(card, /<option value="ASSET_B" >ASSET_B buy &amp; hold/);
  const series = runInContext("replaySeries.five_year", context);
  const original = JSON.stringify({strategy: series.points, ASSET_A: series.benchmarks.ASSET_A.points,
    ASSET_B: series.benchmarks.ASSET_B.points});
  const host = context.document.getElementById("plot-five_year");

  const assertOverlay = (symbol, scale, expectedAxis) => {
    context.setReplayBenchmark("five_year", symbol);
    const output = host.innerHTML;
    assert.match(output, new RegExp(`Equity \\(USD · ${scale}\\)`));
    assert.deepEqual([...output.matchAll(/data-axis-value="([^"]+)"/g)].map(match => match[1]),
      expectedAxis, "the Y-axis domain stays fixed as the overlay changes");
    assert.match(output, new RegExp(`aria-label="Chart scale"><button type="button" aria-pressed="${scale === "linear"}"`));
    assert.match(output, new RegExp(`<button type="button" aria-pressed="${scale === "log"}" onclick="setChartScale\\('five_year','log'\\)">LOG`));
    assert.equal((output.match(/stroke="#f5a742"/g) || []).length, symbol === "none" ? 0 : 1,
      "exactly the selected reporting line is rendered");
    assert.equal((output.match(/stroke="#00e7f4"/g) || []).length, 1,
      "the strategy line remains present");
    if (symbol !== "none") {
      assert.ok(output.indexOf('stroke="#f5a742"') < output.indexOf('stroke="#00e7f4"'),
        "strategy polyline is painted after the reporting overlay");
      assert.match(output, /stroke-width="2\.6"/);
      assert.match(output, /stroke-width="1\.8"/);
      const selectedValue = symbol === "ASSET_A" ? 11000 : 9000;
      assert.ok(output.includes(`&quot;benchmark&quot;:${selectedValue}`),
        "hover data belongs to the selected benchmark only");
    }
    assert.equal(runInContext("benchmarkSelections.five_year", context), symbol);
    assert.equal(JSON.stringify({strategy: series.points, ASSET_A: series.benchmarks.ASSET_A.points,
      ASSET_B: series.benchmarks.ASSET_B.points}), original, "chart controls never mutate source series");
  };

  context.setChartScale("five_year", "log");
  const logAxis = [...host.innerHTML.matchAll(/data-axis-value="([^"]+)"/g)].map(match => match[1]);
  assertOverlay("none", "log", logAxis);
  assertOverlay("ASSET_A", "log", logAxis);
  assertOverlay("ASSET_B", "log", logAxis);
  assertOverlay("none", "log", logAxis);
  context.setChartScale("five_year", "linear");
  const linearAxis = [...host.innerHTML.matchAll(/data-axis-value="([^"]+)"/g)].map(match => match[1]);
  assertOverlay("ASSET_A", "linear", linearAxis);
  assertOverlay("ASSET_B", "linear", linearAxis);
  assertOverlay("none", "linear", linearAxis);
});

test("Research renders concise recent Annual return rows and an honest empty state", () => {
  const {context} = dashboard();
  const fixture = {
    leader: null,
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
  assert.match(html, /<th>Status<\/th>/);
  assert.match(html, /<span class="run-status keep">KEEP<\/span>/, "each row says whether it was kept or discarded");
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
    leader: {experiment_id: "champion-run", candidate_sha256: fullSha,
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
  assert.match(html, /development-window Annual return only/);
  assert.doesNotMatch(html, /20\.00%/);
  assert.ok(html.includes(`<dt>Candidate SHA-256</dt><dd><code>${fullSha}</code></dd>`),
    "full champion identity remains available behind the collapsed Details disclosure");
  assert.equal((html.match(/<summary>Leader identity<\/summary>/g) || []).length, 1);
  assert.match(html, /Candidate champion-run/,
    "the current candidate is visible without expanding identity details");
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
  assert.doesNotMatch(html, /<polygon/, "sparse marked series avoids disconnected gradient fill seams");
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
  const details = context.renderResearch({leader: {experiment_id: "champ", candidate_sha256: "sha",
    dataset_manifest_sha256: "manifest", development_start: "2024-01-01", development_end: "2024-01-05",
    score: .25}, chart: {...data, development_start: "2024-01-01", development_end: "2024-01-05"},
    counts: {}, activity: {}, recent: []});
  assert.match(details, /<summary>Leader identity<\/summary>/);
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
  assert.doesNotMatch(rendered, /<polygon/, "missing-mark gaps remain line-only rather than drawing separate gradient panels");
  assert.match(rendered, /onpointermove="chartPointer\(event,this\)"/);
  assert.match(rendered, /onkeydown="chartKey\(event,this\)"/);
  assert.match(rendered, /onfocus="chartPoint/);
  assert.match(rendered, /class="chart-crosshair"/);
  assert.match(rendered, /role="tooltip" aria-live="polite"/);
  assert.match(rendered, /aria-valuenow="0"/);
  context.setReplayBenchmark("overlay", "ASSET_B");
  const overlaid = context.chart({availability: "available", chart_id: "overlay", replay: true,
    points: [{date: "2024-01-01", equity: 10000}, {date: "2024-01-02", equity: 12000}],
    benchmarks: {ASSET_B: {availability: "available", points: [
      {date: "2024-01-01", equity: 10000}, {date: "2024-01-02", equity: 11000}]}}});
  assert.match(overlaid, /stroke="#f5a742"/);
  assert.match(overlaid, /ASSET_B buy &amp; hold/);
  assert.match(overlaid, /&quot;benchmarkSymbol&quot;:&quot;ASSET_B&quot;/);

  const attrs = {"data-points": JSON.stringify([
    {x: 78, y: 80, date: "2024-01-01", equity: 10000},
    {x: 510, y: null, date: "2024-01-02", equity: null},
    {x: 942, y: 40, date: "2024-01-03", equity: 12000},
  ]), "data-index": "0"};
  const values = {};
  const makeNode = () => ({setAttribute(key, value) { this[key] = String(value); }});
  const elements = Object.fromEntries([".chart-crosshair", ".chart-point", ".chart-tip-bg",
    ".chart-tip-date", ".chart-tip-equity", ".chart-tip-benchmark"].map(key => [key, makeNode()]));
  const group = {...makeNode(), querySelector: key => elements[key]};
  const live = {textContent: "", hidden: true};
  const parentNode = {querySelector: key => key === ".chart-inspection" ? group : live};
  const svg = {...makeNode(), parentNode,
    ownerSVGElement: {getBoundingClientRect: () => ({left: 0, width: 960})},
    getAttribute(key) { return attrs[key]; }, setAttribute(key, value) { attrs[key] = String(value); }};
  context.chartPointer({clientX: 510}, svg);
  assert.equal(attrs["data-index"], "1", "pointer hover inspects the nearest plotted date");
  assert.equal(attrs["aria-valuetext"], "2024-01-02, strategy Equity unavailable (missing mark), No reporting reference selected");
  assert.equal(elements[".chart-crosshair"].x1, "510");
  const keyEvent = {key: "ArrowRight", preventDefault() { this.prevented = true; }};
  context.chartKey(keyEvent, svg);
  assert.equal(keyEvent.prevented, true);
  assert.equal(attrs["data-index"], "2");
  assert.equal(attrs["aria-valuetext"], "2024-01-03, strategy $12,000.00, No reporting reference selected");
  assert.equal(elements[".chart-point"].cx, "942");
  context.chartKey({key: "Home", preventDefault() {}}, svg);
  assert.equal(attrs["aria-valuetext"], "2024-01-01, strategy $10,000.00, No reporting reference selected");
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

test("Trading keeps a champion preview and disables unsupported capital stages", () => {
  const {context} = dashboard();
  const html = context.renderTrading({lanes: [], leader: null,
    historical_replay: {availability: "unavailable"}});
  assert.match(html, /Research · Current Leader/);
  assert.equal((html.match(/role="tab"/g) || []).length, 5);
  assert.equal((html.match(/disabled title='Unavailable: no verified stage evidence'/g)||[]).length,5);
  assert.doesNotMatch(html, /submit|place order|enable live/i);
  assert.doesNotMatch(html, /\$[0-9]|[0-9]+\.[0-9]+%|READY/);
});

test("overlay selection survives the rebuild of its card on refresh", () => {
  const {context} = dashboard();
  const replay = overlayReplay();
  const selectedOption = card => [...card.matchAll(/<option value="([^"]+)"([^>]*)>/g)]
    .filter(([, , attrs]) => /\bselected\b/.test(attrs)).map(([, value]) => value);
  assert.deepEqual(selectedOption(context.replayCard(replay, "five_year", "Replay", "", false)), ["none"]);
  context.setReplayBenchmark("five_year", "ASSET_A");
  let rebuilt = context.replayCard(replay, "five_year", "Replay", "", false);
  assert.deepEqual(selectedOption(rebuilt), ["ASSET_A"], "the dropdown shows the overlay that is drawn");
  assert.equal((rebuilt.match(/stroke="#f5a742"/g) || []).length, 1);
  context.setReplayBenchmark("five_year", "none");
  rebuilt = context.replayCard(replay, "five_year", "Replay", "", false);
  assert.deepEqual(selectedOption(rebuilt), ["none"]);
  assert.equal((rebuilt.match(/stroke="#f5a742"/g) || []).length, 0);
  context.setReplayBenchmark("five_year", "ASSET_B");
  rebuilt = context.replayCard(overlayReplay({assetBAvailable: false}), "five_year", "Replay", "", false);
  assert.deepEqual(selectedOption(rebuilt), ["none"], "an overlay that became unavailable reads as None");
  assert.equal((rebuilt.match(/stroke="#f5a742"/g) || []).length, 0);
});

test("leader verification unavailable is shown distinctly from no v4 leader", () => {
  const {context} = dashboard();
  const unavailable = {...emptyResearch, activity: {state: "active"}, leader_status: {state: "unavailable",
    reason: "verifier_failed", detail: "RuntimeError: candidate_champion_identity_mismatch"}};
  let html = context.renderResearch(unavailable);
  assert.match(html, /VERIFICATION UNAVAILABLE/);
  assert.match(html, /Leader verification unavailable · the AutoResearch verifier reported an error \(RuntimeError: candidate_champion_identity_mismatch\)/);
  assert.match(html, /expected while an active research cycle is editing the candidate/);
  assert.doesNotMatch(html, /NO CURRENT V4 LEADER|No current v4 leader/);
  html = context.renderResearch({...unavailable, activity: {state: "sleeping"},
    leader_status: {state: "unavailable", reason: "leader_invalidated", detail: "run-7"}});
  assert.match(html, /the current leader is on the invalidation list \(run-7\)/);
  assert.doesNotMatch(html, /active research cycle/);
  html = context.renderResearch({...emptyResearch, leader_status: {state: "none", reason: "no_v4_incumbent"}});
  assert.match(html, /NO CURRENT V4 LEADER/);
  assert.doesNotMatch(html, /verification unavailable/i);
  const trading = context.renderTrading({lanes: [], leader: null, leader_status: unavailable.leader_status,
    historical_replay: {availability: "unavailable"}});
  assert.match(trading, /VERIFICATION UNAVAILABLE/);
  assert.match(trading, /Leader verification unavailable/);
  assert.match(context.renderTrading({lanes: [], leader: null}), /No current v4 research leader/);
});

test("the leader headline is labeled with the authoritative v4 score window", () => {
  const {context} = dashboard();
  const html = context.renderResearch({...emptyResearch, leader: {experiment_id: "run-7", leader_type: "qualified",
    candidate_sha256: "a".repeat(64), development_annual_return: 0.4271828, regimes_passed: 4, regime_results: [],
    score_window: {start: "2016-09-01", end: "2024-08-01"},
    development_start: "2016-01-04", development_end: "2024-08-01"}});
  assert.match(html, /Score Annual return · 2016-09-01 → 2024-08-01<\/span><strong>42\.72%<\/strong>/);
  assert.doesNotMatch(html, /Full-development Annual return|2016-01-04 → 2024-08-01/,
    "the development calendar start is not presented as the score window");
  const replay = {...overlayReplay(), periods: {development: {...overlayReplay().periods.five_year,
    metrics: {...overlayReplay().periods.five_year.metrics, start_date: "2016-01-04", end_date: "2024-08-01"}}}};
  const card = context.replayCard(replay, "development", "Development Replay", "", true);
  assert.match(card, /2016-01-04 → 2024-08-01 · Start \$10,000/, "the replay card keeps its own replay dates");
  assert.match(card, /<dt>Objective score window<\/dt><dd>2016-09-01 through 2024-08-01<\/dd>/);
});

test("narrow screens carry tooltip text in HTML and wide axis labels are not clipped", () => {
  const {context} = dashboard({innerWidth: 390});
  context.setReplayBenchmark("narrow", "ASSET_B");
  const narrow = context.chart({availability: "available", chart_id: "narrow", replay: true,
    points: [{date: "2024-01-01", equity: 10000}, {date: "2024-01-02", equity: 12000}],
    benchmarks: {ASSET_B: {availability: "available", points: [
      {date: "2024-01-01", equity: 10000}, {date: "2024-01-02", equity: 11000}]}}});
  assert.equal((narrow.match(/<text class="chart-legend"/g) || []).length, 2,
    "the in-SVG legend is marked so narrow CSS can hide it");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /@media\(max-width:620px\)\{\.chart \.chart-legend,\.chart \.chart-tip-bg,[^}]*\{display:none\}\.chart \.chart-tooltip\{position:static/);

  const attrs = {"data-points": JSON.stringify([{x: 172, y: 80, date: "2024-01-01", equity: 10000,
    benchmark: 10000, benchmarkSymbol: "ASSET_B"}]), "data-index": "0"};
  const makeNode = () => ({setAttribute(key, value) { this[key] = String(value); }});
  const elements = Object.fromEntries([".chart-crosshair", ".chart-point", ".chart-tip-bg", ".chart-tip-date",
    ".chart-tip-equity", ".chart-tip-benchmark"].map(key => [key, makeNode()]));
  const live = {textContent: "", hidden: true};
  const chartHost = {querySelector: key => key === ".chart-tooltip" ? live : null};
  const svg = {...makeNode(), parentNode: {querySelector: key => key === ".chart-inspection"
      ? {...makeNode(), querySelector: name => elements[name]} : null},
    closest: selector => selector === ".chart" ? chartHost : null,
    getAttribute(key) { return attrs[key]; }, setAttribute(key, value) { attrs[key] = String(value); }};
  context.chartPoint(svg, 0);
  assert.equal(live.hidden, false);
  assert.equal(live.textContent, "2024-01-01 · Strategy: $10,000.00 · ASSET_B buy & hold: $10,000",
    "the tooltip element outside the SVG is populated (accessible + narrow-screen text)");

  const wide = dashboard().context.chart({availability: "available",
    points: [{date: "2024-01-01", equity: 10000}, {date: "2024-01-02", equity: 237030897}]});
  const left = Number(/data-left="([0-9.]+)"/.exec(wide)[1]);
  const labels = [...wide.matchAll(/class="chart-label chart-axis-label"[^>]*>([^<]+)</g)].map(match => match[1]);
  assert.ok(labels.some(label => label.length >= 12), "fixture produces a long tick label");
  assert.ok(labels.every(label => label.length * 6.6 + 8 <= left), "every tick label fits left of the plot");
});

const runner = mode => ({mode, cycle: 6, cycle_started_at: "2026-10-20T14:26:27+00:00",
  wake_at: mode === "sleeping" ? "2099-01-01T00:00:00+00:00" : null, provider_failure_streak: 0, completed_cycles: 5,
  last_cycle: {cycle: 5, started_at: "2026-10-20T09:26:26+00:00", ended_at: "2026-10-20T14:26:27+00:00",
    experiments: 282, keeps: 3, discards: 256, failures: 23, stop_reason: "time_limit", elapsed_seconds: 18000},
  model: "openai/gpt-6-luna", variant: "medium"});
const growthLab = (key, name, annual_return) => ({key, lab: `lab_${key}`, display_name: name, kind: "growth",
  service: "active", available: true,
  window: {start: "2016-01-04", end: "2024-08-01", label: "Development / in-sample"},
  counts: {experiments: 471, keeps: 9, discards: 460, failures: 2},
  best: {experiment_id: `${key}-best`, annual_return, max_drawdown: -0.2875, average_gross_exposure: 0.6115,
    starting_capital: 10000, implied_growth_multiple: 2.5, implied_final_equity: 25000,
    score_window: {start: "2016-09-01", end: "2024-08-01"}, sessions: 2157, signal_inputs: 15,
    tradable_targets: ["ASSET_F", "ASSET_E"], partial_fill_rate: 0.0005,
    found_at: "2026-10-20T10:20:36+00:00",
    regimes: [{key: "2022", label: "2022", excess_annual_return: -0.2257}]},
  recent_bests: [{experiment_id: `${key}-best`, at: "2026-10-20T10:20:36+00:00", annual_return, max_drawdown: -0.2875},
    {experiment_id: `${key}-older`, at: "2026-10-20T01:46:16+00:00", annual_return: 0.4, max_drawdown: -0.5}],
  latest: {experiment_id: `${key}-latest`, status: "discard", score: 0.9, at: "2026-10-20T15:33:33+00:00"},
  last_activity_at: "2026-10-20T15:33:33+00:00", runner: runner("active")});
const activeLab = (multiple = 3.1416) => ({key: "active_v2", lab: "active_v2", display_name: "Active V2",
  kind: "active", service: "active", available: true,
  window: {start: "2023-01-03", end: "2025-06-30", label: "Search window / in-sample"},
  counts: {experiments: 267, keeps: 8, discards: 259, failures: 0},
  best: {experiment_id: "fc-best", growth_multiple: multiple, starting_capital: 10000, final_equity: multiple * 10000,
    closed_trades: 94, winning_trades: 52, win_rate: 0.5512, cost_dollars: 6180.25, mean_holding_minutes: 2915,
    max_drawdown: -0.1934, found_at: "2026-10-20T11:48:46+00:00", asset_use: {ASSET_A: 42, USD: 24},
    total_return: multiple - 1, sessions: 601, sessions_with_position: 388, forced_exits: 71,
    frequency_qualified: null, qualified_winner: null},
  recent_bests: [{experiment_id: "fc-best", at: "2026-10-20T11:48:46+00:00", growth_multiple: multiple,
    final_equity: multiple * 10000, closed_trades: 94}],
  latest: {experiment_id: "fc-latest", status: "discard", score: 0.78, at: "2026-10-20T15:30:26+00:00"},
  last_activity_at: "2026-10-20T15:30:26+00:00", runner: runner("sleeping")});
const activeSeed = () => ({key: "active_frequent", lab: "active_frequent",
  display_name: "Active Frequent V3", kind: "active", service: "stopped", available: true,
  window: {start: "2023-01-03", end: "2025-06-30", label: "Search window / in-sample"},
  counts: {experiments: 0, keeps: 0, discards: 0, failures: 0},
  best: {experiment_id: "neutral_seed", growth_multiple: 1, starting_capital: 10000, final_equity: 10000,
    closed_trades: 0, winning_trades: 0, win_rate: 0, cost_dollars: 0, mean_holding_minutes: 0, max_drawdown: -0,
    found_at: null, asset_use: {}},
  recent_bests: [], latest: null, last_activity_at: null});
const fourLabs = () => [growthLab("growth_offensive", "Growth — Offensive", 0.3311),
  growthLab("growth_defensive", "Growth — Defensive", 0.4210), activeLab(), activeSeed()];
const laneCards = html => html.slice(html.indexOf('<section class="lane-cards">'), html.indexOf('<article class="card research-table">'));
const cardFor = (html, name) => { const start = html.indexOf(`<h2>${name}</h2>`); return html.slice(start, html.indexOf("</article>", start)); };

test("Research leads with one lane card per active lab, above the archived single-lab view", () => {
  const {context} = dashboard();
  const html = context.renderResearch({...emptyResearch, labs: fourLabs()});
  const cards = laneCards(html);
  assert.equal((cards.match(/<article class="card lane-card">/g) || []).length, 4);
  assert.ok(html.indexOf('class="lane-cards"') < html.indexOf("Archived lab"), "active labs come first");
  assert.ok(html.indexOf("Archived lab") < html.indexOf("Current Research Leader"));
  assert.equal((cards.match(/template-badge research-badge">ACTIVE</g) || []).length, 3);
});

test("cards show whether each supervisor is running or sleeping and its last completed cycle", () => {
  const {context} = dashboard();
  const html = context.renderResearch({...emptyResearch, labs: fourLabs()});
  const core = cardFor(html, "Growth — Offensive"), fast = cardFor(html, "Active V2");
  assert.match(core, /research-badge">RUNNING</);
  assert.match(core, /Running cycle 6 · started/);
  assert.match(fast, /warn-badge">SLEEPING</);
  assert.match(fast, /Sleeping after cycle 6 · wakes .* \(in \d+h/);
  assert.match(core, /Cycle 5 · 282 experiments · 3 keeps · 23 failures · time limit · .* \(5h 0m\)/);
  assert.match(core, /openai\/gpt-6-luna · medium/);
  const seed = cardFor(html, "Active Frequent V3");
  assert.match(seed, /warn-badge">STOPPED</);
  assert.doesNotMatch(seed, />RUNNING<|>SLEEPING</, "a stopped service never claims a running supervisor");
});

test("Growth cards headline champion Annual return with its window and the implied capital growth", () => {
  const {context} = dashboard();
  const card = cardFor(context.renderResearch({...emptyResearch, labs: fourLabs()}), "Growth — Defensive");
  assert.match(card, /DEVELOPMENT \/ IN-SAMPLE · 2016-01-04 → 2024-08-01/);
  assert.match(card, /<span>Best Annual return · 2016-09-01 → 2024-08-01<\/span><strong>42\.10%<\/strong>/);
  assert.match(card, /\$10,000 → \$25,000 \(2\.50×\)/);
  assert.match(card, /Compounded from the Annual return/);
  for (const label of ["Max drawdown", "Avg gross exposure", "Sessions", "Inputs / targets", "Partial-fill rate",
    "Experiments", "Keeps", "Failures", "Best experiment", "Best found", "Latest experiment", "Last activity",
    "Tradable targets"]) assert.match(card, new RegExp(label));
  assert.match(card, /-28\.75%/);
  assert.match(card, /growth_defensive-latest · DISCARD/);
  assert.doesNotMatch(card, /90\.00%/, "the latest discard's score is not shown as the best");
  assert.match(card, /2022 · excess Annual return<\/span><strong class="negative">-22\.57%/);
});

test("Active cards headline growth multiple and capital, never Annual return", () => {
  const {context} = dashboard();
  const html = context.renderResearch({...emptyResearch, labs: fourLabs()});
  const card = cardFor(html, "Active V2");
  assert.match(card, /SEARCH WINDOW \/ IN-SAMPLE · 2023-01-03 → 2025-06-30/);
  assert.match(card, /<span>Best growth multiple<\/span><strong>3\.14×<\/strong>/);
  assert.match(card, /\$10,000 → \$31,416/);
  assert.match(card, /214\.16% total return/);
  for (const label of ["Trades", "Win rate", "Costs", "Mean holding", "Sessions in market", "Forced exits", "Discards", "Assets traded"])
    assert.match(card, new RegExp(label));
  assert.match(card, /55\.12% \(52\/94\)/);
  assert.match(card, /64\.56% \(388\/601\)/);
  assert.match(card, /ASSET_A 42 · USD 24/);
  assert.doesNotMatch(card, /Annual return|fold|walk-forward|Qualified winner/i);
  const seed = cardFor(html, "Active Frequent V3");
  assert.match(seed, /1\.00×[\s\S]*\$10,000 → \$10,000/);
  assert.match(seed, /neutral seed \(no keep yet\)/);
});

test("Frequent-trading labs also show their frequency qualification", () => {
  const {context} = dashboard();
  const labs = fourLabs();
  Object.assign(labs[3].best, {closed_trades_per_session: 0.7741, frequency_threshold_trades_per_session: 0.5,
    frequency_qualified: true, qualified_winner: true});
  const card = cardFor(context.renderResearch({...emptyResearch, labs}), "Active Frequent V3");
  assert.match(card, /Trades \/ session<\/strong><span>0\.77 \(min 0\.5\)/);
  assert.match(card, /Qualified winner<\/strong><span>Yes/);
});

test("one unavailable lab keeps the other cards, and service states are badged honestly", () => {
  const {context} = dashboard();
  const labs = fourLabs();
  labs[0] = {key: "growth_offensive", display_name: "Growth — Offensive", kind: "growth",
    service: "error", available: false, error: "Data temporarily unavailable (ValueError)", runner: null};
  labs[2].service = "stopped";
  const html = context.renderResearch({...emptyResearch, labs});
  assert.match(cardFor(html, "Growth — Offensive"), /error-badge">ERROR<[\s\S]*Data temporarily unavailable[\s\S]*Supervisor state not published/);
  assert.match(cardFor(html, "Growth — Defensive"), /Best Annual return/);
  assert.match(cardFor(html, "Active V2"), /warn-badge">STOPPED<[\s\S]*Supervisor STOPPED/);
  assert.match(context.renderResearch(emptyResearch), /Research lab status unavailable/);
});

test("Recent Bests lists kept champions across labs newest first with lab-appropriate metrics", () => {
  const {context} = dashboard();
  const html = context.renderResearch({...emptyResearch, labs: fourLabs()});
  const table = html.slice(html.indexOf("<h3>Recent Bests</h3>"), html.indexOf("</article>", html.indexOf("<h3>Recent Bests</h3>")));
  assert.equal((table.match(/<tr class=/g) || []).length, 5);
  assert.ok(table.indexOf("fc-best") < table.indexOf("growth_offensive-older"), "newest first across labs");
  assert.match(table, /class="champ-row"><td>★ Active V2<\/td>[\s\S]*?3\.14× · \$31,416[\s\S]*?94 trades/);
  assert.match(table, /42\.10% Annual return[\s\S]*?-28\.75% DD/);
  assert.equal((html.match(/<h3>Recent Experiments<\/h3>/g) || []).length, 1, "archived lab table kept, not duplicated");
});

test("the archived lab section renders identically whatever the active labs show", () => {
  const {context} = dashboard();
  const archived = html => html.slice(html.indexOf('<h2 class="section-heading">Archived lab'));
  const labs = fourLabs();
  labs[1] = {key: "growth_defensive", display_name: "Growth — Defensive", kind: "growth",
    service: "error", available: false, error: "Data temporarily unavailable (OSError)"};
  assert.equal(archived(context.renderResearch({...emptyResearch, labs: fourLabs()})),
    archived(context.renderResearch({...emptyResearch, labs})));
  assert.equal(archived(context.renderResearch({...emptyResearch, labs: fourLabs()})), archived(context.renderResearch(emptyResearch)));
});

test("Refresh rereads the research endpoint and replaces lane data with the newer champion", async () => {
  const {context, nodes, requests} = dashboard();
  requests[0].resolve(response({...emptyResearch, labs: fourLabs()}));
  await settle();
  assert.match(nodes.get("view").innerHTML, /<strong>3\.14×<\/strong>/);
  const newer = fourLabs();
  newer[2] = activeLab(9.5);
  newer[3].counts = {experiments: 3, keeps: 1, discards: 2, failures: 0};
  context.loadRoute("research");
  requests[1].resolve(response({...emptyResearch, labs: newer}));
  await settle();
  const view = nodes.get("view").innerHTML;
  assert.match(view, /<strong>9\.50×<\/strong>/);
  assert.doesNotMatch(view, /<strong>3\.14×<\/strong>/);
  assert.match(cardFor(view, "Active Frequent V3"), /Experiments<\/strong><span>3<[\s\S]*Keeps<\/strong><span>1</);
});

test("each population renders a table of every trajectory with its state, staleness and family", () => {
  const {context} = dashboard();
  const labs = fourLabs();
  const member = (lab, extra) => ({...lab, population: "growth", ...extra});
  const populations = [{population: "growth", display_name: "Growth", kind: "growth",
    policy: {enabled: true, fresh_slots: 1, mature_slots: 2, demote_after_no_keep: 300, duty: {fresh: [300, 180], mature: [60, 420]}},
    members: [member(labs[0], {trajectory: "t002", state: "fresh", since_last_keep: 12, family: ["breakout idea"], max_similarity: 0.31, closest: "growth_offensive"}),
              member(labs[1], {lab: "growth_offensive", trajectory: "offensive", state: "mature", since_last_keep: 900, keep_while_mature: true}),
              {trajectory: "defensive", state: "paused", available: false}],
    log: [{at: "2026-10-21T20:00:00+00:00", action: "spawn", lab: "growth_combined_t002", state: "fresh"}]}];
  const html = context.renderResearch({...emptyResearch, labs, populations});
  const table = html.slice(html.indexOf("Growth population"), html.indexOf("Growth population log"));
  assert.match(table, /1 fresh slot \(300m on \/ 180m off\) · 2 mature slots \(60m on \/ 420m off\)/);
  assert.match(table, /<td>t002<\/td><td>FRESH<\/td><td>12<\/td>/);
  assert.match(table, /MATURE <span class="state-flag">· NEW KEEP<\/span>/);
  assert.match(table, /<td>defensive<\/td><td>PAUSED<\/td>/);
  assert.match(table, /31% like offensive/);
  assert.match(table, /breakout idea/);
  assert.match(html, /Growth population log[\s\S]*spawn[\s\S]*growth_combined_t002/);
  assert.ok(html.indexOf("Growth population") < html.indexOf('class="lane-cards"'), "populations lead the page");
});
