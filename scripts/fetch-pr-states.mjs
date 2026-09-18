#!/usr/bin/env node
// Fetches state + assignees for every PR referenced by the workstreams.
// Auth: gh CLI login locally, GH_TOKEN in Actions.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readIf = (p) => (existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), 'utf8')) : null);

// PR number -> the slugs claiming it, so a stale pointer can be reported as the
// piece a reader would look for rather than as a bare number.
const nums = new Map();
const ref = (pr, slug) => { if (pr) nums.set(pr, [...(nums.get(pr) ?? []), slug]); };
for (const p of readIf('ai-actions/pieces.json')?.pieces ?? []) ref(p.pr, p.slug);
for (const p of readIf('ui-improvements/pieces.json')?.pieces ?? []) ref(p.pr, p.slug);
for (const [slug, ov] of Object.entries(readIf('output-schema/overrides.json')?.pieces ?? {})) ref(ov.pr, slug);
for (const [slug, ov] of Object.entries(readIf('ai-actions/overrides.json')?.pieces ?? {})) ref(ov.pr, slug);

const prs = {};
for (const n of [...nums.keys()].sort((a, b) => a - b)) {
  // Fail-loud by design: partial PR data would silently mis-stage pieces; a failed
  // run fails CI and Pages keeps serving the last good deploy.
  let pr;
  try {
    pr = JSON.parse(execFileSync('gh', ['api', `repos/activepieces/activepieces/pulls/${n}`], { encoding: 'utf8' }));
  } catch (e) {
    throw new Error(`PR #${n} fetch failed (check the number in overrides/pieces.json, gh auth, rate limits): ${e.message}`);
  }
  prs[n] = {
    state: pr.merged_at ? 'MERGED' : pr.state.toUpperCase(), // OPEN | CLOSED | MERGED
    // The two dates a stage changed on. `state` is only ever NOW, so a
    // question about a past week — which pieces had landed by the end of
    // W36, which were sitting in review — can only be answered from these:
    // see scripts/backfill-ui-improvements.mjs, which reconstructs six
    // already-archived weeks from them rather than guessing.
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    title: pr.title,
    url: pr.html_url,
    assignees: (pr.assignees ?? []).map((a) => a.login),
  };
}
// The one failure this fetcher cannot see by looking a number up: a PR that
// closed without merging still resolves, so the STATE stays fresh while the
// POINTER rots — and deriveStage() then falls back to the closed PR's own
// assignees and reports finished work as `assigned`. Three pieces sat that way
// for six weeks. The superseding PR re-opens the same work under the same
// title, so the closed PR's title finds it.
//
// Printed, never written: claims are curated by hand (see the header of
// ai-actions/pieces.json), and the search is a hint a human confirms. Covers
// every dataset in `nums` — ai-actions, ui-improvements and both override
// files — because it works off the fetched state, not off one schema.
for (const [n, pr] of Object.entries(prs)) {
  if (pr.state !== 'CLOSED') continue;
  let hits = [];
  try {
    hits = JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', 'activepieces/activepieces',
      '--search', `"${pr.title}" in:title`, '--state', 'merged', '--limit', '3',
      '--json', 'number,mergedAt'], { encoding: 'utf8' }));
  } catch {
    // Best-effort: a failed search must still leave the warning below standing.
  }
  const found = hits.map((h) => `#${h.number} (merged ${h.mergedAt.slice(0, 10)})`).join(', ');
  console.warn(`⚠ ${(nums.get(Number(n)) ?? ['?']).join(', ')}: PR #${n} closed without merging — `
    + (found ? `same title merged as ${found}. Update the claim or give it a held reason.`
             : 'no merged PR shares its title. Update the claim or give it a held reason.'));
}

writeFileSync(join(ROOT, 'data/pr-states.json'),
  JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), prs }, null, 2) + '\n');
console.log(`✓ fetched ${Object.keys(prs).length} PRs → data/pr-states.json`);
