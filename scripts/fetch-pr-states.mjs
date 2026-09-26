#!/usr/bin/env node
// Fetches state + assignees for every PR referenced by the workstreams.
// Auth: gh CLI login locally, GH_TOKEN in Actions.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaims, ROLLOUTS } from '../lib/discover.mjs';
import { reviewVerdict } from '../lib/reviews.mjs';

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

const REPO = 'activepieces/activepieces';
const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

// Work IN FLIGHT is discovered, not declared. See lib/discover.mjs for why; the
// short version is that a PR nobody wrote into a claims file used to be a PR the
// page could not see, and an unseen queue renders as an empty one.
//
// Two passes, because the cheap call cannot answer the question. `gh pr list`
// returns file PATHS, which is enough to find the piece PRs and nothing like
// enough to tell which rollout one is doing -- `propertyGroups` and
// `audience: 'ai'` live in the diff. So: list every open PR once, keep the ones touching a piece
// directory, and pull the patch only for those. About 30 of 139 today.
//
// The limit is deliberately far above the real number: `gh pr list` silently
// truncates, and a truncated list does not fail, it just quietly stops finding
// the oldest open PRs -- which are exactly the ones most likely to have been
// forgotten.
//
// BEST EFFORT as a whole. Discovery is an improvement on the claims files, not
// a dependency of them: if GitHub search is down or a patch will not fetch, the
// build still runs on the curated claims, which is what it did before this
// existed. A hard failure here would take out the daily refresh over work that
// is only ever additive.
function discover() {
  let open = [];
  try {
    open = gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '500',
      '--json', 'number,files,baseRefName']);
  } catch (e) {
    console.warn(`⚠ open-PR discovery skipped (${e.message}) — in-flight counts fall back to the claims files`);
    return Object.fromEntries(ROLLOUTS.map((r) => [r, {}]));
  }
  const piecePrs = open.filter((pr) => (pr.files ?? [])
    .some((f) => f.path?.startsWith('packages/pieces/community/')));

  const withPatches = [];
  for (const pr of piecePrs) {
    try {
      // `filename`, not `path`: the two gh surfaces disagree on the key, and
      // lib/discover.mjs reads the REST one.
      const files = gh(['api', '--paginate', `repos/${REPO}/pulls/${pr.number}/files?per_page=100`]);
      withPatches.push({ number: pr.number, base: pr.baseRefName ?? null, files });
    } catch (e) {
      console.warn(`⚠ PR #${pr.number}: files unavailable (${e.message}) — not classified`);
    }
  }
  const found = discoverClaims(withPatches);
  const total = ROLLOUTS.reduce((a, r) => a + Object.keys(found[r]).length, 0);
  console.log(`✓ discovered ${total} in-flight claims across ${withPatches.length} open piece PRs`);
  return found;
}

const discovered = discover();
writeFileSync(join(ROOT, 'data/discovered-claims.json'),
  JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), ...discovered }, null, 2) + '\n');

// Discovered numbers need their state fetched like any other: the builds read
// stage off data/pr-states.json, not off the fact that a PR was found.
for (const rollout of ROLLOUTS) {
  for (const [slug, pr] of Object.entries(discovered[rollout])) ref(pr, slug);
}

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
  const state = pr.merged_at ? 'MERGED' : pr.state.toUpperCase(); // OPEN | CLOSED | MERGED
  // Approval only means something while the PR is open: merged is already done,
  // closed is not happening. See lib/reviews.mjs.
  let verdict = { approved: false, approvedAt: null };
  if (state === 'OPEN') {
    try {
      verdict = reviewVerdict(JSON.parse(execFileSync('gh', ['api', '--paginate',
        `repos/activepieces/activepieces/pulls/${n}/reviews?per_page=100`], { encoding: 'utf8' })));
    } catch (e) {
      throw new Error(`PR #${n} reviews fetch failed: ${e.message}`);
    }
  }
  prs[n] = {
    state,
    // The two dates a stage changed on. `state` is only ever NOW, so a
    // question about a past week — which pieces had landed by the end of
    // W36, which were sitting in review — can only be answered from these:
    // see scripts/backfill-ui-improvements.mjs, which reconstructs six
    // already-archived weeks from them rather than guessing.
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
    title: pr.title,
    url: pr.html_url,
    // The branch it merged INTO. A stacked PR (#15758 targets
    // feat/asana-ai-actions-a) reads MERGED the day it lands on its parent,
    // which says nothing about main; lib/ai-roster.mjs needs to tell the two apart.
    base: pr.base?.ref ?? null,
    approved: verdict.approved,
    approvedAt: verdict.approvedAt,
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
