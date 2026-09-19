// test/weekly-collect-shipping.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectShipping } from '../weekly/collect/shipping.mjs';

const WINDOW = { start: '2026-07-25', end: '2026-07-31' };
const WEEK = '2026-W31';   // Monday = 2026-07-27

const GITHUB = {
  stamp: '2026-07-31',
  mergedEvents: [
    { d: '2026-07-27', p: 'kishan', kind: 'pieces' },
    { d: '2026-07-28', p: 'kishan', kind: 'platform' },
    { d: '2026-07-29', p: 'odai', kind: 'mixed' },
    { d: '2026-07-31', p: 'sanket', kind: 'pieces' },
    { d: '2026-07-30', p: 'talal', kind: 'pieces' },
    { d: '2026-07-10', p: 'sanket', kind: 'pieces' },   // outside the window
    { d: '2026-07-28', p: 'ahmad', kind: 'pieces' },    // outside the roster
  ],
  reviews: { approx: true, weekly: [
    { w: '2026-07-20', kishan: 3, sanket: 2, odai: 0, talal: 0 },
    { w: '2026-07-27', kishan: 12, sanket: 9, odai: 4, talal: 1 },
  ] },
  recentPrs: [
    { number: 15611, title: 'chore(aws-bedrock): bump', author: 'kishan', state: 'MERGED',
      mergedAt: '2026-07-27T13:57:00Z', kind: 'pieces', url: 'https://github.com/x/1' },
    { number: 15600, title: 'still open', author: 'odai', state: 'OPEN',
      mergedAt: null, kind: 'pieces', url: 'https://github.com/x/2' },
    { number: 15500, title: 'merged last month', author: 'sanket', state: 'MERGED',
      mergedAt: '2026-07-10T09:00:00Z', kind: 'pieces', url: 'https://github.com/x/3' },
  ],
};

const read = (over = {}) => (name) => ({ 'github.json': GITHUB, ...over }[name]);

test('merged PRs are counted per person inside the window', () => {
  const out = collectShipping({ window: WINDOW, weekId: WEEK, readJson: read() });
  assert.equal(out.status, 'ok');
  assert.equal(out.prsMerged, 5);
  assert.deepEqual(out.byPerson, { kishan: 2, sanket: 1, odai: 1, talal: 1 });
});

// The roster is the whole point of this tile existing: Odai and Talal were
// shipping for months with nothing on the page. A regression that drops them
// reads as a quiet week, not as an error.
test('the two people added in September are counted', () => {
  const { byPerson } = collectShipping({ window: WINDOW, weekId: WEEK, readJson: read() });
  assert.equal(byPerson.odai, 1);
  assert.equal(byPerson.talal, 1);
});

test('somebody outside the roster is not counted', () => {
  const { prsMerged } = collectShipping({ window: WINDOW, weekId: WEEK, readJson: read() });
  assert.equal(prsMerged, 5, "ahmad's PR is not this team's PR");
});

// `mixed` is a PR that changed a piece AND something else. It touched a piece,
// so it counts: excluding it would under-report the team's own subject.
test('a piece PR is one that touched packages/pieces, mixed included', () => {
  const { piecePrs, prsMerged } = collectShipping({ window: WINDOW, weekId: WEEK, readJson: read() });
  assert.equal(piecePrs, 4);
  assert.equal(prsMerged, 5, 'the platform PR is still a merged PR');
});

test('reviews come from the bucket keyed by the Monday of the week', () => {
  const out = collectShipping({ window: WINDOW, weekId: WEEK, readJson: read() });
  assert.equal(out.reviews, 26);
  assert.deepEqual(out.reviewsByPerson, { kishan: 12, sanket: 9, odai: 4, talal: 1 });
  assert.equal(out.reviewsApprox, true, 'GitHub cannot resolve a review finer than its week');
});

test('a week with no review bucket reads as zero, not as a crash', () => {
  const out = collectShipping({ window: WINDOW, weekId: WEEK,
    readJson: read({ 'github.json': { ...GITHUB, reviews: { weekly: [] } } }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.reviews, 0);
});

test('the strip carries only PRs merged inside the window', () => {
  const { shipped } = collectShipping({ window: WINDOW, weekId: WEEK, readJson: read() });
  assert.deepEqual(shipped.map((p) => p.number), [15611]);
});

// The headline comes from mergedEvents, which is complete; the strip comes from
// recentPrs, which is capped upstream. A short strip under a true number is the
// intended shape -- the alternative is trimming the number to match the list.
test('a capped strip does not cap the headline', () => {
  const out = collectShipping({ window: WINDOW, weekId: WEEK,
    readJson: read({ 'github.json': { ...GITHUB, recentPrs: [] } }) });
  assert.equal(out.prsMerged, 5);
  assert.deepEqual(out.shipped, []);
});

// ── freshness ───────────────────────────────────────────────────────────────
// The internal dashboard runs its own rolling window. Data that predates this
// week yields 0 everywhere, which is indistinguishable from a week in which
// nobody merged anything -- and publishing that as a fact about the team is the
// exact failure this gate exists to prevent.
test('data that does not reach the end of the window degrades to no-data', () => {
  const out = collectShipping({ window: WINDOW, weekId: WEEK,
    readJson: read({ 'github.json': { ...GITHUB, stamp: '2026-07-30' } }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /2026-07-30/);
});

test('data stamped exactly on the window end is fresh enough', () =>
  assert.equal(collectShipping({ window: WINDOW, weekId: WEEK, readJson: read() }).status, 'ok'));

test('a missing stamp degrades rather than being assumed fresh', () => {
  const { stamp, ...noStamp } = GITHUB;
  const out = collectShipping({ window: WINDOW, weekId: WEEK, readJson: read({ 'github.json': noStamp }) });
  assert.equal(out.status, 'no-data');
});

test('a missing data file degrades instead of throwing', () => {
  const out = collectShipping({ window: WINDOW, weekId: WEEK,
    readJson: () => { throw new Error('ENOENT'); } });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /ENOENT/);
});

// A genuinely quiet week is a zero, and a zero is publishable.
test('an empty week is a real zero, not no-data', () => {
  const out = collectShipping({ window: { start: '2026-06-06', end: '2026-06-12' }, weekId: '2026-W24',
    readJson: read() });
  assert.equal(out.status, 'ok');
  assert.equal(out.prsMerged, 0);
  assert.deepEqual(out.byPerson, { kishan: 0, sanket: 0, odai: 0, talal: 0 });
});
