// test/weekly-collect-tickets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTickets } from '../weekly/collect/tickets.mjs';

const WINDOW = { start: '2026-07-25', end: '2026-07-31' };
const WEEK = '2026-W31';   // Monday = 2026-07-27

const LINEAR = {
  stamp: '2026-07-31',
  events: [
    { d: '2026-07-27', p: 'kishan', t: 'Pieces' },
    { d: '2026-07-30', p: 'kishan', t: 'GIT' },
    { d: '2026-07-31', p: 'sanket', t: 'Pieces' },
    { d: '2026-07-25', p: 'sanket', t: 'Pieces' },   // Saturday — inside a Sat→Fri window
    { d: '2026-08-01', p: 'sanket', t: 'Pieces' },   // outside
    { d: '2026-07-10', p: 'kishan', t: 'GIT' },      // outside
  ],
  recent: [
    { id: 'PIE-101', title: 'Add Notion outputSchema', team: 'Pieces', assignee: 'kishan',
      status: 'Done', completedAt: '2026-07-27T09:00:00Z' },
    { id: 'GIT-1612', title: 'Bundler inlines sharp', team: 'GIT', assignee: 'kishan',
      status: 'Done', completedAt: '2026-07-10T09:00:00Z' },   // outside window
    { id: 'PIE-999', title: 'In flight', team: 'Pieces', assignee: 'sanket',
      status: 'In Progress', completedAt: null },
  ],
};

const GITHUB = {
  stamp: '2026-07-31',
  mergedEvents: [
    { d: '2026-07-27', p: 'kishan', kind: 'pieces' },
    { d: '2026-07-28', p: 'kishan', kind: 'platform' },
    { d: '2026-07-31', p: 'sanket', kind: 'pieces' },
    { d: '2026-07-10', p: 'sanket', kind: 'pieces' },
  ],
  reviews: { kishan: 199, sanket: 120, approx: true,
    weekly: [{ w: '2026-07-20', kishan: 3, sanket: 2 }, { w: '2026-07-27', kishan: 12, sanket: 9 }] },
};

const read = (over = {}) => (name) => ({ 'linear.json': LINEAR, 'github.json': GITHUB, ...over }[name]);

test('counts completions inside the window, per person', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.equal(out.status, 'ok');
  assert.equal(out.total, 4);
  assert.deepEqual(out.byPerson, { kishan: 2, sanket: 2 });
});

test('merged PRs counted per person inside the window', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.deepEqual(out.prsMerged, { kishan: 2, sanket: 1 });
});

test('reviews come from the weekly bucket keyed by the Monday of the week', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.deepEqual(out.reviews, { kishan: 12, sanket: 9 });
});

test('a missing weekly review bucket yields zeros, not a crash', () => {
  const gh = { ...GITHUB, reviews: { ...GITHUB.reviews, weekly: [] } };
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read({ 'github.json': gh }), linearRefreshPending: false });
  assert.deepEqual(out.reviews, { kishan: 0, sanket: 0 });
});

test('shipped lists only completed issues inside the window', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.deepEqual(out.shipped, [
    { id: 'PIE-101', title: 'Add Notion outputSchema', assignee: 'kishan', team: 'Pieces' },
  ]);
});

test('a pending Linear refresh degrades to no-data instead of undercounting', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: true });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /Linear refresh pending/);
});

test('a missing data file degrades to no-data', () => {
  const out = collectTickets({
    window: WINDOW, weekId: WEEK, linearRefreshPending: false,
    readJson: () => { throw new Error('ENOENT linear.json'); },
  });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /ENOENT/);
});

// The internal dashboard runs its own rolling window. Data that predates this
// week counts 0 everywhere, which is indistinguishable from a quiet week — so
// freshness is gated separately from the NEEDS-LINEAR-REFRESH marker.
test('data that does not reach the end of the window degrades to no-data', () => {
  const stale = { ...LINEAR, stamp: '2026-07-14' };
  const out = collectTickets({
    window: WINDOW, weekId: WEEK, linearRefreshPending: false,
    readJson: read({ 'linear.json': stale }),
  });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /2026-07-14/);
  assert.match(out.reason, /2026-07-31/);
});

test('freshness uses the older of the two stamps', () => {
  const out = collectTickets({
    window: WINDOW, weekId: WEEK, linearRefreshPending: false,
    readJson: read({ 'github.json': { ...GITHUB, stamp: '2026-07-20' } }),
  });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /2026-07-20/);
});

test('data stamped exactly on the window end is fresh enough', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.equal(out.status, 'ok');
});

test('missing stamps degrade rather than being assumed fresh', () => {
  const { stamp, ...noStamp } = LINEAR;
  const out = collectTickets({
    window: WINDOW, weekId: WEEK, linearRefreshPending: false,
    readJson: read({ 'linear.json': noStamp, 'github.json': (({ stamp: _s, ...g }) => g)(GITHUB) }),
  });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /stamp/);
});

test('an empty week is a real zero, not no-data', () => {
  const out = collectTickets({
    window: { start: '2026-06-06', end: '2026-06-12' }, weekId: '2026-W24',
    readJson: read(), linearRefreshPending: false,
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.total, 0);
  assert.deepEqual(out.byPerson, { kishan: 0, sanket: 0 });
});
