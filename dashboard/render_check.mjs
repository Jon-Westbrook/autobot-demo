/**
 * Render every dashboard stage against the live payload, in a stubbed DOM.
 *
 * `node dashboard/render_check.mjs` from the repository root. It reads the script out
 * of index.html so the two cannot drift, gets a real payload from status.py, and
 * renders all five lifecycle stages. A template bug in a tab nobody clicked during
 * review fails here instead of in the browser.
 *
 * It also asserts the one rule the UI has to keep: the research view never prints a
 * final-holdout performance figure, and the Historical view is where that lives.
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const nodes = {};
const makeNode = id => (nodes[id] = {
  id, innerHTML: '', textContent: '', style: {}, value: '', disabled: false,
  offsetWidth: 220, offsetHeight: 110,
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {},
});
globalThis.document = {
  getElementById: id => nodes[id] || makeNode(id),
  querySelector: () => makeNode('refresh-btn'),
  createElement: () => makeNode('created'),
  body: { appendChild() {} },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { reload() {} };
globalThis.fetch = async () => { throw new Error('render_check does not use the network'); };
globalThis.setInterval = () => 0;
globalThis.window = { innerWidth: 1400, innerHeight: 900 };

const html = readFileSync(join(here, 'index.html'), 'utf8');
const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
const payload = JSON.parse(
  execFileSync('python3', [join(root, 'status.py'), '--json'], { maxBuffer: 64 * 1024 * 1024 }));

const exported = 'globalThis.__api = {renderOverview, renderLifecycle, renderFoundation,'
  + ' renderStage, setStage, set DASHBOARD(value) { DASHBOARD = value; }};';
const api = (await import('data:text/javascript;base64,'
  + Buffer.from(`${script}\n${exported}`).toString('base64')), globalThis.__api);
api.DASHBOARD = payload;

const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
};

api.renderOverview(payload);
api.renderLifecycle(payload);
api.renderFoundation(payload);
check('overview rendered', nodes['overview'].innerHTML.length > 400);
check('lifecycle rendered', nodes['lifecycle'].innerHTML.length > 300);
check('foundation rendered', nodes['foundation'].innerHTML.length > 400);
for (const { key, label } of payload.lifecycle) {
  check(`lifecycle nav names ${key}`, nodes['lifecycle'].innerHTML.includes(label));
}

for (const { key } of payload.lifecycle) {
  api.setStage(key);
  const view = nodes['stage-view'].innerHTML;
  check(`${key} renders`, view.length > 200);
  check(`${key} has no "undefined"`, !view.includes('undefined'));
  check(`${key} has no "NaN"`, !view.includes('NaN'));
  console.log(`${key.padEnd(11)} ${String(view.length).padStart(7)} chars`);
}

api.setStage('research');
const research = nodes['stage-view'].innerHTML;
const holdout = (payload.promotion || {}).final_holdout || {};
if (holdout.excess_annual_return !== null && holdout.excess_annual_return !== undefined) {
  const figure = (holdout.excess_annual_return * 100).toFixed(2);
  check(`research view hides the holdout figure ${figure}%`, !research.includes(figure));
}
check('research view names the reserved sessions', research.includes('reserved as the final holdout'));

if ((payload.promotion || {}).available) {
  api.setStage('historical');
  const historical = nodes['stage-view'].innerHTML;
  check('historical shows the validation report', historical.includes('PROMOTION VALIDATION'));
  check('historical shows the holdout panel', historical.includes('Final holdout'));
}

if (failures.length) {
  console.error('\nFAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nall stage views render; holdout stays out of the research view');
