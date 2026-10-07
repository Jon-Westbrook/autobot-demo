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
const makeNode = id => {
  const classes = new Set();
  return nodes[id] = {
    id, innerHTML: '', textContent: '', style: {}, value: '', disabled: false,
    offsetWidth: 220, offsetHeight: 110,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, force) => {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
        return classes.has(name);
      },
      contains: name => classes.has(name),
    },
    addEventListener() {},
  };
};
const refreshButton = makeNode('refresh-button');
const archiveLink = makeNode('archive-link');
archiveLink.textContent = 'ARCHIVED Lane 4';
let lastQuerySelector;
globalThis.document = {
  getElementById: id => nodes[id] || makeNode(id),
  querySelector: selector => {
    lastQuerySelector = selector;
    return selector === 'button.refresh-btn' ? refreshButton : archiveLink;
  },
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

api.setLoading(true);
check('loading targets the refresh button selector', lastQuerySelector === 'button.refresh-btn');
check('loading disables and relabels REFRESH', refreshButton.disabled
  && refreshButton.textContent === 'LOADING...');
check('loading leaves the archive link alone', !archiveLink.disabled
  && archiveLink.textContent === 'ARCHIVED Lane 4');
api.setLoading(false);
check('loading restores the refresh button label', refreshButton.textContent === 'REFRESH');
check('loading re-enables the refresh button', !refreshButton.disabled);
check('loading removes the refresh button class', !refreshButton.classList.contains('loading-pulse'));
check('loading leaves the archive link label unchanged', archiveLink.textContent === 'ARCHIVED Lane 4');

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
  // Match the rendered percentage, not a bare digit run: chart path coordinates are full
  // of numbers, and "41.04" once matched "L641.04,105.21" with nothing leaked at all.
  const figure = `${(holdout.excess_annual_return * 100).toFixed(2)}%`;
  check(`research view hides the holdout figure ${figure}`, !research.includes(figure));
  // The structural version of the same claim, independent of how anything renders: no
  // value anywhere in the research payload equals a holdout figure.
  // Only figures measured *on* the reserved tail. `final_holdout.development_*` are the
  // development numbers the report carries for contrast, and the research view is of
  // course allowed to show those.
  const holdoutValues = ['excess_annual_return', 'excess_annual_return_decay', 'max_drawdown']
    .map(key => holdout[key]).filter(value => typeof value === 'number');
  const leaked = [];
  const walk = (node, trail) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${trail}[${i}]`)); return; }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (/holdout/i.test(k) && typeof v === 'number') leaked.push(`${trail}.${k}`);
        walk(v, `${trail}.${k}`);
      }
      return;
    }
    if (typeof node === 'number' && holdoutValues.some(v => v !== 0 && Math.abs(v - node) < 1e-12)) {
      leaked.push(`${trail}=${node}`);
    }
  };
  walk(payload.research, 'research');
  // `final_holdout_reserved_sessions` is a count of what is withheld, not a figure from it.
  const real = leaked.filter(item => !item.includes('final_holdout_reserved_sessions'));
  check(`research payload carries no holdout figure${real.length ? ': ' + real.slice(0, 3) : ''}`,
        real.length === 0);
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
