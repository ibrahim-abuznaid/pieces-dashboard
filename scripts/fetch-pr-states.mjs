#!/usr/bin/env node
// Fetches state + assignees for every PR referenced by the workstreams.
// Auth: gh CLI login locally, GH_TOKEN in Actions.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readIf = (p) => (existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), 'utf8')) : null);

const nums = new Set();
for (const p of readIf('ai-actions/pieces.json')?.pieces ?? []) if (p.pr) nums.add(p.pr);
for (const ov of Object.values(readIf('output-schema/overrides.json')?.pieces ?? {})) if (ov.pr) nums.add(ov.pr);
for (const ov of Object.values(readIf('ai-actions/overrides.json')?.pieces ?? {})) if (ov.pr) nums.add(ov.pr);

const prs = {};
for (const n of [...nums].sort((a, b) => a - b)) {
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
    mergedAt: pr.merged_at,
    title: pr.title,
    url: pr.html_url,
    assignees: (pr.assignees ?? []).map((a) => a.login),
  };
}
writeFileSync(join(ROOT, 'data/pr-states.json'),
  JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), prs }, null, 2) + '\n');
console.log(`✓ fetched ${Object.keys(prs).length} PRs → data/pr-states.json`);
