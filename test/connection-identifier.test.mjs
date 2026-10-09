// test/connection-identifier.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectionIdentifier, validateClaims, blockAt } from '../lib/connection-identifier.mjs';

const npm = (slug) => `@activepieces/piece-${slug}`;
const cov = (slug, { oauth2 = true, hook = false, actions = 3, triggers = 1 } = {}) =>
  ({ name: npm(slug), oauth2, connIdHook: hook, totalActions: actions, totalTriggers: triggers });
const cat = (slug, displayName = slug) => ({ name: npm(slug), displayName, logoUrl: `https://cdn/${slug}.png` });

const PRS = {
  14402: { state: 'MERGED', createdAt: '2026-08-03T00:00:00Z', mergedAt: '2026-08-06T10:00:00Z', author: 'AhmadTash', assignees: [] },
  14403: { state: 'MERGED', createdAt: '2026-08-03T00:00:00Z', mergedAt: '2026-08-06T11:00:00Z', author: 'AhmadTash', assignees: [] },
  16025: { state: 'MERGED', createdAt: '2026-10-06T00:00:00Z', mergedAt: '2026-10-06T02:25:00Z', author: 'ibrahim-abuznaid', assignees: [] },
  16100: { state: 'OPEN', createdAt: '2026-10-08T00:00:00Z', mergedAt: null, author: 'OdaiAhmed99', assignees: [] },
};

const base = (over = {}) => ({
  claims: [
    { slug: 'slack', road: 'hook', pr: 14403 },
    { slug: 'gmail', road: 'hook', pr: 16025 },
    { slug: 'google-sheets', road: 'token', pr: 14403 },
    { slug: 'xero', road: 'token', pr: 14402 },
  ],
  none: [{ slug: 'workday', reason: 'tenant-scoped' }],
  coverage: [
    cov('slack', { hook: true }), cov('gmail', { hook: true }), cov('google-sheets'), cov('xero'),
    cov('workday'), cov('zoom'), cov('stripe', { oauth2: false }),
  ],
  catalog: [cat('slack', 'Slack'), cat('gmail', 'Gmail'), cat('google-sheets', 'Google Sheets'), cat('xero', 'Xero'),
    cat('workday'), cat('zoom', 'Zoom'), cat('stripe')],
  prs: PRS,
  ...over,
});

const stages = (out) => Object.fromEntries(out.rows.map((r) => [r.folder, r.stage]));

test('a hook flag on cloud is live, whatever the PR says', () => {
  const out = buildConnectionIdentifier(base());
  assert.equal(stages(out).slack, 'live');
  assert.equal(stages(out).gmail, 'live');
});

test('a hook PR merged but not flagged on cloud yet is merged, not live', () => {
  const out = buildConnectionIdentifier(base({ coverage: base().coverage.map((c) => (c.name === npm('gmail') ? { ...c, connIdHook: false } : c)) }));
  assert.equal(stages(out).gmail, 'merged');
});

test('a token row is live once its PR merged and the piece is on cloud', () => {
  const out = buildConnectionIdentifier(base());
  assert.equal(stages(out)['google-sheets'], 'live');
  assert.equal(stages(out).xero, 'live');
});

test('a token row for a piece cloud does not carry stops at merged', () => {
  const out = buildConnectionIdentifier(base({
    claims: [{ slug: 'brand-new', road: 'token', pr: 14403 }],
  }));
  assert.equal(stages(out)['brand-new'], 'merged');
});

test('an open PR is review, on either road', () => {
  const out = buildConnectionIdentifier(base({
    claims: [{ slug: 'zoom', road: 'hook', pr: 16100 }, { slug: 'xero', road: 'token', pr: 16100 }],
  }));
  assert.equal(stages(out).zoom, 'review');
  assert.equal(stages(out).xero, 'review');
});

test('an open PR found in a diff fills the gap for an unclaimed piece', () => {
  const out = buildConnectionIdentifier(base({ discovered: { zoom: 16100 } }));
  const zoom = out.rows.find((r) => r.folder === 'zoom');
  assert.equal(zoom.stage, 'review');
  assert.equal(zoom.road, 'hook');
  assert.equal(zoom.pr, 16100);
});

test('a hook live on cloud with no row is counted and warned about by name', () => {
  const out = buildConnectionIdentifier(base({
    coverage: [...base().coverage.filter((c) => c.name !== npm('zoom')), cov('zoom', { hook: true })],
  }));
  assert.equal(stages(out).zoom, 'live');
  assert.ok(out.warnings.some((w) => w.includes('zoom') && w.includes('connection-identifier/pieces.json')));
});

// 6 OAuth2 pieces on cloud (stripe is not), minus workday = 5.
test('the denominator is every OAuth2 piece on cloud minus the no-identity list', () => {
  const out = buildConnectionIdentifier(base());
  assert.equal(out.summary.totals.pieces, 5);
  assert.equal(out.summary.totals.oauth2, 6);
  assert.equal(out.summary.totals.noIdentity, 1);
});

test('a hook on a piece with no OAuth2 still widens the denominator', () => {
  const out = buildConnectionIdentifier(base({
    coverage: [...base().coverage.filter((c) => c.name !== npm('stripe')), cov('stripe', { oauth2: false, hook: true })],
  }));
  assert.equal(out.summary.totals.pieces, 6);
  assert.equal(stages(out).stripe, 'live');
});

test('a no-identity piece that gains a hook counts, and the stale listing is warned about', () => {
  const out = buildConnectionIdentifier(base({
    coverage: [...base().coverage.filter((c) => c.name !== npm('workday')), cov('workday', { hook: true })],
  }));
  assert.equal(stages(out).workday, 'live');
  assert.equal(out.summary.totals.pieces, 6);
  assert.ok(out.warnings.some((w) => w.includes('workday') && /none/.test(w)));
});

test('the numerator never exceeds the denominator', () => {
  const out = buildConnectionIdentifier(base({
    claims: [...base().claims, { slug: 'brand-new', road: 'token', pr: 14403 }],
  }));
  assert.ok(out.summary.merged <= out.summary.totals.pieces);
});

test('the headline is landed work: live plus merged, with the roads split out', () => {
  const out = buildConnectionIdentifier(base({
    coverage: base().coverage.map((c) => (c.name === npm('gmail') ? { ...c, connIdHook: false } : c)),
  }));
  assert.deepEqual(out.summary.status, { live: 3, merged: 1, review: 0, assigned: 0, planned: 0 });
  assert.equal(out.summary.merged, 4);
  assert.deepEqual(out.summary.roads, { hook: 2, token: 2 });
});

// A coverage file fetched before the two fields existed carries neither, and
// every hook would read as absent. Nothing about cloud can be claimed then --
// not `live`, and not the denominator either, since that is read off the same
// file.
test('an unmeasured coverage file publishes no live count and no denominator', () => {
  const out = buildConnectionIdentifier(base({
    coverage: base().coverage.map(({ oauth2, connIdHook, ...rest }) => rest),
  }));
  assert.equal(out.measured, false);
  assert.equal('live' in out.summary.status, false);
  assert.equal(out.summary.totals.pieces, null);
  assert.equal(stages(out).slack, 'merged');
  assert.equal(stages(out)['google-sheets'], 'merged');
});

test('rows carry the published name, logo, size and the credited author', () => {
  const out = buildConnectionIdentifier(base());
  const sheets = out.rows.find((r) => r.folder === 'google-sheets');
  assert.equal(sheets.displayName, 'Google Sheets');
  assert.equal(sheets.logoUrl, 'https://cdn/google-sheets.png');
  assert.equal(sheets.steps, 4);
  assert.equal(sheets.author, 'AhmadTash');
  assert.equal(sheets.road, 'token');
});

test('the no-identity pieces never appear as roster rows', () =>
  assert.equal(buildConnectionIdentifier(base()).rows.some((r) => r.folder === 'workday'), false));

// ── the curated file ────────────────────────────────────────────────────────
test('a well-formed claims file validates', () =>
  assert.doesNotThrow(() => validateClaims({ pieces: base().claims, none: base().none })));

test('a claim must name its road', () =>
  assert.throws(() => validateClaims({ pieces: [{ slug: 'x', pr: 1 }], none: [] }), /road/));

test('a road outside hook/token is rejected', () =>
  assert.throws(() => validateClaims({ pieces: [{ slug: 'x', road: 'scope', pr: 1 }], none: [] }), /road/));

test('a piece listed twice is rejected', () =>
  assert.throws(() => validateClaims({ pieces: [{ slug: 'x', road: 'hook' }, { slug: 'x', road: 'token' }], none: [] }), /twice/));

test('a piece both claimed and listed as no-identity is rejected', () =>
  assert.throws(() => validateClaims({ pieces: [{ slug: 'x', road: 'hook' }], none: [{ slug: 'x', reason: 'r' }] }), /both/));

test('a no-identity entry needs its reason', () =>
  assert.throws(() => validateClaims({ pieces: [], none: [{ slug: 'x' }] }), /reason/));

// ── reconstructing a past week ──────────────────────────────────────────────
const rowsNow = buildConnectionIdentifier(base()).rows;

test('a past week counts what had merged by its last day, as merged and never live', () => {
  const block = blockAt({ claims: base().claims, prs: PRS, rowsNow, totalPieces: 5, end: '2026-10-02' });
  assert.equal(block.merged, 3);
  assert.equal(block.roster.every((r) => r.stage === 'merged'), true);
  assert.equal('live' in block, false);
  assert.equal(block.totalPieces, 5);
});

test('a PR merging after the week ended is not in that week', () => {
  const block = blockAt({ claims: base().claims, prs: PRS, rowsNow, totalPieces: 5, end: '2026-10-05' });
  assert.equal(block.roster.some((r) => r.folder === 'gmail'), false);
  const next = blockAt({ claims: base().claims, prs: PRS, rowsNow, totalPieces: 5, end: '2026-10-09' });
  assert.equal(next.roster.find((r) => r.folder === 'gmail').stage, 'merged');
});

test('a PR open at the end of a week is review that week', () => {
  const block = blockAt({ claims: [{ slug: 'zoom', road: 'hook', pr: 16100 }], prs: PRS, rowsNow, totalPieces: 5, end: '2026-10-09' });
  assert.equal(block.review, 1);
  assert.equal(block.merged, 0);
});

test('a week before the feature shipped is a measured zero', () => {
  const block = blockAt({ claims: base().claims, prs: PRS, rowsNow, totalPieces: 5, end: '2026-07-31' });
  assert.deepEqual({ merged: block.merged, review: block.review, assigned: block.assigned }, { merged: 0, review: 0, assigned: 0 });
  assert.deepEqual(block.roster, []);
});

test('a reconstructed row is keyed on folder and credited to the PR author', () => {
  const block = blockAt({ claims: base().claims, prs: PRS, rowsNow, totalPieces: 5, end: '2026-10-09' });
  const gmail = block.roster.find((r) => r.folder === 'gmail');
  assert.deepEqual(gmail, {
    folder: 'gmail', name: 'gmail', displayName: 'Gmail', actions: 4, stage: 'merged',
    logo: 'https://cdn/gmail.png', author: 'ibrahim-abuznaid',
  });
});
