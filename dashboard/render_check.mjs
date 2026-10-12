/** Static UX/API guardrails for the two-route dashboard. Run with node dashboard/render_check.mjs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const server = readFileSync(join(here, 'server.js'), 'utf8');
const researchRenderers = [...html.matchAll(/function renderResearch\(data\)\{([\s\S]*?)\n\s*\}/g)];
const researchRenderer = researchRenderers[0]?.[1] ?? '';
const checks = [
  ['exactly one authoritative Research renderer', [...html.matchAll(/function renderResearch\(/g)].length === 1],
  ['shared brand header', /class="topbar"[\s\S]*?AUTOBOT[\s\S]*?class="nav"/.test(html)],
  ['Research and Trading text navigation', /data-route="research">Research/.test(html)
    && /data-route="trading">Trading/.test(html)],
  ['direct route/history support', html.includes("history.pushState") && html.includes("popstate")
    && server.includes('"/research"') && server.includes('"/trading"')],
  ['separate authenticated data endpoints', server.includes('/api/dashboard/research')
    && server.includes('/api/dashboard/trading') && server.includes('requireAuth')],
  ['no lifecycle-wide tabs or promotion panel', !/id="lifecycle"|renderLifecycle|promotion panel|final_holdout/i.test(html)],
  ['Trading has an honest empty state, research CTA and non-operational template', html.includes('No Active Strategies')
    && html.includes('Go to Research →') && html.includes('function renderTrading')
     && html.includes('<h2>Example Strategy Component</h2>') && html.includes('TEMPLATE')
     && html.includes('Illustrative component only') && html.includes('Verified historical series unavailable')
     && html.includes('Unavailable: no verified return series') && html.includes('Unavailable: no verified capital value')
    && html.includes('Unavailable: no verified return value') && html.includes('Awaiting promotion')
    && html.includes('No verified ${esc(stage)} data is available')
    && !html.includes('renderDashboard') && !html.includes('dashboard-grid')],
  ['Trading tiles use verified lane count and clearly unavailable financial values',
    html.includes('["Strategies",String(count)')
    && html.includes('["Capital","—","Unavailable: no verified capital value"]')
    && html.includes('["Total Return","—","Unavailable: no verified return value"]')
    && html.includes('count?"Status unavailable":"Awaiting promotion"')
    && html.includes('Go to Research →') && !/\$0|READY/.test(html)],
  ['research presents only ordinary Annual return and concise recent rows', researchRenderer.includes('pct(c.annual_return)')
    && researchRenderer.includes('Standard compounded annual growth')
    && researchRenderer.includes('<th>Annual return</th>')
    && researchRenderer.includes('experimentDate(r.experiment_id)')
    && !researchRenderer.includes('score_label') && !researchRenderer.includes('pct(c.score)')
    && !researchRenderer.includes('pct(r.score)') && !/EXCESS Annual return|Excess Annual return|Best Score/.test(researchRenderer)],
  ['champion keeps risk context and audit identity secondary', researchRenderer.includes('<strong>Sharpe</strong>')
    && researchRenderer.includes('<strong>Max Drawdown</strong>')
    && researchRenderer.includes('Champion audit identity') && researchRenderer.includes('Candidate SHA-256')
    && !researchRenderer.includes('candidate_identity') && !researchRenderer.includes('Legacy rows')],
  ['historical charts use concise labels without objective-score language', html.includes('function chart(data){')
    && html.includes('Verified historical equity')
    && html.includes('The chart uses verified historical marks through the development cutoff.')
    && !html.includes('Objective score is separate')
    && researchRenderer.includes('${chart(data.chart||{})}')
    && html.includes("data.replay?'Five-year historical replay':'Verified historical equity'")
    && html.includes('point.date<=cutoff')],
  ['four summary tiles show standard Annual return', (researchRenderer.match(/class="tile"/g) || []).length === 4
    && html.includes('research-heading') && researchRenderer.includes('pct(c.annual_return)')
    && !researchRenderer.includes('pct(c.score)')],
  ['chart uses actual equity values with grid and value labels', html.includes('stroke="#22293a"')
    && html.includes('money(value)')
    && html.includes('equities=points.map(point=>equityNumber(point.equity))')
    && html.includes('const marks=equities.filter(value=>value!==null)')
    && html.includes('y(equities[i])')],
  ['chart x-axis endpoints use the first and last actual point dates', html.includes('${esc(points[0].date)}')
    && html.includes('${esc(points[points.length-1].date)}')],
  ['chart parses numeric and strict ASCII decimal/exponent-string marks safely', html.includes('const equityNumber=value=>')
    && html.includes('Number.isFinite(number)&&number>0')
    && html.includes('[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+')
    && html.includes('(?![\\s\\S])')
    && html.includes('(?:[eE][+-]?[0-9]+)?')
    && html.includes('Math.min(...marks)') && html.includes('y(equities[i])')],
  ['chart preserves missing-mark gaps without interpolation or smoothing', html.includes('valid=equities.map(value=>value!==null)')
    && html.includes('else if(segment.length){segments.push(segment);segment=[]}')
    && html.includes('if(segment.length)segments.push(segment)')
    && html.includes('segments.filter(segment=>segment.length>1)')
    && html.includes('missing mark${data.gap_count===1?\'\':\'s\'} shown as gaps; no data is invented or smoothed.')],
  ['five-year replay is a distinct cutoff-filtered historical chart', html.includes('function fiveYearReplay')
    && html.includes('point.date<=championCutoff') && html.includes('point.date<=cutoff')
    && html.includes('fiveYearReplay(data.chart,c.development_end)')
    && html.includes('Historical modeled results are not guarantees or live performance')
     && html.includes('@media(max-width:620px){#app')
     && html.includes('.tiles{grid-template-columns:repeat(2,minmax(0,1fr))')
    && html.includes('.example-grid{display:grid')],
   ['template metrics remain placeholders, with no fabricated performance', html.includes('no data plotted')
     && html.includes('Unavailable: no verified return series')
     && html.includes('Unavailable: no verified risk metric')
     && html.includes('Unavailable: no verified drawdown')
      && html.includes('Unavailable: no verified equity')
     && html.includes('No strategy, order activity, or performance claims')
    && !/dashboard-grid|dashboard-panel|renderDashboard/.test(html)],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
