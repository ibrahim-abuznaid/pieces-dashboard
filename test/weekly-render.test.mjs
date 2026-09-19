// test/weekly-render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { buildAll } from '../weekly/build.mjs';
import { prTitle, STRIP_CAP } from '../weekly/lib/view.mjs';
// The degraded-box tests below assert against the reasons the collectors really
// produce rather than a retyped copy of them.
import { collectOutputSchema } from '../weekly/collect/output-schema.mjs';
import { collectAiActions } from '../weekly/collect/ai-actions.mjs';
import { collectTesting } from '../weekly/collect/testing.mjs';
import { collectTickets } from '../weekly/collect/tickets.mjs';

const snap = (week, over = {}) => ({
  week, start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  uiImprovements: { status: 'ok', merged: 5, live: 5, review: 2, assigned: 0, totalPieces: 765 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] },
  shipping: { status: 'ok', prsMerged: 7, piecePrs: 5,
              byPerson: { kishan: 3, sanket: 4, odai: 0, talal: 0 },
              reviews: 21, reviewsByPerson: { kishan: 12, sanket: 9, odai: 0, talal: 0 },
              reviewsApprox: true, shipped: [{ number: 9, title: 'feat(slack): x', url: 'https://g/9' }] },
  decisions: [], ...over,
});

function render(weeks, { notes } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data/weeks.json'), JSON.stringify({ weeks }));
  if (notes) writeFileSync(join(dir, 'data/notes.json'), JSON.stringify(notes));
  const outDir = join(dir, 'out');
  const { html } = buildAll({ archiveDir: join(dir, 'data'), outDir });
  return { html, outDir };
}

// The page's markup only exists once its own script has run, so asserting on
// the raw file would only ever prove the JSON payload contains a string. Run
// the template's scripts against a DOM-lite stub and assert on the HTML the
// page actually produces — that is what catches missing escaping.
//
// `mount` keeps the sandbox, so the page's own nav wiring and focus handling can
// be driven the way a keyboard user drives them rather than read as markup.
function mount(weeks, hash = '', opts = {}) {
  const { html } = render(weeks, opts);
  const focused = [];
  const node = (id) => ({ id, innerHTML: '', disabled: false, focus() { focused.push(id); } });
  const nodes = { app: node('app'), pick: node('pick'), prev: node('prev'), next: node('next') };
  const listeners = [];
  const doc = { getElementById: (id) => nodes[id] ?? null, activeElement: null };
  const sandbox = createContext({
    document: doc,
    location: { hash },
    addEventListener: (type, fn) => listeners.push([type, fn]),
  });
  for (const [, src] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInContext(src, sandbox);
  const go = (to) => {
    sandbox.location.hash = to;
    for (const [type, fn] of listeners) if (type === 'hashchange') fn();
  };
  return { nodes, doc, focused, go, hash: () => sandbox.location.hash, sandbox };
}

const renderDom = (weeks, hash = '', opts = {}) => mount(weeks, hash, opts).nodes.app.innerHTML;

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
  assert.equal(summary.tiles.length, 7);
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

// The box explains its own em dash. In the page's words, not the collector's —
// see 'no collector diagnostic reaches the page' below.
test('a no-data tile says why it has no number', () => {
  const { html } = render([snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear refresh pending' } })]);
  assert.match(html, /No data/);
  assert.match(html, /not measured this week/);
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
  uiImprovements: { status: 'ok', merged: 5, live: 5, review: 2, assigned: 0, totalPieces: 765,
    roster: [{ folder: 'whatsscale', name: 'whatsscale', displayName: 'WhatsScale', actions: 46, stage: 'live' }] },
  ...over,
});

// Guards the harness itself: if the sandbox silently rendered nothing, every
// `doesNotMatch` below would pass for the wrong reason.
test('the DOM-lite harness actually renders the page body', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /Pieces Team · Week 31/);
  assert.match(dom, /class="tile"/);
});

// ── what is on the page ────────────────────────────────────────────────────
// A project manager's page: the week and its nav, four numbers with the pieces
// behind them, and an ask when there is one. Nothing else — no lede restating
// the numbers, no sub-lines under them, no engineering caveat, no tables of
// per-piece detail to cross-reference against.

const at = (dom, needle) => dom.indexOf(needle);

test('the page is a header, seven boxes and nothing structural besides', () => {
  const dom = renderDom([withRosters()]);
  assert.equal([...dom.matchAll(/<div class="tile[ "]/g)].length, 7);
  assert.doesNotMatch(dom, /<section/, 'the roster and detail sections are gone');
  assert.doesNotMatch(dom, /<table|<tr|<td|<th/, 'nothing on this page is a table any more');
  assert.doesNotMatch(dom, /<details|<summary/, 'no collapsible per-piece detail');
  assert.ok(at(dom, '<header') < at(dom, 'class="tiles"'), 'the week leads the page');
  assert.ok(at(dom, 'class="tiles"') < at(dom, '<footer'), 'the boxes are the page body');
});

test('no lede restates the numbers as prose above the boxes', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.doesNotMatch(dom, /class="verdict"/);
  assert.doesNotMatch(dom, /Output schemas are merged/);
  assert.doesNotMatch(dom, /have AI actions\./);
});

// A degraded workstream is named in its own box — see 'a no-data box shows its
// reason' below — instead of in a sentence at the top of the page as well.
test('a degraded workstream is reported once, in its own box', () => {
  const dom = renderDom([snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear refresh pending' } })]);
  assert.doesNotMatch(dom, /Ticket data unavailable/);
  assert.equal([...dom.matchAll(/not measured this week/g)].length, 1);
});

test('the header keeps the week, the date range and real nav controls', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /<h1>Pieces Team · Week 31<\/h1>/);
  assert.match(dom, /Jul 25–31/);
  assert.match(dom, /<select id="pick"/);
  assert.match(dom, /<button id="prev"/);
  assert.match(dom, /<button id="next"/);
});

// The date range says which 7 days these are; spelling out the window definition
// is process explanation, which is what this page stopped carrying.
test('the caption is the build date, not an explanation of the window', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.doesNotMatch(dom, /7 days ending Friday/);
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

// ── moving between weeks ───────────────────────────────────────────────────
// The header is the only chrome left on the page, so its wiring is load-bearing:
// the newest week by default, the arrows and the picker driving the hash, and
// keyboard focus surviving a re-render. Nothing here is markup — it is the
// page's own handlers, called.

const TWO = [snap('2026-W30'), snap('2026-W31')];

test('the newest week is the default and the newest-end arrow is disabled', () => {
  const dom = renderDom(TWO);
  assert.match(dom, /Week 31/);
  assert.match(dom, /<button id="next" disabled/);
  assert.doesNotMatch(dom, /<button id="prev" disabled/);
});

test('the arrows and the picker move the selection through the hash', () => {
  const page = mount(TWO);
  page.nodes.prev.onclick();
  assert.equal(page.hash(), '2026-W30');
  page.go('#2026-W30');
  assert.match(page.nodes.app.innerHTML, /Week 30/);
  page.nodes.next.onclick();
  assert.equal(page.hash(), '2026-W31');
  page.nodes.pick.onchange({ target: { value: '2026-W30' } });
  assert.equal(page.hash(), '2026-W30');
});

test('keyboard focus survives the re-render a week change causes', () => {
  const page = mount(TWO);
  page.doc.activeElement = page.nodes.prev;
  page.go('#2026-W30');
  assert.deepEqual(page.focused, ['prev']);
});

// At the oldest week the button the user was on goes disabled, and focus on a
// disabled control is focus lost — it lands on the picker instead.
test('focus moves to the picker when the control it was on goes disabled', () => {
  const page = mount(TWO);
  page.doc.activeElement = page.nodes.prev;
  page.nodes.prev.disabled = true;
  page.go('#2026-W30');
  assert.deepEqual(page.focused, ['pick']);
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
  })]);
  assert.match(dom, /PR shipped/);
  assert.doesNotMatch(dom, /PRs shipped/);
});

test('counts above one keep the plural', () =>
  assert.match(renderDom([snap('2026-W31', { testing: { status: 'ok', prsMerged: 3, commits: 2, shipped: [] } })]),
    /PRs shipped/));

// ── no sub-lines ───────────────────────────────────────────────────────────
// Each box was a number and then a line of detail under it. The detail was for
// engineers; the per-person split is the one line management does read, so it is
// the only `.note` left on the page.

test('no box carries a sub-line under its number', () => {
  const dom = renderDom([withRosters()]);
  assert.doesNotMatch(dom, /live on cloud · /);
  // "in review" is the review PILL now — the number line, not a sub-line (see
  // the review-pill tests below). It was also the tail of the old outputSchema
  // sub-line, so this narrows to where a sub-line would put it rather than
  // banning the words: the ban was on the LINE, never on the phrase.
  assert.doesNotMatch(dom, /class="note">[^<]*in review/);
  assert.doesNotMatch(dom, /tracked · /);
  assert.doesNotMatch(dom, /blockers?</);
  assert.doesNotMatch(dom, /\d+ commits?</);
  // Three per-person lines (PRs, tickets, reviews) and the PR box's "N of them
  // touched a piece", which is the one note that earns its place: it splits the
  // headline rather than restating it.
  assert.equal([...dom.matchAll(/class="note"/g)].length, 4, 'only per-person lines and the piece split remain');
});

test('a box that did not report carries no per-person line', () => {
  const dom = renderDom([withRosters({
    tickets: { status: 'no-data', reason: 'Linear refresh pending' },
    shipping: { status: 'no-data', reason: 'GitHub data stale' },
  })]);
  assert.doesNotMatch(dom, /class="note"/);
});

// ── the piece-testing caveat ───────────────────────────────────────────────
// An engineering limitation, not page copy. It left the page for README.md —
// see weekly-wiring.test.mjs, which holds it to being on the record there.

test('the build-progress caveat is not on the page', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.doesNotMatch(dom, /stats endpoint/i);
  assert.doesNotMatch(dom, /piece health/i);
  assert.doesNotMatch(dom, /Build progress/i);
});

// ── a dark box, in words this reader can use ───────────────────────────────
// A collector's `reason` is written for whoever has to FIX the pipeline: it names
// the internal marker the tickets refresh writes, the JSON field that went
// missing, and the commands to re-run. Printing it verbatim put
// `NEEDS-LINEAR-REFRESH` on the one box that is dark in the week the site ships
// today — an internal field name and a process explanation, which is exactly what
// this slice took off every other part of the page.
//
// The reasons are not retyped here: they come from the collectors themselves, so
// one added or reworded later is covered without this file learning it. The
// verbatim strings stay on the record in the committed archive.

// esc() in the template, so a reason containing HTML specials cannot pass the
// "not on the page" check just by arriving escaped.
const escaped = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const collectorReasons = () => {
  const boom = () => { throw new Error("ENOENT: no such file, open 'dist/output-schema/summary.json'"); };
  const window = { start: '2026-07-25', end: '2026-07-31' };
  const stale = (name) => ({
    'linear.json': { stamp: '2026-07-20', events: [], recent: [] },
    'github.json': { stamp: '2026-07-20', mergedEvents: [], reviews: { weekly: [] } },
  }[name]);
  const tickets = (over) => collectTickets({ window, weekId: '2026-W31', linearRefreshPending: false, ...over });
  return [
    collectOutputSchema({ readJson: boom }),
    collectAiActions({ readJson: boom }),
    collectTesting({ window, gh: boom }),
    tickets({ linearRefreshPending: true }),
    tickets({ readJson: stale }),
    tickets({ readJson: boom }),
  ].map((ws) => ws.reason);
};

test('no collector diagnostic reaches the page, whatever it says', () => {
  const reasons = collectorReasons();
  assert.equal(reasons.filter(Boolean).length, reasons.length, 'a reasonless degrade would make this vacuous');
  for (const reason of reasons) {
    const dom = renderDom([snap('2026-W31', { tickets: { status: 'no-data', reason } })]);
    for (const form of [reason, escaped(reason)]) {
      assert.ok(!dom.includes(form), `the page prints the collector's own words: "${reason}"`);
    }
  }
});

test('a box with no number says so, however it came to be missing', () => {
  for (const reason of collectorReasons()) {
    const tile = tileOf(renderDom([snap('2026-W31', { tickets: { status: 'no-data', reason } })]), 'Tickets solved');
    assert.match(tile, /<b>No data<\/b> — not measured this week/);
    assert.match(tile, /class="big">—</, 'a missing number must still read as unknown, not as 0');
  }
});

// The reason recorded in the week the site is serving right now, verbatim.
test('the internal refresh marker in the shipping week is not on the page', () => {
  const dom = renderDom([snap('2026-W31', { tickets: { status: 'no-data',
    reason: 'Linear refresh pending — internal dashboard wrote NEEDS-LINEAR-REFRESH' } })]);
  assert.doesNotMatch(dom, /NEEDS-LINEAR-REFRESH/);
  assert.doesNotMatch(dom, /internal dashboard/);
  assert.match(dom, /No data<\/b> — not measured this week/);
});

// ── no roster sections ─────────────────────────────────────────────────────
// 51 stage-grouped rows at the foot of the page, holding the numbers the tiles
// already showed. Their content is the strip inside each box now.

test('the per-piece rosters are not rendered anywhere on the page', () => {
  const dom = renderDom([withRosters()]);
  assert.doesNotMatch(dom, / tracked/);
  assert.doesNotMatch(dom, /Live on cloud|Merged, awaiting release|In progress|PR open|Held/);
  assert.doesNotMatch(dom, /31 actions|37 AI actions/);
});

// A piece in review is not done, so it is not on a PM's page at all.
test('a piece that is not done is not named anywhere on the page', () => {
  const dom = renderDom([withRosters({
    outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
      roster: [{ name: 'Jira', actions: 9, triggers: 1, stage: 'review', tier: 'P3' }] },
  })]);
  assert.doesNotMatch(dom, /Jira/);
});

// The TABLE is gone. Two of its three columns came back as boxes of their own
// on 2026-09-19, so this no longer bans their names -- "PRs merged" and
// "Reviews given" are tile headings now. What it still bans is the table: the
// "Per person" heading, the Engineer column, and any <tr>/<td> on the page
// (asserted structurally above).
test('the per-person table is gone; its numbers came back as boxes', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.doesNotMatch(dom, /Per person/);
  assert.doesNotMatch(dom, /Engineer/);
  assert.match(dom, /Kishan 5 · Sanket 6/, 'the tickets line still reads as one line');
  assert.match(dom, />PRs merged</, 'PRs merged is a tile heading');
  assert.match(dom, />Reviews given</, 'reviews are a tile heading');
});

// The tickets table stays gone; what replaced it is a strip of linked CHIPS —
// id plus shortened title, each opening the ticket itself in Linear. Ticket
// ids and short titles on the public site are a deliberate policy decision
// (see README.md, "Public-data policy"): the ceiling moved because a list the
// reader cannot click through was the page's most-asked-for missing feature.
test('the shipped-this-week table is gone; linked ticket chips carry the list instead', () => {
  const dom = renderDom([snap('2026-W31', {
    tickets: { status: 'ok', total: 2, byPerson: { kishan: 2, sanket: 0 },
      shipped: [{ id: 'PIE-101', title: '[BUG] flow editor crash', assignee: 'kishan' }] },
  })]);
  assert.doesNotMatch(dom, /Shipped this week/);
  const tile = tileOf(dom, 'Tickets solved');
  assert.match(tile, /<a href="https:\/\/linear\.app\/activepieces\/issue\/PIE-101" target="_blank" rel="noopener">/);
  assert.match(tile, /<span class="tid">PIE-101<\/span>/);
  // The routing tag is stripped for display; the sentence survives.
  assert.deepEqual(chipNames(tile), ['Flow editor crash']);
  assert.doesNotMatch(tile, /\[BUG\]/);
});

// Both halves of a ticket chip pass through the same escaping as every other
// chip, and a hostile id never becomes an href at all.
test('a hostile ticket title is escaped and a hostile id gets no link', () => {
  const dom = renderDom([snap('2026-W31', {
    tickets: { status: 'ok', total: 2, byPerson: { kishan: 2, sanket: 0 },
      shipped: [
        { id: 'PIE-9', title: '<img src=x onerror=alert(1)>', assignee: 'kishan' },
        { id: '"><script>alert(1)</script>-1', title: 'evil id', assignee: 'kishan' },
      ] },
  })]);
  assert.doesNotMatch(dom, /<img src=x/);
  assert.doesNotMatch(dom, /<script>alert/);
  assert.match(dom, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(dom, /evil id/);
});

// ── the catalog denominator ────────────────────────────────────────────────

test('the AI-actions tile divides by the catalog, not by the tracked count', () => {
  const dom = renderDom([snap('2026-W31', {
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2,
                 totalPieces: 28, blockersOpen: 30, catalogPieces: 756 },
  })]);
  assert.match(dom, /of 756 have AI actions/);
  assert.doesNotMatch(dom, /28 tracked/);
});

test('a snapshot without a catalog keeps the wording of the week it measured', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.match(dom, /of 28 merged/);
  assert.doesNotMatch(dom, /of 756 have AI actions/);   // a denominator it never measured
});

// ── no done lines ──────────────────────────────────────────────────────────
// Each roster section used to print "3 done in total · 2 this week: Notion,
// Slack" — the same claim the box's strip now makes, in prose, below the fold.

const osWeek = (week, roster) => snap(week, {
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster },
});

const CURRENT = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2' },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'live', tier: 'P1' },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'merged-not-live', tier: 'P1' },
];

test('the page states each claim once — the strip, not a prose done line too', () => {
  const dom = renderDom([osWeek('2026-W31', CURRENT)]);
  assert.doesNotMatch(dom, /done in total/);
  assert.doesNotMatch(dom, /none this week/);
  assert.doesNotMatch(dom, /this week: /);
  assert.equal([...dom.matchAll(/Done in total/g)].length, 1, 'the strip label, once');
});

// ── the pieces strip ───────────────────────────────────────────────────────
// The pieces behind each number, rendered INSIDE the box that carries the
// number. Asserted against the tile's own slice of the DOM, because "on the
// page somewhere" is the exact failure this redesign exists to fix.

const LOGO = (slug) => `https://cdn.activepieces.com/pieces/${slug}.png`;

// Notion carries no logo: the catalog resolves per piece, and one unresolved
// logo must cost that one logo and nothing else.
const OS_LOGOS = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2', logo: LOGO('clickup') },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'merged-not-live', tier: 'P1', logo: LOGO('slack') },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'live', tier: 'P1', logo: null },
  { name: 'Jira', actions: 9, triggers: 1, stage: 'review', tier: 'P3', logo: LOGO('jira') },
];
const OS_LOGOS_PRIOR = OS_LOGOS.map((r) => (r.name === 'ClickUp' ? r : { ...r, stage: 'review' }));

const osLogoWeek = (week, roster) => snap(week, {
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster },
});

// Tiles are the unit of this feature, so assertions are scoped to one tile's
// markup rather than to the whole page. Splitting on tile boundaries leaves the
// LAST tile's block running to the end of the document, so cut the DOM back to
// the tiles container first: everything after it is a different part of the
// page, and the footer alone names two of the workstreams.
const tilesOnly = (dom) => {
  const start = dom.indexOf('<div class="tiles">');
  const ends = ['<div class="band"', '<footer']
    .map((tag) => dom.indexOf(tag, start)).filter((i) => i !== -1);
  return dom.slice(start, ends.length ? Math.min(...ends) : dom.length);
};

const tileOf = (dom, title) =>
  tilesOnly(dom).split('<div class="tile').find((block) => block.includes(`<h2>${title}</h2>`)) ?? '';

test('the harness can isolate a single tile', () => {
  const tile = tileOf(renderDom([snap('2026-W31')]), 'Tickets solved');
  assert.match(tile, /class="big">11</);
  assert.doesNotMatch(tile, /outputSchema/);
});

test('the done pieces render inside the outputSchema box, not in a list elsewhere', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W31', OS_LOGOS)]), 'outputSchema');
  assert.match(tile, /<ul class="strip">/);
  for (const name of ['ClickUp', 'Slack', 'Notion'])
    assert.match(tile, new RegExp(`<span class="nm">${name}</span></li>`));
  assert.doesNotMatch(tile, />Jira</, 'Jira is in review, not done');
});

test('a logo renders as an img with the URL the catalog published', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W31', OS_LOGOS)]), 'outputSchema');
  assert.match(tile, /<img src="https:\/\/cdn\.activepieces\.com\/pieces\/clickup\.png"/);
});

// The logo is decoration next to a name the reader can already see; announcing
// it would read the piece out twice.
test('logos are hidden from assistive tech, leaving the name as the accessible text', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W31', OS_LOGOS)]), 'outputSchema');
  assert.match(tile, /<span class="ic" aria-hidden="true">/);
  assert.match(tile, /<img [^>]*alt=""/);
});

// The initial is rendered UNDERNEATH the logo and revealed when the image is
// removed, so a 404 — or a page opened with no network at all — shows a letter
// rather than a broken-image icon.
test('every logo has an inline onerror fallback to the first letter', () => {
  const dom = renderDom([osLogoWeek('2026-W31', OS_LOGOS)]);
  const imgs = [...dom.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 2, `expected logo imgs, found ${imgs.length}`);
  for (const img of imgs) assert.match(img, /onerror="this\.remove\(\)"/);
  assert.match(tileOf(dom, 'outputSchema'), /<b class="init">C<\/b>/);
});

test('a piece with no logo renders its initial and no img at all', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W31',
    [{ name: 'Notion', actions: 12, triggers: 2, stage: 'live', tier: 'P1', logo: null }])]), 'outputSchema');
  assert.match(tile, /<b class="init">N<\/b>/);
  assert.doesNotMatch(tile, /<img/);
});

// Nothing on this page may need the network to be READABLE: the theme and the
// data are inlined, and the only external requests are logos, every one of
// which degrades to a letter.
test('the document loads no external script or stylesheet', () => {
  const { html } = render([osLogoWeek('2026-W31', OS_LOGOS)]);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  assert.doesNotMatch(html, /@import/i);
});

test('the strip is labelled as the total when there is no prior week to diff against', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W31', OS_LOGOS)]), 'outputSchema');
  assert.match(tile, /Done in total/);
  assert.doesNotMatch(tile, /Done this week/);
});

test('no strip claims "this week" while the archive holds a single week', () => {
  const dom = renderDom([osLogoWeek('2026-W31', OS_LOGOS)]);
  assert.doesNotMatch(dom, /Done this week/);
  assert.doesNotMatch(dom, /Nothing new this week/);
});

test('with a consecutive prior week the strip is labelled the week and lists only what landed', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W30', OS_LOGOS_PRIOR), osLogoWeek('2026-W31', OS_LOGOS)]),
    'outputSchema');
  assert.match(tile, /Done this week/);
  assert.doesNotMatch(tile, /Done in total/);
  assert.match(tile, /<span class="nm">Notion<\/span><\/li>/);
  assert.match(tile, /<span class="nm">Slack<\/span><\/li>/);
  assert.doesNotMatch(tile, />ClickUp</, 'ClickUp was already done last week');
});

test('a gap in the archive renders the total, not a two-week claim', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W29', OS_LOGOS_PRIOR), osLogoWeek('2026-W31', OS_LOGOS)]),
    'outputSchema');
  assert.match(tile, /Done in total/);
  assert.doesNotMatch(tile, /Done this week/);
  assert.match(tile, /<span class="nm">ClickUp<\/span><\/li>/);
});

test('a week that moved nothing says so instead of re-listing finished work', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W30', OS_LOGOS), osLogoWeek('2026-W31', OS_LOGOS)]),
    'outputSchema');
  assert.match(tile, /Nothing new this week/);
  assert.doesNotMatch(tile, /<ul class="strip">/);
});

// Derived from STRIP_CAP, not hardcoded: this assertion went stale the moment
// the cap changed, while the view tests that derive from the constant did not.
//
// The overflow is IN the page now — every chip past the cap renders `hidden`,
// and "+N more" is the button that reveals them — so what these assert is the
// landing state: exactly STRIP_CAP chips visible, the remainder hidden, and
// the button announcing itself collapsed.
test('an overflowing strip lands capped, with the remainder hidden behind the button', () => {
  const over = 3;
  const many = Array.from({ length: STRIP_CAP + over }, (_, i) =>
    ({ name: `Piece ${i}`, actions: 20 - i, triggers: 0, stage: 'live', tier: 'P1', logo: LOGO(`p${i}`) }));
  const tile = tileOf(renderDom([osLogoWeek('2026-W31', many)]), 'outputSchema');
  // Visible chips only: `class="chip"` exactly — hidden overflow is `chip ext`.
  assert.equal([...tile.matchAll(/<li class="chip"/g)].length, STRIP_CAP);
  assert.match(tile, /<span class="nm">Piece 0<\/span><\/li>/);
  // The whole remainder is present, each hidden until asked for.
  assert.equal([...tile.matchAll(/<li class="chip ext" hidden>/g)].length, over);
  assert.match(tile, new RegExp(`<li class="chip ext" hidden>.*?>Piece ${STRIP_CAP + over - 1}<`));
  // The button starts collapsed and remembers its own label for collapsing back.
  assert.match(tile, new RegExp(
    `<button type="button" aria-expanded="false" data-more="\\+${over} more" onclick="toggleStrip\\(this\\)">\\+${over} more</button>`));
});

// The toggle itself, driven the way a reader drives it: expanded shows every
// chip and offers "Show less"; collapsing restores the landing state.
test('the "+N more" button reveals the overflow and collapses it back', () => {
  const { sandbox } = mount([osLogoWeek('2026-W31', Array.from({ length: STRIP_CAP + 2 }, (_, i) =>
    ({ name: `Piece ${i}`, actions: 9, triggers: 0, stage: 'live', tier: 'P1', logo: null })))]);
  const hidden = [{ hidden: true }, { hidden: true }];
  const btn = {
    attrs: { 'aria-expanded': 'false' },
    dataset: { more: '+2 more' },
    textContent: '+2 more',
    getAttribute(k) { return this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    closest: () => ({ querySelectorAll: () => hidden }),
  };
  sandbox.toggleStrip(btn);
  assert.deepEqual(hidden, [{ hidden: false }, { hidden: false }]);
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.equal(btn.textContent, 'Show less');
  sandbox.toggleStrip(btn);
  assert.deepEqual(hidden, [{ hidden: true }, { hidden: true }]);
  assert.equal(btn.attrs['aria-expanded'], 'false');
  assert.equal(btn.textContent, '+2 more');
});

test('a strip that fits shows no "+N more"', () =>
  assert.doesNotMatch(tileOf(renderDom([osLogoWeek('2026-W31', OS_LOGOS)]), 'outputSchema'), /more/));

// The title arrives as a commit subject, so what the box shows is the sentence
// without its machine-readable prefix — see the display tests further down.
test("the testing box carries the titles of the PRs it shipped", () => {
  const tile = tileOf(renderDom([snap('2026-W31', { testing: { status: 'ok', prsMerged: 1, commits: 4,
    shipped: [{ number: 5, title: 'feat(health): piece health board', url: 'https://x/pull/5' }] } })]),
    'Piece testing');
  assert.match(tile, /Piece health board/);
  assert.match(tile, /Shipped/);
  assert.doesNotMatch(tile, /class="ic"/, 'a PR title has no logo');
});

test('the tickets box keeps its number and its per-person line, and shows no strip', () => {
  const tile = tileOf(renderDom([snap('2026-W31')]), 'Tickets solved');
  assert.match(tile, /class="big">11</);
  assert.match(tile, /<div class="note">Kishan 5 · Sanket 6<\/div>/);
  assert.doesNotMatch(tile, /class="strip"/);
});

// The line is built from the snapshot's own person KEYS now — that is the fix
// for a view that iterated its own list of names — so the key is what reaches
// the page, and it is escaped like any other value.
test('the per-person line is HTML-escaped', () => {
  const tile = tileOf(renderDom([snap('2026-W31', { tickets: { status: 'ok', total: 1,
    byPerson: { '<img onerror=x>': 1 } } })]), 'Tickets solved');
  assert.match(tile, /&lt;img onerror=x&gt; 1/);
  assert.doesNotMatch(tile, /<img onerror=x>/);
});

// The other half of the same fix: a count that is not a number cannot be summed
// against the total, so the attribution goes rather than rendering as junk.
test('an unusable per-person count renders no line at all', () => {
  const tile = tileOf(renderDom([snap('2026-W31', { tickets: { status: 'ok', total: 1,
    byPerson: { kishan: '<img onerror=x>' } } })]), 'Tickets solved');
  assert.doesNotMatch(tile, /class="note"/);
  assert.doesNotMatch(tile, /img onerror/);
  assert.match(tile, /class="big">1</);           // the number itself still stands
});

test('a no-data box shows why it has no number and no strip', () => {
  const tile = tileOf(renderDom([snap('2026-W31', {
    outputSchema: { status: 'no-data', reason: 'build output missing', roster: OS_LOGOS } })]), 'outputSchema');
  assert.match(tile, /No data<\/b> — not measured this week/);
  assert.doesNotMatch(tile, /class="strip"/);
  assert.doesNotMatch(tile, /Done in total/);
});

// ── escaping ───────────────────────────────────────────────────────────────
// Both halves of a chip are attacker-influenced: the name comes from a piece's
// displayName and the URL from the catalog, and the URL lands in an attribute.

test('a piece name in the strip is HTML-escaped, initial included', () => {
  const dom = renderDom([osLogoWeek('2026-W31',
    [{ name: '<img onerror=alert(1)>', actions: 1, triggers: 0, stage: 'live', tier: 'P1', logo: null }])]);
  assert.match(dom, /&lt;img onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(dom, /<img onerror=alert\(1\)>/);
  assert.match(dom, /<b class="init">&lt;<\/b>/);
});

test('a logo URL cannot break out of its attribute', () => {
  const dom = renderDom([osLogoWeek('2026-W31',
    [{ name: 'Slack', actions: 1, triggers: 0, stage: 'live', tier: 'P1',
       logo: 'https://x/a.png" onload="alert(1)' }])]);
  assert.doesNotMatch(dom, /onload="alert\(1\)"/);
  assert.match(dom, /&quot; onload=&quot;alert\(1\)/);
});

test('a shipped PR title in the strip is HTML-escaped', () => {
  const dom = renderDom([snap('2026-W31', { testing: { status: 'ok', prsMerged: 1, commits: 1,
    shipped: [{ number: 1, title: '<script>alert(1)</script>', url: 'u' }] } })]);
  assert.match(dom, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(dom, /<script>alert\(1\)/);
});

// ── which piece is which ───────────────────────────────────────────────────
// Issue #4 promoted the week-over-week diff from a footnote at the foot of the
// page into the tile's headline claim, so an identity bug now lands above the
// fold. `displayName` is not an identity: the cloud catalog renames pieces, and
// two folders publish 'Cashfree Payments' today. Keyed on the name, the tile
// either overclaims or contradicts itself inside one box.

// The counts are per-week here, because the point of these two tests is that
// the number and the strip inside one box have to tell the same story.
const osCountedWeek = (week, roster, over = {}) => snap(week, {
  outputSchema: { status: 'ok', live: 1, mergedNotLive: 0, review: 0, todo: 733, totalPieces: 756,
                  roster, ...over },
});

const TELEGRAM = [{ folder: 'telegram-bot', name: 'Telegram Bot', actions: 20, triggers: 0,
                    stage: 'live', tier: 'P1', logo: LOGO('telegram-bot') }];

test('a piece renamed upstream is not presented in its tile as this week\'s output', () => {
  const tile = tileOf(renderDom([osCountedWeek('2026-W30', TELEGRAM),
                                 osCountedWeek('2026-W31', [{ ...TELEGRAM[0], name: 'Telegram' }])]),
    'outputSchema');
  assert.match(tile, /Nothing new this week/);
  assert.doesNotMatch(tile, /class="strip"/, 'nothing crossed the line, so there is nothing to list');
});

test('the delta pill and the strip in the same box agree when two pieces share a name', () => {
  const dup = (stage) => ([
    { folder: '@activepieces/cashfree-payments', name: 'Cashfree Payments', actions: 5, triggers: 0,
      stage: 'live', tier: 'P1', logo: LOGO('cashfree-payments') },
    { folder: 'cashfree-payments', name: 'Cashfree Payments', actions: 3, triggers: 0,
      stage, tier: 'P2', logo: LOGO('cashfree-payments') },
  ]);
  const tile = tileOf(renderDom([osCountedWeek('2026-W30', dup('review'), { live: 1, review: 1 }),
                                 osCountedWeek('2026-W31', dup('live'), { live: 2 })]), 'outputSchema');
  assert.match(tile, /▲<\/span> \+1 vs prior week/);
  assert.match(tile, /Done this week/);
  assert.equal([...tile.matchAll(/<li class="chip"/g)].length, 1);
  assert.doesNotMatch(tile, /Nothing new this week/);
});

// ── one page, one naming convention ────────────────────────────────────────
// The AI-actions roster identifies a piece by SLUG, so its box rendered `apify`,
// `firecrawl` and `google-docs` next to a box rendering `ClickUp` and `Google
// Sheets`. A lowercase-hyphen slug is an internal identifier: it is how the
// monorepo names a directory, not how anyone names a product, and this page is
// read by someone who has never seen the directory.
//
// The catalog publishes the piece's real name and is already the file the logos
// come from, so the chip shows that. The roster row's `name` is untouched — see
// the diff tests in weekly-view.test.mjs for what changing it would cost.

const aiWeek = (week, roster) => snap(week, {
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2,
               totalPieces: 28, blockersOpen: 30, roster },
});

// The three slugs the AI-actions box really showed, with the names the real
// catalog publishes for them. `serp-api` → `SerpApi` is the one no amount of
// title-casing produces.
const AI_NAMED = [
  { name: 'apify', actions: 12, stage: 'merged', displayName: 'Apify', logo: LOGO('apify') },
  { name: 'firecrawl', actions: 9, stage: 'merged', displayName: 'Firecrawl', logo: LOGO('firecrawl') },
  { name: 'serp-api', actions: 4, stage: 'merged', displayName: 'SerpApi', logo: null },
];

const chipNames = (html) => [...html.matchAll(/<span class="nm">([^<]*)<\/span>/g)].map((m) => m[1]);

test('the AI-actions box names a piece the way the catalog does', () => {
  const tile = tileOf(renderDom([aiWeek('2026-W31', AI_NAMED)]), 'AI-actions');
  assert.deepEqual(chipNames(tile), ['Apify', 'Firecrawl', 'SerpApi']);
});

// Across BOTH boxes, because the complaint was that the page read as two pages.
test('no box on the page names a piece by its internal identifier', () => {
  const dom = renderDom([snap('2026-W31', {
    outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
                    roster: OS_LOGOS },
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28,
                 blockersOpen: 30, roster: AI_NAMED },
  })]);
  const names = chipNames(tilesOnly(dom));
  assert.ok(names.length >= 6, `expected chips in both boxes, found ${names.length}`);
  for (const name of names) {
    assert.doesNotMatch(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      `"${name}" is a piece slug, not a piece name`);
  }
});

// Every week already in the archive carries slugs and no display name, and a slug
// the catalog cannot name has nothing to fall back to but itself.
test('a slug with no catalog name is shown as the slug, never a prettified guess', () => {
  const tile = tileOf(renderDom([aiWeek('2026-W31',
    [{ name: 'reoon-verifier', actions: 4, stage: 'merged', logo: null }])]), 'AI-actions');
  assert.deepEqual(chipNames(tile), ['reoon-verifier']);
});

// The fallback letter is the one the reader sees, not the one the archive keys on.
test('the fallback initial follows the name on screen', () => {
  const tile = tileOf(renderDom([aiWeek('2026-W31',
    [{ name: 'sendinblue', actions: 6, stage: 'merged', displayName: 'Brevo', logo: null }])]), 'AI-actions');
  assert.match(tile, /<b class="init">B<\/b>/);
  assert.doesNotMatch(tile, /<b class="init">S<\/b>/);
});

test('a display name is HTML-escaped like any other value', () => {
  const dom = renderDom([aiWeek('2026-W31',
    [{ name: 'apify', actions: 1, stage: 'merged', displayName: '<img onerror=alert(1)>', logo: null }])]);
  assert.match(dom, /&lt;img onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(dom, /<img onerror=alert\(1\)>/);
});

// ── and the testing box named PRs by their commit subject ──────────────────
// The same complaint, one box over: `feat(health): piece health board, needs-
// attention inbox, persisted ru…`. The prefix is a classifier for the repo's own
// tooling, and a chip is clamped to half a strip row — so those nine characters
// are paid for at the far end of the string, in the words that get ellipsized.
//
// The transform lives in the view (unit-tested in weekly-view.test.mjs); these
// pin that it is wired to the page, and that nothing else on the page changed.

const testingWeek = (week, shipped) => snap(week, {
  testing: { status: 'ok', prsMerged: shipped.length, commits: 4, shipped },
});

test('the testing box shows the sentence, not the commit classifier', () => {
  const tile = tileOf(renderDom([testingWeek('2026-W31', [
    { number: 5, title: 'feat(health): piece health board', url: 'https://x/pull/5' },
    { number: 6, title: 'chore(deps): bump the test runner', url: 'https://x/pull/6' },
  ])]), 'Piece testing');
  assert.deepEqual(chipNames(tile), ['Piece health board', 'Bump the test runner']);
  assert.doesNotMatch(tile, /feat\(|chore\(/);
});

test('a shipped title that is only a prefix is never rendered as an empty chip', () => {
  const tile = tileOf(renderDom([testingWeek('2026-W31',
    [{ number: 7, title: 'feat:', url: 'https://x/pull/7' }])]), 'Piece testing');
  assert.deepEqual(chipNames(tile), ['feat:']);
});

// Real data, not a fixture: the week the site is serving right now, out of the
// committed archive. The snapshot keeps the subject verbatim — that is the record
// of what shipped — so this is also the check that the two never got confused.
// Reads the REAL committed archive, not a fixture, so a rewrite of the stored
// titles is caught as well as a rendering regression.
//
// It used to read the Piece testing box. That box shows a COVERAGE roster the
// moment the tester is reachable -- piece names, no PR titles -- so once the
// tester password landed on 2026-09-19 there were no prefixed titles left in it
// to strip. The path did not go away: the PRs merged box renders the same
// `prStrip`, over seventeen conventional-commit titles rather than one.
test('the week in the committed archive reaches the page without its prefix', () => {
  const archive = JSON.parse(readFileSync(new URL('../weekly/data/weeks.json', import.meta.url), 'utf8'));
  const week = archive.weeks.at(-1);
  const prefixed = (week.shipping.shipped ?? []).filter((pr) => prTitle(pr.title) !== pr.title);
  assert.ok(prefixed.length, 'the committed archive no longer exercises the prefix path');
  const tile = tileOf(renderDom([week]), 'PRs merged');
  for (const pr of prefixed) {
    const prefix = pr.title.slice(0, pr.title.indexOf(':') + 1);          // 'feat(health):'
    assert.ok(!tile.includes(prefix), `the page still shows "${prefix}"`);
    assert.ok(tile.includes(`<span class="nm">${escaped(prTitle(pr.title))}</span>`),
      `the chip is not the display form of "${pr.title}"`);
    assert.equal(pr.title.slice(0, prefix.length), prefix, 'the archive was rewritten, not just re-rendered');
  }
});

// ── the initial must not show through the logo ──────────────────────────────
// The fallback letter is painted UNDERNEATH every logo and stays in the DOM
// after the logo loads, which is what makes the offline path free. It only works
// if the logo layer OCCLUDES it: published Activepieces logos are RGBA PNGs with
// transparent backgrounds, so an unfilled <img> lets a bold letter show through
// the artwork on the success path — the path the whole "recognise a piece by its
// logo" story depends on.
//
// This is a painting invariant, so it is asserted on the page's own stylesheet:
// no DOM assertion can see a letter bleeding through a logo.

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const pageCss = (html) =>
  [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(CSS_COMMENT, '');

// Declarations that apply to exactly this selector, later rules winning — enough
// CSS to reason about one 16px box, not a cascade implementation.
const declarationsFor = (css, selector) => {
  const out = {};
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!sel.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const decl of body.split(';')) {
      const at = decl.indexOf(':');
      if (at !== -1) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
  }
  return out;
};

const themeValues = (token) => [...readFileSync(new URL('../shared/theme.css', import.meta.url), 'utf8')
  .matchAll(new RegExp(`${token}\\s*:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());

test('the initial is emitted before the logo, so the logo paints over it', () => {
  const tile = tileOf(renderDom([osLogoWeek('2026-W31', OS_LOGOS)]), 'outputSchema');
  assert.match(tile, /<b class="init">C<\/b><img src="[^"]*clickup\.png"/);
});

test('the logo is filled, so the initial underneath it cannot show through', () => {
  const css = pageCss(render([osLogoWeek('2026-W31', OS_LOGOS)]).html);
  assert.ok(declarationsFor(css, '.ic .init').background, 'the fallback letter sits on a filled tile');
  const fill = declarationsFor(css, '.ic img').background ?? declarationsFor(css, '.ic img')['background-color'];
  assert.ok(fill, '.ic img needs its own fill or every transparent logo pixel reveals the letter');
  assert.match(fill, /^var\(--[a-z0-9-]+\)$/, `the fill must be a theme token, got ${fill}`);
});

// A translucent fill would leak the letter through just as well, and the page
// ships light and dark, so the token has to be opaque in every theme block.
test('the logo fill is an opaque token in every theme', () => {
  const css = pageCss(render([osLogoWeek('2026-W31', OS_LOGOS)]).html);
  const decls = declarationsFor(css, '.ic img');
  const token = /^var\((--[a-z0-9-]+)\)$/.exec(decls.background ?? decls['background-color'] ?? '')?.[1];
  assert.ok(token, 'no theme token to resolve');
  const values = themeValues(token);
  assert.ok(values.length >= 2, `${token} must be defined for light and dark, found ${values.length}`);
  for (const v of values) assert.match(v, /^#[0-9a-f]{6}$/i, `${token} is not opaque in every theme: ${v}`);
});

// ── one screen ─────────────────────────────────────────────────────────────
// The page's own acceptance criterion is that it fits a laptop screen without
// scrolling. Measured in headless Chrome against the tallest LEGITIMATE week
// (two weeks recorded, the outputSchema strip at its cap plus "+N more", all
// four workstreams ok, one "Needs you" line) the page was 917px against a 681px
// viewport on a 1366x768 laptop. The two biggest contributors were both blocks
// sitting under each number: the trend chart plus its caption (~67px per tile,
// ~134px across the two grid rows) and the chip strip (~93px).
//
// The chart is gone. The delta pill on the number line already carries the
// week-over-week move, which is the only comparison a PM asked for, and the
// chart was also the one thing on the page that drew a hole in the archive as if
// it were not there — see the gap test below.
//
// Removing it took the same week to 796px, which still scrolled: the strip was
// the other unbounded block, because a chip could wrap inside itself. Chips are
// one line and half a row wide now, and the cap is 5 — see the chip tests below.
// The same week measures 662px, and the archive as committed in August, 575px.
//
// RE-MEASURED 2026-09-13, same viewport, after the fifth box (UI improvements)
// replaced the curated band: the six committed weeks span 584–781px, and the
// week a reader lands on is 781px. It scrolls, by ~100px.
//
// Recorded rather than quietly dropped, because two different things are true.
// The archive had ALREADY outgrown the criterion before this box existed — the
// same six weeks measured 476–741px on the build before it, so the two heaviest
// weeks scrolled either way; the page was tuned when the archive held two light
// weeks, and weeks get heavier as the team ships more per week. And the box
// itself is cheap: 97px bare, 123px with a note, 149px with a note and a chip
// row, against the ~120px band it replaced. What is left to give back is not whitespace or a
// cap — it is a WEEK'S CONTENT, four boxes' worth of chips and two asks, and
// that is the reader's call to make, not a margin to shave.
//
// So the budget below stays exactly where it was tuned: it is what stops the
// page drifting further, and every px it guards is one the content does not
// have to give up.
//
// No test here can measure pixels without a browser, so what these pin is the
// structure the measurement established: the blocks that are gone stay gone, no
// block's height depends on how long a name is, the strip stays capped, and the
// whitespace budget stays where it was tuned.

const SIX_WEEKS = ['2026-W26', '2026-W27', '2026-W28', '2026-W29', '2026-W30', '2026-W31']
  .map((w, i) => snap(w, { tickets: { status: 'ok', total: 4 + i * 2, byPerson: { kishan: 2 + i, sanket: 2 + i } } }));

test('no box draws a trend chart or claims "last N weeks"', () => {
  const dom = renderDom(SIX_WEEKS);         // six contiguous weeks: a chart would have every point it wants
  assert.doesNotMatch(dom, /<svg/);
  assert.doesNotMatch(dom, /class="trend"|sparkcap/);
  assert.doesNotMatch(dom, /last \d+ weeks/);
});

test('the stylesheet keeps no rules for the chart it no longer draws', () => {
  const css = pageCss(render([snap('2026-W31')]).html);
  for (const sel of ['.trend', '.sparkcap', 'svg.spark', '.spark']) {
    assert.deepEqual(declarationsFor(css, sel), {}, `dead CSS left behind for ${sel}`);
  }
  assert.doesNotMatch(css, /--spark-/, 'dead sparkline custom properties left behind');
});

// The archive holds one week today and the refresh job runs on Saturdays, so a
// single missed run puts a hole in it. The chart drew two entries eleven weeks
// apart as adjacent weeks and captioned them "last 2 weeks · 1 → 15", directly
// under a strip this same slice correctly labels "Done in total": one box
// contradicting itself, with the overstated half below the honest half.
test('a hole in the archive is never presented as recent movement', () => {
  const dom = renderDom([
    snap('2026-W20', { outputSchema: { status: 'ok', live: 1, mergedNotLive: 0, review: 0, todo: 755, totalPieces: 756 } }),
    snap('2026-W31'),
  ]);
  assert.doesNotMatch(dom, /last \d+ weeks/);
  assert.doesNotMatch(dom, /<svg/);
  assert.doesNotMatch(dom, /vs prior week/, 'W20 is not the week before W31, so there is no delta either');
  assert.match(dom, /no prior week to compare against yet/);
});

// ── a chip is one line, and never a whole row ──────────────────────────────
// The strip was the last block on the page whose height was unbounded: a chip
// carried whatever text a collector recorded and was allowed to wrap INSIDE
// itself, so a box grew with the LENGTH of a name rather than with the cap.
// Measured in headless Chrome at 1366x768 (681px of viewport), a week that
// shipped eight PRs with ordinary 70-character titles drew chips 408px wide
// inside a 418px box — one chip per row, seven rows, a 336px box — and the page
// came to 796px. The cap was doing nothing for height there.
//
// Two structural bounds replace that, one pinned by each test below: a chip
// renders on ONE line, and no chip may take more than half a row. Six chips
// (the cap plus "+N more") are then three rows at worst, every box measures
// 202px, and the same week comes to 662px — 19px inside the viewport, which is
// what leaves room for a second "Needs you" line.
//
// The clipping is an ellipsis, not a truncation: the full name stays in the DOM,
// so a screen reader, a text selection and summary.json all still get it.

test('a strip chip renders on one line and cannot fill a whole row', () => {
  const chip = declarationsFor(pageCss(render([snap('2026-W31')]).html), 'ul.strip .chip');
  assert.equal(chip['white-space'], 'nowrap',
    'a chip that wraps inside itself makes the page height depend on how long a name is');
  assert.match(chip['max-width'] ?? '', /^calc\(50% - [\d.]+px\)$/,
    `a chip must be clamped to half a strip row, got max-width: ${chip['max-width']}`);
});

test('a clamped chip ellipsizes its name rather than clipping it mid-glyph', () => {
  const nm = declarationsFor(pageCss(render([snap('2026-W31')]).html), 'ul.strip .chip .nm');
  assert.equal(nm.overflow, 'hidden');
  assert.equal(nm['text-overflow'], 'ellipsis');
  assert.equal(nm['min-width'], '0', 'without this the name will not shrink inside the flex chip');
});

// The ellipsis needs something of its own to apply to — a bare text node in a
// flex chip cannot be ellipsized — so the name is its own element. Which means
// the page must still carry the whole string: clipped on screen, intact in the
// markup. Nothing here is truncated at any length, which is what keeps text
// selection and a screen reader whole.
test('a chip keeps the full name in the markup, however long it is', () => {
  const title = 'feat(health): piece health board, needs-attention inbox, persisted runs';
  const tile = tileOf(renderDom([snap('2026-W31', { testing: { status: 'ok', prsMerged: 1, commits: 4,
    shipped: [{ number: 5, title, url: 'https://x/pull/5' }] } })]), 'Piece testing');
  // The prefix is dropped for display; every one of the remaining 57 characters
  // stays, and the CSS above is what clips them.
  assert.deepEqual(chipNames(tile), ['Piece health board, needs-attention inbox, persisted runs']);
});

// ── the clamp needs a track that can shrink ────────────────────────────────
// `nowrap` buys a bounded HEIGHT at the cost of an unbounded intrinsic WIDTH: a
// chip's min-content size is now its entire name, so a tile's min-content size is
// the longest name inside it. `grid-template-columns: 1fr` is `minmax(auto, 1fr)`
// and that `auto` floor IS min-content — so the track grows to fit the name
// instead of the name ellipsizing to fit the track, and the tile stops being
// bounded by its container at all.
//
// Measured in headless Chrome at 375x667 with every strip at the cap: the
// one-column track computed to 566px inside a 335px container, and the document
// came out 586px wide in a 375px viewport — all four boxes hanging off the right
// edge of the phone, which is the one thing the mobile rule exists to prevent.
// The two-column rule never had the bug because it spells the floor out as
// `minmax(0, 1fr)`; the one-column override dropped it. Both are pinned here.
//
// A width invariant, so it is asserted on the stylesheet: no DOM assertion can
// see a grid track outgrow its container.
//
// The page's OWN layer, not pageCss: shared/theme.css is inlined above it and
// carries a `.tiles` rule of its own for the sibling pages' grid, which this page
// overrides and which is not what these tracks are.
const ownCss = (html) =>
  [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].at(-1)[1].replace(CSS_COMMENT, '');

const tileTracks = (css) => [...css.matchAll(/\.tiles\s*\{([^{}]*)\}/g)]
  .map((m) => /grid-template-columns\s*:\s*([^;]+)/.exec(m[1])?.[1].trim())
  .filter(Boolean);

test('every tile track zeroes its automatic minimum, so a long name cannot widen the page', () => {
  const css = ownCss(render([snap('2026-W31')]).html);
  assert.match(css, /@media[^{]*max-width:\s*640px[^{]*\{\s*\.tiles\s*\{/,
    'the one-column override is not a .tiles rule any more, so this test measures nothing');
  const tracks = tileTracks(css);
  assert.equal(tracks.length, 2,
    `expected a two-column track and a one-column override, found ${tracks.length}: ${tracks}`);
  for (const track of tracks) {
    assert.match(track, /minmax\(\s*0\s*,/,
      `tile track "${track}" leaves its automatic minimum at auto, which is min-content — and a `
      + "nowrap chip's min-content is its whole name, so the track grows to fit the longest name");
  }
});

// Height is rows, and the clamp above guarantees at least two chips per row, so
// the cap is what actually keeps a box at the 202px it was measured at: the cap
// plus the "+N more" chip must not need a fourth row.
const CHIPS_PER_ROW = 2;      // guaranteed by the half-row clamp, whatever the names are
const ROW_BUDGET = 3;         // Chrome-measured: 3 rows of chips = a 202px box = a 662px page

test('the strip cap keeps every box inside its three-row height budget', () => {
  const rows = Math.ceil((STRIP_CAP + 1) / CHIPS_PER_ROW);   // +1: "+N more" takes a chip slot too
  assert.ok(rows <= ROW_BUDGET,
    `${STRIP_CAP} chips plus "+N more" is ${rows} rows of chips; the one-screen budget is ${ROW_BUDGET}`);
});

// Shorthand box sides, top and bottom only: `16px 20px 24px` → top 16, bottom 24.
const sidesY = (shorthand) => {
  const parts = String(shorthand).trim().split(/\s+/).map((v) => Number(/^(-?[\d.]+)(px)?$/.exec(v)?.[1]));
  const [top, , third] = parts;
  return { top, bottom: parts.length >= 3 ? third : top };
};

// Everything on the page that is whitespace rather than content: the wrap's own
// padding, the gaps around and inside the tile grid, and the footer's lead-in.
// Chrome-measured, 1366x768 (681px of viewport): the header, caption, four boxes
// at their tallest and a one-line "Needs you" band come to ~552px, so the page
// only fits while its furniture stays inside what is left. 64px of dead space
// under the footer was a third of that budget on its own.
//
// The fifth box added content, not furniture — it shares the same grid gap the
// other four already pay for — so the number below is unchanged and still the
// figure it was tuned to. See the re-measurement note above for where the page
// actually stands.
//
// 98px is what the tallest week measured at: it leaves 31px spare, which is one
// more "Needs you" line (26px). Loosen this and the page stops fitting for a
// week with two asks — the one part of the page that asks for an action is the
// last thing that should fall below the fold.
test('the page keeps the whitespace budget that makes it fit a laptop screen', () => {
  const css = pageCss(render([snap('2026-W31')]).html);
  const wrap = sidesY(declarationsFor(css, '.wrap').padding);
  const tiles = declarationsFor(css, '.tiles');
  const grid = sidesY(tiles.margin);
  const gap = Number(/^([\d.]+)px$/.exec(tiles.gap)?.[1]);
  const footer = Number(/^([\d.]+)px$/.exec(declarationsFor(css, 'footer')['margin-top'])?.[1]);
  const budget = [wrap.top, wrap.bottom, grid.top, grid.bottom, gap, footer];
  for (const v of budget) assert.ok(Number.isFinite(v), `unreadable vertical metric in the page CSS: ${budget}`);
  const total = budget.reduce((a, b) => a + b, 0);
  assert.ok(total <= 98, `page furniture is ${total}px of whitespace; the one-screen budget is 98px`);
});

// ── linked chips, coverage, and notes on the rendered page ──────────────────
// The view builds hrefs, short titles and notes; these pin that they reach the
// DOM wired the way a reader uses them — and that nothing unescaped rides in.

const coveredWeek = (week = '2026-W31') => snap(week, {
  testing: { status: 'ok', prsMerged: 1, commits: 6,
    shipped: [{ number: 5, title: 'feat(health): piece health board',
                url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/5' }],
    catalogPieces: 720,
    roster: [
      { name: 'zendesk', folder: 'zendesk', displayName: 'Zendesk', logo: null, actions: 12, stage: 'covered' },
      { name: 'slack', folder: 'slack', displayName: 'Slack',
        logo: 'https://cdn.activepieces.com/pieces/slack.png', actions: 2, stage: 'covered' },
    ] },
});

test('a covered week leads with the coverage headline and lists the pieces', () => {
  const tile = tileOf(renderDom([coveredWeek()]), 'Piece testing');
  assert.match(tile, /of 720 pieces covered/);
  assert.deepEqual(chipNames(tile), ['Zendesk', 'Slack']);
  assert.match(tile, /cdn\.activepieces\.com\/pieces\/slack\.png/);
  assert.match(tile, /1 PR merged · 6 commits this week/);
});

test('a label-less strip renders chips with no striplab heading', () => {
  const tile = tileOf(renderDom([coveredWeek()]), 'Piece testing');
  assert.doesNotMatch(tile, /striplab/);
});

test('a curated note replaces the derived build-progress line', () => {
  const tile = tileOf(renderDom([coveredWeek()], '',
    { notes: { '2026-W31': { testing: 'Health board shipped; nightly runs live' } } }), 'Piece testing');
  assert.match(tile, /Health board shipped; nightly runs live/);
  assert.doesNotMatch(tile, /6 commits this week/);
});

test('a hostile curated note is escaped on its way to the DOM', () => {
  const tile = tileOf(renderDom([snap('2026-W31')], '',
    { notes: { '2026-W31': { tickets: '<script>alert(1)</script>' } } }), 'Tickets solved');
  assert.doesNotMatch(tile, /<script>/);
  assert.match(tile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a shipped PR chip links to the PR when the archive recorded an https URL', () => {
  const tile = tileOf(renderDom([testingWeek('2026-W31', [
    { number: 5, title: 'feat(health): piece health board',
      url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/5' },
  ])]), 'Piece testing');
  assert.match(tile,
    /<a href="https:\/\/github\.com\/ibrahim-abuznaid\/piece-tester-web\/pull\/5" target="_blank" rel="noopener">/);
});

test('a PR whose recorded url is not https renders a plain, unlinked chip', () => {
  const tile = tileOf(renderDom([testingWeek('2026-W31', [
    { number: 6, title: 'feat: alerts', url: 'javascript:alert(1)' },
  ])]), 'Piece testing');
  assert.doesNotMatch(tile, /<a /);
  assert.doesNotMatch(tile, /javascript:/);
  assert.deepEqual(chipNames(tile), ['Alerts']);
});

// The ticket chips of the week the site is serving right now, out of the
// committed archive — the check that the real data renders, not just fixtures.
test('the committed archive renders linked ticket chips', () => {
  const archive = JSON.parse(readFileSync(new URL('../weekly/data/weeks.json', import.meta.url), 'utf8'));
  const week = archive.weeks.at(-1);
  const shipped = week.tickets?.shipped ?? [];
  if (!shipped.length) return; // a quiet week is not a failure of the wiring
  const tile = tileOf(renderDom([week]), 'Tickets solved');
  for (const t of shipped) {
    assert.match(tile, new RegExp(`<a href="https://linear\\.app/activepieces/issue/${t.id}"`));
    assert.match(tile, new RegExp(`<span class="tid">${t.id}</span>`));
  }
});

// Painting invariant, so it is asserted on the stylesheet: `[hidden]` hides via
// the BROWSER'S `display: none`, and the strip's own `display: inline-flex` on
// .chip is an author declaration, which beats any UA rule. Without an explicit
// author `display: none` for hidden chips, the overflow renders fully visible
// with a "+N more" button under it — which is exactly how this shipped broken.
test('a hidden overflow chip is actually display:none, not just marked hidden', () => {
  const css = pageCss(render([snap('2026-W31')]).html);
  assert.equal(declarationsFor(css, 'ul.strip .chip[hidden]').display, 'none');
});

// ── the UI-improvements tile ────────────────────────────────────────────────
// The fifth box replaced the curated band that used to sit here. It renders
// through the same tileHtml as the other four — that is the point of the change
// — so what these pin is the part that is NOT shared: it spans both columns, and
// it spends less height doing it than the four narrow boxes do.

const wideTile = (dom) => {
  const start = dom.indexOf('<div class="tile wide');
  return start === -1 ? '' : dom.slice(start, dom.indexOf('</div>', dom.indexOf('class="strip"', start) + 1));
};

test('UI improvements renders as a stat box, not as a band', () => {
  const dom = renderDom([withRosters()]);
  assert.doesNotMatch(dom, /class="band plain"/, 'the curated band is gone');
  const tile = wideTile(dom);
  assert.match(tile, /<h2>UI improvements<\/h2>/);
  assert.match(tile, /<span class="big">5<\/span>/);
  assert.match(tile, /of 765 pieces/);
});

test('the wide box spans the whole grid — no hole beside it', () => {
  const css = pageCss(render([snap('2026-W31')]).html);
  assert.equal(declarationsFor(css, '.tile.wide')['grid-column'], '1 / -1');
});

// The label folds onto the chip row instead of sitting above it. Worth 20px of
// the one-screen budget, and only safe because the box is full width — see the
// page-height test below.
test('the wide box puts its strip label inline with the chips', () => {
  const dom = renderDom([withRosters()]);
  assert.match(dom, /<div class="stripline"><div class="striplab">/);
  const css = pageCss(render([snap('2026-W31')]).html);
  assert.equal(declarationsFor(css, '.tile.wide .stripline').display, 'flex');
  assert.equal(declarationsFor(css, '.tile.wide ul.strip')['margin-top'], '0');
});

// The clamp that keeps a chip to half a row is a PERCENTAGE of the strip, so
// the strip has to have a width of its own. Left to shrink-wrap its chips it
// made half-a-chip the limit, and a two-chip strip ellipsized both of them in a
// box with 400px unused.
test('the wide strip fills its row so the half-row clamp means half the row', () => {
  const css = pageCss(render([snap('2026-W31')]).html);
  assert.equal(declarationsFor(css, '.tile.wide ul.strip').flex, '1');
});

// A degraded fifth box keeps its width. Losing it would drop the box into a
// half-width slot beside a hole — a collector failure reflowing the layout is
// exactly what the fixed tile order exists to prevent.
test('a degraded UI-improvements box stays wide', () => {
  const dom = renderDom([snap('2026-W31', {
    uiImprovements: { status: 'no-data', reason: 'summary.json missing' },
  })]);
  assert.match(dom, /<div class="tile wide is-nodata">/);
  assert.match(dom, /not measured this week/);
});

// The prose the band carried is committed in notes.json now. Every week that
// names it must still put it on the page.
test('the committed notes.json renders its UI-improvements note for the weeks it names', () => {
  const notes = JSON.parse(readFileSync(new URL('../weekly/data/notes.json', import.meta.url), 'utf8'));
  const archive = JSON.parse(readFileSync(new URL('../weekly/data/weeks.json', import.meta.url), 'utf8'));
  const named = Object.entries(notes).filter(([w, n]) => n.uiImprovements
    && archive.weeks.some((x) => x.week === w));
  assert.ok(named.length, 'notes.json should still carry the migrated band prose');
  for (const [w, n] of named) {
    const dom = renderDom(archive.weeks, `#${w}`, { notes });
    assert.ok(dom.includes(escaped(n.uiImprovements)),
      `week ${w} is curated in notes.json but its note does not reach the page`);
  }
});

// ── the review pill ─────────────────────────────────────────────────────────
// Work in flight, drawn beside the work that landed. Its own pill rather than a
// second sentence under the number: the box's height budget is what retired the
// sub-lines in the first place (see the measurements above), and the number line
// is the one row on a tile that had room left.
//
// NEUTRAL, never the delta pill's green. A queue is not progress — it is the
// same work counted before it arrives — and colouring it as a gain is how a
// reader ends up adding it to the headline.
test('a staged rollout draws its review queue beside the number', () => {
  const tile = tileOf(renderDom([snap('2026-W31')]), 'UI improvements');
  assert.match(tile, /class="inreview"/);
  assert.match(tile, /\+2 in review/);
});

test('the review pill is not styled as a gain', () => {
  const tile = tileOf(renderDom([snap('2026-W31')]), 'UI improvements');
  assert.doesNotMatch(tile, /class="inreview up"/);
});

// The pill names no noun. The unit line it sits beside has just said what is
// being counted ("of 765 pieces"), so repeating "pieces" spends the width the
// two-column tiles do not have — and buys a pluralisation bug for nothing.
test('the review pill does not repeat the unit line\'s noun', () => {
  const tile = tileOf(renderDom([snap('2026-W31')]), 'UI improvements');
  assert.match(tile, /class="inreview">\+2 in review</);
  assert.doesNotMatch(tile, /\d+ pieces in review/);
});

// The whole point of the correction: the outputSchema box records a `review`
// count that means "flagged for a human decision", not "PR awaiting review", so
// it must reach the page under no wording at all. The fixture has 8 of them.
test('the outputSchema box never draws its decision-flag count as a review pill', () => {
  const tile = tileOf(renderDom([snap('2026-W31')]), 'outputSchema');
  assert.doesNotMatch(tile, /in review/);
  assert.doesNotMatch(tile, /class="inreview"/);
});

// The real queue does draw. The fixture carries 8 decision flags and 2 open PRs,
// so a pill reading "+8" is the exact failure this pair of tests exists to catch.
test('the outputSchema box draws its open-PR queue', () => {
  const os = { status: 'ok', live: 9, mergedNotLive: 6, review: 8, prOpen: 2, todo: 733, totalPieces: 756, roster: [] };
  const tile = tileOf(renderDom([snap('2026-W31', { outputSchema: os })]), 'outputSchema');
  assert.match(tile, /class="inreview">\+2 in review</);
  assert.doesNotMatch(tile, /\+8 in review/);
});

// An empty queue draws nothing. "+0 in review" is a pill that costs a reader a
// glance to learn there is nothing behind it, and the tile's own number already
// says everything measured landed.
test('an empty review queue draws no pill', () => {
  const empty = { status: 'ok', merged: 2, prOpen: 0, assigned: 0, held: 2, totalPieces: 28 };
  const tile = tileOf(renderDom([snap('2026-W31', { aiActions: empty })]), 'AI-actions');
  assert.doesNotMatch(tile, /in review/);
});

// Piece testing stages nothing through review, so it never grows a pill whatever
// the snapshot happens to carry.
test('piece testing carries no review pill', () =>
  assert.doesNotMatch(tileOf(renderDom([snap('2026-W31')]), 'Piece testing'), /in review/));

// Tickets do, and the pill is the whole point of the box: "7 closed this week"
// on its own reports a week spent waiting on reviewers as a week of seven, and
// says nothing about the ten that are done and stuck.
test('the tickets box draws the queue waiting on a reviewer', () => {
  const tickets = { status: 'ok', total: 7, inReview: 10, byPerson: { kishan: 6, sanket: 1 },
    prsMerged: { kishan: 0, sanket: 0 }, reviews: { kishan: 0, sanket: 0 }, shipped: [] };
  const tile = tileOf(renderDom([snap('2026-W31', { tickets })]), 'Tickets solved');
  assert.match(tile, /class="inreview">\+10 in review</);
});

// An archived week collected before the field existed. The pill is absent, not
// "+0 in review" over a queue nobody counted.
test('a week that never counted its ticket queue draws no pill', () =>
  assert.doesNotMatch(tileOf(renderDom([snap('2026-W31')]), 'Tickets solved'), /in review/));

test('a degraded tile draws no review pill', () => {
  const tile = tileOf(renderDom([snap('2026-W31', { uiImprovements: { status: 'no-data', reason: 'x' } })]), 'UI improvements');
  assert.doesNotMatch(tile, /in review/);
});

// The pill sits on the number line, between the unit and the week-over-week
// delta: merged, what it is out of, what is behind it, then the move. Asserted
// because the order is the sentence — a queue drawn after the delta reads as
// part of the comparison rather than as the state it actually is.
test('the pill sits between the unit and the delta', () => {
  const tile = tileOf(renderDom([
    snap('2026-W30', { uiImprovements: { status: 'ok', merged: 3, live: 3, review: 2, assigned: 0, totalPieces: 765 } }),
    snap('2026-W31'),
  ]), 'UI improvements');
  assert.match(tile, /class="unit"[\s\S]*class="inreview"[\s\S]*class="delta/);
});
