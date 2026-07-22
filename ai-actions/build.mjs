#!/usr/bin/env node
// Joins curated data + live PR states into dist/ai-actions/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveStage, assigneesOf } from '../lib/stages.mjs';
import { renderPage } from '../lib/render.mjs';
import { validateAiData } from './validate.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const { pieces } = read('pieces.json');
const { categories, blockers } = read('blockers.json');
const overrides = read('overrides.json');
const prData = read('../data/pr-states.json');

const problems = validateAiData({ pieces, categories, blockers });
if (problems.length) { console.error('✗ ' + problems.join('\n✗ ')); process.exit(1); }

const enriched = pieces.map((p) => {
  const ov = overrides.pieces?.[p.slug] ?? {};
  const claim = { assignee: ov.assignee ?? null, pr: p.pr ?? ov.pr ?? null };
  return {
    ...p,
    pr: claim.pr,
    stage: p.held ? 'held' : (deriveStage(claim, prData.prs) ?? 'held'),
    assignees: assigneesOf(claim, prData.prs),
    prState: claim.pr ? (prData.prs[claim.pr]?.state ?? null) : null,
  };
});

const sum = (fn) => enriched.reduce((a, p) => a + fn(p), 0);
const stageCount = (s) => enriched.filter((p) => p.stage === s).length;
const summary = {
  generated: new Date().toISOString().slice(0, 10),
  prFetched: prData.fetched,
  pieces: enriched.length,
  atomics: sum((p) => p.atomics),
  t2v: sum((p) => p.t2v ?? 0),
  t2t: sum((p) => p.t2t ?? 0),
  stages: { held: stageCount('held'), assigned: stageCount('assigned'), prOpen: stageCount('pr-open'), merged: stageCount('merged') },
  prsOpen: new Set(enriched.filter((p) => p.prState === 'OPEN').map((p) => p.pr)).size,
  prsMerged: new Set(enriched.filter((p) => p.prState === 'MERGED').map((p) => p.pr)).size,
  blockersOpen: blockers.filter((b) => !b.done).length,
  blockersDone: blockers.filter((b) => b.done).length,
};

const DIST = join(ROOT, '../dist/ai-actions');
mkdirSync(DIST, { recursive: true });
renderPage({
  templatePath: join(ROOT, 'template.html'),
  themePath: join(ROOT, '../shared/theme.css'),
  data: { summary, pieces: enriched, categories, blockers },
  outPath: join(DIST, 'index.html'),
});
writeFileSync(join(DIST, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`✓ ai-actions: ${summary.pieces} pieces · ${summary.atomics} atomics · held ${summary.stages.held} / assigned ${summary.stages.assigned} / PR-open ${summary.stages.prOpen} / merged ${summary.stages.merged} · ${summary.blockersOpen} open blockers`);
