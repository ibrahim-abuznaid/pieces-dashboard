// test/weekly-snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, deriveDecisions, parseArgs, testerClient } from '../weekly/snapshot.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSnapshot } from '../weekly/lib/archive.mjs';

const collectors = (over = {}) => ({
  outputSchema: () => ({ status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 }),
  aiActions: () => ({ status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 }),
  uiImprovements: () => ({ status: 'ok', merged: 5, live: 5, review: 2, assigned: 0, totalPieces: 765 }),
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
    uiImprovements: { status: 'ok', merged: 5, live: 5 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  });
  assert.deepEqual(lines, ['6 pieces merged but not live — needs a cloud release']);
});

test('the cloud-release ask agrees in number', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 1, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    uiImprovements: { status: 'ok', merged: 5, live: 5 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  });
  assert.deepEqual(lines, ['1 piece merged but not live — needs a cloud release']);
});

// The same ask, for the second rollout that ships metadata through the cloud
// registry. Derived from merged − live rather than stored, so it cannot
// disagree with the tile: a week that recorded no cloud state asks for nothing.
test('the property-UI rollout asks for the cloud release on the same terms', () => {
  assert.deepEqual(deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    uiImprovements: { status: 'ok', merged: 5, live: 4 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  }), ['1 piece with the new property UI merged but not live — needs a cloud release']);
});

test('a week that never measured cloud state asks nothing of it', () => {
  assert.deepEqual(deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    uiImprovements: { status: 'ok', merged: 5, review: 2, assigned: 0, totalPieces: 765 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  }), []);
});

test('PRs in review and open blockers are status, not decisions', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 8 },
    aiActions: { status: 'ok', prOpen: 24, blockersOpen: 30 },
    uiImprovements: { status: 'ok', merged: 5, live: 5 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  });
  assert.deepEqual(lines, []);
});

test('a degraded workstream is not a decision line — its tile already says so', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    uiImprovements: { status: 'no-data', reason: 'build output missing' },
    testing: { status: 'no-data', reason: 'gh unreachable' },
    tickets: { status: 'no-data', reason: 'Linear refresh pending' },
  });
  assert.deepEqual(lines, []);
});

test('a clean week produces no decision lines', () => {
  assert.deepEqual(deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    uiImprovements: { status: 'ok', merged: 5, live: 5 },
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

// ── the tester client ───────────────────────────────────────────────────────
// The piece tester mounts requireAuth in front of every /api route, so the
// coverage endpoint needs a session. The login lives here rather than in the
// collector so that collect/testing.mjs stays a "GET this URL" consumer.
const JAR = join(tmpdir(), 'pieces-dashboard-test.cookies');
const recorder = (fail = null) => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input });
    if (fail && args.join(' ').includes(fail)) throw new Error('boom');
    return '[]';
  };
  return { calls, exec };
};

test('no password means no login — the collector gets a plain GET', () => {
  const { calls, exec } = recorder();
  const { curl } = testerClient({ baseUrl: 'http://tester.example', password: '', exec, jarPath: JAR });
  curl('http://tester.example/api/coverage');
  assert.equal(calls.length, 1, 'a login was attempted with no password to send');
  assert.ok(!calls[0].args.includes('-b'));
});

test('an unset tester URL means no login either', () => {
  const { calls, exec } = recorder();
  testerClient({ baseUrl: undefined, password: 'hunter2', exec, jarPath: JAR });
  assert.equal(calls.length, 0);
});

test('a password buys a session cookie, and every later GET carries it', () => {
  const { calls, exec } = recorder();
  const { curl } = testerClient({ baseUrl: 'http://tester.example/', password: 'hunter2', exec, jarPath: JAR });
  curl('http://tester.example/api/coverage');

  const [login, get] = calls;
  assert.ok(login.args.includes('/api/auth/login') || login.args.some((a) => a.endsWith('/api/auth/login')),
    'the first call must be the login');
  assert.ok(login.args.includes('-c') && login.args.includes(JAR), 'login must write the jar');
  assert.ok(get.args.includes('-b') && get.args.includes(JAR), 'the coverage GET must read the jar');
});

// A trailing slash on the configured URL must not produce //api/auth/login.
test('the login URL is joined cleanly', () => {
  const { calls, exec } = recorder();
  testerClient({ baseUrl: 'http://tester.example/', password: 'hunter2', exec, jarPath: JAR });
  assert.ok(calls[0].args.includes('http://tester.example/api/auth/login'));
});

// argv is world-readable in `ps` for the life of the call, and a snapshot runs
// under cron beside whatever else is on that machine.
test('the password goes in on stdin, never in the arguments', () => {
  const { calls, exec } = recorder();
  testerClient({ baseUrl: 'http://tester.example', password: 'hunter2', exec, jarPath: JAR });
  assert.equal(calls[0].input, JSON.stringify({ password: 'hunter2' }));
  assert.ok(!calls[0].args.some((a) => String(a).includes('hunter2')), 'password leaked into argv');
});

// A wrong or expired secret costs the coverage half and nothing else: the
// collector 401s on the plain curl and degrades to build progress, which is
// what it already does when the tester is simply unreachable.
test('a failed login degrades instead of taking the snapshot down', () => {
  const warned = [];
  const { calls, exec } = recorder('/api/auth/login');
  const { curl } = testerClient({ baseUrl: 'http://tester.example', password: 'wrong', exec,
    jarPath: JAR, warn: (m) => warned.push(m) });
  curl('http://tester.example/api/coverage');
  assert.equal(warned.length, 1);
  assert.doesNotMatch(warned[0], /wrong/, 'the warning must not carry the password');
  assert.ok(!calls[1].args.includes('-b'), 'a failed login must not leave a jar in play');
});

// The jar holds a live 7-day session for a host this repo deliberately does not
// name. It does not outlive the process that made it.
test('cleanup removes the cookie jar', () => {
  const { exec } = recorder();
  writeFileSync(JAR, 'session');
  const { cleanup } = testerClient({ baseUrl: 'http://tester.example', password: 'hunter2', exec, jarPath: JAR });
  cleanup();
  assert.equal(existsSync(JAR), false);
});
