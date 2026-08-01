// test/weekly-render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../weekly/build.mjs';

const snap = (week, over = {}) => ({
  week, start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] },
  decisions: [], ...over,
});

function render(weeks) {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data/weeks.json'), JSON.stringify({ weeks }));
  const outDir = join(dir, 'out');
  const { html } = buildAll({ archiveDir: join(dir, 'data'), outDir });
  return { html, outDir };
}

test('renders an HTML document', () => {
  const { html } = render([snap('2026-W31')]);
  assert.match(html, /<!doctype html>/i);
});

test('inlines the theme — no unresolved markers survive', () => {
  const { html } = render([snap('2026-W31')]);
  assert.doesNotMatch(html, /__THEME__/);
  assert.doesNotMatch(html, /__DATA__/);
});

test('embeds every week so switching needs no network', () => {
  const { html } = render([snap('2026-W30'), snap('2026-W31')]);
  assert.match(html, /2026-W30/);
  assert.match(html, /2026-W31/);
});

test('writes summary.json for the selected week', () => {
  const { outDir } = render([snap('2026-W31')]);
  const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
  assert.equal(summary.week, '2026-W31');
  assert.equal(summary.tiles.length, 4);
});

test('an empty archive renders a placeholder rather than throwing', () => {
  const { html } = render([]);
  assert.match(html, /No weeks recorded yet/i);
});

// The placeholder string above is a static literal in the template, so it
// matches on every render. Assert the embedded payload actually signals empty,
// which is what drives the client-side fallback.
test('an empty archive embeds a null default with no views', () => {
  const { html } = render([]);
  const payload = JSON.parse(/const ARCHIVE = (.*?);\n/s.exec(html)[1]);
  assert.equal(payload.default, null);
  assert.deepEqual(payload.views, {});
});

test('a populated archive embeds the newest week as the default', () => {
  const { html } = render([snap('2026-W30'), snap('2026-W31')]);
  const payload = JSON.parse(/const ARCHIVE = (.*?);\n/s.exec(html)[1]);
  assert.equal(payload.default, '2026-W31');
  assert.deepEqual(Object.keys(payload.views).sort(), ['2026-W30', '2026-W31']);
});

test('a no-data tile renders its reason text', () => {
  const { html } = render([snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear refresh pending' } })]);
  assert.match(html, /Linear refresh pending/);
});

test('decisions render when present', () => {
  const { html } = render([snap('2026-W31', { decisions: ['6 pieces await a cloud release'] })]);
  assert.match(html, /6 pieces await a cloud release/);
});

test('script-closing sequences in data cannot break out of the script tag', () => {
  const { html } = render([snap('2026-W31', { decisions: ['</script><img onerror=x>'] })]);
  assert.doesNotMatch(html, /<\/script><img/);
});
