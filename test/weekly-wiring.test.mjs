// test/weekly-wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('npm run build builds the weekly page last', () => {
  assert.match(pkg.scripts.build, /weekly\/build\.mjs/);
  assert.ok(pkg.scripts.build.indexOf('site/build.mjs') < pkg.scripts.build.indexOf('weekly/build.mjs'),
    'weekly must build after site so dist/ layout is settled');
});

test('a snapshot script exists for the local job', () =>
  assert.match(pkg.scripts.snapshot, /weekly\/snapshot\.mjs/));

test('the build script never invokes snapshot.mjs — CI must not mutate history', () =>
  assert.doesNotMatch(pkg.scripts.build, /snapshot/));

test('the landing page links to the weekly page', () => {
  const tpl = readFileSync(new URL('../site/template.html', import.meta.url), 'utf8');
  assert.match(tpl, /weekly\//);
});

// The weekly page is written for a project manager, so the piece-tester-web
// caveat came off it. It is an engineering limitation, not page copy — losing it
// entirely would let someone read `prsMerged` as "pieces tested", so the repo
// has to keep saying what those numbers are and what it would take to fix them.
test('the piece-tester-web stats-endpoint limitation stays on the record in the README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /piece-tester-web/);
  assert.match(readme, /build progress/i);
  assert.match(readme, /stats endpoint/i);
});

// The landing scan's credit is archived for good by the Saturday job, so there
// an incomplete scan must fail the run (and the trap retry it tomorrow); CI's
// daily rebuild keeps it best-effort. See landingScanVerdict in lib/discover.mjs.
test('the Saturday job requires a complete landing scan; CI does not', () => {
  const sh = readFileSync(new URL('../refresh-weekly.sh', import.meta.url), 'utf8');
  const at = sh.search(/^export LANDINGS_REQUIRED=1$/m);
  assert.ok(at >= 0, 'refresh-weekly.sh must export LANDINGS_REQUIRED=1');
  assert.ok(at < sh.search(/^npm run fetch$/m), 'and before it runs the fetch');
  const fetch = readFileSync(new URL('../scripts/fetch-pr-states.mjs', import.meta.url), 'utf8');
  assert.match(fetch, /process\.env\.LANDINGS_REQUIRED === '1'/);
  const yml = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(yml, /LANDINGS_REQUIRED/, 'CI stays best-effort');
});
