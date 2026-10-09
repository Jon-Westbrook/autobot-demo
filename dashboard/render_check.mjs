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
    && html.includes('Array.isArray(data.recent)?data.recent:[]')
    && html.includes('No verified recent experiments.') && html.includes('Current champion')],
  ['full-history in-sample metrics and objective score windows are explicit', html.includes('Full-history in-sample Annual return')
    && html.includes('Full-history in-sample Sharpe')
    && html.includes('Full-history in-sample max drawdown')
    && html.includes('full-history in-sample Annual return, Sharpe, and maximum drawdown metrics summarize the displayed full development-history window')
    && html.includes('Objective score is separate and uses ${esc(data.score_label)}')
    && html.includes('final verified chart point')
    && !html.includes('displayed Annual return, Sharpe, and maximum drawdown are development-window metrics')],
  ['four summary tiles with research heading and percentage score', (html.match(/class="tile"/g) || []).length === 4
    && html.includes('research-heading') && html.includes('pct(c.score)')],
  ['chart uses actual equity values with grid and value labels', html.includes('stroke="#22293a"')
    && html.includes('money(value)') && html.includes('typeof x.equity===\'number\'')],
  ['no sample/archive/demo interface reference', !/archive|fixture|illustrative/i.test(html + server)],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
