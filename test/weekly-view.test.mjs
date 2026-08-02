import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView, plural } from '../weekly/lib/view.mjs';

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
  assert.equal(tile.sub, '9 live on cloud · 8 in review');
});

test('the outputSchema delta and sparkline follow the same derived merged metric', () => {
  const tile = buildView(archive).tiles[0];
  assert.equal(tile.delta, 2);                  // 13 merged last week → 15
  assert.deepEqual(tile.spark, [{ week: '2026-W30', value: 13 }, { week: '2026-W31', value: 15 }]);
});

test('the testing tile pluralises its unit and sub-line', () => {
  const one = buildView(archive).tiles.find((t) => t.key === 'testing');
  assert.equal(one.value, 1);
  assert.equal(one.unit, 'PR shipped');
  assert.equal(one.sub, '4 commits');
  const many = oneWeek({ testing: { status: 'ok', prsMerged: 3, commits: 1, shipped: [] } })
    .tiles.find((t) => t.key === 'testing');
  assert.equal(many.unit, 'PRs shipped');
  assert.equal(many.sub, '1 commit');
});

test('the tickets tile splits the week by person', () => {
  const tile = buildView(archive).tiles.find((t) => t.key === 'tickets');
  assert.equal(tile.value, 11);
  assert.equal(tile.unit, 'closed this week');
  assert.equal(tile.sub, '5 Kishan · 6 Sanket');
});

test('every ok tile carries the full field set', () => {
  for (const t of buildView(archive).tiles.filter((x) => x.status === 'ok')) {
    assert.deepEqual(Object.keys(t).sort(),
      ['delta', 'key', 'reason', 'spark', 'status', 'sub', 'title', 'unit', 'value']);
  }
});

test('a no-data workstream produces a no-data tile, not a zero', () => {
  const a = { weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear pending' } })] };
  const tile = buildView(a).tiles.find((t) => t.key === 'tickets');
  assert.equal(tile.status, 'no-data');
  assert.equal(tile.value, null);
  assert.equal(tile.delta, null);
  assert.deepEqual(tile.spark, []);
  assert.match(tile.reason, /Linear pending/);
});

// The caveat still has to be on the page — the tile itself is now too small to
// carry it, so it moves to the footer rather than disappearing.
test('the build-progress caveat survives as a page footnote', () =>
  assert.match(buildView(archive).testingNote, /health/i));

test('no caveat is claimed when the testing workstream is degraded', () =>
  assert.equal(oneWeek({ testing: { status: 'no-data', reason: 'gh down' } }).testingNote, ''));

test('people rows come from the tickets workstream', () =>
  assert.deepEqual(buildView(archive).people, [
    { key: 'kishan', name: 'Kishan', tickets: 5, prsMerged: 3, reviews: 12 },
    { key: 'sanket', name: 'Sanket', tickets: 6, prsMerged: 4, reviews: 9 },
  ]));

test('people is empty when tickets is no-data', () => {
  const a = { weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason: 'x' } })] };
  assert.deepEqual(buildView(a).people, []);
});

test('the heading names the team and the week number', () =>
  assert.equal(buildView(archive).title, 'Pieces Team · Week 31'));

test('the date range collapses a same-month week', () =>
  assert.equal(buildView(archive).range, 'Jul 25–31'));

test('a range that crosses a month names both months', () =>
  assert.equal(buildView({ weeks: [snap('2026-W31', { start: '2026-07-27', end: '2026-08-02' })] }).range,
    'Jul 27 – Aug 2'));

test('shipped is split by source', () => {
  const v = buildView(archive);
  assert.equal(v.shipped.tickets.length, 1);
  assert.equal(v.shipped.testing.length, 1);
});

// ── the verdict ────────────────────────────────────────────────────────────
// The lede: what a reader who reads nothing else should walk away with. Built
// only from workstreams that actually reported, so it can never state a number
// the collectors did not measure.

test('the verdict states where the two headline workstreams stand', () =>
  assert.equal(buildView(archive).verdict,
    'Output schemas are merged on 15 of 756 pieces; 9 are live on cloud. 2 pieces have AI actions.'));

test('a degraded workstream is named in a short trailing clause', () =>
  assert.equal(oneWeek({ tickets: { status: 'no-data', reason: 'Linear refresh pending' } }).verdict,
    'Output schemas are merged on 15 of 756 pieces; 9 are live on cloud. 2 pieces have AI actions.'
    + ' Ticket data unavailable.'));

test('several degraded workstreams share one clause', () =>
  assert.match(oneWeek({
    testing: { status: 'no-data', reason: 'gh down' },
    tickets: { status: 'no-data', reason: 'Linear refresh pending' },
  }).verdict, /Ticket and testing data unavailable\.$/));

test('the verdict falls back to the workstreams that did report', () => {
  const v = oneWeek({ outputSchema: { status: 'no-data', reason: 'build missing' } }).verdict;
  assert.match(v, /^2 pieces have AI actions\./);
  assert.match(v, /Output-schema data unavailable\.$/);
  assert.doesNotMatch(v, /Output schemas are merged/);
});

test('the verdict says so plainly when nothing reported at all', () =>
  assert.equal(oneWeek({
    outputSchema: { status: 'no-data', reason: 'a' }, aiActions: { status: 'no-data', reason: 'b' },
    testing: { status: 'no-data', reason: 'c' }, tickets: { status: 'no-data', reason: 'd' },
  }).verdict, 'No data is available for this week.'));

test('the verdict stays at two sentences before the degraded clause', () => {
  const sentences = buildView(archive).verdict.split('. ').length;
  assert.ok(sentences <= 2, `verdict ran to ${sentences} sentences`);
});

test('the verdict is grammatical for singular counts', () => {
  const v = oneWeek({
    outputSchema: { status: 'ok', live: 1, mergedNotLive: 0, review: 0, todo: 1, totalPieces: 756 },
    aiActions: { status: 'ok', merged: 1, prOpen: 0, assigned: 0, held: 0, totalPieces: 28, blockersOpen: 0 },
  }).verdict;
  assert.match(v, /1 of 756 pieces; 1 is live on cloud\./);
  assert.match(v, /1 piece has AI actions\./);
});

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
// The per-piece detail behind the outputSchema and AI-actions tiles. It is
// OPTIONAL: snapshots taken before the collectors recorded it carry no roster
// at all, and must keep rendering.

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

test('rosters is empty when no workstream carries one', () =>
  assert.deepEqual(buildView(archive).rosters, []));

test('an absent roster keeps the workstream out of rosters — back-compat with older snapshots', () =>
  assert.deepEqual(oneWeek({ aiActions: withAiRoster(AI_ROSTER) }).rosters.map((r) => r.key), ['aiActions']));

test('an empty roster array produces no roster entry', () =>
  assert.deepEqual(oneWeek({ outputSchema: withOsRoster([]) }).rosters, []));

test('a no-data workstream produces no roster entry even if one is attached', () => {
  const v = oneWeek({ outputSchema: { status: 'no-data', reason: 'build missing', roster: OS_ROSTER } });
  assert.deepEqual(v.rosters, []);
});

test('the outputSchema roster groups by stage in pipeline order, most advanced first', () =>
  assert.deepEqual(oneWeek({ outputSchema: withOsRoster(OS_ROSTER) }).rosters[0], {
    key: 'outputSchema', title: 'outputSchema', total: 4, unit: 'actions',
    groups: [
      { stage: 'live', label: 'Live on cloud', count: 2,
        pieces: [{ name: 'ClickUp', actions: 31, tier: 'P2' }, { name: 'Notion', actions: 12, tier: 'P1' }] },
      { stage: 'merged-not-live', label: 'Merged, awaiting release', count: 1,
        pieces: [{ name: 'Slack', actions: 28, tier: 'P1' }] },
      { stage: 'review', label: 'In review', count: 1,
        pieces: [{ name: 'Jira', actions: 9, tier: 'P3' }] },
    ],
    done: { total: 3, stages: ['live', 'merged-not-live'], thisWeek: [], hasPrior: false },
  }));

test('the AI-actions roster uses its own stage order, labels and unit', () =>
  assert.deepEqual(oneWeek({ aiActions: withAiRoster(AI_ROSTER) }).rosters[0], {
    key: 'aiActions', title: 'AI-actions', total: 3, unit: 'AI actions',
    groups: [
      { stage: 'merged', label: 'Merged', count: 1, pieces: [{ name: 'google-sheets', actions: 37 }] },
      { stage: 'pr-open', label: 'PR open', count: 1, pieces: [{ name: 'hubspot', actions: 22 }] },
      { stage: 'held', label: 'Held', count: 1, pieces: [{ name: 'intercom', actions: 8 }] },
    ],
    done: { total: 1, stages: ['merged'], thisWeek: [], hasPrior: false },
  }));

test('an empty stage produces no group at all', () => {
  const v = oneWeek({ outputSchema: withOsRoster(OS_ROSTER), aiActions: withAiRoster(AI_ROSTER) });
  assert.deepEqual(v.rosters[0].groups.map((g) => g.stage), ['live', 'merged-not-live', 'review']);
  assert.deepEqual(v.rosters[1].groups.map((g) => g.stage), ['merged', 'pr-open', 'held']);
});

test('the remaining known stages label correctly when they are populated', () => {
  const v = oneWeek({
    outputSchema: withOsRoster([{ name: 'Asana', actions: 4, triggers: 0, stage: 'in-progress', tier: 'P2' }]),
    aiActions: withAiRoster([{ name: 'stripe', actions: 6, stage: 'assigned' }]),
  });
  assert.deepEqual(v.rosters[0].groups[0], { stage: 'in-progress', label: 'In progress', count: 1,
    pieces: [{ name: 'Asana', actions: 4, tier: 'P2' }] });
  assert.deepEqual(v.rosters[1].groups[0], { stage: 'assigned', label: 'Assigned', count: 1,
    pieces: [{ name: 'stripe', actions: 6 }] });
});

// A piece vanishing from the page because upstream added a status is exactly
// the silent loss this project keeps guarding against.
test('an unrecognised stage gets its own trailing group instead of vanishing', () => {
  const v = oneWeek({ outputSchema: withOsRoster([
    ...OS_ROSTER,
    { name: 'Airtable', actions: 3, triggers: 0, stage: 'sunsetting', tier: 'P4' },
  ]) });
  const groups = v.rosters[0].groups;
  assert.deepEqual(groups.map((g) => g.stage), ['live', 'merged-not-live', 'review', 'sunsetting']);
  assert.deepEqual(groups.at(-1), { stage: 'sunsetting', label: 'sunsetting', count: 1,
    pieces: [{ name: 'Airtable', actions: 3, tier: 'P4' }] });
  assert.equal(v.rosters[0].total, 5);
});

test('several unrecognised stages each keep a group, in first-seen order', () => {
  const v = oneWeek({ aiActions: withAiRoster([
    { name: 'a', actions: 9, stage: 'quarantined' },
    { name: 'b', actions: 5, stage: 'merged' },
    { name: 'c', actions: 2, stage: 'draft' },
  ]) });
  assert.deepEqual(v.rosters[0].groups.map((g) => g.stage), ['merged', 'quarantined', 'draft']);
});

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

test('rosters preserve the order the collector recorded, they are not re-sorted', () =>
  assert.deepEqual(
    oneWeek({ outputSchema: withOsRoster([
      { name: 'Small', actions: 1, triggers: 0, stage: 'live', tier: 'P3' },
      { name: 'Big', actions: 99, triggers: 0, stage: 'live', tier: 'P1' },
    ]) }).rosters[0].groups[0].pieces.map((p) => p.name),
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

test('the AI-actions tile counts against the whole catalog when the snapshot recorded it', () => {
  const t = aiTile(oneWeek({ aiActions: withCatalog(756) }));
  assert.equal(t.unit, 'of 756 have AI actions');
  assert.equal(t.sub, '28 tracked · 24 PRs open · 30 blockers');
});

test('the tracked count is still the note, not the headline denominator', () => {
  const t = aiTile(oneWeek({ aiActions: withCatalog(756) }));
  assert.equal(t.value, 2);
  assert.doesNotMatch(t.unit, /28/);
});

test('a snapshot without a catalog keeps the tracked-count wording', () => {
  const t = aiTile(buildView(archive));
  assert.equal(t.unit, 'of 28 merged');
  assert.equal(t.sub, '28 tracked · 24 PRs open · 30 blockers');
});

// typeof, not truthiness: 0 is a recorded catalog size, not a missing one.
test('a zero catalog is still a recorded catalog', () =>
  assert.equal(aiTile(oneWeek({ aiActions: withCatalog(0) })).unit, 'of 0 have AI actions'));

test('a single open PR and a single blocker read in the singular', () =>
  assert.equal(aiTile(oneWeek({ aiActions: { status: 'ok', merged: 2, prOpen: 1, assigned: 0,
    held: 2, totalPieces: 28, blockersOpen: 30 } })).sub, '28 tracked · 1 PR open · 30 blockers'));

// ── done totals ────────────────────────────────────────────────────────────
// "Done" means merged: `live` + `merged-not-live` for outputSchema (both are
// merged; `live` additionally shipped to cloud), `merged` for AI-actions. It is
// split into a running total and what crossed the line THIS week — and the
// second number is only claimable against a real immediately-preceding week.
// With nothing to diff against, every piece ever finished would otherwise be
// reported as finished this week: the same silent overclaim deltaFor guards.

const osDone = (v) => v.rosters.find((r) => r.key === 'outputSchema').done;
const aiDone = (v) => v.rosters.find((r) => r.key === 'aiActions').done;
const twoWeeks = (prev, cur, prevWeek = '2026-W30') =>
  buildView({ weeks: [snap(prevWeek, prev), snap('2026-W31', cur)] });

// ClickUp live, Slack merged-not-live, Notion live, Jira review → 3 done.
const OS_PRIOR = [
  { name: 'ClickUp', actions: 31, triggers: 5, stage: 'live', tier: 'P2' },
  { name: 'Slack', actions: 28, triggers: 4, stage: 'review', tier: 'P1' },
  { name: 'Notion', actions: 12, triggers: 2, stage: 'review', tier: 'P1' },
  { name: 'Jira', actions: 9, triggers: 1, stage: 'review', tier: 'P3' },
];

test('outputSchema done counts live and merged-not-live, and says so', () => {
  const d = osDone(oneWeek({ outputSchema: withOsRoster(OS_ROSTER) }));
  assert.equal(d.total, 3);
  assert.deepEqual(d.stages, ['live', 'merged-not-live']);
});

test('AI-actions done counts only merged', () => {
  const d = aiDone(oneWeek({ aiActions: withAiRoster(AI_ROSTER) }));
  assert.equal(d.total, 1);
  assert.deepEqual(d.stages, ['merged']);
});

test('with no prior week nothing is claimed for this week', () => {
  const d = osDone(oneWeek({ outputSchema: withOsRoster(OS_ROSTER) }));
  assert.equal(d.hasPrior, false);
  assert.deepEqual(d.thisWeek, []);
  assert.equal(d.total, 3, 'the running total is still reported');
});

test('pieces that became done this week are listed, sorted by name', () => {
  const d = osDone(twoWeeks({ outputSchema: withOsRoster(OS_PRIOR) },
                             { outputSchema: withOsRoster(OS_ROSTER) }));
  assert.equal(d.hasPrior, true);
  assert.deepEqual(d.thisWeek, ['Notion', 'Slack']);
  assert.equal(d.total, 3);
});

test('a piece that was already done is not re-claimed', () => {
  const d = osDone(twoWeeks({ outputSchema: withOsRoster(OS_PRIOR) },
                             { outputSchema: withOsRoster(OS_ROSTER) }));
  assert.ok(!d.thisWeek.includes('ClickUp'));
});

test('nothing new is an empty list against a real prior week, not a missing one', () => {
  const d = osDone(twoWeeks({ outputSchema: withOsRoster(OS_ROSTER) },
                             { outputSchema: withOsRoster(OS_ROSTER) }));
  assert.equal(d.hasPrior, true);
  assert.deepEqual(d.thisWeek, []);
});

// The gap guard, mirroring deltaFor: W29 → W31 is a two-week jump, so anything
// "new" spans two weeks and must not be reported as one week's work.
test('a gap in the archive yields no comparison at all', () => {
  const d = osDone(twoWeeks({ outputSchema: withOsRoster(OS_PRIOR) },
                             { outputSchema: withOsRoster(OS_ROSTER) }, '2026-W29'));
  assert.equal(d.hasPrior, false);
  assert.deepEqual(d.thisWeek, []);
});

test('a no-data previous week yields no comparison', () => {
  const d = osDone(twoWeeks({ outputSchema: { status: 'no-data', reason: 'build missing' } },
                             { outputSchema: withOsRoster(OS_ROSTER) }));
  assert.equal(d.hasPrior, false);
  assert.deepEqual(d.thisWeek, []);
});

test('a previous week that never recorded a roster yields no comparison', () => {
  const d = osDone(twoWeeks({}, { outputSchema: withOsRoster(OS_ROSTER) }));
  assert.equal(d.hasPrior, false);
  assert.deepEqual(d.thisWeek, []);
});

// An empty roster is indistinguishable from a roster the collector lost — it
// returns [] on a missing or malformed pieces.json — so it cannot be treated as
// "nothing was done last week".
test('a previous week with an empty roster yields no comparison', () => {
  const d = osDone(twoWeeks({ outputSchema: withOsRoster([]) },
                             { outputSchema: withOsRoster(OS_ROSTER) }));
  assert.equal(d.hasPrior, false);
  assert.deepEqual(d.thisWeek, []);
});

test('selecting the oldest week in the archive has no prior week', () => {
  const a = { weeks: [snap('2026-W30', { outputSchema: withOsRoster(OS_ROSTER) }),
                      snap('2026-W31', { outputSchema: withOsRoster(OS_ROSTER) })] };
  const d = osDone(buildView(a, { weekId: '2026-W30' }));
  assert.equal(d.hasPrior, false);
  assert.deepEqual(d.thisWeek, []);
});

test('a piece that fell back out of done is not listed and lowers the total', () => {
  const d = osDone(twoWeeks({ outputSchema: withOsRoster(OS_ROSTER) },
                             { outputSchema: withOsRoster(OS_PRIOR) }));
  assert.equal(d.total, 1);
  assert.deepEqual(d.thisWeek, []);
});

test('each roster carries its own done totals', () => {
  const v = twoWeeks(
    { outputSchema: withOsRoster(OS_PRIOR),
      aiActions: withAiRoster([{ name: 'google-sheets', actions: 37, stage: 'pr-open' }]) },
    { outputSchema: withOsRoster(OS_ROSTER), aiActions: withAiRoster(AI_ROSTER) });
  assert.deepEqual(osDone(v), { total: 3, stages: ['live', 'merged-not-live'],
    thisWeek: ['Notion', 'Slack'], hasPrior: true });
  assert.deepEqual(aiDone(v), { total: 1, stages: ['merged'],
    thisWeek: ['google-sheets'], hasPrior: true });
});

test('computing done does not mutate the input archive', () => {
  const input = { weeks: [snap('2026-W30', { outputSchema: withOsRoster(OS_PRIOR) }),
                          snap('2026-W31', { outputSchema: withOsRoster(OS_ROSTER) })] };
  const before = JSON.stringify(input);
  buildView(input);
  assert.equal(JSON.stringify(input), before);
});
