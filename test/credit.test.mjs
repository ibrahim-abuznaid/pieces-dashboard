// test/credit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB, PEOPLE, personOf } from '../weekly/collect/people.mjs';
import { authorOf } from '../lib/credit.mjs';
import { discoverLandings } from '../lib/discover.mjs';

test('every person on the roster has a GitHub handle', () =>
  assert.deepEqual(Object.keys(GITHUB).sort(), [...PEOPLE].sort()));

test('personOf maps a login to the person key', () => {
  assert.equal(personOf('kishanprmr'), 'kishan');
  assert.equal(personOf('OdaiAhmed99'), 'odai');
});

test('personOf ignores case — GitHub logins are case-insensitive', () =>
  assert.equal(personOf('odaiahmed99'), 'odai'));

test('personOf is null for anyone off the team, and for no login', () => {
  assert.equal(personOf('ibrahim-abuznaid'), null);
  assert.equal(personOf(null), null);
  assert.equal(personOf(''), null);
});

const prStates = { 101: { author: 'kishanprmr' }, 102: { author: null }, 103: {} };
const landings = { aiActions: { gmail: { pr: 200, author: 'OdaiAhmed99', mergedAt: '2026-09-20T10:00:00Z' } } };

test('authorOf prefers the author of the row\'s own PR', () =>
  assert.equal(authorOf({ slug: 'gmail', pr: 101 }, 'aiActions', prStates, landings), 'kishanprmr'));

test('authorOf falls back to the landing PR when the pointer has no author', () => {
  assert.equal(authorOf({ slug: 'gmail', pr: 102 }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: 103 }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: null }, 'aiActions', prStates, landings), 'OdaiAhmed99');
});

test('authorOf never borrows another rollout\'s landing', () =>
  assert.equal(authorOf({ slug: 'gmail', pr: null }, 'uiImprovements', prStates, landings), null));

test('authorOf is null when nothing names an author', () =>
  assert.equal(authorOf({ slug: 'slack' }, 'aiActions', {}, {}), null));

const aiFile = (slug) => ({ filename: `packages/pieces/community/${slug}/src/lib/actions/a.ts`,
  patch: "@@ -1 +1,2 @@\n+  audience: 'ai',\n" });
const uiFile = (slug) => ({ filename: `packages/pieces/community/${slug}/src/lib/actions/b.ts`,
  patch: '@@ -1 +1,2 @@\n+  propertyGroups: [],\n' });

test('discoverLandings records the PR, author and merge time per slug and rollout', () => {
  const out = discoverLandings([
    { number: 10, mergedAt: '2026-09-20T10:00:00Z', base: 'main', author: 'kishanprmr', files: [aiFile('asana'), uiFile('slack')] },
  ]);
  assert.deepEqual(out.aiActions.asana, { pr: 10, author: 'kishanprmr', mergedAt: '2026-09-20T10:00:00Z' });
  assert.deepEqual(out.uiImprovements.slack, { pr: 10, author: 'kishanprmr', mergedAt: '2026-09-20T10:00:00Z' });
  assert.deepEqual(out.outputSchema, {});
});

test('discoverLandings keeps the EARLIEST merged PR — the one that made the piece done', () => {
  const out = discoverLandings([
    { number: 30, mergedAt: '2026-09-24T10:00:00Z', base: 'main', author: 'Talaljaber', files: [aiFile('asana')] },
    { number: 20, mergedAt: '2026-09-21T10:00:00Z', base: 'main', author: 'kishanprmr', files: [aiFile('asana')] },
  ]);
  assert.equal(out.aiActions.asana.pr, 20);
  assert.equal(out.aiActions.asana.author, 'kishanprmr');
});

test('discoverLandings ignores PRs that did not merge into main', () => {
  const out = discoverLandings([
    { number: 40, mergedAt: '2026-09-21T10:00:00Z', base: 'feat/asana-ai-actions-a', author: 'kishanprmr', files: [aiFile('asana')] },
    { number: 41, mergedAt: null, base: 'main', author: 'kishanprmr', files: [aiFile('gmail')] },
  ]);
  assert.deepEqual(out.aiActions, {});
});

test('discoverLandings keeps a missing author as null rather than dropping the landing', () => {
  const out = discoverLandings([{ number: 50, mergedAt: '2026-09-21T10:00:00Z', base: 'main', files: [aiFile('asana')] }]);
  assert.deepEqual(out.aiActions.asana, { pr: 50, author: null, mergedAt: '2026-09-21T10:00:00Z' });
});
