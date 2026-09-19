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

test('added aiMetadata is the AI-actions signature', () => {
  const m = classifyFiles([file(piece('slack', 'src/lib/actions/post.ts'), '+  aiMetadata: { audience: "ai" },')]);
  assert.deepEqual(rollouts(m, 'slack'), ['aiActions']);
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
    file('packages/server/api/src/app/flows/aiMetadata.ts', '+  aiMetadata: {}'),
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
    file(piece('whatsapp', 'src/lib/actions/send.ts'), '+  aiMetadata: {},'),
  ]);
  assert.deepEqual(rollouts(m, 'whatsapp'), ['aiActions', 'outputSchema']);
});

// ── the wave filter ─────────────────────────────────────────────────────────
// Every piece scaffolded from the CLI template today ships aiMetadata, so an
// unfiltered rule folds three new community pieces a week into a rollout that is
// a defined wave of 28. The denominator stops meaning anything.
const AI_PR = { number: 15389, files: [{ filename: piece('google-gemini', 'src/lib/actions/img.ts'), patch: '+ aiMetadata: {}' }] };
const NEW_PIECE_PR = { number: 15551, files: [{ filename: piece('kickcall', 'src/lib/actions/call.ts'), patch: '+ aiMetadata: {}' }] };

test('AI-actions counts only pieces already in the tracked wave', () => {
  const out = discoverClaims([AI_PR, NEW_PIECE_PR], { aiWave: ['google-gemini'] });
  assert.deepEqual(out.aiActions, { 'google-gemini': 15389 });
});

test('with no wave supplied, AI-actions discovers nothing rather than everything', () => {
  assert.deepEqual(discoverClaims([AI_PR, NEW_PIECE_PR]).aiActions, {});
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
