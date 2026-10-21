// test/ai-quality.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { k1Pace, qualityModel, windowWeekOf } from '../lib/ai-quality.mjs';

const TARGETS = { from: '2026-W39', targets: { aiActions: { kishan: 20, odai: 20 } } };
const wk = (week, merged, approved, end, extra = {}) => ({ week, end, aiActions: { status: 'ok', merged, approved }, targets: { aiActions: { kishan: 20, odai: 20 } }, ...extra });
// The council's reading of the archive: +29, +17, +42, +10 → 24.5 a week, 61%.
const WEEKS = [
  wk('2026-W38', 29, undefined, '2026-09-18', { targets: undefined }),
  wk('2026-W39', 58, 0, '2026-09-25'),
  wk('2026-W40', 75, 0, '2026-10-02'),
  wk('2026-W41', 117, 1, '2026-10-09'),
  wk('2026-W42', 127, 0, '2026-10-16'),
];

test('K1 is the week-over-week change in merged pieces against the summed targets', () => {
  const k = k1Pace({ weeks: WEEKS, targetsFile: TARGETS });
  assert.deepEqual(k.weeks.map((w) => w.gained), [29, 17, 42, 10]);
  assert.equal(k.target, 40);
  assert.equal(k.perWeek, 24.5);
  assert.equal(k.pacePct, 61.3);
  assert.deepEqual(k.weeks.map((w) => w.approved), [0, 0, 1, 0], 'approved rides on its own line');
});

test('a week after a gap, or a degraded one, is not measured -- never a 0 or a two-week jump', () => {
  const weeks = [WEEKS[0], WEEKS[1], WEEKS[3], { ...WEEKS[4], aiActions: { status: 'no-data', reason: 'x' } }];
  const k = k1Pace({ weeks, targetsFile: TARGETS });
  assert.deepEqual(k.weeks.map((w) => w.gained), [29, null, null]);
  assert.equal(k.measuredWeeks, 1);
  assert.equal(k.pacePct, 72.5);
});

test('a week archived without targets takes them from targets.json', () => {
  const k = k1Pace({ weeks: [WEEKS[0], { ...WEEKS[1], targets: undefined }], targetsFile: TARGETS });
  assert.equal(k.weeks[0].target, 40);
});

test('the tripwire counts trailing weeks under half the target', () => {
  const weeks = [...WEEKS, wk('2026-W43', 140, 0, '2026-10-23')];
  assert.equal(k1Pace({ weeks, targetsFile: TARGETS }).belowHalfStreak, 2);
  assert.equal(k1Pace({ weeks: WEEKS.slice(0, 4), targetsFile: TARGETS }).belowHalfStreak, 0);
});

test('the week in progress: main now against the last archived week, only when main is newer', () => {
  const k = k1Pace({ weeks: WEEKS, targetsFile: TARGETS, mergedNow: 145, approvedNow: 2, mainAt: '2026-10-21T11:27:29Z', today: '2026-10-21' });
  assert.deepEqual(k.thisWeek, { week: '2026-W43', soFar: 18, approved: 2 });
  const stale = k1Pace({ weeks: WEEKS, targetsFile: TARGETS, mergedNow: 113, mainAt: '2026-10-09T00:00:00Z', today: '2026-10-21' });
  assert.equal(stale.thisWeek, null, 'a checkout that has not fetched says nothing about this week');
});

test('the weekly window runs Saturday to Friday', () => {
  assert.equal(windowWeekOf('2026-10-23'), '2026-W43', 'Friday closes W43');
  assert.equal(windowWeekOf('2026-10-24'), '2026-W44', 'Saturday opens W44');
  assert.equal(windowWeekOf('2026-10-21'), '2026-W43');
});

test('no targets file, no K1', () => assert.equal(k1Pace({ weeks: WEEKS }), null));

test('the page model is null where nothing was measured', () => {
  const m = qualityModel({});
  for (const k of ['audit', 'rollout', 'k1', 'k3', 'k4', 'k9', 'checks', 'floor', 'soft']) assert.equal(m[k], null, k);
  assert.equal(qualityModel({ rollout: { measured: false, commit: 'abc', fetched: '2026-10-21' } }).k3, null, 'a failed funnel is a gap');
});

test('K9 is a gap when S2 could not be measured', () => {
  const audit = { commit: 'a', ai: { actions: 10, pieces: 2, unresolvedProps: 0 }, k4: { p1PassPct: 90, p1Actions: 1, piecesCleanOfP1: 1, piecesCleanIncludingS2: null },
    checks: { S2: { severity: 'P1', actions: null, pieces: null, demoted: null, reason: 'no-baseline' } }, baseline: null };
  const m = qualityModel({ audit });
  assert.equal(m.k9, null);
  assert.equal(m.k4.passPct, 90);
  assert.deepEqual(m.checks, [{ id: 'S2', severity: 'P1', actions: null, pieces: null }]);
});
