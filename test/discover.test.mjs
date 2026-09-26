// test/discover.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFiles, discoverClaims, claimedPr } from '../lib/discover.mjs';

const file = (filename, patch = '') => ({ filename, patch });
const piece = (slug, rest) => `packages/pieces/community/${slug}/${rest}`;
const rollouts = (map, slug) => [...(map.get(slug) ?? [])].sort();

test('an output-schemas.ts file is the outputSchema signature', () => {
  const m = classifyFiles([file(piece('slack', 'src/lib/output-schemas.ts'))]);
  assert.deepEqual(rollouts(m, 'slack'), ['outputSchema']);
});

test('added propertyGroups or advanced:true is the property-UI signature', () => {
  for (const line of ['+    propertyGroups: [', '+      advanced: true,', '+  advanced:true']) {
    const m = classifyFiles([file(piece('gmail', 'src/lib/actions/send.ts'), line)]);
    assert.deepEqual(rollouts(m, 'gmail'), ['uiImprovements'], `missed: ${line}`);
  }
});

test('an added audience: \'ai\' action is the AI-actions signature', () => {
  for (const line of ["+  audience: 'ai',", "+  audience:'ai',", '+    audience: "ai",']) {
    const m = classifyFiles([file(piece('slack', 'src/lib/actions/post.ts'), line)]);
    assert.deepEqual(rollouts(m, 'slack'), ['aiActions'], `missed: ${line}`);
  }
});

// The team comments these actions with the same phrase: 16 of 1576 matches on
// main were comments. A comment is not an action.
test('a comment naming audience: \'ai\' is not the AI-actions signature', () => {
  const m = classifyFiles([file(piece('trello', 'src/index.ts'), "+// audience:'ai' agent atomics\n+ * Shared helpers for the audience:'ai' atomics")]);
  assert.equal(m.size, 0);
});

// src/ is the scope main is read in; a fixture under test/ is not a shipped action.
test('an audience: \'ai\' line outside src/ is not the AI-actions signature', () => {
  const m = classifyFiles([file(piece('asana', 'test/fixtures/actions.ts'), "+  audience: 'ai',")]);
  assert.equal(m.size, 0);
});

// aiMetadata sits on 720 of 733 pieces and audience: 'both' on 663 -- both came
// in with a catalog-wide migration, so neither says anything about THIS work.
// #15389 added 24 actions to three pieces as 'both' and is the case in point.
test('aiMetadata and audience: \'both\' are not the AI-actions signature', () => {
  const m = classifyFiles([file(piece('google-gemini', 'src/lib/actions/img.ts'),
    "+  aiMetadata: { description: 'x' },\n+  audience: 'both',\n+  audience: 'human',")]);
  assert.equal(m.size, 0);
});

// The rollout is adoption. A PR that strips the new UI back out is the opposite
// of this work, and counting it would be worse than missing it.
test('a removed line is not adoption', () => {
  const m = classifyFiles([file(piece('gmail', 'src/lib/actions/send.ts'), '-      advanced: true,')]);
  assert.equal(m.size, 0);
});

// `+++ b/<path>` starts with a '+' and carries the filename. Unfiltered, it tags
// every PR that so much as renames a file called ai-metadata.ts.
test('the diff header is not a line of code', () => {
  const m = classifyFiles([file(piece('slack', 'src/lib/x.ts'), '+++ b/packages/pieces/community/slack/src/lib/aiMetadata.ts')]);
  assert.equal(m.size, 0);
});

// The rollouts are about pieces. Engine, UI and shared changes are not.
test('files outside packages/pieces/community are ignored', () => {
  const m = classifyFiles([
    file('packages/server/api/src/app/flows/agent.ts', "+  audience: 'ai',"),
    file('packages/shared/src/lib/output-schemas.ts', '+  propertyGroups: []'),
  ]);
  assert.equal(m.size, 0);
});

// One PR, two pieces. A PR-level answer would put both rollouts on both pieces;
// the signal belongs to the piece whose file carried it.
test('signals attribute to the piece whose file carried them', () => {
  const m = classifyFiles([
    file(piece('pinterest', 'src/lib/output-schemas.ts')),
    file(piece('trello', 'src/lib/actions/card.ts'), '+  advanced: true,'),
  ]);
  assert.deepEqual(rollouts(m, 'pinterest'), ['outputSchema']);
  assert.deepEqual(rollouts(m, 'trello'), ['uiImprovements']);
});

test('one piece can be doing two rollouts in one PR', () => {
  const m = classifyFiles([
    file(piece('whatsapp', 'src/lib/output-schemas.ts')),
    file(piece('whatsapp', 'src/lib/actions/send.ts'), "+  audience: 'ai',"),
  ]);
  assert.deepEqual(rollouts(m, 'whatsapp'), ['aiActions', 'outputSchema']);
});

// ── no wave filter ──────────────────────────────────────────────────────────
// AI-actions used to be filtered to a curated wave of 28, because its old
// signature (aiMetadata) was on every scaffolded piece. That filter, and the
// curated roster behind it, is what hid W39: 23 pieces gained agent atomics
// that week, across 17 PRs, and the page reported one.
// audience: 'ai' is on 52 pieces, none of them by template, so it needs no list.
const AI_PR = { number: 15725, files: [
  { filename: piece('pipedrive', 'src/lib/actions/deal.ts'), patch: "+  audience: 'ai'," },
  { filename: piece('mailer-lite', 'src/lib/actions/sub.ts'), patch: "+  audience: 'ai'," },
] };
const NEW_PIECE_PR = { number: 15551, files: [{ filename: piece('kickcall', 'src/lib/actions/call.ts'), patch: "+ aiMetadata: {},\n+ audience: 'both'," }] };

test('AI-actions is catalog-wide: every piece a PR gives agent atomics is found', () => {
  assert.deepEqual(discoverClaims([AI_PR, NEW_PIECE_PR]).aiActions, { pipedrive: 15725, 'mailer-lite': 15725 });
});

// The old option is ignored rather than rejected, so a caller still passing it
// cannot quietly narrow the rollout back down.
test('a stale aiWave option no longer narrows AI-actions', () => {
  assert.deepEqual(discoverClaims([AI_PR], { aiWave: ['slack'] }).aiActions, { pipedrive: 15725, 'mailer-lite': 15725 });
});

// The other two rollouts are catalog-wide: every published piece is in scope, so
// there is no list to be absent from.
test('the catalog-wide rollouts take no wave filter', () => {
  const out = discoverClaims([
    { number: 15258, files: [{ filename: piece('firecrawl', 'src/lib/output-schemas.ts') }] },
    { number: 15216, files: [{ filename: piece('outseta', 'src/lib/actions/sub.ts'), patch: '+ advanced: true,' }] },
  ]);
  assert.deepEqual(out.outputSchema, { firecrawl: 15258 });
  assert.deepEqual(out.uiImprovements, { outseta: 15216 });
});

// The supersede case: a PR reopened or split out under a new number. The later
// one is the live one.
test('the newest PR wins when two claim the same piece and rollout', () => {
  const f = [{ filename: piece('notion', 'src/lib/output-schemas.ts') }];
  const out = discoverClaims([{ number: 15400, files: f }, { number: 15100, files: f }]);
  assert.equal(out.outputSchema.notion, 15400);
});

test('a PR with no number or no files is skipped, not thrown on', () => {
  const out = discoverClaims([{ files: [{ filename: piece('slack', 'src/lib/output-schemas.ts') }] }, { number: 5 }, null]);
  assert.deepEqual(out.outputSchema, {});
});

// ── the merge rule ──────────────────────────────────────────────────────────
// A human knows that #15406 superseded #15398. The diff does not.
test('a curated claim always beats a discovered one', () => {
  assert.equal(claimedPr(15406, { 'google-calendar': 15398 }, 'google-calendar'), 15406);
});

test('a discovered claim fills a gap', () => {
  assert.equal(claimedPr(null, { notion: 15397 }, 'notion'), 15397);
});

test('no claim either way is null, not undefined', () => {
  assert.equal(claimedPr(null, {}, 'slack'), null);
  assert.equal(claimedPr(undefined, undefined, 'slack'), null);
});

// Asana is two PRs: #15757 into main, and #15758 stacked on #15757's branch. The
// one into main is the one that lands, so it is the piece's claim even though
// the stacked one has the higher number.
test('a PR into main wins over a stacked one for the same piece', () => {
  const f = [{ filename: piece('asana', 'src/lib/actions/task.ts'), patch: "+  audience: 'ai'," }];
  const out = discoverClaims([
    { number: 15757, base: 'main', files: f },
    { number: 15758, base: 'feat/asana-ai-actions-a', files: f },
  ]);
  assert.deepEqual(out.aiActions, { asana: 15757 });
});
