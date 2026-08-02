// test/weekly-deltas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pick, deltaFor, seriesFor } from '../weekly/lib/deltas.mjs';

const snap = (week, total, live) => ({
  week,
  tickets: total === null ? { status: 'no-data', reason: 'x' } : { status: 'ok', total },
  outputSchema: { status: 'ok', live },
});

const weeks = [snap('2026-W29', 8, 5), snap('2026-W30', 9, 7), snap('2026-W31', 11, 9)];

test('pick reads a dotted path', () => assert.equal(pick(weeks[2], 'tickets.total'), 11));
test('pick returns null for a no-data workstream', () =>
  assert.equal(pick(snap('2026-W32', null, 9), 'tickets.total'), null));
test('pick returns null for an unknown path', () => assert.equal(pick(weeks[0], 'nope.nope'), null));
test('pick returns null for a missing snapshot', () => assert.equal(pick(undefined, 'tickets.total'), null));
test('pick preserves a real zero', () => assert.equal(pick(snap('2026-W32', 0, 0), 'tickets.total'), 0));

// ── derived metrics ────────────────────────────────────────────────────────
// Some headline numbers are not stored fields: "outputSchema merged" is
// live + mergedNotLive. Accepting an accessor here keeps every snapshot ever
// written renderable — no schema change, no backfill — and gives deltaFor and
// seriesFor the same derived metric for free.

test('pick accepts an accessor function', () =>
  assert.equal(pick(weeks[2], (s) => s.tickets.total + s.outputSchema.live), 20));

test('pick hands the accessor the whole snapshot', () => {
  let seen;
  pick(weeks[1], (s) => { seen = s; return 0; });
  assert.equal(seen, weeks[1]);
});

test('pick preserves a real zero from an accessor', () =>
  assert.equal(pick(snap('2026-W32', 0, 0), (s) => s.tickets.total), 0));

test('an accessor that throws yields null instead of escaping pick', () =>
  assert.equal(pick(weeks[0], () => { throw new Error('boom'); }), null));

test('an accessor on a missing snapshot yields null, not a TypeError', () =>
  assert.equal(pick(undefined, (s) => s.tickets.total), null));

test('an accessor returning a non-number yields null', () =>
  assert.equal(pick(weeks[0], () => 'nine'), null));

// The whole point of the no-data status: arithmetic over a degraded workstream
// produces NaN, and NaN must read as "we do not know", never as a number.
test('an accessor reading a no-data workstream yields null', () =>
  assert.equal(pick(snap('2026-W32', null, 9), (s) => s.tickets.total), null));

test('an accessor whose arithmetic goes NaN over a no-data workstream yields null', () =>
  assert.equal(pick(snap('2026-W32', null, 9), (s) => s.tickets.total + s.outputSchema.live), null));

test('deltaFor accepts an accessor', () =>
  assert.equal(deltaFor(weeks, '2026-W31', (s) => s.tickets.total), 2));

test('deltaFor with an accessor is null when a week is no-data', () => {
  const w = [snap('2026-W30', null, 7), snap('2026-W31', 11, 9)];
  assert.equal(deltaFor(w, '2026-W31', (s) => s.tickets.total), null);
});

test('seriesFor accepts an accessor', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W31', (s) => s.outputSchema.live + s.tickets.total, 2), [
    { week: '2026-W30', value: 16 },
    { week: '2026-W31', value: 20 },
  ]));

test('a throwing accessor inside seriesFor produces null points, not a crash', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W30', (s) => s.missing.deep, 2), [
    { week: '2026-W29', value: null },
    { week: '2026-W30', value: null },
  ]));

test('deltaFor computes week-over-week', () => assert.equal(deltaFor(weeks, '2026-W31', 'tickets.total'), 2));
test('deltaFor is null for the first week in the archive', () =>
  assert.equal(deltaFor(weeks, '2026-W29', 'tickets.total'), null));
test('deltaFor is null when the previous week is no-data', () => {
  const w = [snap('2026-W30', null, 7), snap('2026-W31', 11, 9)];
  assert.equal(deltaFor(w, '2026-W31', 'tickets.total'), null);
});
test('deltaFor is null when the previous week is absent from the archive', () => {
  const w = [snap('2026-W29', 8, 5), snap('2026-W31', 11, 9)];
  assert.equal(deltaFor(w, '2026-W31', 'tickets.total'), null);
});
test('deltaFor can be negative', () => {
  const w = [snap('2026-W30', 12, 7), snap('2026-W31', 11, 9)];
  assert.equal(deltaFor(w, '2026-W31', 'tickets.total'), -1);
});

test('seriesFor returns oldest to newest ending at the given week', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W31', 'outputSchema.live'), [
    { week: '2026-W29', value: 5 },
    { week: '2026-W30', value: 7 },
    { week: '2026-W31', value: 9 },
  ]));
test('seriesFor caps at count, keeping the most recent', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W31', 'tickets.total', 2), [
    { week: '2026-W30', value: 9 },
    { week: '2026-W31', value: 11 },
  ]));
test('seriesFor stops at the selected week, ignoring later ones', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W30', 'tickets.total').map((p) => p.week), ['2026-W29', '2026-W30']));
test('seriesFor emits null values for no-data weeks rather than dropping them', () => {
  const w = [snap('2026-W30', null, 7), snap('2026-W31', 11, 9)];
  assert.deepEqual(seriesFor(w, '2026-W31', 'tickets.total'), [
    { week: '2026-W30', value: null },
    { week: '2026-W31', value: 11 },
  ]);
});
