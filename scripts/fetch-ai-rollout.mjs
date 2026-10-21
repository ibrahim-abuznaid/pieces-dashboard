#!/usr/bin/env node
// The rollout funnel for every AI piece → data/ai-rollout.json (counts only).
//
//   node scripts/fetch-ai-rollout.mjs --roster <file> --out <file> [--private <dir>]
//
// Run by scripts/fetch-ai-audit.mjs, which writes the roster (slug, main
// version, AI action names) from the same clone it audited, so both files
// describe one commit. Three public reads per piece and no credentials:
//
//   npm    registry.npmjs.org/<name>: dist-tags.latest and time[main version]
//   Cloud  cloud.activepieces.com/api/v1/pieces/<name>?audience=all&cb=<ts>.
//          `audience=all` because the endpoint defaults to human and hides every
//          AI action (#13960 -- the 09-26 check read that as "not served"), and
//          the cache-buster because Cloudflare serves a stale version for 20+
//          minutes after a release.
//   gh     the last commits touching the piece's package.json, for merge time
//
// Concurrency 4, three attempts per call, 30 s timeouts. A call that still fails
// leaves that piece unmeasured for that stage -- never "not served" -- and the
// run exits 0: the funnel is a reading, not a gate on the deploy.
//
// Per-piece rows go to <dir>/rollout.json with --private, and nowhere else.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pieceRollout, summarizeRollout } from '../lib/ai-rollout.mjs';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPO = 'activepieces/activepieces';
const CONCURRENCY = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); } catch (err) { last = err; }
    if (attempt < 3) await sleep(1000 * attempt);
  }
  throw last;
}

// 404 is an answer (the piece is not on Cloud), not a failure to retry.
async function getJson(url) {
  return retry(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { body: await res.json() };
  });
}

const gh = async (path) => JSON.parse((await retry(() => run('gh', ['api', path], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }))).stdout);

async function npmOf(name) {
  try {
    const { body, notFound } = await getJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
    if (notFound) return { latest: null, publishedAt: null };
    return { latest: body['dist-tags']?.latest ?? null, time: body.time ?? {} };
  } catch { return { error: true }; }
}

async function cloudOf(name) {
  try {
    const { body, notFound } = await getJson(`https://cloud.activepieces.com/api/v1/pieces/${name}?audience=all&cb=${Date.now()}`);
    if (notFound) return { missing: true };
    const actions = body.actions && typeof body.actions === 'object' ? Object.values(body.actions) : [];
    return { version: body.version ?? null, aiActions: actions.filter((a) => a?.audience === 'ai').map((a) => a.name) };
  } catch { return { error: true }; }
}

// The commit that put main's version into package.json. Usually the newest
// commit touching the file; when that one lands AFTER npm has the version, it
// may be a later edit with no bump (a dependency line), so walk back to the
// commit whose patch changed `"version"` before calling it a collision.
async function mergedAtOf(slug, commit, publishedAt) {
  try {
    const path = `packages/pieces/community/${slug}/package.json`;
    const list = await gh(`repos/${REPO}/commits?path=${encodeURIComponent(path)}&sha=${commit}&per_page=5`);
    if (!Array.isArray(list) || !list.length) return null;
    const dateOf = (c) => c.commit?.committer?.date ?? null;
    if (!publishedAt || Date.parse(dateOf(list[0])) <= Date.parse(publishedAt)) return dateOf(list[0]);
    for (const c of list) {
      const full = await gh(`repos/${REPO}/commits/${c.sha}`);
      const patch = (full.files ?? []).find((f) => f.filename === path)?.patch ?? '';
      if (/^[+-]\s*"version"\s*:/m.test(patch)) return dateOf(c);
    }
    return dateOf(list[0]);
  } catch { return null; }
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const roster = JSON.parse(readFileSync(resolve(opt('--roster')), 'utf8'));
const out = resolve(opt('--out'));
const privateDir = opt('--private') ? resolve(opt('--private')) : null;
const now = Date.now();
const fetched = new Date(now).toISOString().slice(0, 10);

const rows = await pool(roster.pieces, async (piece) => {
  const name = piece.npmName ?? `@activepieces/piece-${piece.slug}`;
  const [npmRaw, cloud] = await Promise.all([npmOf(name), cloudOf(name)]);
  const npm = npmRaw.error ? npmRaw : { latest: npmRaw.latest, publishedAt: npmRaw.time?.[piece.version] ?? null };
  const mergedAt = await mergedAtOf(piece.slug, roster.commit, npm.publishedAt ?? null);
  return pieceRollout({ piece, npm, cloud, mergedAt, now });
});

const counts = summarizeRollout(rows, { commit: roster.commit, fetched });
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(counts, null, 2) + '\n');
if (privateDir) {
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, 'rollout.json'), JSON.stringify({ ...counts, rows }, null, 2) + '\n');
}
const unmeasured = (key) => rows.filter((r) => r[key] == null).length;
const n = counts.npm;
const c = counts.cloud;
console.log(`  ${counts.pieces} AI pieces · npm at main ${n ? `${n.atMain}/${n.measured}` : 'not measured'}`
  + ` · Cloud serving main ${c ? `${c.served}/${c.measured}` : 'not measured'}, with its AI actions ${c ? `${c.servedWithAi}/${c.measured}` : '—'}`
  + ` · stuck >24h ${counts.stuck24h ? counts.stuck24h.count : '—'} · collisions ${n ? n.collisions : '—'}`);
if (n?.lagMinutes) console.log(`  merge → npm minutes: median ${n.lagMinutes.median}, p90 ${n.lagMinutes.p90}, max ${n.lagMinutes.max} (n=${n.lagMinutes.n})`);
for (const [key, what] of [['npmAtMain', 'npm'], ['served', 'Cloud'], ['mergedAt', 'merge time']]) {
  if (unmeasured(key)) console.warn(`  ⚠ ${unmeasured(key)} piece(s) without a ${what} reading after 3 attempts — left out of that stage, not counted as missing`);
}
