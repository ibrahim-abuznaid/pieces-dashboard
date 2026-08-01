// test/isoweek.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekId, mondayOfWeekId, windowForWeekId, latestCompleteWeek, previousWeekId } from '../lib/isoweek.mjs';

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
