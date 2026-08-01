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
