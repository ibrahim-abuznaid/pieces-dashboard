import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, plural, prTitle, ticketTitle, STRIP_CAP } from '../weekly/lib/view.mjs';
import { collectTickets } from '../weekly/collect/tickets.mjs';

const snap = (week, over = {}) => ({
  week, start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [{ number: 5, title: 't', url: 'u' }] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 },
             shipped: [{ id: 'PIE-101', title: 'x', assignee: 'kishan', team: 'Pieces' }] },
  decisions: ['6 outputSchema pieces merged but not cloud-live'],
  ...over,
});

const archive = { weeks: [snap('2026-W30', { outputSchema: { status: 'ok', live: 7, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 } }), snap('2026-W31')] };

test('defaults to the newest week in the archive', () =>
  assert.equal(buildView(archive).week, '2026-W31'));

test('an explicit weekId wins', () =>
  assert.equal(buildView(archive, { weekId: '2026-W30' }).week, '2026-W30'));

test('an unknown weekId falls back to the newest', () =>
  assert.equal(buildView(archive, { weekId: '1999-W01' }).week, '2026-W31'));

// `deltaFor` → `previousWeekId` throws on anything that is not `YYYY-Wnn`, so
// the selection must be resolved to a real archive entry BEFORE any week id is
// handed downstream. A malformed id has to fall back, never propagate.
test('a malformed weekId falls back to the newest instead of throwing', () => {
  assert.doesNotThrow(() => buildView(archive, { weekId: 'not-a-week' }));
  assert.equal(buildView(archive, { weekId: 'not-a-week' }).week, '2026-W31');
  assert.equal(buildView(archive, { weekId: 'not-a-week' }).tiles[0].delta, 2);
});

test('an empty archive is flagged rather than crashing', () =>
  assert.deepEqual(buildView({ weeks: [] }), { empty: true, weeks: [] }));

test('picker lists weeks newest first', () =>
  assert.deepEqual(buildView(archive).weeks, ['2026-W31', '2026-W30']));

test('always four tiles in fixed order', () =>
  assert.deepEqual(buildView(archive).tiles.map((t) => t.key),
    ['outputSchema', 'aiActions', 'testing', 'tickets']));

// The headline for outputSchema is MERGED work — live + merged-not-live — not
// just what reached cloud. Counting only `live` reports 9 when 15 pieces are
// done, blaming the team for a release train it does not own. The metric is
// derived at read time, so no snapshot needed rewriting for this.
test('the outputSchema tile leads with merged, not with cloud-live', () => {
  const tile = buildView(archive).tiles[0];
  assert.equal(tile.value, 15);                 // 9 live + 6 merged-not-live
  assert.equal(tile.unit, 'of 756 merged');
});

test('the outputSchema delta follows the same derived merged metric', () => {
  const tile = buildView(archive).tiles[0];
  assert.equal(tile.delta, 2);                  // 13 merged last week → 15
});

// The delta pill is now the ONLY comparison a tile carries. The per-tile trend
// series went with the sparkline it fed: read by index over the archive, it drew
// weeks that were never recorded as if they were adjacent, and it was the tallest
// block on a page whose acceptance criterion is fitting one laptop screen. A
// field the page does not render is a field the next reader is misled by, so it
// is gone from the model too — the rendered page is asserted in
// test/weekly-render.test.mjs.
test('no tile carries a trend series any more', () => {
  for (const t of buildView(archive).tiles) {
    assert.equal(t.spark, undefined);
    assert.equal(t.series, undefined);
  }
  assert.doesNotMatch(JSON.stringify(buildView(archive)), /spark|series/i);
});

test('the testing tile pluralises its unit', () => {
  const one = buildView(archive).tiles.find((t) => t.key === 'testing');
  assert.equal(one.value, 1);
  assert.equal(one.unit, 'PR shipped');
  const many = oneWeek({ testing: { status: 'ok', prsMerged: 3, commits: 1, shipped: [] } })
    .tiles.find((t) => t.key === 'testing');
  assert.equal(many.unit, 'PRs shipped');
});

// A tile is a number, its unit and the pieces behind it. The sub-lines that used
// to sit under each number (`9 live on cloud · 8 in review`, `2 commits`) were
// detail, not signal, for a project manager — and a field the page no longer
// renders is a field the next reader gets misled by, so it is gone from the
// model too, not just from the markup.
test('no tile carries a sub-line any more', () => {
  for (const t of buildView(archive).tiles) assert.equal(t.sub, undefined);
});

// The one exception, and the reason it is not a sub-line: who closed the tickets
// is management-relevant, so it folds into the box as a single line rather than
// into a table of its own.
test('the tickets tile folds per-person into one line', () => {
  const tile = buildView(archive).tiles.find((t) => t.key === 'tickets');
  assert.equal(tile.value, 11);
  assert.equal(tile.unit, 'closed this week');
  assert.equal(tile.perPerson, 'Kishan 5 · Sanket 6');
});

test('a person who closed nothing still reads as zero rather than vanishing', () =>
  assert.equal(oneWeek({ tickets: { status: 'ok', total: 5, byPerson: { kishan: 5, sanket: 0 } } })
    .tiles.find((t) => t.key === 'tickets').perPerson, 'Kishan 5 · Sanket 0'));

// The line is read out of the SAME object the total is summed from, never out of
// a list of names held here. The team is hiring a third member: a view that
// iterated its own roster would publish their tickets as a silent 0 beside a
// total that already counts them, and nothing on the page would say so.
const perPersonOf = (over) => oneWeek({ tickets: { status: 'ok', ...over } })
  .tiles.find((t) => t.key === 'tickets').perPerson;

test('the per-person line names whoever the snapshot recorded, not a list held in the view', () =>
  assert.equal(perPersonOf({ total: 18, byPerson: { kishan: 5, sanket: 6, newbie: 7 } }),
    'Kishan 5 · Sanket 6 · Newbie 7'));

// The failure mode this guards is the box contradicting itself: a total of 11
// printed inches above an attribution that adds up to 5. When the two disagree,
// the number stands alone and the attribution goes — a missing line is honest,
// a wrong one is not.
test('attribution that does not add up to the total is dropped rather than contradicting it', () => {
  assert.equal(perPersonOf({ total: 11, byPerson: { kishan: 5 } }), '');
  assert.equal(perPersonOf({ total: 11, byPerson: { kishan: 5, sanket: 6, newbie: 7 } }), '');
});

test('a snapshot with no per-person record carries no per-person line', () => {
  assert.equal(perPersonOf({ total: 11 }), '');
  assert.equal(perPersonOf({ total: 11, byPerson: {} }), '');
});

// `byPerson` is not validated by the archive, so a count that is not a number is
// reachable. It must cost the line, never render as "Kishan undefined".
test('a count that is not a number costs the line', () => {
  assert.equal(perPersonOf({ total: 11, byPerson: { kishan: '5', sanket: 6 } }), '');
  assert.equal(perPersonOf({ total: 11, byPerson: { kishan: null, sanket: 11 } }), '');
});

test('a real zero week still reads as a zero for each person', () =>
  assert.equal(perPersonOf({ total: 0, byPerson: { kishan: 0, sanket: 0 } }), 'Kishan 0 · Sanket 0'));

// The fixtures above are hand-written shapes; this one is the collector's own
// output, because the bug was a SEAM between two files. `collect/tickets.mjs`
// owns the list of people and sums the total from it; this file owns the line
// that names them. While the line was built from a second copy of that list kept
// here, adding a person to the collector — the team is hiring — would have
// counted their tickets in the total and printed them as a silent 0, or dropped
// them from the line altogether.
//
// Roster-agnostic on purpose: the keys come from the collector, so this covers
// whoever it records today AND whoever is added to it later, without this file
// having to learn the names.
const ticketsFrom = (events) => collectTickets({
  window: { start: '2026-07-25', end: '2026-07-31' }, weekId: '2026-W31', linearRefreshPending: false,
  readJson: (name) => ({
    'linear.json': { stamp: '2026-07-31', events, recent: [] },
    'github.json': { stamp: '2026-07-31', mergedEvents: [], reviews: { weekly: [] } },
  }[name]),
});

test('every person the tickets collector records is named on the page', () => {
  const people = Object.keys(ticketsFrom([]).byPerson);          // the collector's own roster
  assert.ok(people.length >= 2, 'the collector recorded nobody, so this test would prove nothing');
  // A different count per person, so a name dropped from the line cannot hide
  // behind a number that happens to belong to someone else.
  const events = people.flatMap((p, i) => Array.from({ length: i + 1 }, () => ({ d: '2026-07-27', p })));
  const ws = ticketsFrom(events);
  const line = oneWeek({ tickets: ws }).tiles.find((t) => t.key === 'tickets').perPerson;
  assert.equal(ws.total, people.reduce((sum, _, i) => sum + i + 1, 0), 'the collector did not count them all');
  for (const [i, p] of people.entries()) {
    assert.match(line, new RegExp(`${p.charAt(0).toUpperCase()}${p.slice(1)} ${i + 1}(?!\\d)`),
      `${p} closed ${i + 1} of the ${ws.total} tickets and the page does not say so: "${line}"`);
  }
});

test('only the tickets tile carries a per-person line', () =>
  assert.deepEqual(buildView(archive).tiles.filter((t) => t.perPerson).map((t) => t.key), ['tickets']));

test('every ok tile carries the full field set', () => {
  for (const t of buildView(archive).tiles.filter((x) => x.status === 'ok')) {
    assert.deepEqual(Object.keys(t).sort(),
      ['delta', 'key', 'note', 'perPerson', 'reason', 'status', 'strip', 'title', 'unit', 'value']);
  }
});

test('a no-data workstream produces a no-data tile, not a zero', () => {
  const a = { weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear pending' } })] };
  const tile = buildView(a).tiles.find((t) => t.key === 'tickets');
  assert.equal(tile.status, 'no-data');
  assert.equal(tile.value, null);
  assert.equal(tile.delta, null);
  assert.equal(tile.perPerson, '');
  assert.equal(tile.reason, 'not measured this week');
});

// The collector's own sentence names internal markers, JSON fields and the
// commands to re-run — see the reason strings in weekly/collect/*.mjs. It stays on
// the record in the committed archive; it does not become page copy, and it is not
// smuggled into the view under another key for a later reader to render.
test('a collector diagnostic does not survive anywhere in the view', () => {
  const reason = 'Linear refresh pending — internal dashboard wrote NEEDS-LINEAR-REFRESH';
  const view = buildView({ weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason } })] });
  assert.doesNotMatch(JSON.stringify(view), /NEEDS-LINEAR-REFRESH|internal dashboard/);
});

// Including a workstream a snapshot never recorded at all: that box must not be
// left with a bare em dash and nothing to explain it.
test('a workstream missing from the snapshot entirely reads as unmeasured too', () => {
  const week = snap('2026-W31');
  delete week.tickets;
  const tile = buildView({ weeks: [week] }).tiles.find((t) => t.key === 'tickets');
  assert.equal(tile.status, 'no-data');
  assert.equal(tile.reason, 'not measured this week');
});

// The piece-tester-web stats-endpoint caveat is an engineering note, so it left
// the page. It is not smuggled back in as a view field either — the record for
// it is README.md (see weekly-wiring.test.mjs).
test('no view field carries the piece-testing caveat any more', () => {
  assert.equal(buildView(archive).testingNote, undefined);
  assert.doesNotMatch(JSON.stringify(buildView(archive)), /stats endpoint/i);
});

// The per-person TABLE is gone, so the columns only it read — PRs merged and
// reviews — must not be left computed and unrendered.
test('the view no longer builds a per-person table', () => {
  const v = buildView(archive);
  assert.equal(v.people, undefined);
  assert.doesNotMatch(JSON.stringify(v), /prsMerged|reviews/);
});

test('the heading names the team and the week number', () =>
  assert.equal(buildView(archive).title, 'Pieces Team · Week 31'));

test('the date range collapses a same-month week', () =>
  assert.equal(buildView(archive).range, 'Jul 25–31'));

test('a range that crosses a month names both months', () =>
  assert.equal(buildView({ weeks: [snap('2026-W31', { start: '2026-07-27', end: '2026-08-02' })] }).range,
    'Jul 27 – Aug 2'));

// ── nothing the page does not render ───────────────────────────────────────
// The page is a week header, four boxes and an ask. This is the whole contract
// between the view and the template: a field computed but never rendered is how
// the next reader gets misled about what the page shows.
//
// `start`/`end` are the exception, deliberately: they are the counting window
// itself, published in `dist/weekly/summary.json` for machine readers, and
// `range` ("Jul 25–31") is lossy — no year, no ISO dates.

test('the view carries exactly the fields the page renders', () =>
  assert.deepEqual(Object.keys(buildView(archive)).sort(),
    ['builtAt', 'decisions', 'end', 'noPriorWeek', 'range', 'start', 'tiles', 'title', 'week', 'weeks']));

// The lede restated the numbers in prose above the boxes that already carry
// them. Two rounds of editing it did not make the page clearer, so it is gone.
test('the view builds no verdict sentence', () => {
  const v = buildView(archive);
  assert.equal(v.verdict, undefined);
  assert.doesNotMatch(JSON.stringify(v), /Output schemas are merged/);
});

// Shipped ticket ids and titles were a table of their own below the boxes. They
// are also exactly what this public repo's data policy keeps off the site.
test('the view no longer assembles a shipped list', () =>
  assert.equal(buildView(archive).shipped, undefined));

// ── decisions: only genuine asks ───────────────────────────────────────────
// The band is worth reading only if every line asks someone to act. Pure status
// and "no data" reports are already on the tiles; repeating them here is what
// made the band skippable. The FILTER lives in the view so weeks already in the
// archive are cleaned up on render, not just weeks snapshotted from now on.

const decisionsFrom = (lines) => oneWeek({ decisions: lines }).decisions;

test('a genuine ask survives', () =>
  assert.deepEqual(decisionsFrom(['6 pieces merged but not live — needs a cloud release']),
    ['6 pieces merged but not live — needs a cloud release']));

test('PRs awaiting review is status, not an ask', () =>
  assert.deepEqual(decisionsFrom(['8 outputSchema PRs awaiting review']), []));

test('open blockers is status, not an ask', () =>
  assert.deepEqual(decisionsFrom(['30 AI-actions blockers still open']), []));

test('a no-data report is dropped — the tile already carries it', () =>
  assert.deepEqual(decisionsFrom(['tickets: no data — Linear refresh pending']), []));

test('historical noise is filtered on render, keeping only the ask', () =>
  assert.deepEqual(decisionsFrom([
    '6 outputSchema pieces merged but not cloud-live — needs a cloud release',
    '8 outputSchema PRs awaiting review',
    '30 AI-actions blockers still open',
    'tickets: no data — Linear refresh pending — internal dashboard wrote NEEDS-LINEAR-REFRESH',
  ]), ['6 outputSchema pieces merged but not cloud-live — needs a cloud release']));

test('a snapshot with no decisions at all yields an empty list', () =>
  assert.deepEqual(oneWeek({ decisions: undefined }).decisions, []));

// ── no prior week ──────────────────────────────────────────────────────────
// Said once, in the caption, instead of stamped on all four tiles.

test('noPriorWeek is true when nothing can be compared', () =>
  assert.equal(oneWeek({}).noPriorWeek, true));

test('noPriorWeek is false once any tile has a delta', () =>
  assert.equal(buildView(archive).noPriorWeek, false));

test('a prior week that reported nothing still leaves nothing to compare', () => {
  const degraded = { status: 'no-data', reason: 'x' };
  const a = { weeks: [
    snap('2026-W30', { outputSchema: degraded, aiActions: degraded, testing: degraded, tickets: degraded }),
    snap('2026-W31'),
  ] };
  assert.equal(buildView(a).noPriorWeek, true);
});

// ── grammar ────────────────────────────────────────────────────────────────

test('plural agrees the noun with the count', () => {
  assert.equal(plural(1, 'PR'), 'PR');
  assert.equal(plural(2, 'PR'), 'PRs');
  assert.equal(plural(0, 'commit'), 'commits');
  assert.equal(plural(1, 'piece'), 'piece');
});

// ── rosters ────────────────────────────────────────────────────────────────
// A snapshot's roster is the per-piece record behind the outputSchema and
// AI-actions numbers. It is OPTIONAL: snapshots taken before the collectors
// recorded it carry no roster at all, and must keep rendering.
//
// The page no longer has roster SECTIONS — 51 stage-grouped rows at the foot of
// the page, the exact cross-referencing this redesign removed — so the roster's
// only consumer is now the pieces strip inside each box. The view therefore
// builds no stage grouping at all.

const OS_ROSTER = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2' },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'merged-not-live', tier: 'P1' },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'live', tier: 'P1' },
  { name: 'Jira', actions: 9, triggers: 1, stage: 'review', tier: 'P3' },
];

const AI_ROSTER = [
  { name: 'google-sheets', actions: 37, stage: 'merged' },
  { name: 'hubspot', actions: 22, stage: 'pr-open' },
  { name: 'intercom', actions: 8, stage: 'held' },
];

const withOsRoster = (roster) => ({
  status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster });
const withAiRoster = (roster) => ({
  status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30, roster });

const oneWeek = (over) => buildView({ weeks: [snap('2026-W31', over)] });

// The strip is the roster's only consumer now, so it is what these read.
const stripOf = (v, key) => v.tiles.find((t) => t.key === key).strip;
const stripNames = (v, key) => (stripOf(v, key)?.items ?? []).map((i) => i.name);
const labelOf = (v, key) => stripOf(v, key)?.label ?? null;

test('the view builds no stage-grouped roster for the page', () => {
  const v = oneWeek({ outputSchema: withOsRoster(OS_ROSTER), aiActions: withAiRoster(AI_ROSTER) });
  assert.equal(v.rosters, undefined);
  assert.doesNotMatch(JSON.stringify(v), /Live on cloud|Merged, awaiting release|In review|PR open/);
});

// A roster row carries `actions`, `triggers` and `tier`; the tables that read
// them are gone, so a chip is a name and a logo and nothing more.
test('a roster row reaches the page as a name and a logo only', () =>
  assert.deepEqual(stripOf(oneWeek({ outputSchema: withOsRoster(OS_ROSTER) }), 'outputSchema').items,
    [{ name: 'ClickUp', logo: null }, { name: 'Slack', logo: null }, { name: 'Notion', logo: null }]));

test('an absent roster leaves the workstream with no strip — back-compat with older snapshots', () => {
  const v = oneWeek({ aiActions: withAiRoster(AI_ROSTER) });
  assert.equal(stripOf(v, 'outputSchema'), null);
  assert.deepEqual(stripNames(v, 'aiActions'), ['google-sheets']);
});

test('an empty roster array produces no strip', () =>
  assert.equal(stripOf(oneWeek({ outputSchema: withOsRoster([]) }), 'outputSchema'), null));

test('a no-data workstream produces no strip even if a roster is attached', () =>
  assert.equal(stripOf(oneWeek({ outputSchema: { status: 'no-data', reason: 'build missing',
    roster: OS_ROSTER } }), 'outputSchema'), null));

// A piece silently disappearing because upstream added a status is the loss this
// project keeps guarding against — but the guard is now "do not COUNT it as
// done", since only done pieces are on the page at all.
test('a stage the page does not recognise is never counted as done', () =>
  assert.equal(stripOf(oneWeek({ outputSchema: withOsRoster(
    [{ name: 'Airtable', actions: 3, triggers: 0, stage: 'sunsetting', tier: 'P4' }]) }), 'outputSchema'),
  null));

test('buildView does not mutate the input archive — no in-place sorting of rosters', () => {
  const input = { weeks: [snap('2026-W31', {
    outputSchema: withOsRoster([
      { name: 'Small', actions: 1, triggers: 0, stage: 'live', tier: 'P3' },
      { name: 'Big', actions: 99, triggers: 0, stage: 'live', tier: 'P1' },
    ]),
    aiActions: withAiRoster([...AI_ROSTER].reverse()),
  })] };
  const before = JSON.stringify(input);
  buildView(input);
  assert.equal(JSON.stringify(input), before);
});

test('a strip preserves the order the collector recorded, it is not re-sorted', () =>
  assert.deepEqual(
    stripNames(oneWeek({ outputSchema: withOsRoster([
      { name: 'Small', actions: 1, triggers: 0, stage: 'live', tier: 'P3' },
      { name: 'Big', actions: 99, triggers: 0, stage: 'live', tier: 'P1' },
    ]) }), 'outputSchema'),
    ['Small', 'Big']));

// ── the AI-actions denominator ─────────────────────────────────────────────
// The initiative tracks 28 pieces out of a 756-piece catalog. "2 of 28 merged"
// reads as 7% catalog coverage when the truth is 0.3% — ~27x overstated. When
// the snapshot recorded the catalog size the tile counts against it; when it
// did not, the wording stays honest about what that week actually measured
// rather than retrofitting a denominator onto history.

const withCatalog = (catalogPieces) => ({
  status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2,
  totalPieces: 28, blockersOpen: 30, catalogPieces });

const aiTile = (v) => v.tiles.find((t) => t.key === 'aiActions');

test('the AI-actions tile counts against the whole catalog when the snapshot recorded it', () =>
  assert.equal(aiTile(oneWeek({ aiActions: withCatalog(756) })).unit, 'of 756 have AI actions'));

test('the tracked count is not the headline denominator', () => {
  const t = aiTile(oneWeek({ aiActions: withCatalog(756) }));
  assert.equal(t.value, 2);
  assert.doesNotMatch(t.unit, /28/);
});

test('a snapshot without a catalog keeps the tracked-count wording', () =>
  assert.equal(aiTile(buildView(archive)).unit, 'of 28 merged'));

// typeof, not truthiness: 0 is a recorded catalog size, not a missing one.
test('a zero catalog is still a recorded catalog', () =>
  assert.equal(aiTile(oneWeek({ aiActions: withCatalog(0) })).unit, 'of 0 have AI actions'));

// The tracked count, the open PRs and the open blockers were the tile's
// sub-line. They are collector detail, and the box is a number now.
test('the tracked count, open PRs and blockers are not carried onto the tile', () => {
  const t = aiTile(oneWeek({ aiActions: withCatalog(756) }));
  assert.doesNotMatch(JSON.stringify(t), /tracked|blocker|PRs open/);
});

// ── what counts as done ────────────────────────────────────────────────────
// "Done" means merged: `live` + `merged-not-live` for outputSchema (both are
// merged; `live` additionally shipped to cloud), `merged` for AI-actions. What
// crossed the line THIS week is only claimable against a real
// immediately-preceding week. With nothing to diff against, every piece ever
// finished would otherwise be reported as finished this week: the same silent
// overclaim deltaFor guards.
//
// The strip is the only thing this diff feeds now — the running total and the
// list of names that the roster's done LINE used to print are gone with it.

const twoWeeks = (prev, cur, prevWeek = '2026-W30') =>
  buildView({ weeks: [snap(prevWeek, prev), snap('2026-W31', cur)] });

// ClickUp live, Slack merged-not-live, Notion live, Jira review → 3 done.
const OS_PRIOR = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2' },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'review', tier: 'P1' },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'review', tier: 'P1' },
  { name: 'Jira', actions: 9, triggers: 1, stage: 'review', tier: 'P3' },
];

test('outputSchema done counts live and merged-not-live, not just cloud-live', () => {
  const v = oneWeek({ outputSchema: withOsRoster(OS_ROSTER) });
  assert.deepEqual(stripNames(v, 'outputSchema'), ['ClickUp', 'Slack', 'Notion']);
  assert.equal(labelOf(v, 'outputSchema'), 'Done in total');
});

test('AI-actions done counts only merged', () => {
  const v = oneWeek({ aiActions: withAiRoster(AI_ROSTER) });
  assert.deepEqual(stripNames(v, 'aiActions'), ['google-sheets']);
  assert.equal(labelOf(v, 'aiActions'), 'Done in total');
});

test('with no prior week nothing is claimed for this week', () => {
  const v = oneWeek({ outputSchema: withOsRoster(OS_ROSTER) });
  assert.equal(labelOf(v, 'outputSchema'), 'Done in total');
  assert.equal(stripNames(v, 'outputSchema').length, 3, 'everything done is still listed');
});

test('pieces that became done this week are listed, sorted by name', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(OS_PRIOR) },
                     { outputSchema: withOsRoster(OS_ROSTER) });
  assert.equal(labelOf(v, 'outputSchema'), 'Done this week');
  assert.deepEqual(stripNames(v, 'outputSchema'), ['Notion', 'Slack']);
});

test('a piece that was already done is not re-claimed', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(OS_PRIOR) },
                     { outputSchema: withOsRoster(OS_ROSTER) });
  assert.ok(!stripNames(v, 'outputSchema').includes('ClickUp'));
});

test('nothing new says so against a real prior week, rather than re-listing', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(OS_ROSTER) },
                     { outputSchema: withOsRoster(OS_ROSTER) });
  assert.equal(labelOf(v, 'outputSchema'), 'Nothing new this week');
  assert.deepEqual(stripNames(v, 'outputSchema'), []);
});

// The gap guard, mirroring deltaFor: W29 → W31 is a two-week jump, so anything
// "new" spans two weeks and must not be reported as one week's work.
test('a gap in the archive yields no comparison at all', () =>
  assert.equal(labelOf(twoWeeks({ outputSchema: withOsRoster(OS_PRIOR) },
                                { outputSchema: withOsRoster(OS_ROSTER) }, '2026-W29'), 'outputSchema'),
    'Done in total'));

test('a no-data previous week yields no comparison', () =>
  assert.equal(labelOf(twoWeeks({ outputSchema: { status: 'no-data', reason: 'build missing' } },
                                { outputSchema: withOsRoster(OS_ROSTER) }), 'outputSchema'),
    'Done in total'));

test('a previous week that never recorded a roster yields no comparison', () =>
  assert.equal(labelOf(twoWeeks({}, { outputSchema: withOsRoster(OS_ROSTER) }), 'outputSchema'),
    'Done in total'));

// An empty roster is indistinguishable from a roster the collector lost — it
// returns [] on a missing or malformed pieces.json — so it cannot be treated as
// "nothing was done last week".
test('a previous week with an empty roster yields no comparison', () =>
  assert.equal(labelOf(twoWeeks({ outputSchema: withOsRoster([]) },
                                { outputSchema: withOsRoster(OS_ROSTER) }), 'outputSchema'),
    'Done in total'));

test('selecting the oldest week in the archive has no prior week', () => {
  const a = { weeks: [snap('2026-W30', { outputSchema: withOsRoster(OS_ROSTER) }),
                      snap('2026-W31', { outputSchema: withOsRoster(OS_ROSTER) })] };
  assert.equal(labelOf(buildView(a, { weekId: '2026-W30' }), 'outputSchema'), 'Done in total');
});

test('a piece that fell back out of done is not claimed as this week\'s work', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(OS_ROSTER) },
                     { outputSchema: withOsRoster(OS_PRIOR) });
  assert.equal(labelOf(v, 'outputSchema'), 'Nothing new this week');
  assert.deepEqual(stripNames(v, 'outputSchema'), []);
});

test('each box carries its own diff', () => {
  const v = twoWeeks(
    { outputSchema: withOsRoster(OS_PRIOR),
      aiActions: withAiRoster([{ name: 'google-sheets', actions: 37, stage: 'pr-open' }]) },
    { outputSchema: withOsRoster(OS_ROSTER), aiActions: withAiRoster(AI_ROSTER) });
  assert.deepEqual(stripOf(v, 'outputSchema'), { kind: 'pieces', label: 'Done this week', more: 0, rest: [],
    items: [{ name: 'Notion', logo: null }, { name: 'Slack', logo: null }] });
  assert.deepEqual(stripOf(v, 'aiActions'), { kind: 'pieces', label: 'Done this week', more: 0, rest: [],
    items: [{ name: 'google-sheets', logo: null }] });
});

test('computing the diff does not mutate the input archive', () => {
  const input = { weeks: [snap('2026-W30', { outputSchema: withOsRoster(OS_PRIOR) }),
                          snap('2026-W31', { outputSchema: withOsRoster(OS_ROSTER) })] };
  const before = JSON.stringify(input);
  buildView(input);
  assert.equal(JSON.stringify(input), before);
});

// ── the pieces strip ───────────────────────────────────────────────────────
// The pieces behind the number, in the same box as the number, so the reader
// never holds a number in their head and scrolls for the list. Two rules carry
// the weight:
//
//   · the strip is CAPPED, so a big week cannot push the page past one screen;
//   · its LABEL says WHICH set it is. What landed this week is only claimable
//     against a real immediately-preceding week; with no prior week, or across
//     a gap, the strip is the running total and has to be labelled the total.
//     A finished backlog presented as one week's output is the overclaim this
//     page has guarded against throughout.
//
// The label and the list come out of one computation, so they can never end up
// describing different weeks.

const LOGO = (slug) => `https://cdn.activepieces.com/pieces/${slug}.png`;

// Notion's logo is deliberately null: the catalog resolves per piece, so one
// unresolved logo must cost that one logo and nothing else.
const OS_LOGOS = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2', logo: LOGO('clickup') },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'merged-not-live', tier: 'P1', logo: LOGO('slack') },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'live', tier: 'P1', logo: null },
  { name: 'Jira', actions: 9, triggers: 1, stage: 'review', tier: 'P3', logo: LOGO('jira') },
];

// Same four pieces a week earlier, with only ClickUp done.
const OS_LOGOS_PRIOR = OS_LOGOS.map((r) =>
  (r.name === 'ClickUp' ? r : { ...r, stage: 'review' }));

test('with nothing to diff against, the strip is every done piece, labelled the total', () =>
  assert.deepEqual(stripOf(oneWeek({ outputSchema: withOsRoster(OS_LOGOS) }), 'outputSchema'), {
    kind: 'pieces', label: 'Done in total', more: 0, rest: [],
    items: [{ name: 'ClickUp', logo: LOGO('clickup') },
            { name: 'Slack', logo: LOGO('slack') },
            { name: 'Notion', logo: null }],
  }));

test('with a consecutive prior week the strip is only what newly landed, labelled the week', () =>
  assert.deepEqual(stripOf(twoWeeks({ outputSchema: withOsRoster(OS_LOGOS_PRIOR) },
                                    { outputSchema: withOsRoster(OS_LOGOS) }), 'outputSchema'), {
    kind: 'pieces', label: 'Done this week', more: 0, rest: [],
    items: [{ name: 'Notion', logo: null }, { name: 'Slack', logo: LOGO('slack') }],
  }));

// The gap guard, mirroring deltaFor: W29 → W31 spans two weeks, so anything
// "new" across it is not one week's work and the strip falls back to the total.
test('across a gap in the archive the strip is the total, never a one-week claim', () => {
  const s = stripOf(twoWeeks({ outputSchema: withOsRoster(OS_LOGOS_PRIOR) },
                             { outputSchema: withOsRoster(OS_LOGOS) }, '2026-W29'), 'outputSchema');
  assert.equal(s.label, 'Done in total');
  assert.deepEqual(s.items.map((i) => i.name), ['ClickUp', 'Slack', 'Notion']);
});

test('a week where nothing crossed the line says so and shows no chips', () => {
  const s = stripOf(twoWeeks({ outputSchema: withOsRoster(OS_LOGOS) },
                             { outputSchema: withOsRoster(OS_LOGOS) }), 'outputSchema');
  assert.equal(s.label, 'Nothing new this week');
  assert.deepEqual(s.items, []);
  assert.equal(s.more, 0);
});

test('the strip is capped, and the pieces it could not fit are counted', () => {
  const many = Array.from({ length: STRIP_CAP + 3 }, (_, i) =>
    ({ name: `Piece ${i}`, actions: 20 - i, triggers: 0, stage: 'live', tier: 'P1', logo: LOGO(`p${i}`) }));
  const s = stripOf(oneWeek({ outputSchema: withOsRoster(many) }), 'outputSchema');
  assert.equal(s.items.length, STRIP_CAP);
  assert.equal(s.more, 3);
  assert.deepEqual(s.items[0], { name: 'Piece 0', logo: LOGO('p0') });
});

test('an exactly-full strip reports no remainder', () => {
  const many = Array.from({ length: STRIP_CAP }, (_, i) =>
    ({ name: `Piece ${i}`, actions: 1, triggers: 0, stage: 'live', tier: 'P1', logo: null }));
  assert.equal(stripOf(oneWeek({ outputSchema: withOsRoster(many) }), 'outputSchema').more, 0);
});

// `<img src="">` re-requests the page itself and renders as a broken image, so
// an empty URL has to reach the template as the same null as no URL at all.
test('an empty-string logo is normalised to null rather than reaching an img src', () => {
  const s = stripOf(oneWeek({ outputSchema: withOsRoster(
    [{ name: 'Slack', actions: 28, triggers: 4, stage: 'live', tier: 'P1', logo: '' }]) }), 'outputSchema');
  assert.deepEqual(s.items, [{ name: 'Slack', logo: null }]);
});

test('a roster row from a snapshot written before logos existed still gets a chip', () =>
  assert.deepEqual(stripOf(oneWeek({ aiActions: withAiRoster(AI_ROSTER) }), 'aiActions').items,
    [{ name: 'google-sheets', logo: null }]));

test('the AI-actions strip shows merged pieces only — not the PRs still open', () => {
  const s = stripOf(oneWeek({ aiActions: withAiRoster(AI_ROSTER) }), 'aiActions');
  assert.deepEqual(s.items.map((i) => i.name), ['google-sheets']);
  assert.equal(s.label, 'Done in total');
});

test("the testing tile's strip is the titles of the PRs it shipped", () =>
  assert.deepEqual(stripOf(buildView(archive), 'testing'),
    { kind: 'prs', label: 'Shipped', items: [{ name: 't' }], rest: [], more: 0 }));

test('the testing strip is capped like any other', () => {
  const shipped = Array.from({ length: STRIP_CAP + 1 }, (_, i) => ({ number: i, title: `pr ${i}`, url: 'u' }));
  const s = stripOf(oneWeek({ testing: { status: 'ok', prsMerged: shipped.length, commits: 9, shipped } }), 'testing');
  assert.equal(s.items.length, STRIP_CAP);
  assert.equal(s.more, 1);
});

test('a testing week that shipped no PRs carries no strip', () =>
  assert.equal(stripOf(oneWeek({ testing: { status: 'ok', prsMerged: 0, commits: 3, shipped: [] } }), 'testing'),
    null));

// ── the tickets strip ───────────────────────────────────────────────────────
// One chip per closed ticket: id, shortened title, and a link to the ticket
// itself. Label-less on purpose — the unit line ("closed this week") has
// already named the set, and a heading that repeats the previous line is
// filler. The fixture's title 'x' carries no routing tags, so it reaches the
// chip verbatim.
test('the tickets strip is one linked chip per closed ticket', () =>
  assert.deepEqual(stripOf(buildView(archive), 'tickets'),
    { kind: 'tickets', label: '', more: 0, rest: [],
      items: [{ id: 'PIE-101', name: 'x', href: 'https://linear.app/activepieces/issue/PIE-101' }] }));

// The id goes into a URL, so junk must cost the chip, never become a dead or
// dangerous link.
test('a ticket whose id is not Linear-shaped gets no chip', () => {
  const shipped = [
    { id: 'PIE-7', title: 'ok', assignee: 'kishan', team: 'Pieces' },
    { id: 'not an "id"', title: 'junk', assignee: 'kishan', team: 'Pieces' },
    { id: 42, title: 'numeric', assignee: 'kishan', team: 'Pieces' },
  ];
  const s = stripOf(oneWeek({ tickets: { status: 'ok', total: 3,
    byPerson: { kishan: 3, sanket: 0 }, shipped } }), 'tickets');
  assert.deepEqual(s.items.map((i) => i.id), ['PIE-7']);
});

test('a ticket with no usable title keeps its chip — the id alone still links', () => {
  const shipped = [{ id: 'GIT-9', assignee: 'sanket', team: 'GIT' }];
  const s = stripOf(oneWeek({ tickets: { status: 'ok', total: 1,
    byPerson: { kishan: 0, sanket: 1 }, shipped } }), 'tickets');
  assert.deepEqual(s.items, [{ id: 'GIT-9', name: '', href: 'https://linear.app/activepieces/issue/GIT-9' }]);
});

test('the tickets strip is capped like any other', () => {
  const shipped = Array.from({ length: STRIP_CAP + 2 }, (_, i) =>
    ({ id: `PIE-${i + 1}`, title: `t ${i}`, assignee: 'kishan', team: 'Pieces' }));
  const s = stripOf(oneWeek({ tickets: { status: 'ok', total: shipped.length,
    byPerson: { kishan: shipped.length, sanket: 0 }, shipped } }), 'tickets');
  assert.equal(s.items.length, STRIP_CAP);
  assert.equal(s.more, 2);
});

// `shipped` is optional detail the archive schema does not check, so a snapshot
// that lost it must cost the strip and never the tile's number.
test('a malformed shipped list costs the tickets strip, not the tile', () => {
  const v = oneWeek({ tickets: { status: 'ok', total: 2,
    byPerson: { kishan: 2, sanket: 0 }, shipped: 'nope' } });
  const tile = v.tiles.find((t) => t.key === 'tickets');
  assert.equal(tile.strip, null);
  assert.equal(tile.value, 2);
});

test('a no-data workstream carries no strip alongside its reason', () => {
  const tile = oneWeek({ outputSchema: { status: 'no-data', reason: 'build missing', roster: OS_LOGOS } })
    .tiles.find((t) => t.key === 'outputSchema');
  assert.equal(tile.status, 'no-data');
  assert.equal(tile.strip, null);
  assert.equal(tile.reason, 'not measured this week');
});

test('a workstream that recorded no roster at all carries no strip', () =>
  assert.equal(stripOf(buildView(archive), 'outputSchema'), null));

test('a workstream with nothing done yet carries no strip rather than an empty one', () =>
  assert.equal(stripOf(oneWeek({ aiActions: withAiRoster(
    [{ name: 'hubspot', actions: 22, stage: 'pr-open' }]) }), 'aiActions'), null));

test('building a strip does not mutate the archive', () => {
  const input = { weeks: [snap('2026-W30', { outputSchema: withOsRoster(OS_LOGOS_PRIOR) }),
                          snap('2026-W31', { outputSchema: withOsRoster(OS_LOGOS) })] };
  const before = JSON.stringify(input);
  buildView(input);
  assert.equal(JSON.stringify(input), before);
});

// `shipped` is optional detail the archive schema does not check, so a snapshot
// that lost it must cost the strip and never the tile's number.
test('a malformed shipped list costs the testing strip, not the tile', () => {
  const v = oneWeek({ testing: { status: 'ok', prsMerged: 2, commits: 4, shipped: 'nope' } });
  const tile = v.tiles.find((t) => t.key === 'testing');
  assert.equal(tile.strip, null);
  assert.equal(tile.value, 2);
});

test('a shipped entry with no title is skipped rather than rendered as a blank chip', () => {
  const shipped = [{ number: 1, url: 'u' }, { number: 2, title: 'feat: real one', url: 'u' }];
  assert.deepEqual(stripOf(oneWeek({ testing: { status: 'ok', prsMerged: 2, commits: 4, shipped } }), 'testing').items,
    [{ name: 'Real one' }]);
});

// ── a shipped PR, in words a reader outside the repo can use ───────────────
// The testing box lists the PRs that shipped, and their titles are commit
// subjects: `feat(health): piece health board, needs-attention inbox, persisted
// ru…`. Everything up to the colon is a machine-readable classifier — a type and
// a scope, for the repo's own tooling — and it is charged to the front of a chip
// that is clamped to half a strip row, so what it costs is the words at the end,
// ellipsized away. A project manager cannot use `feat(health)`; they can use
// `piece health board`.
//
// DISPLAY ONLY, and this is the last transform before the chip: the collector
// records the subject verbatim (see weekly-collect-testing.test.mjs) and the
// committed archive keeps it that way, because that is the record of what actually
// shipped.

test('a conventional-commit prefix is dropped and the sentence capitalised', () => {
  assert.equal(prTitle('feat(health): piece health board'), 'Piece health board');
  assert.equal(prTitle('fix: flaky run poller'), 'Flaky run poller');
  assert.equal(prTitle('chore(deps): bump the runner'), 'Bump the runner');
});

// `!` marks a breaking change and is part of the classifier, not of the sentence.
test('a breaking-change marker goes with the prefix', () => {
  assert.equal(prTitle('feat!: drop node 18'), 'Drop node 18');
  assert.equal(prTitle('refactor(engine)!: one runner per piece'), 'One runner per piece');
});

// Unchanged, capitalisation included: the transform's whole justification is that
// the prefix is not the author's words, so where there is no prefix there is
// nothing this may touch.
test('a title with no prefix passes through completely unchanged', () => {
  for (const title of ['piece health board', 'Add a run poller', 'PIE-114 fallout', 'wip on the tester']) {
    assert.equal(prTitle(title), title);
  }
});

// The prefix is matched against the conventional-commit VOCABULARY, not against
// `\w+:`. A colon is ordinary punctuation, and a generic pattern amputates whatever
// stands in front of one — `Update: the tester UI` losing its verb, a bare URL
// losing its scheme — which is a page misleading its reader to save nine
// characters.
test('a colon that is not a conventional-commit prefix is left alone', () => {
  for (const title of ['Update: the tester UI', 'note: read this first', 'https://github.com/x/y']) {
    assert.equal(prTitle(title), title);
  }
});

// All the title there is. Stripping it leaves a chip with a logo-less dot and no
// name, which reads as a rendering bug rather than as a PR.
test('a title that is nothing but a prefix keeps the original string', () => {
  for (const title of ['feat:', 'feat(health):', 'fix: ', 'chore(deps):   ']) {
    assert.equal(prTitle(title), title);
  }
});

test('the testing strip carries the display form of each title', () =>
  assert.deepEqual(stripOf(oneWeek({ testing: { status: 'ok', prsMerged: 2, commits: 4, shipped: [
    { number: 5, title: 'feat(health): piece health board', url: 'u' },
    { number: 6, title: 'fix(runner): stop double-counting a retry', url: 'u' },
  ] } }), 'testing').items,
  [{ name: 'Piece health board' }, { name: 'Stop double-counting a retry' }]));

// The archive is the record of what shipped, so the subject stays in it verbatim —
// including in the week this view was just built from.
test('rendering a week does not rewrite the title the snapshot recorded', () => {
  const shipped = [{ number: 5, title: 'feat(health): piece health board', url: 'u' }];
  const week = snap('2026-W31', { testing: { status: 'ok', prsMerged: 1, commits: 4, shipped } });
  buildView({ weeks: [week] });
  assert.equal(week.testing.shipped[0].title, 'feat(health): piece health board');
});

// ── which piece is which ───────────────────────────────────────────────────
// The week-over-week diff needs a piece's STABLE identity, and `displayName` is
// not one. It is editorial — the cloud catalog renames pieces; 'Telegram Bot'
// and 'Google Gemini' are current examples — and it is not even unique: two
// folders publish 'Cashfree Payments' and two publish 'Weekdone' today. A
// name-keyed diff therefore fails in both directions, and since the strip is
// now the tile's headline claim, both failures land above the fold:
//
//   · a rename re-reports finished work as this week's output;
//   · a duplicated name hides a genuinely new piece behind its twin, so the
//     tile's delta pill and its strip contradict each other.
//
// `folder` is the catalog's own key — the piece's directory — and is stable and
// unique, so the diff is keyed on it.

const foldered = (rows) => rows.map((r) => ({ ...r, folder: r.name.toLowerCase().replace(/ /g, '-') }));

// One piece, live both weeks, renamed upstream in between.
const TELEGRAM = [{ folder: 'telegram-bot', name: 'Telegram Bot', actions: 20, triggers: 0,
                    stage: 'live', tier: 'P1', logo: null }];
const TELEGRAM_RENAMED = [{ ...TELEGRAM[0], name: 'Telegram' }];

// Two DIFFERENT pieces that share a display name, as the catalog publishes them.
const CASHFREE_PRIOR = [
  { folder: '@activepieces/cashfree-payments', name: 'Cashfree Payments', actions: 5, triggers: 0,
    stage: 'live', tier: 'P1', logo: null },
  { folder: 'cashfree-payments', name: 'Cashfree Payments', actions: 3, triggers: 0,
    stage: 'review', tier: 'P2', logo: null },
];
const CASHFREE_NOW = CASHFREE_PRIOR.map((r) => ({ ...r, stage: 'live' }));

test('a piece the catalog renamed is not re-reported as this week\'s work', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(TELEGRAM) },
                     { outputSchema: withOsRoster(TELEGRAM_RENAMED) });
  assert.equal(labelOf(v, 'outputSchema'), 'Nothing new this week');
  assert.deepEqual(stripNames(v, 'outputSchema'), []);
});

test('a rename does not hide a piece that really did land the same week', () => {
  const landed = { folder: 'gemini', name: 'Google Gemini', actions: 4, triggers: 0,
                   stage: 'live', tier: 'P1', logo: null };
  const v = twoWeeks({ outputSchema: withOsRoster(TELEGRAM) },
                     { outputSchema: withOsRoster([...TELEGRAM_RENAMED, landed]) });
  assert.deepEqual(stripNames(v, 'outputSchema'), ['Google Gemini']);
});

test('two pieces sharing a display name are diffed as the separate pieces they are', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(CASHFREE_PRIOR) },
                     { outputSchema: withOsRoster(CASHFREE_NOW) });
  assert.equal(labelOf(v, 'outputSchema'), 'Done this week');
  assert.deepEqual(stripNames(v, 'outputSchema'), ['Cashfree Payments'],
    'the second folder crossed the line this week — once, not twice');
});

// Back-compat, and the reason the folder key cannot simply replace the name one:
// every snapshot already in the archive is name-keyed. Comparing this week's
// folders against those rows would find nothing in common and report the whole
// finished backlog as one week's output — the overclaim this page exists to
// avoid — so a prior roster that is not folder-keyed is diffed by name.
test('a prior roster written before folders existed is diffed by name, not re-reported wholesale', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(OS_ROSTER) },
                      { outputSchema: withOsRoster(foldered(OS_ROSTER)) });
  assert.equal(labelOf(v, 'outputSchema'), 'Nothing new this week');
  assert.deepEqual(stripNames(v, 'outputSchema'), []);
});

test('a piece that landed this week is still found across the name→folder change', () => {
  const v = twoWeeks({ outputSchema: withOsRoster(OS_PRIOR) },
                      { outputSchema: withOsRoster(foldered(OS_ROSTER)) });
  assert.deepEqual(stripNames(v, 'outputSchema'), ['Notion', 'Slack']);
});

// The AI-actions roster identifies a piece by SLUG in `name`, which already is
// the stable key, so it keeps working with no folder recorded at all.
test('the AI-actions diff still works with slugs as the identity', () => {
  const v = twoWeeks({ aiActions: withAiRoster([{ name: 'google-sheets', actions: 37, stage: 'pr-open' }]) },
                      { aiActions: withAiRoster(AI_ROSTER) });
  assert.deepEqual(stripNames(v, 'aiActions'), ['google-sheets']);
});

// ── what the reader is shown a piece as ────────────────────────────────────
// The AI-actions roster identifies a piece by SLUG, so its box rendered `apify`,
// `firecrawl` and `google-docs` beside a box rendering `ClickUp` and `Google
// Sheets`: one page, two naming conventions, and the lowercase-hyphen one is an
// internal identifier. The catalog's own `displayName` rides alongside the slug so
// the chip can show it.
//
// ALONGSIDE, never instead of. `name` is the identity this diff matches on and the
// only key the snapshots already in the archive carry — they hold no `folder` — so
// keying on the display name would find nothing in common with them and re-report
// the entire finished backlog as "Done this week". That is the overclaim this page
// has guarded against throughout, which is why the two tests below exist.

const AI_NAMED = [
  { name: 'google-docs', actions: 37, stage: 'merged', displayName: 'Google Docs', logo: LOGO('google-docs') },
  { name: 'hubspot', actions: 22, stage: 'pr-open', displayName: 'HubSpot', logo: LOGO('hubspot') },
];

test('a chip shows the catalog display name rather than the slug', () =>
  assert.deepEqual(stripOf(oneWeek({ aiActions: withAiRoster(AI_NAMED) }), 'aiActions').items,
    [{ name: 'Google Docs', logo: LOGO('google-docs') }]));

// Every week already in the archive, and any slug the catalog cannot name.
test('a row with no display name still shows its slug', () =>
  assert.deepEqual(stripNames(oneWeek({ aiActions: withAiRoster(AI_ROSTER) }), 'aiActions'),
    ['google-sheets']));

// The archive validates a string or null, but `byPerson` proves unvalidated
// shapes reach this file; a label is decoration, so junk costs the label, and the
// slug is the honest fallback — never a prettified guess at what it should say.
test('an unusable display name falls back to the slug rather than rendering as junk', () => {
  for (const displayName of [null, '', 42, {}]) {
    assert.deepEqual(stripNames(oneWeek({ aiActions: withAiRoster(
      [{ name: 'serp-api', actions: 4, stage: 'merged', displayName }]) }), 'aiActions'), ['serp-api'],
      `displayName ${JSON.stringify(displayName)} reached the page`);
  }
});

// The diff, across the exact change this slice makes: last week's rows are the
// slug-keyed ones already committed, this week's are the same pieces with a
// display name resolved. Nothing moved, and the page has to say so.
const AI_SLUGS_PRIOR = [
  { name: 'apify', actions: 12, stage: 'merged' },
  { name: 'firecrawl', actions: 9, stage: 'merged' },
];
const AI_SLUGS_NAMED = [
  { name: 'apify', actions: 12, stage: 'merged', displayName: 'Apify' },
  { name: 'firecrawl', actions: 9, stage: 'merged', displayName: 'Firecrawl' },
];

test('adding a display name does not re-report the finished backlog as this week', () => {
  const v = twoWeeks({ aiActions: withAiRoster(AI_SLUGS_PRIOR) },
                     { aiActions: withAiRoster(AI_SLUGS_NAMED) });
  assert.equal(labelOf(v, 'aiActions'), 'Nothing new this week');
  assert.deepEqual(stripNames(v, 'aiActions'), []);
});

test('a piece that really did land is still found once display names exist', () => {
  const landed = { name: 'sendinblue', actions: 6, stage: 'merged', displayName: 'Brevo' };
  const v = twoWeeks({ aiActions: withAiRoster(AI_SLUGS_PRIOR) },
                     { aiActions: withAiRoster([...AI_SLUGS_NAMED, landed]) });
  assert.equal(labelOf(v, 'aiActions'), 'Done this week');
  assert.deepEqual(stripNames(v, 'aiActions'), ['Brevo']);
});

// A folder is optional detail, like a logo: one catalog row missing it must cost
// that row's precision and nothing else — never the whole week's diff.
test('one row with no folder does not throw away the rest of the diff', () => {
  const prior = foldered(OS_PRIOR);
  const now = [{ ...foldered(OS_ROSTER)[0], folder: undefined }, ...foldered(OS_ROSTER).slice(1)];
  const v = twoWeeks({ outputSchema: withOsRoster(prior) }, { outputSchema: withOsRoster(now) });
  assert.deepEqual(stripNames(v, 'outputSchema'), ['Notion', 'Slack']);
});

// ── ticket titles, in words a reader outside the tracker can use ────────────
// Subjects lead with routing tags — `[BUG] [Pieces] …` — written for triage.
// Tags are stripped by VOCABULARY, exactly as prTitle strips conventional-commit
// types: a generic bracket-stripper would amputate `[Salesforce]`, which is the
// sentence's subject.

test('routing tags are stripped, informative brackets survive', () => {
  assert.equal(
    ticketTitle('[BUG] [Pieces] [Salesforce] Find Record always fails'),
    '[Salesforce] Find Record always fails');
  assert.equal(ticketTitle('[BUG]: Update member triggers twice.'), 'Update member triggers twice.');
  assert.equal(ticketTitle('[Feature] [Request] Bulk import'), 'Bulk import');
});

test('a title with no routing tags is untouched', () => {
  assert.equal(ticketTitle('Review #14413 pr'), 'Review #14413 pr');
  assert.equal(ticketTitle('[Salesforce] Find Record fails'), '[Salesforce] Find Record fails');
});

test('the sentence left behind is capitalised', () =>
  assert.equal(ticketTitle('[bug] fix the flow editor'), 'Fix the flow editor'));

test('a title that is nothing but tags keeps the original string', () => {
  assert.equal(ticketTitle('[BUG]'), '[BUG]');
  assert.equal(ticketTitle('[bug] [pieces] '), '[bug] [pieces] ');
});

// ── the testing tile, once coverage is measured ──────────────────────────────
// With a coverage roster recorded the headline is pieces COVERED; build
// progress (PRs, commits) drops to the note line. Without one — every older
// snapshot, and any week the tester was unreachable — the tile is build
// progress exactly as it always was (pinned by the tests above).

const COVERED = [
  { name: 'zendesk', folder: 'zendesk', displayName: 'Zendesk', logo: null, actions: 12, stage: 'covered' },
  { name: 'slack', folder: 'slack', displayName: 'Slack', logo: LOGO('slack'), actions: 2, stage: 'covered' },
];

const testingCovered = (roster = COVERED, extra = {}) => ({
  status: 'ok', prsMerged: 1, commits: 6,
  shipped: [{ number: 5, title: 'feat: x', url: 'https://x/pull/5' }],
  roster, catalogPieces: 720, ...extra,
});

const testingTile = (over) => oneWeek(over).tiles.find((t) => t.key === 'testing');

test('with coverage measured the headline is pieces covered, of the catalog', () => {
  const tile = testingTile({ testing: testingCovered() });
  assert.equal(tile.value, 2);
  assert.equal(tile.unit, 'of 720 pieces covered');
});

test('the covered strip is label-less chips, display names and logos intact', () =>
  assert.deepEqual(stripOf(oneWeek({ testing: testingCovered() }), 'testing'),
    { kind: 'pieces', label: '', more: 0, rest: [],
      items: [{ name: 'Zendesk', logo: null }, { name: 'Slack', logo: LOGO('slack') }] }));

test('build progress moves to the note line under the coverage headline', () =>
  assert.equal(testingTile({ testing: testingCovered() }).note, '1 PR merged · 6 commits this week'));

test('a week without coverage derives no note', () =>
  assert.equal(testingTile({}).note, ''));

test('with no catalog size recorded the unit does not invent a denominator', () => {
  const { catalogPieces, ...ws } = testingCovered();
  assert.equal(testingTile({ testing: ws }).unit, 'pieces covered');
  const one = testingTile({ testing: { ...ws, roster: [COVERED[0]] } });
  assert.equal(one.unit, 'piece covered');
});

test('an empty coverage roster is a measured zero, not a fallback to PRs', () => {
  const tile = testingTile({ testing: testingCovered([]) });
  assert.equal(tile.value, 0);
  assert.equal(tile.unit, 'of 720 pieces covered');
  assert.equal(tile.strip, null);
});

test('the covered strip is capped like any other', () => {
  const many = Array.from({ length: STRIP_CAP + 2 }, (_, i) =>
    ({ name: `p${i}`, folder: `p${i}`, displayName: `P${i}`, logo: null, actions: 1, stage: 'covered' }));
  const s = stripOf(oneWeek({ testing: testingCovered(many) }), 'testing');
  assert.equal(s.items.length, STRIP_CAP);
  assert.equal(s.more, 2);
});

// The changeover week: last week measured PRs only, this week measured
// coverage. A delta of "2 covered minus 1 PR" would be a number with no
// meaning, so there must be none at all.
test('the delta never compares a coverage count against a PR count', () => {
  const v = twoWeeks({}, { testing: testingCovered() });
  assert.equal(v.tiles.find((t) => t.key === 'testing').delta, null);
});

test('two measured weeks diff coverage against coverage', () => {
  const v = twoWeeks({ testing: testingCovered([COVERED[0]]) }, { testing: testingCovered() });
  assert.equal(v.tiles.find((t) => t.key === 'testing').delta, 1);
});

test('two unmeasured weeks still diff PRs against PRs', () => {
  const v = twoWeeks({}, {});
  assert.equal(v.tiles.find((t) => t.key === 'testing').delta, 0);
});

// ── curated notes ────────────────────────────────────────────────────────────
// One sentence of prose per tile per week, out of weekly/data/notes.json —
// display layer, so it can be written or fixed after the week is sealed.

test('a curated note reaches its tile, collapsed to one line', () => {
  const v = buildView(archive, { notes: { '2026-W31': { tickets: '  Salesforce fix\n shipped  ' } } });
  assert.equal(v.tiles.find((t) => t.key === 'tickets').note, 'Salesforce fix shipped');
});

test('a curated note beats the derived one', () => {
  const a = { weeks: [snap('2026-W31', { testing: testingCovered() })] };
  const v = buildView(a, { notes: { '2026-W31': { testing: 'Health board shipped' } } });
  assert.equal(v.tiles.find((t) => t.key === 'testing').note, 'Health board shipped');
});

test('a note for another week does not leak into this one', () => {
  const v = buildView(archive, { notes: { '2026-W30': { tickets: 'last week' } } });
  assert.equal(v.tiles.find((t) => t.key === 'tickets').note, '');
});

test('a non-string note is ignored rather than rendered', () => {
  const v = buildView(archive, { notes: { '2026-W31': { tickets: 42 } } });
  assert.equal(v.tiles.find((t) => t.key === 'tickets').note, '');
});

test('a degraded tile carries no note, even a curated one', () => {
  const a = { weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear pending' } })] };
  const v = buildView(a, { notes: { '2026-W31': { tickets: 'should not render' } } });
  assert.equal(v.tiles.find((t) => t.key === 'tickets').note, '');
});

// ── the overflow rides along ────────────────────────────────────────────────
// `items` is what a fresh page shows; `rest` is everything past the cap, in
// the same order, so the "+N more" button can reveal the WHOLE list — the two
// always partition the strip, and `more` is the count they must agree on.
test('a strip carries its whole overflow in rest, in order, agreeing with more', () => {
  const many = Array.from({ length: STRIP_CAP + 3 }, (_, i) =>
    ({ name: `Piece ${i}`, actions: 20 - i, triggers: 0, stage: 'live', tier: 'P1', logo: null }));
  const s = stripOf(oneWeek({ outputSchema: withOsRoster(many) }), 'outputSchema');
  assert.deepEqual(s.rest.map((i) => i.name), ['Piece 5', 'Piece 6', 'Piece 7']);
  assert.equal(s.rest.length, s.more);
});

test('a strip inside the cap has an empty rest', () =>
  assert.deepEqual(stripOf(buildView(archive), 'tickets').rest, []));
