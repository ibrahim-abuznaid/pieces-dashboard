// test/ai-audit.test.mjs
// Every static check on a fake piece small enough to read in one go. The
// regression oracle for the real catalog is the council's run at 6d93dbc
// (README, "Quality & rollout"); these pin down the rule each number rests on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPiece, auditCatalog, audiencesOf, aiRoster, isBehaviourFlag, isUpdateAction, mentionedIn, isPieceSource } from '../lib/ai-audit.mjs';

// A piece from { relPath: text }. Paths are rooted the way the clone roots them.
const piece = (slug, files, pkg = { name: `@activepieces/piece-${slug}`, version: '0.1.0' }) => extractPiece({
  slug,
  files: Object.entries(files).map(([rel, text]) => ({ path: `packages/pieces/community/${slug}/src/${rel}`, text })),
  packageJson: pkg,
});
const index = (names, { floor = "'0.88.2'", displayName = 'Acme' } = {}) => `
import { createPiece } from '@activepieces/pieces-framework';
${names.map((n) => `import { ${n} } from './lib/${n}';`).join('\n')}
export const acme = createPiece({ displayName: '${displayName}', minimumSupportedRelease: ${floor}, actions: [${names.join(', ')}] });
`;
// One action; `extra` lands inside createAction({...}).
const action = (varName, { name = varName, displayName = 'Do thing', audience = "'ai'", props = '{}', extra = '', classification = "'WRITE'", outputSchema = true } = {}) => `
import { createAction, Property } from '@activepieces/pieces-framework';
export const ${varName} = createAction({
  name: '${name}',
  displayName: '${displayName}',
  description: 'x',
  ${audience == null ? '' : `audience: ${audience},`}
  ${classification == null ? '' : `classification: ${classification},`}
  aiMetadata: { description: 'Updates one record and leaves the other fields alone.', idempotent: true },
  ${outputSchema ? 'outputSchema: { type: "object" },' : ''}
  props: ${props},
  ${extra}
  async run() { return {}; },
});
`;
const audit = (pieces, opts = {}) => auditCatalog({ pieces, latestRelease: '0.92.3', ...opts });
const of = (r, check) => r.findings.filter((f) => f.check === check);

test('source files: tests, specs, declarations and i18n are not piece code', () => {
  assert.equal(isPieceSource('packages/pieces/community/a/src/lib/x.ts'), true);
  for (const p of ['src/lib/x.test.ts', 'src/lib/x.spec.ts', 'src/x.d.ts', 'src/test/x.ts', 'src/__tests__/x.ts', 'src/i18n/x.ts', 'src/x.json']) {
    assert.equal(isPieceSource(`packages/pieces/community/a/${p}`), false, p);
  }
});

test('extraction reads audience, classification, aiMetadata, outputSchema, floor and the piece name', () => {
  const p = piece('acme', {
    'index.ts': index(['upd'], { floor: 'FLOOR', displayName: 'Acme CRM' }).replace('export const acme', "const FLOOR = '0.90.1';\nexport const acme"),
    'lib/upd.ts': action('upd', { name: 'update_thing', classification: "'WRITE'" }),
  });
  assert.equal(p.displayName, 'Acme CRM');
  assert.equal(p.minimumSupportedRelease, '0.90.1', 'resolved through a same-file const');
  assert.equal(p.npmName, '@activepieces/piece-acme');
  assert.equal(p.version, '0.1.0');
  const [a] = p.actions;
  assert.equal(a.name, 'update_thing');
  assert.equal(a.audience, 'ai');
  assert.equal(a.classification, 'WRITE');
  assert.equal(a.ai.idem, true);
  assert.match(a.ai.desc, /leaves the other fields/);
  assert.equal(a.hasOutputSchema, true);
  assert.equal(a.varName, 'upd');
  assert.equal(a.exported, true);
  assert.equal(a.registered, true);
  assert.equal(p.grepLines, 1);
});

test('props resolve across same-file consts and spreads, with required and defaultValue', () => {
  const p = piece('acme', {
    'index.ts': index(['upd']),
    'lib/upd.ts': `
const shared = { tags: Property.Array({ displayName: 'Tags', required: false }) };
const shiny = Property.Checkbox({ displayName: 'Shiny', required: false, defaultValue: true });
${action('upd', { name: 'update_thing', props: "{ ...shared, shiny, id: Property.ShortText({ displayName: 'Id', required: true }) }" })}`,
  });
  const props = Object.fromEntries(p.actions[0].props.map((x) => [x.key, x]));
  assert.equal(props.tags.type, 'Array');
  assert.equal(props.tags.required, false);
  assert.equal(props.shiny.type, 'Checkbox');
  assert.equal(props.shiny.hasDefault, true);
  assert.equal(props.shiny.defaultValue, true);
  assert.equal(props.id.required, true);
  assert.equal(p.actions[0].propsUnresolved, false);
});

test('a prop from a helper outside the piece is unresolved, so S1 is a floor', () => {
  const p = piece('acme', {
    'index.ts': index(['upd']),
    'lib/upd.ts': `import { boardProp } from '@activepieces/pieces-common';\n${action('upd', { name: 'update_x', props: '{ board: boardProp() }' })}`,
  });
  assert.equal(p.actions[0].props[0].via, 'unresolved');
  assert.equal(audit([p]).counts.ai.unresolvedProps, 1);
});

test('update actions: by name word or by display name', () => {
  for (const name of ['update_gizmo', 'gizmo_update', 'set_status', 'edit-gizmo', 'patch_record', 'change_owner', 'toggle_flag']) {
    assert.equal(isUpdateAction({ name, displayName: '' }), true, name);
  }
  assert.equal(isUpdateAction({ name: 'x', displayName: 'Update Gizmo (Agent)' }), true);
  for (const name of ['create_gizmo', 'get_settings', 'upsert_row', 'reset_password']) {
    assert.equal(isUpdateAction({ name, displayName: 'Do it' }), false, name);
  }
});

test('behaviour flags: "false" means skip the extra step, so they are not S1', () => {
  for (const key of ['clear_description', 'clearDescription', 'notify_customer', 'notifyUsers', 'skip_automation',
    'disable_web_page_preview', 'disableParsing', 'create_labels_if_missing', 'create_missing_select_options',
    'submit', 'as_string', 'all_slides', 'make_open_ended', 'end_sale', 'merge_line_items']) {
    assert.equal(isBehaviourFlag(key), true, key);
  }
  // Saved state that happens to share a prefix still counts.
  for (const key of ['clearance', 'disabled', 'notifications', 'skipped', 'shiny', 'locked', 'visible']) {
    assert.equal(isBehaviourFlag(key), false, key);
  }
});

test('S1: an optional Checkbox on an AI update is a P1; flags, required boxes and non-updates are not', () => {
  const box = (req) => `Property.Checkbox({ displayName: 'x', required: ${req} })`;
  const p = piece('acme', {
    'index.ts': index(['a1', 'a2', 'a3', 'a4', 'a5']),
    'lib/a1.ts': action('a1', { name: 'update_widget', props: `{ shiny: ${box(false)}, clear_note: ${box(false)} }` }),
    'lib/a2.ts': action('a2', { name: 'update_flags', props: `{ notify_customer: ${box(false)}, clear_tags: ${box(false)} }` }),
    'lib/a3.ts': action('a3', { name: 'update_req', props: `{ shiny: ${box(true)} }` }),
    'lib/a4.ts': action('a4', { name: 'create_widget', props: `{ shiny: ${box(false)} }` }),
    'lib/a5.ts': action('a5', { name: 'update_human', audience: "'human'", props: `{ shiny: ${box(false)} }` }),
  });
  const r = audit([p]);
  const s1 = of(r, 'S1');
  assert.deepEqual(s1.map((f) => f.action), ['update_widget']);
  assert.deepEqual(s1[0].props.map((x) => x.key), ['shiny'], 'only the stateful box is named');
  assert.equal(s1[0].severity, 'P1');
  assert.match(s1[0].file, /lib\/a1\.ts$/);
  assert.ok(s1[0].line > 0);
  assert.deepEqual(r.counts.checks.S1, { severity: 'P1', actions: 1, pieces: 1, allOptionalCheckbox: { actions: 2, pieces: 1 } });
});

test('S1b: optional Array or DynamicProperties on an AI update is a P2', () => {
  const p = piece('acme', {
    'index.ts': index(['a1', 'a2']),
    'lib/a1.ts': action('a1', { name: 'update_gizmo', props: "{ tags: Property.Array({ displayName: 't', required: false }), extra: Property.DynamicProperties({ displayName: 'e', required: false, refreshers: [], props: async () => ({}) }) }" }),
    'lib/a2.ts': action('a2', { name: 'update_list', props: "{ items: Property.Array({ displayName: 'i', required: true }) }" }),
  });
  const r = audit([p]);
  assert.deepEqual(of(r, 'S1b').map((f) => f.action), ['update_gizmo']);
  assert.equal(of(r, 'S1b')[0].severity, 'P2');
  assert.deepEqual(of(r, 'S1b')[0].props.map((x) => x.key), ['tags', 'extra']);
  assert.equal(r.counts.checks.S1b.actions, 1);
});

// The baseline is audiences only; S2 is the diff plus the mention test.
const demoPieces = () => [
  piece('widget-co', {
    'index.ts': index(['h1', 'h2', 'h3', 'ai1'], { displayName: 'Widget Co' }),
    'lib/h1.ts': action('h1', { name: 'create_widget', audience: "'human'" }),
    'lib/h2.ts': action('h2', { name: 'get_widget', audience: "'human'" }),
    'lib/h3.ts': action('h3', { name: 'old_human', audience: "'human'" }),
    'lib/ai1.ts': action('ai1', { name: 'create_widget_ai' }),
  }),
  piece('declared', {
    'index.ts': index(['h1', 'ai1'], { displayName: 'Declared App' }),
    'lib/h1.ts': action('h1', { name: 'send', audience: "'human'" }),
    'lib/ai1.ts': action('ai1', { name: 'send_ai' }),
  }),
];
const BASE = { commit: '9ed198fb27f53755acd0df6711b84ac547ee066e', committedAt: '2026-07-21T22:41:18+03:00',
  pieces: { 'widget-co': { both: ['create_widget'], unset: ['get_widget'], human: ['old_human'] }, declared: { both: ['send'] } } };

test('S2: both/unset → human with no breaking-changes entry is a P1 at piece level', () => {
  const r = audit(demoPieces(), { baseline: BASE, breakingChanges: '## 0.90\n- Declared App: send is now human-only\n' });
  const s2 = of(r, 'S2');
  assert.deepEqual(s2.map((f) => f.piece), ['widget-co']);
  assert.deepEqual(s2[0].actions, ['create_widget', 'get_widget'], 'unset counts; human → human does not');
  assert.deepEqual(r.counts.checks.S2, { severity: 'P1', actions: 2, pieces: 1, demoted: { actions: 3, pieces: 2 } });
  // A demotion is a human action now, so it never touches the per-AI-action rate.
  assert.equal(r.counts.k4.p1Actions, 0);
  assert.equal(r.counts.k4.piecesCleanOfP1, 2);
  assert.equal(r.counts.k4.piecesCleanIncludingS2, 1);
});

test('S2 mention test: display name, slug or slug with spaces, any case', () => {
  const p = { slug: 'widget-co', displayName: 'Widget Co' };
  assert.equal(mentionedIn(p, 'the WIDGET CO piece'), true);
  assert.equal(mentionedIn(p, '@activepieces/piece-widget-co'), true);
  assert.equal(mentionedIn(p, 'widget co'), true);
  assert.equal(mentionedIn(p, 'nothing here'), false);
});

test('S2 is not measured -- null, not 0 -- without a baseline or without the docs', () => {
  const none = audit(demoPieces(), { baseline: null, breakingChanges: 'x' }).counts;
  assert.equal(none.checks.S2.actions, null);
  assert.equal(none.checks.S2.reason, 'no-baseline');
  assert.equal(none.k4.piecesCleanIncludingS2, null);
  const noDocs = audit(demoPieces(), { baseline: BASE, breakingChanges: null }).counts;
  assert.equal(noDocs.checks.S2.pieces, null);
  assert.equal(noDocs.checks.S2.reason, 'no-breaking-changes-docs');
});

test('S3/S4: the floor window 0.86.4 … latest release, counted per AI action', () => {
  const at = (floor) => piece('acme', {
    'index.ts': index(['a1', 'a2', 'h1'], { floor }),
    'lib/a1.ts': action('a1'), 'lib/a2.ts': action('a2'), 'lib/h1.ts': action('h1', { audience: "'both'" }),
  });
  assert.deepEqual(audit([at("'0.36.1'")]).counts.checks.S3, { severity: 'P1', actions: 2, pieces: 1 });
  assert.deepEqual(audit([at("'0.86.4'")]).counts.checks.S3, { severity: 'P1', actions: 0, pieces: 0 }, '0.86.4 itself is fine');
  assert.equal(audit([at('undefined')]).counts.checks.S3.actions, 2, 'a floor the audit cannot read is below it');
  assert.deepEqual(audit([at("'0.93.0'")]).counts.checks.S4, { severity: 'P1', actions: 2, pieces: 1 });
  assert.deepEqual(audit([at("'0.92.3'")]).counts.checks.S4, { severity: 'P1', actions: 0, pieces: 0 });
  const unknown = audit([at("'0.93.0'")], { latestRelease: null }).counts;
  assert.equal(unknown.checks.S4.actions, null);
  assert.equal(unknown.checks.S4.reason, 'no-latest-release');
  assert.equal(audit([at("'0.36.1'")]).counts.k4.p1PassPct, 0);
});

test('S5: an AI action and a visible twin with the same name, (Agent) ignored', () => {
  const p = piece('acme', {
    'index.ts': index(['a1', 'b1', 'a2', 'h2']),
    'lib/a1.ts': action('a1', { name: 'create_gadget_ai', displayName: 'Create Gadget (Agent)' }),
    'lib/b1.ts': action('b1', { name: 'create_gadget', displayName: 'Create gadget', audience: null }),
    'lib/a2.ts': action('a2', { name: 'get_order_ai', displayName: 'Get Order (AI)' }),
    'lib/h2.ts': action('h2', { name: 'get_order', displayName: 'Get Order', audience: "'human'" }),
  });
  const s5 = of(audit([p]), 'S5');
  assert.deepEqual(s5.map((f) => f.action), ['create_gadget_ai'], 'a human twin is hidden from agents, so it is fine');
  assert.equal(s5[0].severity, 'P2');
});

test('S6: an AI action nobody imports is a P1; inline and default-export registration count', () => {
  const p = piece('acme', {
    'index.ts': `
import { createPiece, createAction } from '@activepieces/pieces-framework';
import { used } from './lib/used';
import dflt from './lib/dflt';
export const acme = createPiece({ displayName: 'Acme', minimumSupportedRelease: '0.88.2', actions: [used, dflt,
  createAction({ name: 'inline_ai', displayName: 'Inline', audience: 'ai', classification: 'READ', outputSchema: {}, aiMetadata: { description: 'x', idempotent: true }, props: {}, async run() {} })] });`,
    'lib/used.ts': action('used'),
    'lib/orphan.ts': action('orphan'),
    'lib/dflt.ts': action('ignored').replace('export const ignored = createAction', 'export default createAction'),
  });
  const r = audit([p]);
  assert.deepEqual(of(r, 'S6').map((f) => f.action), ['orphan']);
  assert.equal(r.counts.checks.S6.actions, 1);
  assert.equal(r.counts.ai.unregisteredUnchecked, 0);
});

test('S7: two actions with one name in a piece', () => {
  const p = piece('acme', {
    'index.ts': index(['a1', 'a2']),
    'lib/a1.ts': action('a1', { name: 'dup' }),
    'lib/a2.ts': action('a2', { name: 'dup', audience: "'both'" }),
  });
  const r = audit([p]);
  assert.equal(r.counts.checks.S7.actions, 2);
  assert.equal(r.counts.k4.p1Actions, 1, 'K4 counts the AI action once');
});

test('S8: no outputSchema is a P2, deletes exempt; S9: no classification is a P2', () => {
  const p = piece('acme', {
    'index.ts': index(['a1', 'a2', 'a3', 'a4']),
    'lib/a1.ts': action('a1', { name: 'get_x', outputSchema: false }),
    'lib/a2.ts': action('a2', { name: 'delete_x', outputSchema: false }),
    'lib/a3.ts': action('a3', { name: 'cancel_x', outputSchema: false, classification: "'DESTRUCTIVE'" }),
    'lib/a4.ts': action('a4', { name: 'list_x', classification: null }),
  });
  const c = audit([p]).counts.checks;
  assert.deepEqual(c.S8, { severity: 'P2', actions: 1, pieces: 1, exempt: { actions: 2, pieces: 1 } });
  assert.deepEqual(c.S9, { severity: 'P2', actions: 1, pieces: 1 });
});

test('K4 counts each failing AI action once, and pieces clean of every P1', () => {
  const box = "Property.Checkbox({ displayName: 'x', required: false })";
  const bad = piece('bad', {
    'index.ts': index(['a1', 'a2'], { floor: "'0.30.0'" }),
    'lib/a1.ts': action('a1', { name: 'update_a', props: `{ shiny: ${box} }` }),
    'lib/a2.ts': action('a2', { name: 'get_b' }),
  });
  const good = piece('good', { 'index.ts': index(['a1']), 'lib/a1.ts': action('a1') });
  const { counts } = audit([bad, good]);
  assert.equal(counts.k4.p1Actions, 2, 'S1 + S3 on one action is still one action');
  assert.equal(counts.k4.p1PassPct, 33.3);
  assert.equal(counts.k4.piecesCleanOfP1, 1);
  assert.equal(counts.ai.pieces, 2);
  assert.equal(counts.ai.actions, 3);
});

test('audiencesOf groups names per piece, so the baseline file stays small and diffable', () => {
  const p = piece('acme', {
    'index.ts': index(['a1', 'a2', 'a3']),
    'lib/a1.ts': action('a1', { name: 'z_both', audience: "'both'" }),
    'lib/a2.ts': action('a2', { name: 'a_both', audience: "'both'" }),
    'lib/a3.ts': action('a3', { name: 'unset_one', audience: null }),
  });
  assert.deepEqual(audiencesOf([p]), { acme: { both: ['a_both', 'z_both'], unset: ['unset_one'] } });
});

test('the rollout roster lists AI pieces with their version and AI action names', () => {
  const p = piece('acme', { 'index.ts': index(['a1', 'h1']), 'lib/a1.ts': action('a1', { name: 'get_ai' }), 'lib/h1.ts': action('h1', { name: 'get', audience: "'human'" }) },
    { name: '@activepieces/piece-acme', version: '1.2.3' });
  const none = piece('plain', { 'index.ts': index(['h1']), 'lib/h1.ts': action('h1', { audience: "'both'" }) });
  assert.deepEqual(aiRoster([p, none]), [{ slug: 'acme', npmName: '@activepieces/piece-acme', version: '1.2.3', aiActions: ['get_ai'] }]);
});

// THE privacy rule, on the code path: whatever the findings say, the public
// counts carry none of the names, files or prop keys behind them.
test('the public counts never name a piece, an action, a file or a prop', () => {
  const box = "Property.Checkbox({ displayName: 'x', required: false })";
  const p = piece('zebra-secret', {
    'index.ts': index(['leaky', 'orphan'], { floor: "'0.30.0'", displayName: 'Zebra Secret' }).replace(', orphan]', ']'),
    'lib/leaky.ts': action('leaky', { name: 'update_leaky_thing', displayName: 'Update Leaky Thing', props: `{ archived_flag: ${box} }`, outputSchema: false, classification: null }),
    'lib/orphan.ts': action('orphan', { name: 'orphan_unwired' }),
  });
  const r = audit([p], { baseline: { commit: 'abc', pieces: { 'zebra-secret': { both: ['human_now'] } } }, breakingChanges: '' });
  assert.ok(r.findings.length >= 4, 'the fixture does produce findings');
  const pub = JSON.stringify(r.counts);
  for (const secret of ['zebra', 'Zebra', 'leaky', 'Leaky', 'orphan', 'archived_flag', '.ts', 'packages/', 'lib/']) {
    assert.ok(!pub.includes(secret), `public counts leak "${secret}"`);
  }
  assert.ok(JSON.stringify(r.findings).includes('update_leaky_thing'), 'the private side keeps them');
});
