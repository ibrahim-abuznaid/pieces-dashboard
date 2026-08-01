import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../weekly/lib/view.mjs';

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

test('outputSchema tile carries value, delta and sparkline', () => {
  const tile = buildView(archive).tiles[0];
  assert.equal(tile.value, 9);
  assert.equal(tile.delta, 2);
  assert.deepEqual(tile.spark, [{ week: '2026-W30', value: 7 }, { week: '2026-W31', value: 9 }]);
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

test('the testing tile carries the build-progress caveat', () =>
  assert.match(buildView(archive).tiles.find((t) => t.key === 'testing').note, /health/i));

test('people rows come from the tickets workstream', () =>
  assert.deepEqual(buildView(archive).people, [
    { key: 'kishan', name: 'Kishan', tickets: 5, prsMerged: 3, reviews: 12 },
    { key: 'sanket', name: 'Sanket', tickets: 6, prsMerged: 4, reviews: 9 },
  ]));

test('people is empty when tickets is no-data', () => {
  const a = { weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason: 'x' } })] };
  assert.deepEqual(buildView(a).people, []);
});

test('label reads as a human date range', () =>
  assert.equal(buildView(archive).label, 'Week 31 · Jul 25 – Jul 31, 2026'));

test('shipped is split by source', () => {
  const v = buildView(archive);
  assert.equal(v.shipped.tickets.length, 1);
  assert.equal(v.shipped.testing.length, 1);
});

test('decisions pass through', () =>
  assert.match(buildView(archive).decisions[0], /cloud-live/));

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
  assert.equal(t.unit, 'of 756 pieces have AI actions');
  assert.equal(t.note, '28 tracked · 24 PRs open · 30 blockers');
});

test('the tracked count is still the note, not the headline denominator', () => {
  const t = aiTile(oneWeek({ aiActions: withCatalog(756) }));
  assert.equal(t.value, 2);
  assert.doesNotMatch(t.unit, /28/);
});

test('a snapshot without a catalog keeps the tracked-count wording', () => {
  const t = aiTile(buildView(archive));
  assert.equal(t.unit, 'of 28 merged');
  assert.equal(t.note, '24 PRs open · 30 blockers');
});

// typeof, not truthiness: 0 is a recorded catalog size, not a missing one.
test('a zero catalog is still a recorded catalog', () =>
  assert.equal(aiTile(oneWeek({ aiActions: withCatalog(0) })).unit, 'of 0 pieces have AI actions'));

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
