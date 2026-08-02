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
  assert.match(dom, /Pieces Team · Week 31/);
  assert.match(dom, /class="tile"/);
});

// ── hierarchy ──────────────────────────────────────────────────────────────
// A 30-second skim: verdict first, then the four numbers, then what needs a
// human, then detail. The rosters are ~80% of the page's length and belong at
// the bottom, under everything that is actually news.

const at = (dom, needle) => dom.indexOf(needle);

test('the verdict is the lead element, above the tiles', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /class="verdict"/);
  assert.match(dom, /Output schemas are merged on 15 of 756 pieces; 9 are live on cloud\./);
  assert.ok(at(dom, 'class="verdict"') < at(dom, 'class="tiles"'), 'verdict must precede the tiles');
});

test('the verdict names a degraded workstream instead of going silent', () =>
  assert.match(renderDom([snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear refresh pending' } })]),
    /Ticket data unavailable\./));

test('the rosters sit at the bottom, below the shipped and per-person detail', () => {
  const dom = renderDom([withRosters()]);
  assert.ok(at(dom, 'Per person') < at(dom, 'outputSchema — 3 tracked'), 'rosters must follow per-person');
  assert.ok(at(dom, 'class="tiles"') < at(dom, 'outputSchema — 3 tracked'), 'rosters must follow the tiles');
  assert.ok(at(dom, 'outputSchema — 3 tracked') < at(dom, '<footer'), 'rosters sit above the footer');
});

test('the header keeps the week, the date range and real nav controls', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /<h1>Pieces Team · Week 31<\/h1>/);
  assert.match(dom, /Jul 25–31/);
  assert.match(dom, /<select id="pick"/);
  assert.match(dom, /<button id="prev"/);
  assert.match(dom, /<button id="next"/);
});

test('the quiet caption carries the window, the build date and nothing loud', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /7 days ending Friday/);
  assert.match(dom, /built 2026-08-01/);
});

// It used to be stamped on all four tiles. Once, in the caption, is enough.
test('"no prior week" is said exactly once, in the caption', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.equal([...dom.matchAll(/no prior week/g)].length, 1);
  assert.ok(at(dom, 'no prior week') < at(dom, 'class="tiles"'));
});

test('no delta badge is rendered when there is nothing to compare against', () =>
  assert.doesNotMatch(renderDom([snap('2026-W31')]), /class="delta/));

test('a real delta still renders its badge on the tile', () => {
  const dom = renderDom([
    snap('2026-W30', { outputSchema: { status: 'ok', live: 7, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 } }),
    snap('2026-W31'),
  ]);
  assert.match(dom, /class="delta up"/);
  assert.match(dom, /\+2 vs prior week/);
  assert.doesNotMatch(dom, /no prior week/);
});

// ── needs you ──────────────────────────────────────────────────────────────

test('the needs-you band renders genuine asks with a marker', () => {
  const dom = renderDom([snap('2026-W31', { decisions: ['6 pieces merged but not live — needs a cloud release'] })]);
  assert.match(dom, /Needs you/);
  assert.match(dom, /→<\/span> 6 pieces merged but not live — needs a cloud release/);
});

test('the band does not render at all when nothing is being asked', () =>
  assert.doesNotMatch(renderDom([snap('2026-W31', { decisions: [] })]), /Needs you/));

// The filter lives in the view, so a week snapshotted before that rule existed
// renders clean rather than being reprinted with its old noise.
test('a historical snapshot of pure status renders no band', () => {
  const dom = renderDom([snap('2026-W31', { decisions: [
    '8 outputSchema PRs awaiting review',
    '30 AI-actions blockers still open',
    'tickets: no data — Linear refresh pending',
  ] })]);
  assert.doesNotMatch(dom, /Needs you/);
  assert.doesNotMatch(dom, /awaiting review/);
});

// ── grammar ────────────────────────────────────────────────────────────────

test('a count of one never renders a plural noun', () => {
  const dom = renderDom([snap('2026-W31', {
    testing: { status: 'ok', prsMerged: 1, commits: 1, shipped: [] },
    outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
      roster: [{ name: 'Human Input', actions: 1, triggers: 0, stage: 'review', tier: 'P2' }] },
  })]);
  assert.match(dom, /PR shipped/);
  assert.doesNotMatch(dom, /PRs shipped/);
  assert.match(dom, /1 commit</);
  assert.match(dom, /<td class="n">1 action<\/td>/);
});

test('counts above one keep the plural', () => {
  const dom = renderDom([snap('2026-W31', { testing: { status: 'ok', prsMerged: 3, commits: 2, shipped: [] } })]);
  assert.match(dom, /PRs shipped/);
  assert.match(dom, /2 commits</);
});

// ── the piece-testing caveat ───────────────────────────────────────────────
// Too long for a compact tile, too important to lose: it moved to the footer.

test('the build-progress caveat survives in the footer', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /piece health numbers need a stats endpoint/);
  assert.ok(at(dom, 'piece health numbers') > at(dom, 'class="tiles"'));
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

// Reference detail, not headline: every group starts closed so the section is
// a two-line index at the foot of the page rather than 51 rows of roster.
test('no roster group is open by default', () => {
  const dom = renderDom([withRosters()]);
  const tags = [...dom.matchAll(/<details[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags.length, 3);           // live + merged-not-live + AI merged
  for (const tag of tags) assert.doesNotMatch(tag, /\sopen/);
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
  assert.match(dom, /of 756 have AI actions/);
  assert.match(dom, /28 tracked · 24 PRs open/);
});

test('a snapshot without a catalog keeps the wording of the week it measured', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /of 28 merged/);
  assert.doesNotMatch(dom, /of 756 have AI actions/);   // a denominator it never measured
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

// The caption states it once at the top; repeating it per roster is the noise
// this redesign removed.
test('with no prior week the done line carries the total alone', () => {
  const dom = renderDom([osWeek('2026-W31', CURRENT)]);
  assert.match(dom, /3 done in total</);
  assert.doesNotMatch(dom, /this week: /);
  assert.equal([...dom.matchAll(/no prior week/g)].length, 1);   // the caption only
});

test('a done line renders for every roster section', () => {
  const dom = renderDom([withRosters()]);
  assert.equal([...dom.matchAll(/done in total/g)].length, 2);
  assert.match(dom, /1 done in total</);   // AI-actions
});

test('piece names in the done line are HTML-escaped', () => {
  const evil = [{ name: '<img onerror=x>', actions: 1, triggers: 0, stage: 'live', tier: 'P1' }];
  const dom = renderDom([osWeek('2026-W30', [{ ...evil[0], stage: 'review' }]), osWeek('2026-W31', evil)]);
  assert.match(dom, /1 done in total · 1 this week: &lt;img onerror=x&gt;/);
  assert.doesNotMatch(dom, /<img onerror=x>/);
});
