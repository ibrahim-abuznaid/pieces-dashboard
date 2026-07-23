#!/usr/bin/env node
// Applies a "Claim a piece" issue to the right overrides.json.
// Env in: BODY (the rendered issue-form body), AUTHOR (issue opener's login).
// Outputs (GITHUB_OUTPUT): summary= on success, error= on failure (exit 1).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const fail = (msg) => { out('error', msg); console.error('✗ ' + msg); process.exit(1); };

// ---- parse the issue-form body (### <label>\n<value> sections) ----
const body = process.env.BODY ?? '';
const author = (process.env.AUTHOR ?? '').trim();
const fields = {};
for (const sec of body.split(/^### /m).slice(1)) {
  const nl = sec.indexOf('\n');
  if (nl === -1) continue;
  const val = sec.slice(nl + 1).trim();
  fields[sec.slice(0, nl).trim().toLowerCase()] = val === '_No response_' ? '' : val;
}
const get = (prefix) => fields[Object.keys(fields).find((k) => k.startsWith(prefix)) ?? ''] ?? '';

const workstream = get('workstream').toLowerCase().trim();
const piece = get('piece').trim();
const assignee = (get('assignee') || author).replace(/^@/, '').trim();
const prRaw = get('pr number').trim();
const pr = prRaw ? Number(prRaw.replace(/^#/, '')) : null;

// ---- validate ----
if (!['output-schema', 'ai-actions'].includes(workstream)) fail(`unknown workstream "${workstream}" — use output-schema or ai-actions`);
if (!piece) fail('the Piece field is empty');
if (!/^[a-zA-Z0-9-]{1,39}$/.test(assignee)) fail(`"${assignee}" doesn't look like a GitHub handle`);
if (prRaw && (!Number.isInteger(pr) || pr <= 0)) fail(`PR number "${prRaw}" is not a positive integer`);

if (workstream === 'output-schema') {
  const folders = new Set(read('output-schema/data/cloud-catalog.json').map((p) => p.name.replace('@activepieces/piece-', '')));
  if (!folders.has(piece)) fail(`piece "${piece}" is not in the catalog — use the folder name shown on the dashboard (in parentheses)`);
} else {
  const slugs = new Set(read('ai-actions/pieces.json').pieces.map((p) => p.slug));
  if (!slugs.has(piece)) fail(`piece "${piece}" is not on the AI-actions board — add a row to ai-actions/pieces.json first if it's a new piece`);
}

// ---- apply ----
const file = workstream === 'output-schema' ? 'output-schema/overrides.json' : 'ai-actions/overrides.json';
const j = read(file);
j.pieces ??= {};
const entry = j.pieces[piece] ?? {};
entry.assignee = assignee;
if (pr) entry.pr = pr;
j.pieces[piece] = entry;
writeFileSync(join(ROOT, file), JSON.stringify(j, null, 2) + '\n');

const summary = `${workstream}/${piece} → ${assignee}${pr ? ` (PR #${pr})` : ''}`;
out('summary', summary);
out('file', file);
console.log('✓ ' + summary);
