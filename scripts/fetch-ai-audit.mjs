#!/usr/bin/env node
// The static audit of the AI actions on upstream main → data/ai-audit.json,
// then the rollout funnel for the same commit → data/ai-rollout.json.
// Needs: git, npm; gh (authed) for the latest release and merge times. ~40 s
// for the audit (a ~30 MB sparse, shallow, blobless clone), ~1-2 min rollout.
//
//   node scripts/fetch-ai-audit.mjs                   CI and `npm run fetch`
//   node scripts/fetch-ai-audit.mjs --private <dir>   the local weekly report
//
// COUNTS ONLY reach the repo. This repo is public and a finding names an
// action that does damage, so the per-piece list exists only with --private,
// which writes findings.json + REPORT.md to <dir> and puts the counts there
// too: a private run writes nothing inside the repo, and refuses a <dir> that
// is. CI never passes it (test/ai-audit-wiring.test.mjs). Nothing here prints a
// piece or action name, in any mode.
//
// Other flags, for regression runs: --ref <sha> audits another commit,
// --root <checkout> reuses a clone, --no-rollout skips the funnel, --out-dir
// <dir> moves the counts.
//
// Fail-loud on the two readings that would publish a wrong number -- no clone,
// or a catalog with no AI actions -- like fetch-repo-ai.sh. Everything softer
// (no latest release, the breaking-changes files moved, the rollout fetch)
// records that check as not measured, which the page shows as a gap.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_URL = 'https://github.com/activepieces/activepieces.git';
const BREAKING_CHANGES = ['docs/install/reference/breaking-changes.mdx', 'docs/install/reference/breaking-changes-unreleased.mdx'];
export const SPARSE = [
  '/packages/pieces/community/*/src/',
  '/packages/pieces/community/*/package.json',
  ...BREAKING_CHANGES.map((p) => `/${p}`),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

export const insideRepo = (dir) => {
  const rel = relative(ROOT, resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// The audit imports the TypeScript compiler, and the local cron must never
// fail over a node_modules that was never installed (a fresh clone) or holds
// another version (a lockfile bump). CI runs `npm ci` itself first.
function ensureTypescript() {
  const want = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages?.['node_modules/typescript']?.version;
  let have = null;
  try { have = JSON.parse(readFileSync(join(ROOT, 'node_modules/typescript/package.json'), 'utf8')).version; } catch {}
  if (want && have === want) return;
  console.log(`  typescript ${have ?? 'missing'}, lockfile pins ${want} — running npm ci…`);
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' });
}

// Sparse, shallow, blobless, by ref, retried three times -- the clone in
// fetch-repo-ai.sh, widened to the package.json files and the breaking-changes
// docs, and able to take a sha (the baseline builder uses it for one).
export async function cloneUpstream({ ref = 'main', dir, patterns = SPARSE }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    rmSync(dir, { recursive: true, force: true });
    try {
      git(['init', '--quiet', dir]);
      git(['-C', dir, 'remote', 'add', 'origin', REPO_URL]);
      git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...patterns]);
      git(['-C', dir, 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', ref], { timeout: 300_000 });
      git(['-C', dir, 'checkout', '--quiet', 'FETCH_HEAD'], { timeout: 300_000 });
      if (existsSync(join(dir, 'packages/pieces/community'))) {
        return { commit: git(['-C', dir, 'rev-parse', 'HEAD']), committedAt: git(['-C', dir, 'log', '-1', '--format=%cI']) };
      }
    } catch (err) {
      console.error(`  clone attempt ${attempt} failed (${String(err.message).split('\n')[0]})${attempt < 3 ? ' — retrying' : ''}`);
    }
    if (attempt < 3) await sleep(3000);
  }
  throw new Error(`upstream clone of ${ref} failed after 3 attempts`);
}

const walkTs = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
};

// Every community piece with a src/, extracted one at a time so a 741-piece
// catalog never holds more than one piece's syntax trees.
export function readCatalog(root, extractPiece) {
  const community = join(root, 'packages/pieces/community');
  const pieces = [];
  for (const slug of readdirSync(community).sort()) {
    const srcDir = join(community, slug, 'src');
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    const files = walkTs(srcDir).map((f) => ({ path: relative(root, f), text: readFileSync(f, 'utf8') }));
    let packageJson = null;
    try { packageJson = JSON.parse(readFileSync(join(community, slug, 'package.json'), 'utf8')); } catch {}
    pieces.push(extractPiece({ slug, files, packageJson }));
  }
  return pieces;
}

// The newest release, for S4. GitHub's own answer first; then the highest
// x.y.z tag, which needs no auth; then null -- S4 not measured -- because a
// stale guess would flag every piece that targets the newer engine.
export function latestRelease() {
  try {
    const tag = execFileSync('gh', ['api', 'repos/activepieces/activepieces/releases/latest', '--jq', '.tag_name'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).trim();
    if (/^\d+\.\d+\.\d+$/.test(tag)) return tag;
  } catch {}
  try {
    const tags = git(['ls-remote', '--tags', '--refs', REPO_URL], { timeout: 60_000 })
      .split('\n').map((l) => l.split('refs/tags/')[1]).filter((t) => /^\d+\.\d+\.\d+$/.test(t ?? ''));
    const key = (t) => t.split('.').map((n) => n.padStart(6, '0')).join('.');
    if (tags.length) return tags.sort((a, b) => key(a).localeCompare(key(b))).at(-1);
  } catch {}
  return null;
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function main() {
  const privateDir = opt('--private') ? resolve(opt('--private')) : null;
  if (privateDir && insideRepo(privateDir)) {
    console.error('✗ --private must point outside this repo: it holds the per-piece findings, and the repo is public');
    process.exit(1);
  }
  const outDir = resolve(opt('--out-dir') ?? privateDir ?? join(ROOT, 'data'));
  if (privateDir && insideRepo(outDir)) {
    console.error('✗ a --private run writes nothing inside the repo; drop --out-dir or point it outside');
    process.exit(1);
  }
  const ref = opt('--ref') ?? 'main';

  ensureTypescript();
  const { extractPiece, auditCatalog, aiRoster } = await import('../lib/ai-audit.mjs');

  const tmp = mkdtempSync(join(tmpdir(), 'ai-audit-'));
  try {
    let root = opt('--root') ? resolve(opt('--root')) : null;
    let head;
    console.log(`1/2 static audit of the AI actions on upstream ${ref}…`);
    if (root) {
      head = { commit: git(['-C', root, 'rev-parse', 'HEAD']), committedAt: git(['-C', root, 'log', '-1', '--format=%cI']) };
    } else {
      root = join(tmp, 'ap');
      head = await cloneUpstream({ ref, dir: root });
    }
    const pieces = readCatalog(root, extractPiece);
    const docs = BREAKING_CHANGES.filter((p) => existsSync(join(root, p)));
    if (docs.length < BREAKING_CHANGES.length) console.warn(`  ⚠ ${BREAKING_CHANGES.length - docs.length} breaking-changes file(s) missing on ${ref} — S2 not measured; find where they moved`);
    const breakingChanges = docs.length === BREAKING_CHANGES.length ? docs.map((p) => readFileSync(join(root, p), 'utf8')).join('\n') : null;
    let baseline = null;
    try { baseline = JSON.parse(readFileSync(resolve(ROOT, opt('--baseline') ?? 'data/ai-audit-baseline.json'), 'utf8')); } catch {
      console.warn('  ⚠ no data/ai-audit-baseline.json — S2 not measured; run scripts/build-ai-audit-baseline.mjs');
    }
    const release = latestRelease();
    if (!release) console.warn('  ⚠ latest release unknown (gh and ls-remote both failed) — S4 not measured');
    const fetched = new Date().toISOString().slice(0, 10);
    const { counts, findings, tooling } = auditCatalog({ pieces, baseline, breakingChanges, latestRelease: release,
      commit: head.commit, committedAt: head.committedAt, fetched });

    // A zero is not a reading of a catalog that had 4,005 AI actions the day
    // this was written; it is a moved directory or a parser that broke.
    if (!counts.ai.actions) {
      console.error(`✗ no audience:'ai' actions found on ${ref} — the layout or the parser changed`);
      process.exit(1);
    }
    if (counts.ai.grepLines !== counts.ai.actions) {
      console.warn(`  ⚠ AST found ${counts.ai.actions} AI actions, grep ${counts.ai.grepLines} — a factory-built action or a comment shape the parser does not see`);
    }
    if (counts.catalog.toolingErrors) console.warn(`  ⚠ ${counts.catalog.toolingErrors} file(s) the walker could not read — listed in the private report`);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'ai-audit.json'), JSON.stringify(counts, null, 2) + '\n');
    if (privateDir) {
      mkdirSync(privateDir, { recursive: true });
      writeFileSync(join(privateDir, 'findings.json'), JSON.stringify({ ...counts, findings, tooling }, null, 2) + '\n');
    }
    const c = counts.checks;
    const show = (k) => (c[k].actions == null ? 'not measured' : `${c[k].actions}/${c[k].pieces}`);
    console.log(`  ${counts.ai.pieces} AI pieces, ${counts.ai.actions} AI actions @ ${head.commit.slice(0, 11)} (${head.committedAt})`);
    console.log(`  P1 pass ${counts.k4.p1PassPct}% · S1 ${show('S1')} · S2 ${show('S2')} · S3 ${show('S3')} · S4 ${show('S4')} · S6 ${show('S6')} · S7 ${show('S7')}`);
    console.log(`  P2 · S1b ${show('S1b')} · S5 ${show('S5')} · S8 ${show('S8')} · S9 ${show('S9')}   (actions/pieces)`);

    let rollout = null;
    if (!flag('--no-rollout')) {
      console.log('2/2 rollout funnel (npm, Cloud, merge times)…');
      const rosterFile = join(tmp, 'roster.json');
      writeFileSync(rosterFile, JSON.stringify({ commit: head.commit, pieces: aiRoster(pieces) }));
      // Its own process, so a crash in it costs the funnel and nothing else:
      // the counts above are already written.
      try {
        execFileSync(process.execPath, [join(ROOT, 'scripts/fetch-ai-rollout.mjs'), '--roster', rosterFile,
          '--out', join(outDir, 'ai-rollout.json'), ...(privateDir ? ['--private', privateDir] : [])], { stdio: 'inherit' });
        rollout = privateDir ? JSON.parse(readFileSync(join(privateDir, 'rollout.json'), 'utf8')) : null;
      } catch (err) {
        console.warn(`  ⚠ rollout fetch failed (${String(err.message).split('\n')[0]}) — the page shows it as not measured`);
        writeFileSync(join(outDir, 'ai-rollout.json'), JSON.stringify({ commit: head.commit, fetched, measured: false }, null, 2) + '\n');
      }
    }
    if (privateDir) {
      const { renderReport } = await import('../lib/ai-report.mjs');
      writeFileSync(join(privateDir, 'REPORT.md'), renderReport({ audit: { counts, findings, tooling }, rollout }));
      console.log(`  ✓ private report written (${findings.length} findings) — outside the repo`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
}
