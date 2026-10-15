/** Static UX/API guardrails for Research and Trading. Run with node dashboard/render_check.mjs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const html=readFileSync(join(here,'index.html'),'utf8');
const server=readFileSync(join(here,'server.js'),'utf8');
const status=readFileSync(join(here,'../status.py'),'utf8');
const research=[...html.matchAll(/function renderResearch\(data\)\{([\s\S]*?)\n\}/g)][0]?.[1]??'';
const replay=[...html.matchAll(/function replayCard\([\s\S]*?\n\}/g)][0]?.[0]??'';
const trading=[...html.matchAll(/function renderTemplate\([\s\S]*?\n\}/g)][0]?.[0]??'';
const checks=[
 ['one authoritative Research renderer', [...html.matchAll(/function renderResearch\(/g)].length===1],
 ['shared brand header and text route navigation', /class="topbar"[\s\S]*?AUTOBOT[\s\S]*?class="nav"/.test(html)&&/data-route="research">Research/.test(html)&&/data-route="trading">Trading/.test(html)],
 ['direct route/history support', html.includes('history.pushState')&&html.includes('popstate')&&server.includes('"/research"')&&server.includes('"/trading"')],
 ['separate Research, Trading and replay APIs with no auth layer or static source serving', ['research','trading','replay'].every(x=>server.includes(`"${x}"`))&&server.includes('/api/dashboard/${view}')&&!/requireAuth|api\/auth|express\.static|spawnSync/.test(server)&&!/id="login"|localStorage/.test(html)],
  ['leader card shows only authoritative development and regime metrics', research.includes('pct(c.development_annual_return)')&&research.includes('c.regimes_passed')&&research.includes('c.regime_results')&&research.includes('c.weakest_regime')&&!research.includes('${chart(data.chart||{})}')&&!research.includes('researchScore(c.score)')&&!research.includes('Curve integrity')],
 ['candidate ID and SHA are in collapsed identity Details', research.includes('<summary>Leader identity</summary>')&&research.includes('Candidate SHA-256')&&research.includes('Experiment')],
 ['development replay shows the objective score with the artifact score window', research.includes("replayCard(replay,'development','Development Replay','',true)")&&replay.includes('Objective score window')&&replay.includes('replay.development_objective.window')&&replay.includes('Development Score')],
 ['leader headline uses the authoritative score window, never the development calendar start', research.includes('Score Annual return · ${esc(scoreWindow)}')&&research.includes('c?.score_window')&&!research.includes('Full-development Annual return')],
 ['replay artifact schema v4 pins the v4 score window', status.includes('dashboard_post_selection_replay_v4')&&status.includes('window.get("start") != evaluator.PRE_START')&&readFileSync(join(here,'build_research_replay.py'),'utf8').includes("'window': {'start': evaluator.PRE_START")],
 ['development, five-year, ten-year and full-history cards are independent', ['development','five_year','ten_year','through_present'].every(k=>research.includes(`replayCard(replay,'${k}'`))],
 ['legacy frontend rebasing helper is removed and replay charts use canonical series directly', !html.includes('function fiveYearReplay')&&!html.includes('10000*(point.equity/base)')&&replay.includes('points:period.points||[]')],
 ['in-sample development is not mislabeled post-selection', replay.includes('IN-SAMPLE / SEARCH')&&replay.includes('POST-SELECTION')],
 ['replay metric definitions are available under collapsed Details', replay.includes('Annual return: endpoint equity / starting capital')&&replay.includes('sample deviation')&&replay.includes('<summary>Details</summary>')],
 ['period endpoint metrics sourced and validated server-side', status.includes('total_return')&&status.includes('net_profit')&&status.includes('expected_annual_return')],
 ['fresh capital is explicit for each independent replay window', replay.includes('fresh ledger from')&&status.includes('Fresh $10,000 ledger')&&readFileSync(join(here,'build_research_replay.py'),'utf8').includes('replay_start=start')],
 ['holdout points are not read through a development cutoff', html.includes('point.date<=cutoff')],
  ['chart uses actual positive equity marks and a safe numeric parser', html.includes('equities=points.map(point=>equityNumber(point.equity))')&&html.includes('benchmarkValues')&&html.includes('Number.isFinite(number)&&number>0')&&html.includes('(?![\\s\\S])')],
   ['buy-and-hold selector is optional, single-choice and independent of chart scale', html.includes('setReplayBenchmark')&&html.includes('value="none"')&&html.includes('option("ASSET_A")')&&html.includes('option("ASSET_B")')&&html.includes('availability==="available"')&&html.includes('disabled title=')&&html.includes('strategy curve remains primary')&&html.includes('setChartScale')],
 ['chart preserves missing-mark gaps without interpolation/smoothing', html.includes('valid=equities.map(value=>value!==null)')&&html.includes('segments.filter(segment=>segment.length>1)')&&html.includes('gaps at missing marks')],
 ['chart x-axis uses actual endpoint dates and values', html.includes('${esc(points[0].date)}')&&html.includes('${esc(points[points.length-1].date)}')&&html.includes('money(value)')],
 ['chart pointer and keyboard inspection stay available', html.includes('onpointermove="chartPointer(event,this)"')&&html.includes('onkeydown="chartKey(event,this)"')],
 ['Trading preview labels the selected research leader and says not promoted/no capital at risk', (trading.includes('QUALIFIED CHAMPION')||trading.includes('PROVISIONAL'))&&trading.includes('NOT PROMOTED')&&trading.includes('NO CAPITAL AT RISK')&&trading.includes('no orders or promotion')],
 ['historical stage requires exact candidate and contract identity', trading.includes('replay.candidate?.sha256===champion.candidate_sha256')&&trading.includes('replay.contract?.version===champion.contract_version')&&trading.includes('replay.contract?.sha256===champion.contract_sha256')],
 ['unsupported stages disabled and no operational forms/actions', trading.includes('disabled title=')&&trading.includes('Unavailable: no verified stage evidence')&&!/<form|type="submit"|api\/(?:orders|promote)/i.test(html)],
 ['no implied zero capital, readiness, or fabricated placeholder chart', !/\$0|READY|example-chart|example-metrics/.test(html)],
 ['responsive tiles and expanded metric grid preserved', html.includes('@media(max-width:620px)')&&html.includes('.tiles{grid-template-columns:repeat(2,minmax(0,1fr))')&&html.includes('.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))')&&html.includes('.metrics{grid-template-columns:repeat(2,minmax(0,1fr))')],
 ['narrow charts move squashed SVG legend/tooltip text into the HTML tooltip', /@media\(max-width:620px\)\{\.chart \.chart-legend,[^}]*\{display:none\}\.chart \.chart-tooltip\{position:static/.test(html)&&html.includes('class="chart-legend"')],
 ['replay artifact reader fails closed on identity/pin mismatch', status.includes('DASHBOARD_REPLAY_PATH')&&status.includes('MANIFEST_SHA256_PIN')&&status.includes('candidate_sha256')&&status.includes('return unavailable')],
 ['tracked replay producer confines reporting-symbol union to loading and keeps replay eligibility typed', readFileSync(join(here,'build_research_replay.py'),'utf8').includes('tuple(dict.fromkeys((*deps.required, *reporting_symbols)))')&&readFileSync(join(here,'build_research_replay.py'),'utf8').includes('candidate_dependency_scope_changed_by_reporting_symbols')&&readFileSync(join(here,'build_research_replay.py'),'utf8').includes('canonical_replay.replay(\n        dataset, candidate.module')&&readFileSync(join(here,'build_research_replay.py'),'utf8').includes('/srv/data/autobot-dashboard-replay/')&&!readFileSync(join(here,'build_research_replay.py'),'utf8').includes('results.tsv')],
];
const failed=checks.filter(([,ok])=>!ok);
for(const [name,ok] of checks)console.log(`${ok?'PASS':'FAIL'} ${name}`);
if(failed.length)process.exit(1);
