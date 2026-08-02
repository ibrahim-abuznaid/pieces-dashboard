// test/weekly-snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, deriveDecisions, parseArgs } from '../weekly/snapshot.mjs';
import { validateSnapshot } from '../weekly/lib/archive.mjs';

const collectors = (over = {}) => ({
  outputSchema: () => ({ status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 }),
  aiActions: () => ({ status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 }),
  testing: () => ({ status: 'ok', prsMerged: 1, commits: 4, shipped: [] }),
  tickets: () => ({ status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
                    prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] }),
  ...over,
});

test('buildSnapshot stamps the week, its Sat→Fri window, and builtAt', () => {
  const snap = buildSnapshot({ weekId: '2026-W31', today: '2026-08-01', collectors: collectors() });
  assert.equal(snap.week, '2026-W31');
  assert.equal(snap.start, '2026-07-25');
  assert.equal(snap.end, '2026-07-31');
  assert.equal(snap.builtAt, '2026-08-01');
});

test('buildSnapshot output passes schema validation', () =>
  validateSnapshot(buildSnapshot({ weekId: '2026-W31', today: '2026-08-01', collectors: collectors() })));

test('a throwing collector becomes no-data rather than aborting the snapshot', () => {
  const snap = buildSnapshot({
    weekId: '2026-W31', today: '2026-08-01',
    collectors: collectors({ testing: () => { throw new Error('gh exploded'); } }),
  });
  assert.equal(snap.testing.status, 'no-data');
  assert.match(snap.testing.reason, /gh exploded/);
  assert.equal(snap.outputSchema.status, 'ok');   // the others still land
  validateSnapshot(snap);
});

// A decision line is an ASK: something a human has to go and do. Everything
// else the snapshot knows is already a tile, and mixing status into this list
// is what made the band on the page unreadable.

test('deriveDecisions asks for the cloud release, in plain words', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 6, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  });
  assert.deepEqual(lines, ['6 pieces merged but not live — needs a cloud release']);
});

test('the cloud-release ask agrees in number', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 1, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  });
  assert.deepEqual(lines, ['1 piece merged but not live — needs a cloud release']);
});

test('PRs in review and open blockers are status, not decisions', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 8 },
    aiActions: { status: 'ok', prOpen: 24, blockersOpen: 30 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  });
  assert.deepEqual(lines, []);
});

test('a degraded workstream is not a decision line — its tile already says so', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    testing: { status: 'no-data', reason: 'gh unreachable' },
    tickets: { status: 'no-data', reason: 'Linear refresh pending' },
  });
  assert.deepEqual(lines, []);
});

test('a clean week produces no decision lines', () => {
  assert.deepEqual(deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    testing: { status: 'ok' }, tickets: { status: 'ok' },
  }), []);
});

// --- CLI argument validation -------------------------------------------------
// lib/isoweek.mjs is deliberately permissive: isoWeekId() returns 'NaN-WNaN' for
// an unparseable date and mondayOfWeekId() checks only the YYYY-Wnn shape, not
// that the week exists. Both --week and --today come from a human, so this CLI
// is the boundary that has to reject a typo before it reaches the archive.

test('parseArgs defaults the week to the latest complete week for --today', () =>
  assert.deepEqual(parseArgs(['--today=2026-08-01']),
    { today: '2026-08-01', weekId: '2026-W31', force: false }));

test('parseArgs honours an explicit --week and --force-week', () =>
  assert.deepEqual(parseArgs(['--today=2026-08-01', '--week=2026-W30', '--force-week']),
    { today: '2026-08-01', weekId: '2026-W30', force: true }));

test('parseArgs rejects a wrongly formatted --today', () =>
  assert.throws(() => parseArgs(['--today=01/08/2026']), /--today/));

test('parseArgs rejects a --today that is not a real calendar date', () =>
  assert.throws(() => parseArgs(['--today=2026-02-30']), /--today.*calendar/));

test('parseArgs rejects a wrongly formatted --week', () =>
  assert.throws(() => parseArgs(['--week=2026-31']), /--week/));

test('parseArgs rejects a week number that does not exist in that ISO year', () => {
  assert.throws(() => parseArgs(['--week=2026-W54']), /--week.*not a real ISO week/);
  assert.throws(() => parseArgs(['--week=2026-W00']), /--week.*not a real ISO week/);
});

test('parseArgs accepts a legitimate 53rd week', () =>
  assert.equal(parseArgs(['--week=2026-W53', '--today=2026-08-01']).weekId, '2026-W53'));

test('parseArgs rejects an unrecognised argument instead of silently defaulting', () =>
  assert.throws(() => parseArgs(['--week', '2026-W31']), /unknown argument/));
