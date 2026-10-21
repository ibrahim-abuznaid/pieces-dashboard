// test/ai-report.test.mjs
// The private report is the one place names belong; this checks it says what
// a reader needs (piece, action, file:line, why) in the order the task asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../lib/ai-report.mjs';

const counts = {
  commit: 'abcdef1234567890', committedAt: '2026-10-21T10:00:00Z', fetched: '2026-10-21',
  baseline: { commit: '9ed198fb27f5', committedAt: '2026-07-21' },
  ai: { pieces: 3, actions: 10, unresolvedProps: 1 },
  k4: { p1PassPct: 90, p1Actions: 1, piecesCleanOfP1: 2, piecesCleanIncludingS2: 1 },
  checks: Object.fromEntries(['S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S1b', 'S5', 'S8', 'S9'].map((k) => [k, { severity: ['S1b', 'S5', 'S8', 'S9'].includes(k) ? 'P2' : 'P1', actions: 0, pieces: 0 }])),
};
const file = 'packages/pieces/community/acme/src/lib/actions/update-widget.ts';
const findings = [
  { check: 'S1', severity: 'P1', piece: 'acme', action: 'update_widget', displayName: 'Update Widget', file, line: 10, why: 'optional Checkbox `shiny`', props: [{ key: 'shiny', line: 38 }] },
  { check: 'S2', severity: 'P1', piece: 'acme', file: 'packages/pieces/community/acme/src/index.ts', why: '2 action(s) moved', actions: ['create_gadget', 'create_gizmo'] },
  { check: 'S8', severity: 'P2', piece: 'globex', action: 'get_sprocket', file: 'x', line: 1, why: 'no outputSchema' },
  { check: 'S8', severity: 'P2', piece: 'globex', action: 'get_cog', file: 'x', line: 2, why: 'no outputSchema' },
];

test('P1 findings grouped by piece, with file:line linked at the audited commit', () => {
  const md = renderReport({ audit: { counts, findings } });
  assert.match(md, /^# AI actions audit — main abcdef1/m);
  assert.match(md, /PRIVATE/);
  assert.match(md, /## P1 findings — 2 across 1 pieces/);
  assert.match(md, /### acme \(2\)/);
  assert.match(md, /\*\*S1\*\* `update_widget` \(Update Widget\) — \[src\/lib\/actions\/update-widget\.ts:38\]\(https:\/\/github\.com\/activepieces\/activepieces\/blob\/abcdef1234567890\/packages\/pieces\/community\/acme\/src\/lib\/actions\/update-widget\.ts#L38\)/);
  assert.match(md, /\*\*S2\*\* piece .* `create_gadget`, `create_gizmo`/);
  assert.ok(md.indexOf('## P1') < md.indexOf('## P2') && md.indexOf('## P2') < md.indexOf('## Rollout'), 'P1, then P2, then rollout');
});

test('P2 is counts per piece, not a list', () => {
  const md = renderReport({ audit: { counts, findings } });
  assert.match(md, /\| globex \|  \|  \| 2 \|  \| 2 \|/);
  assert.doesNotMatch(md, /get_sprocket/);
});

test('rollout: the stuck list, the not-yet-served list, and "not measured" without a funnel', () => {
  assert.match(renderReport({ audit: { counts, findings: [] } }), /## Rollout\n\nNot measured this run\./);
  const rows = [
    { slug: 'late', mainVersion: '0.2.0', npmLatest: '0.2.0', cloudVersion: '0.1.0', mergedAt: '2026-10-19T10:00:00Z', stuck24h: true, served: false, servedWithAi: false, cloudRegistered: true, missingAi: ['a'], npmAtMain: true },
    { slug: 'today', mainVersion: '0.3.0', npmLatest: '0.3.0', cloudVersion: '0.2.0', mergedAt: '2026-10-21T10:00:00Z', stuck24h: false, served: false, servedWithAi: false, cloudRegistered: true, missingAi: [], npmAtMain: true },
    { slug: 'fine', mainVersion: '1.0.0', npmLatest: '1.0.0', cloudVersion: '1.0.0', mergedAt: '2026-10-01T10:00:00Z', stuck24h: false, served: true, servedWithAi: true, missingAi: [], npmAtMain: true },
  ];
  const md = renderReport({ audit: { counts, findings: [] }, rollout: { npm: { atMain: 3, measured: 3, lagMinutes: { median: 6, p90: 9, max: 9 }, collisions: 0 }, cloud: { served: 1, servedWithAi: 1, measured: 3 }, rows } });
  assert.match(md, /### Stuck, collided or behind — 1\n[\s\S]*\| late \| 0\.2\.0 \| 0\.2\.0 \| 0\.1\.0 \| 2026-10-19T10:00 \| Cloud serves an older version \|/);
  assert.match(md, /### Not serving main yet, merged under 24 h ago — 1\n[\s\S]*\| today \|/);
  assert.doesNotMatch(md, /\| fine \|/);
});
