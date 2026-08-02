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
