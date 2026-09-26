// test/ai-roster.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiRoster, summarizeAiRoster } from '../lib/ai-roster.mjs';

const MAIN_AT = '2026-09-25T15:49:41Z';
const pr = (state, mergedAt = null, assignees = [], base = 'main') => ({ state, createdAt: '2026-09-10T00:00:00Z', mergedAt, assignees, base });
const bySlug = (rows) => Object.fromEntries(rows.map((r) => [r.slug, r]));

// The W39 miss, in one test: a piece that landed on main and was never written
// into ai-actions/pieces.json is still a piece with AI actions.
test('a piece on main that nobody curated is merged, with main\'s own count', () => {
  const { rows } = buildAiRoster({ curated: [], onMain: { monday: 91 }, mainAt: MAIN_AT });
  assert.deepEqual(bySlug(rows).monday, {
    slug: 'monday', atomics: 91, pr: null, t2v: null, t2t: null,
    stage: 'merged', assignees: [], prState: null, source: 'main',
  });
});

// Main is the record; the curated count is what the PR had when it was authored.
// Trello went 46 -> 66 in #15539 and the roster never heard about it.
test('a curated piece on main is merged and takes main\'s count', () => {
  const curated = [{ slug: 'trello', atomics: 46, pr: 14000, t2v: 40, t2t: 46 }];
  const { rows } = buildAiRoster({ curated, prStates: { 14000: pr('MERGED', '2026-08-01T00:00:00Z') }, onMain: { trello: 66 }, mainAt: MAIN_AT });
  assert.equal(rows[0].stage, 'merged');
  assert.equal(rows[0].atomics, 66);
  assert.equal(rows[0].t2v, 40, 'curated facts survive');
});

// On main beats a held reason: the reason was true once, the code is true now.
test('a held piece that has since landed is merged', () => {
  const curated = [{ slug: 'resend', atomics: 8, held: 'waiting on vendor', t2v: null, t2t: null }];
  assert.equal(buildAiRoster({ curated, onMain: { resend: 9 }, mainAt: MAIN_AT }).rows[0].stage, 'merged');
});

// pubrio and quizell: counted merged off #13979, which merged WITHOUT them.
// A PR that merged before main was read, while main carries nothing for the
// piece, is work that never shipped -- the one lie the old roster told.
test('a merged PR whose atomics are not on main is not merged', () => {
  const curated = [{ slug: 'pubrio', atomics: 14, pr: 13979, t2v: 14, t2t: 14 }];
  const { rows, warnings } = buildAiRoster({
    curated, prStates: { 13979: pr('MERGED', '2026-07-01T00:00:00Z') }, onMain: {}, mainAt: MAIN_AT,
  });
  assert.equal(rows[0].stage, 'held');
  assert.match(warnings.join('\n'), /pubrio.*#13979.*merged/);
});

// ...but a PR that merged AFTER the clone was taken is the fetch race, not a
// lie: the two reads are minutes apart and main simply had not caught up.
test('a PR merged after main was read still counts as merged', () => {
  const curated = [{ slug: 'gmail', atomics: 19, pr: 15900, t2v: 1, t2t: 1 }];
  const { rows, warnings } = buildAiRoster({
    curated, prStates: { 15900: pr('MERGED', '2026-09-25T16:00:00Z') }, onMain: {}, mainAt: MAIN_AT,
  });
  assert.equal(rows[0].stage, 'merged');
  assert.deepEqual(warnings, []);
});

test('a curated piece with an open PR and nothing on main is pr-open', () => {
  const curated = [{ slug: 'slack', atomics: 30, pr: 15000, t2v: 1, t2t: 1 }];
  assert.equal(buildAiRoster({ curated, prStates: { 15000: pr('OPEN') }, onMain: {}, mainAt: MAIN_AT }).rows[0].stage, 'pr-open');
});

// One PR, two pieces (#15725 carries pipedrive and mailer-lite): both rows, one PR.
test('an open PR found in the diff adds a pr-open row per piece it carries', () => {
  const { rows } = buildAiRoster({
    curated: [], discovered: { pipedrive: 15725, 'mailer-lite': 15725 },
    prStates: { 15725: pr('OPEN', null, ['OdaiAhmed99']) }, onMain: {}, mainAt: MAIN_AT,
  });
  const m = bySlug(rows);
  assert.equal(m.pipedrive.stage, 'pr-open');
  assert.equal(m['mailer-lite'].stage, 'pr-open');
  assert.deepEqual(m.pipedrive.assignees, ['OdaiAhmed99']);
  assert.equal(m.pipedrive.source, 'pr');
});

// A piece already on main with an open PR adding MORE atomics is still a piece
// that has AI actions; the open PR must not demote it or double-count it.
test('an open PR on a piece already on main leaves it merged, once', () => {
  const { rows } = buildAiRoster({
    curated: [], discovered: { gmail: 15901 }, prStates: { 15901: pr('OPEN') }, onMain: { gmail: 26 }, mainAt: MAIN_AT,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'merged');
});

// A discovered PR whose state was never fetched says nothing about a stage.
test('a discovered PR with no fetched state adds no row', () => {
  assert.deepEqual(buildAiRoster({ curated: [], discovered: { asana: 15757 }, onMain: {}, mainAt: MAIN_AT }).rows, []);
});

// Without a main reading (a checkout that has not fetched) the build must still
// run, and on the curated claims alone -- exactly what it did before this existed.
test('with no main reading, stages come from the curated claims as before', () => {
  const curated = [
    { slug: 'pubrio', atomics: 14, pr: 13979, t2v: 14, t2t: 14 },
    { slug: 'quizell', atomics: 4, held: 'cut from #13979', t2v: 4, t2t: 4 },
  ];
  const { rows, warnings } = buildAiRoster({ curated, prStates: { 13979: pr('MERGED', '2026-07-01T00:00:00Z') } });
  assert.deepEqual(rows.map((r) => [r.slug, r.stage, r.atomics]), [['pubrio', 'merged', 14], ['quizell', 'held', 4]]);
  assert.deepEqual(warnings, []);
});

test('a zero count on main is not a piece on main', () => {
  assert.deepEqual(buildAiRoster({ curated: [], onMain: { imap: 0 }, mainAt: MAIN_AT }).rows, []);
});

test('an override assignee still reaches a curated row', () => {
  const curated = [{ slug: 'notion', atomics: 22, pr: null, held: 'x', t2v: 1, t2t: 1 }];
  const { rows } = buildAiRoster({ curated, overrides: { notion: { assignee: 'kishanprmr' } }, onMain: {}, mainAt: MAIN_AT });
  assert.deepEqual(rows[0].assignees, ['kishanprmr']);
});

// The curated PR is stale, but the piece is back in review under a new number:
// that is in flight, not shelved.
test('a curated PR that merged without the atomics yields to a newer open PR', () => {
  const curated = [{ slug: 'pubrio', atomics: 14, pr: 13979, t2v: 1, t2t: 1 }];
  const { rows, warnings } = buildAiRoster({
    curated, discovered: { pubrio: 15950 },
    prStates: { 13979: pr('MERGED', '2026-07-01T00:00:00Z'), 15950: pr('OPEN') }, onMain: {}, mainAt: MAIN_AT,
  });
  assert.equal(rows[0].stage, 'pr-open');
  assert.equal(rows[0].pr, 15950);
  assert.match(warnings.join('\n'), /#15950/);
});

// #15758 targets feat/asana-ai-actions-a. Merging THERE is not landing on main,
// however recently it happened.
test('a stacked PR merged into its parent branch is not merged', () => {
  const stacked = pr('MERGED', '2026-09-25T16:00:00Z', [], 'feat/asana-ai-actions-a');
  const curated = [{ slug: 'asana', atomics: 59, pr: 15758, t2v: 1, t2t: 1 }];
  assert.equal(buildAiRoster({ curated, prStates: { 15758: stacked }, onMain: {}, mainAt: MAIN_AT }).rows[0].stage, 'held');
  const found = buildAiRoster({ curated: [], discovered: { asana: 15758 }, prStates: { 15758: stacked }, onMain: {}, mainAt: MAIN_AT }).rows;
  assert.equal(found[0].stage, 'pr-open', 'a discovered one is still on its way to main');
});

test('a discovered PR that merged into main after main was read is merged', () => {
  const { rows } = buildAiRoster({ curated: [], discovered: { dropbox: 15661 },
    prStates: { 15661: pr('MERGED', '2026-09-25T16:00:00Z') }, onMain: {}, mainAt: MAIN_AT });
  assert.equal(rows[0].stage, 'merged');
});

// Merged into main BEFORE main was read, and main has nothing: no stage we can
// defend, so no row rather than a wrong one.
test('a discovered PR that merged into main before the read, with nothing on main, adds no row', () => {
  assert.deepEqual(buildAiRoster({ curated: [], discovered: { dropbox: 15661 },
    prStates: { 15661: pr('MERGED', '2026-09-20T00:00:00Z') }, onMain: {}, mainAt: MAIN_AT }).rows, []);
});

// States fetched before `base` was recorded carry none, and every one of them
// merged into main.
test('a PR state with no recorded base is taken to be main', () => {
  const legacy = { state: 'MERGED', mergedAt: '2026-09-25T16:00:00Z', assignees: [] };
  const curated = [{ slug: 'gmail', atomics: 19, pr: 15900, t2v: 1, t2t: 1 }];
  assert.equal(buildAiRoster({ curated, prStates: { 15900: legacy }, onMain: {}, mainAt: MAIN_AT }).rows[0].stage, 'merged');
});

test('the summary counts atomics on merged rows only, and each open PR once', () => {
  const s = summarizeAiRoster([
    { slug: 'a', atomics: 10, stage: 'merged', pr: null, prState: null, source: 'main' },
    { slug: 'b', atomics: 14, stage: 'held', pr: 13979, prState: 'MERGED', t2v: 14, t2t: 14 },
    { slug: 'c', atomics: 0, stage: 'pr-open', pr: 15725, prState: 'OPEN', source: 'pr' },
    { slug: 'd', atomics: 0, stage: 'pr-open', pr: 15725, prState: 'OPEN', source: 'pr' },
  ]);
  assert.equal(s.atomics, 10);
  assert.deepEqual(s.stages, { held: 1, assigned: 0, prOpen: 2, approved: 0, merged: 1 });
  assert.equal(s.prsOpen, 1);
  assert.equal(s.prsMerged, 1);
  assert.equal(s.fromMain, 1);
  assert.equal(s.fromPrs, 2);
  assert.equal(s.t2v, 14);
  assert.equal(s.pieces, 4);
});

// Approved = finished work waiting on a merge button. Counted as done by the
// weekly page; never confused with merged, because main does not have it yet.
test('an open PR that is approved is approved, curated or discovered', () => {
  const approved = { ...pr('OPEN'), approved: true };
  const curated = [{ slug: 'slack', atomics: 30, pr: 15000, t2v: 1, t2t: 1 }];
  assert.equal(buildAiRoster({ curated, prStates: { 15000: approved }, onMain: {}, mainAt: MAIN_AT }).rows[0].stage, 'approved');
  const { rows } = buildAiRoster({ curated: [], discovered: { pipedrive: 15725 }, prStates: { 15725: approved }, onMain: {}, mainAt: MAIN_AT });
  assert.equal(rows[0].stage, 'approved');
});

test('an approved PR on a piece already on main leaves it merged', () => {
  const { rows } = buildAiRoster({ curated: [], discovered: { gmail: 15901 },
    prStates: { 15901: { ...pr('OPEN'), approved: true } }, onMain: { gmail: 26 }, mainAt: MAIN_AT });
  assert.equal(rows[0].stage, 'merged');
});

test('the summary counts approved rows as their own stage', () => {
  const s = summarizeAiRoster([
    { slug: 'a', atomics: 10, stage: 'merged', pr: null, prState: null },
    { slug: 'b', atomics: 0, stage: 'approved', pr: 15725, prState: 'OPEN' },
  ]);
  assert.equal(s.stages.approved, 1);
  assert.equal(s.stages.prOpen, 0);
  assert.equal(s.prsOpen, 1, 'an approved PR is still an open PR');
});
