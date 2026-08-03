// test/weekly-deltas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as deltas from '../weekly/lib/deltas.mjs';
import { pick, deltaFor } from '../weekly/lib/deltas.mjs';

// There is no `seriesFor` any more, so there are no series tests here. It read a
// window of weeks for the per-tile sparkline, and the sparkline is gone: it drew
// two entries eleven weeks apart as adjacent weeks under a caption that called
// them consecutive, and it was the tallest block on a page whose acceptance
// criterion is fitting one laptop screen. `deltaFor` below is now the only read
// that crosses weeks, and its gap guard is asserted at the bottom of this file.
// That a hole in the archive cannot be drawn as a trend is asserted on the
// rendered page, in test/weekly-render.test.mjs.

// The difference that mattered: `deltaFor` REFUSES to compare across a hole
// (the test at the bottom of this file), while `seriesFor` sliced the weeks array
// by index, so a missing week was simply not among the points and the two either
// side of it were drawn adjacent. Any future windowed read would have the same
// hazard, so the module's surface is pinned rather than the one function's name.
test('the module exposes no windowed read for a chart to draw a gap as adjacent', () =>
  assert.deepEqual(Object.keys(deltas).sort(), ['deltaFor', 'pick']));

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
// written renderable — no schema change, no backfill — and gives deltaFor the
// same derived metric for free.

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

