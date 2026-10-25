#!/usr/bin/env node
// Writes demo-data/api/{research,trading,replay}.json: the three payloads the dashboard
// reads, filled with synthetic values. Seeded, so every run produces the same files.
// Strategy names, assets, curves and counts are invented; none come from a real system.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "demo-data", "api");
const GENERATED_AT = "2026-01-15T15:00:00Z";
const START_CAPITAL = 10000;

// mulberry32: small deterministic PRNG, plus Box-Muller for normal draws.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  return next;
}
const sha = text => createHash("sha256").update(`autobot-demo:${text}`).digest("hex");
const at = (hoursFromGenerated) => new Date(Date.parse(GENERATED_AT) + hoursFromGenerated * 3600000).toISOString().replace(".000Z", "Z");
const experimentId = (hoursFromGenerated, tag) => {
  const d = new Date(Date.parse(GENERATED_AT) + hoursFromGenerated * 3600000);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}_${sha(tag).slice(0, 6)}`;
};
const round = (value, digits = 4) => Number(value.toFixed(digits));

// Weekday sessions; a synthetic calendar, not an exchange calendar.
function sessions(start, end) {
  const out = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
const CALENDAR = sessions("2014-01-02", "2025-12-31");

// Daily returns with slow regime drift, so curves have believable stretches of gain and loss.
function returns(seed, annualDrift, annualVol) {
  const r = rng(seed), daily = [];
  let regime = 0;
  for (let i = 0; i < CALENDAR.length; i++) {
    if (i % 63 === 0) regime = r.normal() * 0.6;
    daily.push((annualDrift + regime * annualVol * 0.5) / 252 + (annualVol / Math.sqrt(252)) * r.normal());
  }
  return daily;
}

function curve(daily, from, to) {
  const points = [];
  let equity = START_CAPITAL;
  CALENDAR.forEach((date, i) => {
    if (date < from || date > to) return;
    if (points.length) equity *= 1 + daily[i];
    points.push({ date, equity: round(equity, 2) });
  });
  return points;
}

function metrics(points) {
  const first = points[0], last = points[points.length - 1];
  const years = (Date.parse(last.date) - Date.parse(first.date)) / (365.25 * 86400000);
  const rets = points.slice(1).map((p, i) => p.equity / points[i].equity - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  let peak = first.equity, maxDrawdown = 0;
  for (const p of points) { peak = Math.max(peak, p.equity); maxDrawdown = Math.min(maxDrawdown, p.equity / peak - 1); }
  return {
    start_date: first.date, end_date: last.date, starting_capital: START_CAPITAL,
    ending_equity: last.equity, net_profit: round(last.equity - START_CAPITAL, 2),
    total_return: round(last.equity / START_CAPITAL - 1),
    annual_return: round((last.equity / START_CAPITAL) ** (1 / years) - 1),
    sharpe: round((mean / sd) * Math.sqrt(252), 3), max_drawdown: round(maxDrawdown),
    priced_sessions: points.length, missing_marks: 0,
  };
}

// ---- Archived single-lab leader and its replay windows --------------------------------
const PERIODS = {
  development: ["2014-01-02", "2020-12-31"],
  five_year: ["2021-01-04", "2025-12-31"],
  ten_year: ["2016-01-04", "2025-12-31"],
  through_present: ["2014-01-02", "2025-12-31"],
};
const ASSETS = ["ASSET_A", "ASSET_B", "ASSET_C", "ASSET_D"];
const leaderDaily = returns(11, 0.15, 0.17);
const benchmarkDaily = { INDEX: returns(23, 0.08, 0.15), SECTOR: returns(37, 0.11, 0.24) };
const leaderId = experimentId(-24 * 41, "leader");
const contract = { id: "DEMO_DAILY_CONTRACT", version: "1.0.0", sha256: sha("contract") };
const manifestSha = sha("dataset-manifest");

function period(key, [from, to], index) {
  const points = curve(leaderDaily, from, to), m = metrics(points);
  const fills = Math.round(points.length * 0.19);
  const bySymbol = Object.fromEntries(ASSETS.map((symbol, i) => [symbol, Math.round(fills * [0.38, 0.27, 0.21, 0.14][i])]));
  const benchmarks = Object.fromEntries(Object.entries(benchmarkDaily).map(([symbol, daily]) => {
    const bPoints = curve(daily, from, to);
    return [symbol, { availability: "available", points: bPoints, metrics: { availability: "available", ...metrics(bPoints) } }];
  }));
  return [key, { metrics: { ...m, executed_fills: fills, executed_fills_by_symbol: bySymbol,
    state_initialization: index === 0 ? "warmup from first observation" : "fresh ledger, warmup from prior observations" },
    points, benchmarks }];
}
const periods = Object.fromEntries(Object.entries(PERIODS).map(([key, range], i) => period(key, range, i)));
const dev = periods.development.metrics;

const REGIME_WINDOWS = [["2014_2015", "2014–2015"], ["2016_2017", "2016–2017"], ["2018_2019", "2018–2019"], ["2020", "2020"]];
const regimeResults = REGIME_WINDOWS.map(([key, label], i) => ({ key, label, excess_annual_return: round([0.071, 0.112, 0.038, 0.154][i]), qualifies: true }));
const weakest = regimeResults.reduce((a, b) => (b.excess_annual_return < a.excess_annual_return ? b : a));

const leader = {
  experiment_id: leaderId, candidate_sha256: sha("leader-candidate"), leader_type: "qualified",
  contract_version: contract.version, contract_sha256: contract.sha256, dataset_manifest_sha256: manifestSha,
  development_annual_return: dev.annual_return, score_window: { start: dev.start_date, end: dev.end_date },
  regimes_passed: 4, regime_results: regimeResults, weakest_regime: weakest, evaluator_version: "evaluator-v4",
};
const historicalReplay = {
  availability: "available", label: "Archived leader replay", leader_type: "qualified",
  candidate: { experiment_id: leaderId, sha256: leader.candidate_sha256 }, contract,
  dataset: { start: CALENDAR[0], latest: CALENDAR[CALENDAR.length - 1], manifest_sha256: manifestSha, snapshot_hash: sha("snapshot") },
  configuration: {
    objective: "annual return above modeled cash, gated on every regime window", slippage: "modeled",
    starting_capital: START_CAPITAL, state_initialization: "warmup from first observation",
    strategy_config: { LOOKBACK: 126, TREND_WINDOW: 200, VOLATILITY_TARGET: 0.15, REBALANCE: "weekly", SIGNAL_INPUTS: ASSETS, TRADABLE_TARGETS: ASSETS },
    strategy_config_sha256: sha("strategy-config"),
  },
  development_objective: { evaluator_version: "evaluator-v4", rankable: true, score: dev.annual_return, window: { start: dev.start_date, end: dev.end_date } },
  first_scoring_date: dev.start_date, periods,
};

// ---- Labs and populations ----------------------------------------------------------------
const MODEL = "LLM research agent";
function runner(seed, mode, cycle, completed) {
  const r = rng(seed), experiments = 8 + Math.floor(r() * 10), keeps = Math.floor(r() * 3);
  const ended = mode === "active" ? -1.5 : -0.4 - r() * 2;
  return {
    mode, cycle, completed_cycles: completed, model: MODEL, variant: "default",
    ...(mode === "active" ? { cycle_started_at: at(-0.6) } : { wake_at: at(1 + r() * 4) }),
    last_cycle: { cycle: mode === "active" ? cycle - 1 : cycle, experiments, keeps, failures: Math.floor(r() * 2),
      stop_reason: "iteration_budget_reached", started_at: at(ended - 4.8), ended_at: at(ended) },
  };
}
function recentBests(seed, kind, n, best) {
  const r = rng(seed), rows = [];
  for (let i = 0; i < n; i++) {
    const hours = -6 - i * (20 + r() * 40), id = i === 0 ? best.experiment_id : experimentId(hours, `${seed}-${i}`);
    rows.push(kind === "growth"
      ? { at: i === 0 ? best.found_at : at(hours), experiment_id: id, annual_return: round(best.annual_return - i * 0.006 - r() * 0.004), max_drawdown: round(best.max_drawdown - r() * 0.03) }
      : { at: i === 0 ? best.found_at : at(hours), experiment_id: id, growth_multiple: round(best.growth_multiple - i * 0.07, 3),
        final_equity: round((best.growth_multiple - i * 0.07) * START_CAPITAL, 2), closed_trades: best.closed_trades - i * 6 });
  }
  return rows;
}

function growthLab({ seed, lab, trajectory, name, template, state, mode, cycle, experiments, keeps, family, drift }) {
  const r = rng(seed), points = curve(returns(seed, drift, 0.16), "2014-01-02", "2020-12-31"), m = metrics(points);
  const foundHours = -10 - r() * 60;
  const best = {
    experiment_id: experimentId(foundHours, `${lab}-best`), found_at: at(foundHours), annual_return: m.annual_return,
    score_window: { start: m.start_date, end: m.end_date }, starting_capital: START_CAPITAL,
    implied_final_equity: m.ending_equity, implied_growth_multiple: round(m.ending_equity / START_CAPITAL, 3),
    max_drawdown: m.max_drawdown, average_gross_exposure: round(0.62 + r() * 0.3), sessions: m.priced_sessions,
    signal_inputs: 4, tradable_targets: ASSETS.slice(0, 3 + Math.floor(r() * 2)), partial_fill_rate: round(r() * 0.004),
    regimes: REGIME_WINDOWS.map(([key, label]) => ({ key, label, excess_annual_return: round(m.annual_return - 0.03 + (r() - 0.45) * 0.08) })),
  };
  const discards = Math.round((experiments - keeps) * 0.96), failures = experiments - keeps - discards;
  return {
    lab, trajectory, display_name: `Growth · ${name}`, template_label: template, population: "growth", kind: "growth",
    state, service: "active", available: true, best, counts: { experiments, keeps, discards, failures },
    window: { label: "Development / in-sample", start: m.start_date, end: m.end_date },
    latest: { experiment_id: experimentId(-0.8 - r(), `${lab}-latest`), status: "discard" },
    since_last_keep: 3 + Math.floor(r() * 40), last_activity_at: at(-0.3 - r()), family,
    runner: runner(seed, mode, cycle, cycle - 1), recent_bests: recentBests(seed, "growth", 4, best),
  };
}

function activeLab({ seed, lab, trajectory, name, template, state, mode, cycle, experiments, keeps, family, multiple, frequency }) {
  const r = rng(seed), closed = 180 + Math.floor(r() * 220), wins = Math.round(closed * (0.51 + r() * 0.06));
  const sessionsTotal = 601, inMarket = Math.round(sessionsTotal * (0.48 + r() * 0.2)), foundHours = -8 - r() * 50;
  const best = {
    experiment_id: experimentId(foundHours, `${lab}-best`), found_at: at(foundHours), growth_multiple: multiple,
    starting_capital: START_CAPITAL, final_equity: round(multiple * START_CAPITAL, 2), total_return: round(multiple - 1),
    closed_trades: closed, winning_trades: wins, win_rate: round(wins / closed), cost_dollars: round(closed * (9 + r() * 6), 2),
    mean_holding_minutes: Math.round(frequency ? 95 + r() * 120 : 1500 + r() * 2400), max_drawdown: round(-0.11 - r() * 0.12),
    sessions: sessionsTotal, sessions_with_position: inMarket, forced_exits: Math.floor(closed * 0.08),
    asset_use: Object.fromEntries(ASSETS.map((s, i) => [s, Math.round(closed * [0.4, 0.3, 0.2, 0.1][i])])),
    ...(frequency ? { frequency_qualified: true, closed_trades_per_session: round(closed / sessionsTotal, 3),
      frequency_threshold_trades_per_session: 0.5, qualified_winner: closed / sessionsTotal >= 0.5 } : {}),
  };
  const discards = Math.round((experiments - keeps) * 0.95), failures = experiments - keeps - discards;
  return {
    lab, trajectory, display_name: `Active · ${name}`, template_label: template, population: "active", kind: "active",
    state, service: "active", available: true, best, counts: { experiments, keeps, discards, failures },
    window: { label: "Search window / in-sample", start: "2023-01-03", end: "2025-06-30" },
    latest: { experiment_id: experimentId(-0.5 - r(), `${lab}-latest`), status: "discard" },
    since_last_keep: 2 + Math.floor(r() * 30), last_activity_at: at(-0.2 - r()), family,
    runner: runner(seed, mode, cycle, cycle - 1), recent_bests: recentBests(seed, "active", 4, best),
  };
}

const labs = [
  growthLab({ seed: 131, lab: "growth_momentum_a", trajectory: "t001", name: "Momentum A", template: "Cross-asset momentum",
    state: "fresh", mode: "active", cycle: 14, experiments: 318, keeps: 19, drift: 0.17,
    family: ["Relative momentum with a volatility-scaled position size", "Trend filter that steps to cash in drawdowns"] }),
  growthLab({ seed: 202, lab: "growth_mean_reversion_b", trajectory: "t002", name: "Mean Reversion B", template: "Short-horizon mean reversion",
    state: "mature", mode: "sleeping", cycle: 41, experiments: 1126, keeps: 37, drift: 0.12,
    family: ["Buys short pullbacks inside an uptrend", "Exposure capped by realized volatility"] }),
  growthLab({ seed: 303, lab: "growth_trend_c", trajectory: "t003", name: "Trend Following C", template: "Multi-horizon trend",
    state: "mature", mode: "sleeping", cycle: 37, experiments: 984, keeps: 29, drift: 0.14,
    family: ["Blends three trend horizons into one target weight", "Rebalances weekly with a turnover budget"] }),
  activeLab({ seed: 404, lab: "active_breakout_d", trajectory: "t001", name: "Breakout D", template: "Intraday range breakout",
    state: "fresh", mode: "active", cycle: 9, experiments: 211, keeps: 14, multiple: 2.41, frequency: true,
    family: ["Enters on an opening-range break, exits by the close"] }),
  activeLab({ seed: 505, lab: "active_reversion_e", trajectory: "t002", name: "Mean Reversion E", template: "Multi-day swing reversion",
    state: "mature", mode: "sleeping", cycle: 28, experiments: 702, keeps: 22, multiple: 1.87, frequency: false,
    family: ["Fades multi-day extremes back toward a moving average"] }),
];

const SIMILARITY = { growth_momentum_a: ["growth_trend_c", 0.41], growth_mean_reversion_b: ["growth_momentum_a", 0.18],
  growth_trend_c: ["growth_momentum_a", 0.41], active_breakout_d: ["active_reversion_e", 0.12], active_reversion_e: ["active_breakout_d", 0.12] };
function population(key, displayName, kind, policy, log) {
  const members = labs.filter(lab => lab.population === key).map(lab => ({
    lab: lab.lab, trajectory: lab.trajectory, template_label: lab.template_label, parent: null, state: lab.state,
    keep_while_mature: false, service: lab.service, runner: { mode: lab.runner.mode, cycle: lab.runner.cycle, wake_at: lab.runner.wake_at },
    available: true, best: kind === "growth" ? { annual_return: lab.best.annual_return } : { growth_multiple: lab.best.growth_multiple },
    counts: { experiments: lab.counts.experiments, keeps: lab.counts.keeps }, since_last_keep: lab.since_last_keep,
    closest: SIMILARITY[lab.lab][0], max_similarity: SIMILARITY[lab.lab][1],
  }));
  return { population: key, display_name: displayName, kind, policy, members, log };
}
const populations = [
  population("growth", "Growth", "growth",
    { enabled: true, fresh_slots: 1, mature_slots: 2, demote_after_no_keep: 250, duty: { fresh: [300, 180], mature: [60, 420] } },
    [{ at: at(-30), action: "demote", lab: "growth_trend_c", state: "mature", reason: "no keep in 250 experiments" },
      { at: at(-29.5), action: "spawn", lab: "growth_momentum_a", state: "fresh", reason: "fresh slot open" }]),
  population("active", "Active", "active",
    { enabled: true, fresh_slots: 1, mature_slots: 1, demote_after_no_keep: 250, duty: { fresh: [240, 120], mature: [60, 300] } },
    [{ at: at(-52), action: "spawn", lab: "active_breakout_d", state: "fresh", reason: "fresh slot open" }]),
];

const recent = Array.from({ length: 5 }, (_, i) => ({
  experiment_id: i === 2 ? leaderId : experimentId(-24 * (38 + i * 2), `recent-${i}`), status: i === 2 ? "keep" : "discard",
  development_annual_return: i === 2 ? dev.annual_return : round(dev.annual_return - 0.012 - i * 0.004),
}));

const research = {
  generated_at: GENERATED_AT, demo: true, available: true, lab: "regime_model_v4",
  labs, populations,
  leader, leader_status: { state: "available" },
  counts: { valid_attempts: 1284, scored: 1190 },
  count_semantics: { valid_attempts: "Experiments with a summary matching the current evaluator", scored: "Experiments with a finite objective score" },
  activity: { state: "stopped", cycle: 96, heartbeat: at(-24 * 40), stop_reason: "archived", completed_cycles: 96,
    last_cycle: { cycle: 96, stop_reason: "iteration_budget_reached", started_at: at(-24 * 40 - 5), ended_at: at(-24 * 40), experiments_completed: 14, elapsed_seconds: 17400 } },
  recent,
};
const replay = { generated_at: GENERATED_AT, leader, leader_status: { state: "available" }, historical_replay: historicalReplay };
const trading = { generated_at: GENERATED_AT, demo: true, lanes: [{ lane_id: "paper/growth_trend_c", display_name: "Trend Following C · paper trading (simulated)" }] };

mkdirSync(OUT, { recursive: true });
for (const [name, payload] of Object.entries({ research, replay, trading })) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(payload) + "\n");
  console.log(`wrote demo-data/api/${name}.json`);
}
