// test/credit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GITHUB, PEOPLE, personOf } from '../weekly/collect/people.mjs';
import { authorOf } from '../lib/credit.mjs';
import { discoverClaims, discoverLandings, landingScanVerdict } from '../lib/discover.mjs';

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

const prStates = {
  101: { state: 'MERGED', author: 'kishanprmr' }, 102: { state: 'MERGED', author: null }, 103: {},
  104: { state: 'OPEN', author: 'kishanprmr' }, 105: { state: 'CLOSED', author: 'kishanprmr' },
};
const landings = { aiActions: { gmail: { pr: 200, author: 'OdaiAhmed99', mergedAt: '2026-09-20T10:00:00Z' } } };

test('authorOf prefers the author of the row\'s own PR once it merged — over the landing', () =>
  assert.equal(authorOf({ slug: 'gmail', pr: 101, stage: 'merged' }, 'aiActions', prStates, landings), 'kishanprmr'));

test('authorOf falls back to the landing PR when the pointer has no author', () => {
  assert.equal(authorOf({ slug: 'gmail', pr: 102 }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: 103 }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: null }, 'aiActions', prStates, landings), 'OdaiAhmed99');
});

// Real data, W39: gmail went live through Talal's merged PR while its curated
// UI row still pointed at Kishan's open one. An open PR has shipped nothing, so
// it cannot take the credit for a piece somebody else's PR made done.
test('an OPEN pointer on a done row yields to the landing — it shipped nothing', () => {
  assert.equal(authorOf({ slug: 'gmail', pr: 104, stage: 'merged' }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: 104, stage: 'live' }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: 104 }, 'aiActions', prStates, landings), 'OdaiAhmed99');
});

test('an OPEN pointer with no landing credits nobody', () =>
  assert.equal(authorOf({ slug: 'slack', pr: 104, stage: 'merged' }, 'aiActions', prStates, landings), null));

test('an OPEN pointer on an APPROVED row is the credit — approved open work is done', () =>
  assert.equal(authorOf({ slug: 'gmail', pr: 104, stage: 'approved' }, 'aiActions', prStates, landings), 'kishanprmr'));

test('a CLOSED pointer yields to the landing', () =>
  assert.equal(authorOf({ slug: 'gmail', pr: 105, stage: 'merged' }, 'aiActions', prStates, landings), 'OdaiAhmed99'));

// Without the stage an approved open PR would lose its author to the landing
// scan, which cannot see it — it has not merged.
test('both builds hand authorOf the row\'s stage', () => {
  for (const rel of ['../ai-actions/build.mjs', '../ui-improvements/build.mjs']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /authorOf\(\{[^}]*\bstage\b[^}]*\}/, rel);
  }
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

// Core pieces (tables, date-helper, pdf, file-helper) live under
// packages/pieces/core/. All four uncredited W39 UI pieces were core, and all
// four were Talal's.
const coreUiFile = (slug) => ({ filename: `packages/pieces/core/${slug}/src/lib/actions/c.ts`,
  patch: '@@ -1 +1,2 @@\n+  advanced: true,\n' });

test('discoverLandings credits a core piece', () => {
  const out = discoverLandings([
    { number: 60, mergedAt: '2026-09-22T10:00:00Z', base: 'main', author: 'Talaljaber', files: [coreUiFile('tables')] },
  ]);
  assert.deepEqual(out.uiImprovements.tables, { pr: 60, author: 'Talaljaber', mergedAt: '2026-09-22T10:00:00Z' });
});

// Claim discovery stays on community: a core claim would make an in-flight row
// that nothing on main could ever mark landed.
test('discoverClaims still ignores the same core file', () => {
  const out = discoverClaims([{ number: 61, base: 'main', files: [coreUiFile('tables')] }]);
  assert.deepEqual(out.uiImprovements, {});
});

// A landing scan that lost a call is not a measurement: with no landings W39
// would have archived Kishan 0/20 as a number, and one lost files fetch hands a
// piece to a LATER PR's author. The Saturday job refuses it; CI takes it.
test('a landing scan with no failures is complete, required or not', () => {
  assert.deepEqual(landingScanVerdict({ failures: [], required: false }), { complete: true, error: null });
  assert.deepEqual(landingScanVerdict({ failures: [], required: true }), { complete: true, error: null });
});

test('an incomplete landing scan is flagged, and best-effort when not required', () =>
  assert.deepEqual(landingScanVerdict({ failures: ['PR #15753 files unavailable (HTTP 502)'], required: false }),
    { complete: false, error: null }));

test('an incomplete landing scan is an error when required, naming every failure', () => {
  const v = landingScanVerdict({ failures: ['merged-PR list failed (timeout)', 'PR #15753 files unavailable (HTTP 502)'], required: true });
  assert.equal(v.complete, false);
  assert.match(v.error, /LANDINGS_REQUIRED/);
  assert.match(v.error, /merged-PR list failed \(timeout\)/);
  assert.match(v.error, /PR #15753 files unavailable/);
});
