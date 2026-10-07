/** Static UX/API guardrails for the two-route dashboard. Run with node dashboard/render_check.mjs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const server = readFileSync(join(here, 'server.js'), 'utf8');
const checks = [
  ['shared brand header', /class="topbar"[\s\S]*?AUTOBOT[\s\S]*?class="nav"/.test(html)],
  ['Research and Trading text navigation', /data-route="research">Research/.test(html)
    && /data-route="trading">Trading/.test(html)],
  ['direct route/history support', html.includes("history.pushState") && html.includes("popstate")
    && server.includes('"/research"') && server.includes('"/trading"')],
  ['separate authenticated data endpoints', server.includes('/api/dashboard/research')
    && server.includes('/api/dashboard/trading') && server.includes('requireAuth')],
  ['no lifecycle-wide tabs or promotion panel', !/id="lifecycle"|renderLifecycle|promotion|final_holdout/i.test(html)],
  ['Trading has an honest empty state and no template activity claims', html.includes('No promoted strategy lanes')
    && html.includes('function renderTrading') && !html.includes('function laneTab')
    && !html.includes('Modeled state is reported')],
  ['research score label and recent fields', html.includes('score_label')
    && html.includes('development_max_drawdown') && html.includes('Current champion')],
  ['metric windows and chart provenance are explicit', html.includes('Full-history Annual return, full-history Sharpe, and full-history maximum drawdown')
    && html.includes('Verified development history')
    && html.includes('data.score_label')
    && html.includes('final verified chart point')],
  ['four summary tiles with research heading and percentage score', (html.match(/class="tile"/g) || []).length === 4
    && html.includes('research-heading') && html.includes('pct(c.score)')],
  ['chart uses actual equity values with grid and value labels', html.includes('stroke="#22293a"')
    && html.includes('money(value)') && html.includes('typeof x.equity===\'number\'')],
  ['no sample/archive/demo interface reference', !/archive|fixture|illustrative/i.test(html + server)],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
