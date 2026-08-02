// test/weekly-render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
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

// The page's markup only exists once its own script has run, so asserting on
// the raw file would only ever prove the JSON payload contains a string. Run
// the template's scripts against a DOM-lite stub and assert on the HTML the
// page actually produces — that is what catches missing escaping.
function renderDom(weeks, hash = '') {
  const { html } = render(weeks);
  const node = () => ({ innerHTML: '', disabled: false, focus() {} });
  const nodes = { app: node(), pick: node(), prev: node(), next: node() };
  const sandbox = createContext({
    document: { getElementById: (id) => nodes[id] ?? null, activeElement: null },
    location: { hash },
    addEventListener: () => {},
  });
  for (const [, src] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInContext(src, sandbox);
  return nodes.app.innerHTML;
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

// ── rosters ────────────────────────────────────────────────────────────────

const withRosters = (over = {}) => snap('2026-W31', {
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
    roster: [
      { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2' },
      { name: 'Notion', actions: 12, triggers: 2, stage: 'live', tier: 'P1' },
      { name: 'Slack', actions: 28, triggers: 4, stage: 'merged-not-live', tier: 'P1' },
    ] },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
    roster: [{ name: 'google-sheets', actions: 37, stage: 'merged' }] },
  ...over,
});

// Guards the harness itself: if the sandbox silently rendered nothing, every
// `doesNotMatch` below would pass for the wrong reason.
test('the DOM-lite harness actually renders the page body', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /Pieces Team — Weekly Progress/);
  assert.match(dom, /class="tile"/);
});

test('the roster renders a section per workstream with its tracked total', () => {
  const dom = renderDom([withRosters()]);
  assert.match(dom, /outputSchema — 3 tracked/);
  assert.match(dom, /AI-actions — 1 tracked/);
});

test('the roster renders piece names and counts with the workstream unit', () => {
  const dom = renderDom([withRosters()]);
  assert.match(dom, /Live on cloud \(2\)/);
  assert.match(dom, /Merged, awaiting release \(1\)/);
  assert.match(dom, /ClickUp/);
  assert.match(dom, /31 actions/);
  assert.match(dom, /google-sheets/);
  assert.match(dom, /37 AI actions/);
});

test('counts sit in a right-aligned tabular-nums cell', () =>
  assert.match(renderDom([withRosters()]), /<td class="n">31 actions<\/td>/));

test('the first group of each roster is open, the rest collapsed', () => {
  const dom = renderDom([withRosters()]);
  const tags = [...dom.matchAll(/<details[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags.length, 3);           // live + merged-not-live + AI merged
  assert.match(tags[0], /\sopen/);
  assert.doesNotMatch(tags[1], /\sopen/);
  assert.match(tags[2], /\sopen/);        // first group of the second roster
});

// Real elements, not divs-plus-JS: <details>/<summary> are keyboard-accessible
// for free and lose that the moment they are rebuilt.
test('groups are real details/summary elements', () => {
  const dom = renderDom([withRosters()]);
  assert.match(dom, /<summary>Live on cloud \(2\)<\/summary>/);
});

test('a snapshot with no roster renders no roster section', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.doesNotMatch(dom, / tracked<\/h2>/);
  assert.doesNotMatch(dom, /<details/);
});

test('an empty roster array renders no roster section', () => {
  const dom = renderDom([snap('2026-W31', {
    outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster: [] },
  })]);
  assert.doesNotMatch(dom, / tracked<\/h2>/);
  assert.doesNotMatch(dom, /<details/);
});

test('piece names are HTML-escaped', () => {
  const dom = renderDom([withRosters({
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
      roster: [{ name: '<img onerror=x>', actions: 1, stage: 'merged' }] },
  })]);
  assert.match(dom, /&lt;img onerror=x&gt;/);
  assert.doesNotMatch(dom, /<img onerror=x>/);
});

// ── the catalog denominator ────────────────────────────────────────────────

test('the AI-actions tile divides by the catalog, not by the tracked count', () => {
  const dom = renderDom([snap('2026-W31', {
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2,
                 totalPieces: 28, blockersOpen: 30, catalogPieces: 756 },
  })]);
  assert.match(dom, /of 756 pieces have AI actions/);
  assert.match(dom, /28 tracked · 24 PRs open · 30 blockers/);
});

test('a snapshot without a catalog keeps the wording of the week it measured', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /of 28 merged/);
  assert.doesNotMatch(dom, /pieces have AI actions/);
});

// ── done lines ─────────────────────────────────────────────────────────────
// One line per roster section: how much is merged in total, and what crossed
// the line during this week. Never a bare list of everything done — see the
// hasPrior rule in view.mjs.

const osWeek = (week, roster) => snap(week, {
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster },
});

const PRIOR = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2' },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'review', tier: 'P1' },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'review', tier: 'P1' },
];

const CURRENT = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2' },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'live', tier: 'P1' },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'merged-not-live', tier: 'P1' },
];

test('the done line names the total and what landed this week', () => {
  const dom = renderDom([osWeek('2026-W30', PRIOR), osWeek('2026-W31', CURRENT)]);
  assert.match(dom, /3 done in total · 2 this week: Notion, Slack/);
});

test('a week where nothing crossed the line says so explicitly', () => {
  const dom = renderDom([osWeek('2026-W30', CURRENT), osWeek('2026-W31', CURRENT)]);
  assert.match(dom, /3 done in total · none this week/);
  assert.doesNotMatch(dom, /this week: /);
});

test('with no prior week the line says there is nothing to compare against', () => {
  const dom = renderDom([osWeek('2026-W31', CURRENT)]);
  assert.match(dom, /3 done in total · no prior week to compare/);
  assert.doesNotMatch(dom, /this week: /);
});

test('a done line renders for every roster section', () => {
  const dom = renderDom([withRosters()]);
  assert.equal([...dom.matchAll(/done in total/g)].length, 2);
  assert.match(dom, /1 done in total · no prior week to compare/);   // AI-actions
});

test('piece names in the done line are HTML-escaped', () => {
  const evil = [{ name: '<img onerror=x>', actions: 1, triggers: 0, stage: 'live', tier: 'P1' }];
  const dom = renderDom([osWeek('2026-W30', [{ ...evil[0], stage: 'review' }]), osWeek('2026-W31', evil)]);
  assert.match(dom, /1 done in total · 1 this week: &lt;img onerror=x&gt;/);
  assert.doesNotMatch(dom, /<img onerror=x>/);
});
