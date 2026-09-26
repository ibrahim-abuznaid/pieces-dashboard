#!/usr/bin/env node
// Joins main's agent atomics + curated data + live PR states into dist/ai-actions/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAiRoster, summarizeAiRoster } from '../lib/ai-roster.mjs';
import { renderPage } from '../lib/render.mjs';
import { validateAiData } from './validate.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const { pieces } = read('pieces.json');
const { categories, blockers } = read('blockers.json');
const overrides = read('overrides.json');
const prData = read('../data/pr-states.json');
// In-flight claims DISCOVERED from open PRs (scripts/fetch-pr-states.mjs), so a
// piece whose PR nobody wrote down still reaches the page. Optional by design:
// a checkout that has not fetched yet builds on the curated claims alone, which
// is exactly what this build did before discovery existed.
const discovered = (() => { try { return read('../data/discovered-claims.json'); } catch { return {}; } })();
// Which pieces carry audience:'ai' actions on main (scripts/fetch-repo-ai.sh):
// the record for MERGED. Optional for the same reason as discovery -- a checkout
// that has not fetched builds on the curated claims alone -- but said out loud,
// because on that path a piece nobody wrote down is invisible again.
const repoAi = (() => { try { return read('../data/repo-ai-actions.json'); } catch { return null; } })();
if (!repoAi) console.warn('⚠ data/repo-ai-actions.json missing — merged counts fall back to the curated claims; run `npm run fetch:ai`');

const problems = validateAiData({ pieces, categories, blockers, prStates: prData.prs });
if (problems.length) { console.error('✗ ' + problems.join('\n✗ ')); process.exit(1); }

const { rows: enriched, warnings } = buildAiRoster({
  curated: pieces,
  overrides: overrides.pieces ?? {},
  discovered: discovered.aiActions ?? {},
  prStates: prData.prs,
  onMain: repoAi?.pieces ?? null,
  mainAt: repoAi?.committedAt ?? null,
});
for (const w of warnings) console.warn(`⚠ ${w}`);
// A curated slug that is not a piece folder can never match main, so it would sit
// held beside the real piece's merged row -- `brevo` for the folder `sendinblue`.
const folders = (() => { try { return new Set(read('../output-schema/data/repo-pieces.json')); } catch { return null; } })();
for (const p of folders ? pieces : []) {
  if (!folders.has(p.slug)) console.warn(`⚠ ${p.slug}: no packages/pieces/community/${p.slug} on main — the slug must be the piece's folder name`);
}

const summary = {
  generated: new Date().toISOString().slice(0, 10),
  prFetched: prData.fetched,
  ...summarizeAiRoster(enriched),
  blockersOpen: blockers.filter((b) => !b.done).length,
  blockersDone: blockers.filter((b) => b.done).length,
  // Where MERGED was read from, so a number on the page can be traced to a
  // commit. Absent when main was not read.
  ...(repoAi ? { mainCommit: repoAi.commit, mainAt: repoAi.committedAt } : {}),
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
// Per-piece roster for consumers that need the detail behind the stage counts
// (the weekly snapshot). Built from the same `enriched` array the counts come
// from, so the roster can never disagree with the tiles.
writeFileSync(join(DIST, 'pieces.json'), JSON.stringify({
  generated: summary.generated,
  pieces: enriched.map(({ slug, atomics, stage, pr, prState }) => ({ slug, atomics, stage, pr, prState })),
}, null, 2) + '\n');
console.log(`✓ ai-actions: ${summary.pieces} pieces (${summary.fromMain} found on main, ${summary.fromPrs} in open PRs, uncurated) · ${summary.atomics} atomics · held ${summary.stages.held} / assigned ${summary.stages.assigned} / PR-open ${summary.stages.prOpen} / approved ${summary.stages.approved} / merged ${summary.stages.merged} · ${summary.blockersOpen} open blockers`);
