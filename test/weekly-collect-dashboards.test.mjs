import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOutputSchema } from '../weekly/collect/output-schema.mjs';
import { collectAiActions } from '../weekly/collect/ai-actions.mjs';
import { validateSnapshot } from '../weekly/lib/archive.mjs';

const OS_SUMMARY = {
  generated: '2026-07-23',
  totals: { pieces: 756, steps: 7019, actions: 5539, triggers: 1480 },
  status: { live: 9, 'merged-not-live': 6, 'in-progress': 0, todo: 733, review: 8, skip: 0 },
};

const AI_SUMMARY = {
  generated: '2026-07-23', prFetched: '2026-07-22', pieces: 28, atomics: 763,
  stages: { held: 2, assigned: 0, prOpen: 24, merged: 2 },
  prsOpen: 15, prsMerged: 1, blockersOpen: 30, blockersDone: 2,
};

// Roster fixtures. Both collectors read a second file for the per-piece detail;
// the aggregate tiles must survive that file being absent or junk.
//
// `dist/output-schema/pieces.json` is also the catalog both workstreams resolve
// logos against, so it carries `folder` and `logoUrl` exactly as the real build
// publishes them.
const OS_PIECES = {
  summary: {},
  pieces: [
    { folder: 'slack', displayName: 'Slack', actions: 12, triggers: 3, tier: 'P1', status: 'live',
      logoUrl: 'https://cdn.activepieces.com/pieces/slack.png' },
    { folder: 'notion', displayName: 'Notion', actions: 12, triggers: 1, tier: 'P1', status: 'merged-not-live',
      logoUrl: 'https://cdn.activepieces.com/pieces/notion.png' },
    // Folder and logo file name deliberately DIVERGE. The URL has to be looked
    // up, and the tests below assert this exact string, so an implementation
    // that concatenates the folder into a CDN path cannot pass.
    { folder: 'airtable', displayName: 'Airtable', actions: 20, triggers: 2, tier: 'P2', status: 'review',
      logoUrl: 'https://cdn.activepieces.com/pieces/airtable-v2.png' },
    { folder: 'zendesk', displayName: 'Zendesk', actions: 4, triggers: 0, tier: 'P3', status: 'in-progress',
      logoUrl: 'https://cdn.activepieces.com/pieces/zendesk.png' },
    { folder: 'trello', displayName: 'Trello', actions: 99, triggers: 9, tier: 'P1', status: 'todo',
      logoUrl: 'https://cdn.activepieces.com/pieces/trello.png' },
    { folder: 'webhook', displayName: 'Webhook', actions: 88, triggers: 8, tier: 'P1', status: 'skip',
      logoUrl: 'https://cdn.activepieces.com/pieces/webhook.png' },
    // Parked out of the outputSchema roster by `todo`, but still catalogued —
    // one file serves both workstreams, so the AI-actions roster resolves its
    // logos against these rows too.
    { folder: 'gmail', displayName: 'Gmail', actions: 19, triggers: 2, tier: 'P1', status: 'todo',
      logoUrl: 'https://cdn.activepieces.com/pieces/gmail.png' },
    { folder: 'google-docs', displayName: 'Google Docs', actions: 37, triggers: 0, tier: 'P1', status: 'todo',
      logoUrl: 'https://cdn.activepieces.com/pieces/google-docs.png' },
    // `asana` is deliberately ABSENT: the AI-actions roster tracks it, so it
    // exercises the unresolved path.
  ],
};

const AI_PIECES = {
  generated: '2026-07-23',
  pieces: [
    { slug: 'gmail', atomics: 19, stage: 'pr-open', pr: 13930, prState: 'OPEN' },
    { slug: 'google-docs', atomics: 37, stage: 'merged', pr: 13926, prState: 'MERGED' },
    { slug: 'airtable', atomics: 19, stage: 'held', pr: null, prState: null },
    { slug: 'asana', atomics: 5, stage: 'assigned', pr: null, prState: null },
  ],
};

// A path absent from the map throws, exactly like the real fs-backed reader.
const reader = (files) => (path) => {
  if (!(path in files)) throw new Error(`ENOENT: no such file, open '${path}'`);
  return files[path];
};

const osRead = (over = {}) => reader({
  'dist/output-schema/summary.json': OS_SUMMARY,
  'dist/output-schema/pieces.json': OS_PIECES,
  ...over,
});

// The catalog is part of the default map: a real snapshot always has it, because
// the outputSchema build runs before the AI-actions one. The tests that drop it
// build their own reader.
const aiRead = (over = {}) => reader({
  'dist/ai-actions/summary.json': AI_SUMMARY,
  'dist/ai-actions/pieces.json': AI_PIECES,
  'dist/output-schema/pieces.json': OS_PIECES,
  ...over,
});

// `folder` is carried as well as `name`: it is the catalog's own key and the
// only stable, unique one, so the week-over-week diff in view.mjs is keyed on it
// rather than on an editorial displayName that upstream renames.
const OS_ROSTER = [
  { folder: 'airtable', name: 'Airtable', actions: 20, triggers: 2, stage: 'review', tier: 'P2',
    logo: 'https://cdn.activepieces.com/pieces/airtable-v2.png' },
  { folder: 'notion', name: 'Notion', actions: 12, triggers: 1, stage: 'merged-not-live', tier: 'P1',
    logo: 'https://cdn.activepieces.com/pieces/notion.png' },
  { folder: 'slack', name: 'Slack', actions: 12, triggers: 3, stage: 'live', tier: 'P1',
    logo: 'https://cdn.activepieces.com/pieces/slack.png' },
  { folder: 'zendesk', name: 'Zendesk', actions: 4, triggers: 0, stage: 'in-progress', tier: 'P3',
    logo: 'https://cdn.activepieces.com/pieces/zendesk.png' },
];

test('collectOutputSchema maps the real summary shape', () => {
  assert.deepEqual(collectOutputSchema({ readJson: () => OS_SUMMARY }), {
    status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster: [],
  });
});

test('collectOutputSchema degrades to no-data with the reason when the file is missing', () => {
  const out = collectOutputSchema({ readJson: () => { throw new Error('ENOENT: no such file'); } });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /npm run build/);
});

test('collectOutputSchema rejects a summary missing the status block', () => {
  const out = collectOutputSchema({ readJson: () => ({ totals: { pieces: 1 } }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /status/);
});

test('collectAiActions maps the real summary shape', () => {
  assert.deepEqual(collectAiActions({ readJson: () => AI_SUMMARY }), {
    status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30, roster: [],
  });
});

test('collectAiActions degrades when stages are absent', () => {
  const out = collectAiActions({ readJson: () => ({ pieces: 28 }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /stages/);
});

test('a zero stage count survives as 0, not no-data', () => {
  const out = collectAiActions({ readJson: () => ({ ...AI_SUMMARY, stages: { held: 0, assigned: 0, prOpen: 0, merged: 0 } }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.merged, 0);
});

// Both collectors must apply the zero-survives rule identically. A truthiness
// check here previously made outputSchema disagree with ai-actions.
test('a zero live count survives as 0, not no-data', () => {
  const out = collectOutputSchema({ readJson: () => ({
    totals: { pieces: 756 }, status: { live: 0, 'merged-not-live': 0, review: 0, todo: 756 },
  }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.live, 0);
});

test('a non-numeric totals.pieces degrades instead of flowing through untyped', () => {
  const out = collectOutputSchema({ readJson: () => ({
    totals: { pieces: '756' }, status: { live: 9, 'merged-not-live': 6, review: 8, todo: 733 },
  }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /totals\.pieces/);
});

// --- rosters -----------------------------------------------------------------
// The roster is the per-piece detail behind each tile. It is DETAIL: losing it
// must never turn a measurable week into no-data.

test('collectOutputSchema carries an in-flight roster, sorted by actions desc then name', () => {
  assert.deepEqual(collectOutputSchema({ readJson: osRead() }), {
    status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
    roster: OS_ROSTER,
  });
});

test('todo and skip pieces never reach the outputSchema roster', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.deepEqual(roster.map((r) => r.name), ['Airtable', 'Notion', 'Slack', 'Zendesk']);
  assert.equal(roster.length, 4);
});

test('outputSchema roster stages are the piece status verbatim', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.deepEqual(roster.map((r) => r.stage), ['review', 'merged-not-live', 'live', 'in-progress']);
});

test('a missing outputSchema roster file leaves the tile numbers intact', () => {
  const out = collectOutputSchema({ readJson: reader({ 'dist/output-schema/summary.json': OS_SUMMARY }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.live, 9);
  assert.equal(out.totalPieces, 756);
  assert.deepEqual(out.roster, []);
});

test('a malformed outputSchema roster file yields an empty roster, not no-data', () => {
  const out = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': { pieces: 'nope' } }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster, []);
});

test('an outputSchema roster row with a non-numeric actions count drops the whole roster', () => {
  const broken = { pieces: [{ displayName: 'Slack', actions: '12', triggers: 3, tier: 'P1', status: 'live' }] };
  const out = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': broken }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.live, 9);
  assert.deepEqual(out.roster, []);
});

test('an outputSchema roster row with zero actions survives — only absence drops it', () => {
  const zeroed = { pieces: [{ folder: 'slack', displayName: 'Slack', actions: 0, triggers: 0, tier: 'P1',
                              status: 'review', logoUrl: 'https://cdn.activepieces.com/pieces/slack.png' }] };
  const out = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': zeroed }) });
  assert.deepEqual(out.roster, [{ folder: 'slack', name: 'Slack', actions: 0, triggers: 0, stage: 'review',
                                  tier: 'P1', logo: 'https://cdn.activepieces.com/pieces/slack.png' }]);
});

// --- folder (the diff's stable key) ------------------------------------------
// The one identity a piece keeps. `displayName` is editorial — upstream renames
// pieces — and not unique: two folders publish 'Cashfree Payments' today. The
// collector read `folder` for the logo index and then threw it away, which left
// view.mjs diffing the weeks by name; see the tests in weekly-view.test.mjs for
// what that costs.

test('the outputSchema roster records the catalog folder alongside the display name', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.deepEqual(roster.map((r) => r.folder), ['airtable', 'notion', 'slack', 'zendesk']);
});

test('two catalog rows sharing a displayName stay distinguishable by folder', () => {
  const dup = { pieces: [
    { folder: '@activepieces/cashfree-payments', displayName: 'Cashfree Payments', actions: 5, triggers: 0,
      tier: 'P1', status: 'live', logoUrl: 'https://cdn.activepieces.com/pieces/cashfree-payments.png' },
    { folder: 'cashfree-payments', displayName: 'Cashfree Payments', actions: 3, triggers: 0,
      tier: 'P2', status: 'review', logoUrl: 'https://cdn.activepieces.com/pieces/cashfree-payments.png' },
  ] };
  const { roster } = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': dup }) });
  assert.deepEqual(roster.map((r) => r.folder), ['@activepieces/cashfree-payments', 'cashfree-payments']);
});

// A folder is optional detail on the same terms as a logo: a catalog row that
// lost it keeps its name and its numbers, and the diff falls back to the name
// for that row alone.
test('a catalog row with no usable folder still yields a roster row, without the key', () => {
  const noFolder = { pieces: [{ displayName: 'Slack', actions: 12, triggers: 3, tier: 'P1', status: 'live',
                                logoUrl: 'https://cdn.activepieces.com/pieces/slack.png' }] };
  const { roster } = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': noFolder }) });
  assert.equal(roster.length, 1);
  assert.equal('folder' in roster[0], false, 'an absent folder must not become a dead key in the archive');
  assert.equal(roster[0].name, 'Slack');
});

// `name` stays the SLUG — it is the identity the week-over-week diff matches on
// and the only key the committed snapshots carry — and the catalog's editorial
// name rides alongside it as `displayName`, for the page to render. `asana` is
// absent from the catalog, so it resolves to neither.
test('collectAiActions carries a roster, sorted by actions desc then name', () => {
  assert.deepEqual(collectAiActions({ readJson: aiRead() }), {
    status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
    roster: [
      { name: 'google-docs', actions: 37, stage: 'merged', displayName: 'Google Docs',
        logo: 'https://cdn.activepieces.com/pieces/google-docs.png' },
      { name: 'airtable', actions: 19, stage: 'held', displayName: 'Airtable',
        logo: 'https://cdn.activepieces.com/pieces/airtable-v2.png' },
      { name: 'gmail', actions: 19, stage: 'pr-open', displayName: 'Gmail',
        logo: 'https://cdn.activepieces.com/pieces/gmail.png' },
      { name: 'asana', actions: 5, stage: 'assigned', logo: null },
    ],
  });
});

test('a missing AI-actions roster file leaves the tile numbers intact', () => {
  const out = collectAiActions({ readJson: reader({ 'dist/ai-actions/summary.json': AI_SUMMARY }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.prOpen, 24);
  assert.equal(out.totalPieces, 28);
  assert.deepEqual(out.roster, []);
});

test('a malformed AI-actions roster file yields an empty roster, not no-data', () => {
  const out = collectAiActions({ readJson: aiRead({ 'dist/ai-actions/pieces.json': { pieces: { gmail: 19 } } }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster, []);
});

test('an AI-actions roster row with a non-numeric atomics count drops the whole roster', () => {
  const broken = { pieces: [{ slug: 'gmail', atomics: null, stage: 'pr-open' }] };
  const out = collectAiActions({ readJson: aiRead({ 'dist/ai-actions/pieces.json': broken }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.prOpen, 24);
  assert.deepEqual(out.roster, []);
});

test('an AI-actions roster row with an empty slug drops the whole roster', () => {
  const broken = { pieces: [{ slug: '', atomics: 3, stage: 'held' }] };
  const out = collectAiActions({ readJson: aiRead({ 'dist/ai-actions/pieces.json': broken }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster, []);
});

// --- catalog denominator -------------------------------------------------------
// The AI-actions initiative TRACKS 28 pieces; the catalog is 756. `totalPieces`
// stays the tracked count — the committed snapshot has it and the schema
// requires it — and `catalogPieces` carries the real catalog size so the tile
// can stop reading as "2 of 28", which overstates coverage ~27x. Like `roster`
// it is OPTIONAL detail: losing it costs the denominator, never the workstream.

const withCatalog = (over) => aiRead({ 'dist/output-schema/summary.json': over ?? OS_SUMMARY });

test('collectAiActions carries the catalog denominator from the outputSchema summary', () => {
  const out = collectAiActions({ readJson: withCatalog() });
  assert.equal(out.catalogPieces, 756);
  assert.equal(out.totalPieces, 28);
});

test('a missing outputSchema summary omits the denominator rather than guessing one', () => {
  const out = collectAiActions({ readJson: aiRead() });
  assert.equal(out.status, 'ok');
  assert.equal(out.merged, 2);
  assert.ok(!('catalogPieces' in out), 'the key must be absent, not present-and-undefined');
});

test('a non-numeric totals.pieces omits the denominator instead of flowing through untyped', () => {
  const out = collectAiActions({ readJson: withCatalog({ ...OS_SUMMARY, totals: { pieces: '756' } }) });
  assert.equal(out.status, 'ok');
  assert.ok(!('catalogPieces' in out));
});

test('an outputSchema summary with no totals block omits the denominator', () => {
  const out = collectAiActions({ readJson: withCatalog({ status: OS_SUMMARY.status }) });
  assert.equal(out.status, 'ok');
  assert.ok(!('catalogPieces' in out));
});

// typeof, not truthiness — the same rule every other numeric field here follows.
test('a zero catalog survives as 0', () => {
  const out = collectAiActions({ readJson: withCatalog({ ...OS_SUMMARY, totals: { pieces: 0 } }) });
  assert.equal(out.catalogPieces, 0);
});

// --- logos ---------------------------------------------------------------------
// `dist/output-schema/pieces.json` is the ONLY source of a logo URL. The
// outputSchema roster reads it off the row it is already mapping; the AI-actions
// roster has a slug and nothing else, so it looks the URL up by `folder`.
//
// It is never CONSTRUCTED from the slug. A guessed CDN path returns 200 for
// every piece whose slug happens to equal its folder and a silent 404 for the
// first one where they diverge — with no signal at snapshot time and no signal
// on the page beyond a piece that quietly loses its logo.
//
// Logos are a recognition cue, so they degrade one row at a time: an unresolved
// logo is `null` and its row still carries the name and the count.

const logosOf = (roster) => Object.fromEntries(roster.map((r) => [r.name, r.logo]));

test('outputSchema roster rows carry the logo URL the catalog publishes', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.deepEqual(logosOf(roster), {
    Airtable: 'https://cdn.activepieces.com/pieces/airtable-v2.png',
    Notion: 'https://cdn.activepieces.com/pieces/notion.png',
    Slack: 'https://cdn.activepieces.com/pieces/slack.png',
    Zendesk: 'https://cdn.activepieces.com/pieces/zendesk.png',
  });
});

// The fixture's airtable logo is `airtable-v2.png`, not `airtable.png`: this
// only passes if the URL was read, not derived.
test('the outputSchema logo is read from the row, not derived from its folder', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.equal(roster.find((r) => r.name === 'Airtable').logo,
    'https://cdn.activepieces.com/pieces/airtable-v2.png');
});

test('a catalogued piece with no logoUrl keeps its row with logo null', () => {
  const noLogo = { pieces: [{ folder: 'slack', displayName: 'Slack', actions: 12, triggers: 3, status: 'live' }] };
  const out = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': noLogo }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster, [{ folder: 'slack', name: 'Slack', actions: 12, triggers: 3, stage: 'live',
                                  tier: undefined, logo: null }]);
});

// A logo is decoration, so a junk one costs that one logo. Contrast the numeric
// fields, where a junk value drops the whole roster.
test('a non-string logoUrl yields logo null without dropping the roster', () => {
  const junk = { pieces: [{ folder: 'slack', displayName: 'Slack', actions: 12, triggers: 3, tier: 'P1',
                            status: 'live', logoUrl: 42 }] };
  const { roster } = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': junk }) });
  assert.equal(roster.length, 1);
  assert.equal(roster[0].logo, null);
});

// `<img src="">` re-requests the page itself and renders as a broken image, so
// an empty URL has to become the same `null` as no URL at all.
test('an empty logoUrl yields logo null, not an empty string', () => {
  const empty = { pieces: [{ folder: 'slack', displayName: 'Slack', actions: 12, triggers: 3, tier: 'P1',
                             status: 'live', logoUrl: '' }] };
  const { roster } = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': empty }) });
  assert.equal(roster[0].logo, null);
});

test('AI-actions roster rows resolve their logo by slug → catalog folder', () => {
  const { roster } = collectAiActions({ readJson: aiRead() });
  assert.deepEqual(logosOf(roster), {
    'google-docs': 'https://cdn.activepieces.com/pieces/google-docs.png',
    airtable: 'https://cdn.activepieces.com/pieces/airtable-v2.png',
    gmail: 'https://cdn.activepieces.com/pieces/gmail.png',
    asana: null,
  });
});

test('an AI-actions slug missing from the catalog yields null, never a guessed URL', () => {
  const { roster } = collectAiActions({ readJson: aiRead() });
  const asana = roster.find((r) => r.name === 'asana');
  assert.equal(asana.logo, null, 'unresolved must be null — a constructed CDN path would 404 silently');
  assert.equal(asana.actions, 5, 'the row itself survives: name and count are the data');
});

test('a missing catalog file costs the AI-actions logos and nothing else', () => {
  const out = collectAiActions({ readJson: reader({
    'dist/ai-actions/summary.json': AI_SUMMARY,
    'dist/ai-actions/pieces.json': AI_PIECES,
  }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.prOpen, 24);
  assert.equal(out.totalPieces, 28);
  assert.equal(out.roster.length, 4);
  assert.deepEqual(out.roster.map((r) => r.logo), [null, null, null, null]);
  assert.deepEqual(out.roster.map((r) => r.name), ['google-docs', 'airtable', 'gmail', 'asana'],
    'the slug is the row, so every piece keeps its identity and its count');
});

test('a malformed catalog file costs the AI-actions logos and nothing else', () => {
  const out = collectAiActions({ readJson: aiRead({ 'dist/output-schema/pieces.json': { pieces: 'nope' } }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.prOpen, 24);
  assert.equal(out.roster.length, 4);
  assert.deepEqual(out.roster.map((r) => r.logo), [null, null, null, null]);
});

test('a catalog entry with a folder but no usable logoUrl resolves to null', () => {
  const partial = { pieces: [{ folder: 'gmail', displayName: 'Gmail', status: 'todo', logoUrl: null }] };
  const { roster } = collectAiActions({ readJson: aiRead({ 'dist/output-schema/pieces.json': partial }) });
  assert.equal(roster.find((r) => r.name === 'gmail').logo, null);
});

// A row the catalog cannot key must not take the other 755 rows' logos with it.
test('a catalog entry with no folder is skipped, leaving the rest resolvable', () => {
  const withJunkRow = { pieces: [{ displayName: 'Nameless', logoUrl: 'https://cdn.activepieces.com/x.png' },
                                 ...OS_PIECES.pieces] };
  const { roster } = collectAiActions({ readJson: aiRead({ 'dist/output-schema/pieces.json': withJunkRow }) });
  assert.equal(roster.find((r) => r.name === 'gmail').logo, 'https://cdn.activepieces.com/pieces/gmail.png');
});

// --- display names -------------------------------------------------------------
// The AI-actions build knows a piece by its SLUG (`google-docs`) and nothing else,
// so its roster used to put that on the page beside boxes naming pieces `ClickUp`
// and `Google Sheets` — one page, two naming conventions, one of them an internal
// identifier a project manager has no use for.
//
// The catalog is the same file the logos come from and it publishes the piece's
// real `displayName`, keyed by `folder`. So the name is LOOKED UP, on exactly the
// terms the logo is: resolved per row, `name` still the slug (the identity the
// week-over-week diff matches on — see weekly-view.test.mjs), and an unresolved
// row keeping its slug rather than a prettified guess.

const namesOf = (roster) => Object.fromEntries(roster.map((r) => [r.name, r.displayName]));

test('AI-actions roster rows resolve their display name by slug → catalog folder', () => {
  const { roster } = collectAiActions({ readJson: aiRead() });
  assert.deepEqual(namesOf(roster), {
    'google-docs': 'Google Docs',
    airtable: 'Airtable',
    gmail: 'Gmail',
    asana: undefined,
  });
});

test('a resolved display name never replaces the slug the diff is keyed on', () => {
  const { roster } = collectAiActions({ readJson: aiRead() });
  assert.deepEqual(roster.map((r) => r.name), ['google-docs', 'airtable', 'gmail', 'asana']);
});

// The catalog renames pieces — `sendinblue` publishes as `Brevo` today — so a name
// derived from the slug is not merely uglier, it is wrong. Nothing an
// implementation could title-case out of `sendinblue` is `Brevo`.
test('a display name is read from the catalog, never derived from the slug', () => {
  const { roster } = collectAiActions({ readJson: aiRead({
    'dist/ai-actions/pieces.json': { pieces: [{ slug: 'sendinblue', atomics: 4, stage: 'merged' }] },
    'dist/output-schema/pieces.json': { pieces: [{ folder: 'sendinblue', displayName: 'Brevo', status: 'todo',
      logoUrl: 'https://cdn.activepieces.com/pieces/brevo.png' }] },
  }) });
  assert.deepEqual(roster, [{ name: 'sendinblue', actions: 4, stage: 'merged', displayName: 'Brevo',
                             logo: 'https://cdn.activepieces.com/pieces/brevo.png' }]);
});

test('a slug missing from the catalog carries no display name at all', () => {
  const { roster } = collectAiActions({ readJson: aiRead() });
  const asana = roster.find((r) => r.name === 'asana');
  assert.equal('displayName' in asana, false, 'an unresolved name must not become a dead key in the archive');
  assert.equal(asana.actions, 5, 'the row itself survives: the slug and the count are the data');
});

// A display name is a label, so a junk one costs that label. Contrast the numeric
// fields, where a junk value drops the whole roster.
test('a catalogued piece with no usable displayName keeps its row and its slug', () => {
  for (const displayName of [undefined, null, '', 42]) {
    const { roster } = collectAiActions({ readJson: aiRead({
      'dist/output-schema/pieces.json': { pieces: [{ folder: 'gmail', displayName, status: 'todo',
        logoUrl: 'https://cdn.activepieces.com/pieces/gmail.png' }] } }) });
    const gmail = roster.find((r) => r.name === 'gmail');
    assert.equal('displayName' in gmail, false, `displayName ${JSON.stringify(displayName)} became a key`);
    assert.equal(gmail.logo, 'https://cdn.activepieces.com/pieces/gmail.png', 'the logo still resolved');
  }
});

test('a missing catalog file costs the AI-actions display names and nothing else', () => {
  const { roster } = collectAiActions({ readJson: reader({
    'dist/ai-actions/summary.json': AI_SUMMARY,
    'dist/ai-actions/pieces.json': AI_PIECES,
  }) });
  assert.equal(roster.length, 4);
  assert.ok(roster.every((r) => !('displayName' in r)));
  assert.deepEqual(roster.map((r) => r.name), ['google-docs', 'airtable', 'gmail', 'asana']);
});

// The catalog row a slug resolves against may be parked out of the outputSchema
// roster (`todo`/`skip`) — `google-docs` is — so the index must key every
// catalogued piece, not just the ones that workstream reports on.
test('a slug resolves against a catalog row the outputSchema roster parks', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.ok(!roster.some((r) => r.name === 'Google Docs'), 'the fixture must park it');
  assert.equal(collectAiActions({ readJson: aiRead() }).roster
    .find((r) => r.name === 'google-docs').displayName, 'Google Docs');
});

// The collectors and the archive schema are two halves of one contract, and the
// only place they meet is inside snapshot.mjs — which cannot run in a test,
// because it writes the committed archive. Pipe real collector output through
// the real validator instead, so an unresolved logo the collectors emit can
// never be a value the schema rejects at snapshot time.
test('what the collectors emit — including an unresolved logo — passes validateSnapshot', () => {
  const snap = {
    week: '2026-W31', start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01', decisions: [],
    outputSchema: collectOutputSchema({ readJson: osRead() }),
    aiActions: collectAiActions({ readJson: aiRead() }),
    testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
    tickets: { status: 'ok', total: 11 },
  };
  assert.ok(snap.aiActions.roster.some((r) => r.logo === null), 'the fixture must exercise the unresolved path');
  assert.ok(snap.aiActions.roster.some((r) => typeof r.displayName === 'string'), 'and the resolved name path');
  assert.ok(snap.aiActions.roster.some((r) => !('displayName' in r)), 'and the unresolved name path');
  assert.ok(snap.outputSchema.roster.every((r) => typeof r.logo === 'string'));
  validateSnapshot(snap);
});
