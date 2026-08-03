// test/weekly-archive.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSnapshot, appendWeek, readArchive } from '../weekly/lib/archive.mjs';

const ok = (over = {}) => ({
  week: '2026-W31', start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] },
  decisions: [],
  ...over,
});

test('a well-formed snapshot validates', () => validateSnapshot(ok()));

test('a no-data workstream validates when it carries a reason', () =>
  validateSnapshot(ok({ tickets: { status: 'no-data', reason: 'Linear refresh pending' } })));

test('no-data without a reason is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ tickets: { status: 'no-data' } })), /tickets.*reason/));

test('a bad week id is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ week: '2026-31' })), /week/));

test('a missing workstream is rejected', () => {
  const snap = ok();
  delete snap.testing;
  assert.throws(() => validateSnapshot(snap), /testing/);
});

test('an ok workstream missing a numeric field is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ testing: { status: 'ok', commits: 4, shipped: [] } })), /prsMerged/));

test('a zero value is valid — only absence is an error', () =>
  validateSnapshot(ok({ testing: { status: 'ok', prsMerged: 0, commits: 0, shipped: [] } })));

test('decisions must be an array of strings', () =>
  assert.throws(() => validateSnapshot(ok({ decisions: 'nope' })), /decisions/));

test('appendWeek adds to an empty archive', () => {
  const out = appendWeek({ weeks: [] }, ok());
  assert.equal(out.weeks.length, 1);
  assert.equal(out.weeks[0].week, '2026-W31');
});

test('appendWeek does not mutate the input archive', () => {
  const before = { weeks: [] };
  appendWeek(before, ok());
  assert.equal(before.weeks.length, 0);
});

test('appendWeek keeps weeks sorted ascending', () => {
  const a = appendWeek({ weeks: [] }, ok({ week: '2026-W31' }));
  const b = appendWeek(a, ok({ week: '2026-W29' }));
  const c = appendWeek(b, ok({ week: '2026-W30' }));
  assert.deepEqual(c.weeks.map((w) => w.week), ['2026-W29', '2026-W30', '2026-W31']);
});

test('a corrupt archive with a non-array weeks field reads as empty', () => {
  const p = join(tmpdir(), `weekly-corrupt-${process.pid}.json`);
  writeFileSync(p, JSON.stringify({ weeks: null }));
  try {
    assert.deepEqual(readArchive(p).weeks, []);
  } finally {
    rmSync(p, { force: true });
  }
});

test('re-appending an existing week throws', () => {
  const a = appendWeek({ weeks: [] }, ok());
  assert.throws(() => appendWeek(a, ok()), /2026-W31 already exists/);
});

test('force replaces an existing week in place', () => {
  const a = appendWeek({ weeks: [] }, ok());
  const b = appendWeek(a, ok({ builtAt: '2026-08-08' }), { force: true });
  assert.equal(b.weeks.length, 1);
  assert.equal(b.weeks[0].builtAt, '2026-08-08');
});

test('appendWeek validates before appending', () =>
  assert.throws(() => appendWeek({ weeks: [] }, ok({ week: 'bad' })), /week/));

test('readArchive on a missing file yields an empty archive', () =>
  assert.deepEqual(readArchive('/tmp/definitely-not-here-9f3a.json'), { weeks: [] }));

// --- roster (optional per-piece detail) --------------------------------------

const withRoster = (roster) => ok({
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster },
});

test('a snapshot with no roster field validates — the field is optional', () => {
  const snap = ok();
  assert.equal(snap.outputSchema.roster, undefined);
  validateSnapshot(snap);
});

test('every already-committed snapshot still validates unchanged', () => {
  const archive = JSON.parse(readFileSync(new URL('../weekly/data/weeks.json', import.meta.url), 'utf8'));
  assert.ok(archive.weeks.length > 0, 'the committed archive should not be empty');
  for (const w of archive.weeks) validateSnapshot(w);
});

test('a well-formed roster validates', () =>
  validateSnapshot(withRoster([{ name: 'Slack', actions: 12, triggers: 3, stage: 'live', tier: 'P1' }])));

test('an empty roster validates', () => validateSnapshot(withRoster([])));

test('a roster entry with zero actions validates — only absence is an error', () =>
  validateSnapshot(withRoster([{ name: 'Slack', actions: 0 }])));

test('a non-array roster is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster({ Slack: 12 })), /outputSchema\.roster must be an array/));

test('a roster entry that is not an object is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster(['Slack'])), /outputSchema\.roster\[0\]/));

test('a roster entry without a name is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster([{ actions: 12 }])), /outputSchema\.roster\[0\]\.name/));

test('a roster entry with an empty name is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster([{ name: '', actions: 12 }])), /outputSchema\.roster\[0\]\.name/));

test('a roster entry with a non-numeric actions count is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster([{ name: 'Slack', actions: '12' }])),
    /outputSchema\.roster\[0\]\.actions/));

test('the offending roster index is named, not just the first one', () =>
  assert.throws(() => validateSnapshot(withRoster([{ name: 'Slack', actions: 12 }, { name: 'Notion' }])),
    /outputSchema\.roster\[1\]\.actions/));

test('an aiActions roster is validated too', () =>
  assert.throws(() => validateSnapshot(ok({
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
                 roster: [{ name: 'gmail' }] },
  })), /aiActions\.roster\[0\]\.actions/));

// --- catalogPieces (optional catalog denominator) ----------------------------
// Optional exactly like `roster`: snapshots written before the field existed —
// including the one already committed — must keep validating. But a present
// value drives a denominator on the page, so a non-number has to be caught here
// rather than rendered as "of undefined pieces".

const withCatalog = (catalogPieces) => ok({
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2,
               totalPieces: 28, blockersOpen: 30, catalogPieces },
});

test('a snapshot with no catalogPieces validates — the field is optional', () => {
  const snap = ok();
  assert.equal(snap.aiActions.catalogPieces, undefined);
  validateSnapshot(snap);
});

test('a numeric catalogPieces validates', () => validateSnapshot(withCatalog(756)));

test('a zero catalogPieces validates — only a wrong type is an error', () =>
  validateSnapshot(withCatalog(0)));

test('a non-numeric catalogPieces is rejected', () =>
  assert.throws(() => validateSnapshot(withCatalog('756')), /aiActions\.catalogPieces must be a number/));

test('a null catalogPieces is rejected', () =>
  assert.throws(() => validateSnapshot(withCatalog(null)), /aiActions\.catalogPieces must be a number/));

// --- logo (optional per-row logo URL) ----------------------------------------
// OPTIONAL for the same reason as `roster` and `catalogPieces`: the snapshot
// already committed has rows without it and must keep validating. `null` is the
// recorded answer for "the catalog had no URL for this piece" — the collectors
// never guess one — so it is a valid value, not a missing field.
//
// A present value goes straight into an `<img src>`, so a number, an object or
// an empty string has to fail here rather than render as a broken image.

const withLogo = (logo) => withRoster([{ name: 'Slack', actions: 12, logo }]);

test('a roster entry with no logo validates — the field is optional', () =>
  validateSnapshot(withRoster([{ name: 'Slack', actions: 12 }])));

test('a string logo validates', () =>
  validateSnapshot(withLogo('https://cdn.activepieces.com/pieces/slack.png')));

test('a null logo validates — it is the recorded answer for "not in the catalog"', () =>
  validateSnapshot(withLogo(null)));

test('a non-string logo is rejected', () =>
  assert.throws(() => validateSnapshot(withLogo(42)), /outputSchema\.roster\[0\]\.logo/));

test('an empty-string logo is rejected — null means unresolved, "" means broken image', () =>
  assert.throws(() => validateSnapshot(withLogo('')), /outputSchema\.roster\[0\]\.logo/));

test('the offending logo index is named, not just the first one', () =>
  assert.throws(() => validateSnapshot(withRoster([
    { name: 'Slack', actions: 12, logo: null },
    { name: 'Notion', actions: 3, logo: { url: 'x' } },
  ])), /outputSchema\.roster\[1\]\.logo/));

test('an aiActions roster logo is validated too', () =>
  assert.throws(() => validateSnapshot(ok({
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
                 roster: [{ name: 'gmail', actions: 19, logo: 12 }] },
  })), /aiActions\.roster\[0\]\.logo/));

// --- folder (optional per-row stable key) ------------------------------------
// The key the week-over-week diff is computed on, so a hand-edited or junk value
// would silently corrupt the honesty claim the whole page rests on: which pieces
// crossed the line THIS week. OPTIONAL like `logo` — the weeks already committed
// were written before the field existed and must keep validating — but a present
// value has to be a usable key.

const withFolder = (folder) => withRoster([{ name: 'Slack', actions: 12, folder }]);

test('a roster entry with no folder validates — the field is optional', () =>
  validateSnapshot(withRoster([{ name: 'Slack', actions: 12 }])));

test('a string folder validates', () => validateSnapshot(withFolder('slack')));

test('a non-string folder is rejected — the diff would key on junk', () =>
  assert.throws(() => validateSnapshot(withFolder(42)), /outputSchema\.roster\[0\]\.folder/));

test('an empty-string folder is rejected', () =>
  assert.throws(() => validateSnapshot(withFolder('')), /outputSchema\.roster\[0\]\.folder/));

test('a null folder is rejected — absence is how "not recorded" is expressed', () =>
  assert.throws(() => validateSnapshot(withFolder(null)), /outputSchema\.roster\[0\]\.folder/));
