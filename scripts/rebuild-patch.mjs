// scripts/rebuild-patch.mjs
// A patch GitHub would not serve, rebuilt from the file's contents.
//
// The pulls/N/files endpoint omits `patch` for a file whose diff is too large
// to serve, and the AI-actions count (lib/discover.mjs discoverActionsLanded)
// reads the patch and nothing else — so a patch-less file counts nothing, and
// a PR that adds two hundred agent atomics in one big generated file would
// land as zero. In W39–W45 twelve files came back that way, all generated
// (eight new output-schemas.ts, four i18n JSON), so the miss was harmless;
// the next one need not be.
//
// The rebuild: the file before the PR, read at the merge base the files
// endpoint diffs from, as all '-' lines; the file after, at the PR's head, as
// all '+'. That is not the diff GitHub would have served, but it NETS to the
// same count, which is all the rule keeps — unchanged lines appear once on each
// side and cancel, so after − before is exactly added − removed matching lines.
//
// Trusted only when it checks out: the two sides must differ by exactly the
// line counts GitHub reported for the file, so a wrong merge base or ref shows
// up here rather than in the archive. A status the two sides cannot describe
// (`copied`) is refused. Shared by the Saturday scan (scripts/fetch-pr-states.mjs)
// and the backfill (scripts/backfill-ai-actions-landed.mjs), so a count read
// off a rebuilt patch is made the same way wherever it is made.
import { execFileSync } from 'node:child_process';

const REPO = 'activepieces/activepieces';
const ghText = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gh = (args) => JSON.parse(ghText(args));

// A file the count would have read: under a piece, and under /src/ — the same
// two tests discoverActionsLanded applies, so only the files whose count would
// be lost are rebuilt, and a generated file outside src/ costs no API call.
export const countable = (filename) =>
  /^packages\/pieces\/(?:community|core)\/[^/]+\//.test(filename) && /\/src\//.test(filename);

const REBUILDABLE = new Set(['added', 'modified', 'changed', 'renamed', 'removed']);
const raw = (endpoint) => ghText(['api', '-H', 'Accept: application/vnd.github.raw', endpoint]);
// Lines the way a patch counts them: a final newline ends the last line rather
// than starting an empty one.
const linesOf = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

function mergeBaseOf(number) {
  const pr = gh(['api', `repos/${REPO}/pulls/${number}`]);
  return ghText(['api', `repos/${REPO}/compare/${pr.base.sha}...${pr.head.sha}`, '--jq', '.merge_base_commit.sha']).trim();
}

export function rebuiltPatch(f, mergeBase) {
  const before = f.status === 'added' ? []
    : linesOf(raw(`repos/${REPO}/contents/${encodeURIComponent(f.previous_filename ?? f.filename)}?ref=${mergeBase()}`));
  const after = f.status === 'removed' ? [] : linesOf(raw(f.contents_url));
  if (after.length - before.length !== f.additions - f.deletions) {
    throw new Error(`rebuilt ${before.length} → ${after.length} lines, but GitHub reports +${f.additions} −${f.deletions}`);
  }
  return [...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)].join('\n');
}

// Fills in, IN PLACE, the patch of every countable file GitHub served without
// one. Returns what it rebuilt and what it could not — each as a line for the
// operator — and leaves the verdict to the caller: the Saturday scan counts a
// failure against `complete`, the backfill refuses to write.
export function fillMissingPatches(files, number) {
  const rebuilt = [];
  const failures = [];
  let base = null;
  const mergeBase = () => (base ??= mergeBaseOf(number));
  for (const f of files ?? []) {
    if (!countable(f?.filename ?? '') || typeof f.patch === 'string' || !(f.changes > 0)) continue;
    if (!REBUILDABLE.has(f.status) || typeof f.contents_url !== 'string') {
      failures.push(`PR #${number} ${f.filename}: GitHub served no patch for ${f.changes} changed lines (${f.status}) — cannot rebuild`);
      continue;
    }
    try {
      f.patch = rebuiltPatch(f, mergeBase);
      rebuilt.push(`#${number} ${f.filename} (${f.status}, +${f.additions} −${f.deletions})`);
    } catch (e) {
      failures.push(`PR #${number} ${f.filename}: no patch, and it would not rebuild (${e.message.split('\n')[0]})`);
    }
  }
  return { rebuilt, failures };
}
