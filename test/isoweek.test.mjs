// test/isoweek.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekId, mondayOfWeekId, windowForWeekId, latestCompleteWeek, latestSealedWeek, previousWeekId } from '../lib/isoweek.mjs';

test('isoWeekId: mid-year Monday', () => assert.equal(isoWeekId('2026-07-27'), '2026-W31'));
test('isoWeekId: the Friday of the same week', () => assert.equal(isoWeekId('2026-07-31'), '2026-W31'));
test('isoWeekId: Sunday belongs to the week that started Monday', () =>
  assert.equal(isoWeekId('2026-08-02'), '2026-W31'));
test('isoWeekId: Jan 1 2026 is a Thursday, so week 01', () =>
  assert.equal(isoWeekId('2026-01-01'), '2026-W01'));
test('isoWeekId: late Dec rolls into the next ISO year', () =>
  assert.equal(isoWeekId('2025-12-29'), '2026-W01'));

test('mondayOfWeekId', () => assert.equal(mondayOfWeekId('2026-W31'), '2026-07-27'));
test('mondayOfWeekId: ISO year boundary', () => assert.equal(mondayOfWeekId('2026-W01'), '2025-12-29'));

test('windowForWeekId is 7 days ending Friday', () =>
  assert.deepEqual(windowForWeekId('2026-W31'), { start: '2026-07-25', end: '2026-07-31' }));

test('latestCompleteWeek on a Saturday returns the week that just ended', () =>
  assert.equal(latestCompleteWeek('2026-08-01'), '2026-W31'));
test('latestCompleteWeek on the Friday itself includes that Friday', () =>
  assert.equal(latestCompleteWeek('2026-07-31'), '2026-W31'));
test('latestCompleteWeek mid-week returns the prior Friday', () =>
  assert.equal(latestCompleteWeek('2026-07-29'), '2026-W30'));

test('previousWeekId', () => assert.equal(previousWeekId('2026-W31'), '2026-W30'));
test('previousWeekId crosses the ISO year', () => assert.equal(previousWeekId('2026-W01'), '2025-W52'));

// ── the week a job may safely seal ──────────────────────────────────────────
// The snapshot runs daily now, so it has to be correct on every day of the
// week and not just the Saturday it was written for.
test('on Saturday, the week that just ended is sealed', () =>
  assert.equal(latestSealedWeek('2026-09-19'), '2026-W38'));

// The one the old helper gets wrong. 2026-09-25 IS the last day of W39, so at
// 09:00 that morning the week still has most of a working day left.
test('on the final Friday, the week in progress is NOT sealed', () => {
  assert.equal(latestCompleteWeek('2026-09-25'), '2026-W39');
  assert.equal(latestSealedWeek('2026-09-25'), '2026-W38');
});

test('the sealed week holds all the way to the next Saturday', () => {
  for (const d of ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']) {
    assert.equal(latestSealedWeek(d), '2026-W38', `${d} should still seal W38`);
  }
  assert.equal(latestSealedWeek('2026-09-26'), '2026-W39');
});

// Seven chances at a week instead of one: that is the whole point of the daily
// schedule, and it only works if every day in the span agrees on the week.
test('a sealed week is never today, whatever day today is', () => {
  for (let i = 0; i < 28; i += 1) {
    const day = new Date(Date.UTC(2026, 8, 1) + i * 86400000).toISOString().slice(0, 10);
    assert.ok(windowForWeekId(latestSealedWeek(day)).end < day, `${day} sealed a week containing itself`);
  }
});
