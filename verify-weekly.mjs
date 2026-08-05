#!/usr/bin/env node
// verify-weekly.mjs
// READ-ONLY verification for the weekly page. Three modes, one file, because all
// three answer the same question — "did the thing that was supposed to happen
// actually happen?" — from the same two sources of truth: the committed archive
// and the page GitHub Pages is really serving.
//
//   --await-run=SHA   poll until the "Refresh & deploy" run for that commit ends
//   --live=YYYY-Wnn   assert the live page serves that week
//   (no mode flag)    the daily health check
//
// The first two are the Saturday job's post-push proof; the third is the daily
// cron. NOTHING here writes, commits, pushes, or snapshots — weekly/snapshot.mjs
// owns the archive and refresh-weekly.sh owns the push. This file only reads.
//
// The logic lives here rather than in the shell scripts for one reason: both the
// live page and `gh run list` answer in JSON, and the page's DOM only exists
// once its own script has run. Neither is a thing to do in bash.
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readArchive, validateSnapshot } from './weekly/lib/archive.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const LIVE_URL = 'https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/';
// Must match `name:` in .github/workflows/deploy.yml. "Claim bot" also runs in
// this repo and fires on issues, so picking the newest run of ANY workflow is
// how a `skipped` claim-bot run gets misread as a successful deploy.
export const WORKFLOW_NAME = 'Refresh & deploy';
export const ARCHIVE_PATH = join(ROOT, 'weekly/data/weeks.json');
export const TEAM_DASHBOARD = process.env.PIECES_TEAM_DASHBOARD
  ?? '/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard';
export const LINEAR_MARKER = join(TEAM_DASHBOARD, 'NEEDS-LINEAR-REFRESH');

// 8, not 7: the snapshot job runs Saturday 09:00, so a healthy archive's newest
// `builtAt` is 0–6 days old on any given day and 7 on the Saturday morning
// before that week's run. 8 is the first age that can only mean a missed run.
//
// This matters more than "the page is a week stale": weekly/lib/view.mjs derives
// each tile's delta from the immediately preceding week, so a gap blanks the
// delta badges of the FOLLOWING week too. One missed Saturday costs two weeks.
export const MAX_SNAPSHOT_AGE_DAYS = 8;

const DAY_MS = 86_400_000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local calendar date, matching the `date +%F` that refresh-weekly.sh feeds to
// snapshot.mjs as `builtAt`. Comparing a UTC "today" against a local `builtAt`
// would read as a day out for the three hours after local midnight in +03.
export const localToday = (d = new Date()) => [
  d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'),
].join('-');

// Whole days between two YYYY-MM-DD dates. NaN for anything unparseable, which
// every caller reports rather than silently treating as fresh.
export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

const show = (v) => (v === null || v === undefined ? String(v) : `${v}`);

// --- the live page -----------------------------------------------------------

// The page builds its DOM client-side from this blob, so grepping the served
// HTML for a week id, a piece name or an <img> proves nothing about what a
// reader sees. Everything downstream works off the parsed archive instead.
export function parseEmbeddedArchive(html) {
  if (typeof html !== 'string' || !html) throw new Error('the response body was empty');
  const m = /const ARCHIVE\s*=\s*([\s\S]*?);\s*<\/script>/.exec(html);
  if (!m) throw new Error('no `const ARCHIVE = …;` blob in the page — this is not the weekly page');
  const raw = m[1].trim();
  // What an unbuilt template looks like: renderPage() replaces the marker, so a
  // surviving `/*__DATA__*/null` means the artifact was never built from data.
  if (raw === 'null' || raw.startsWith('/*__DATA__*/')) {
    throw new Error('the page still carries the unbuilt `/*__DATA__*/null` placeholder');
  }
  let archive;
  try {
    archive = JSON.parse(raw);
  } catch (err) {
    throw new Error(`the embedded archive is not valid JSON: ${err.message}`);
  }
  if (!archive || typeof archive !== 'object') throw new Error('the embedded archive is not an object');
  return archive;
}

// Execute the page's own scripts against a DOM-lite stub and hand back the HTML
// it produced. This is the check the JSON cannot make: the blob can be perfect
// and the page still render nothing if its script throws. Same technique as
// test/weekly-render.test.mjs — one sandbox, no browser, no network.
export function renderLive(html) {
  const scripts = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!scripts.length) throw new Error('the page carries no inline <script> — nothing would render');
  const node = (id) => ({ id, innerHTML: '', disabled: false, focus() {} });
  const nodes = { app: node('app'), pick: node('pick'), prev: node('prev'), next: node('next') };
  const sandbox = createContext({
    document: { getElementById: (id) => nodes[id] ?? null, activeElement: null },
    location: { hash: '' },
    addEventListener: () => {},
  });
  for (const [, src] of scripts) runInContext(src, sandbox);
  if (!nodes.app.innerHTML) throw new Error('the page ran but left #app empty');
  return nodes.app.innerHTML;
}

// Does the page the world can see actually show `expectWeek`? Three independent
// ways of being wrong, all reported together so one fetch diagnoses the whole
// problem instead of one symptom per run.
export function weekProblems({ archive, dom, expectWeek }) {
  const problems = [];
  if (archive.default !== expectWeek) {
    problems.push(`the live page defaults to ${show(archive.default)}, expected ${expectWeek}`);
  }
  const views = archive.views && typeof archive.views === 'object' ? archive.views : {};
  if (!views[expectWeek]) {
    const have = Object.keys(views);
    problems.push(`the live archive has no view for ${expectWeek} (it has: ${have.join(', ') || 'none'})`);
  }
  if (dom !== undefined) {
    if (!dom.includes(expectWeek)) problems.push(`the rendered page never mentions ${expectWeek}`);
    if (dom.includes('No weeks recorded yet')) problems.push('the page rendered its empty-archive placeholder');
  }
  return problems;
}

// One fetch, all three verdicts. `problems` empty means the page is serving that
// week to a real reader.
export function checkLive({ html, expectWeek }) {
  const problems = [];
  let archive = null;
  let dom;
  try {
    archive = parseEmbeddedArchive(html);
  } catch (err) {
    problems.push(err.message);
  }
  // Only worth executing once we know this IS the weekly page: running some
  // other page's scripts against a DOM-lite stub fails for reasons that say
  // nothing about the deploy, and that noise would bury the real message above.
  if (archive) {
    try {
      dom = renderLive(html);
    } catch (err) {
      problems.push(err.message);
    }
    problems.push(...weekProblems({ archive, dom, expectWeek }));
  }
  return { ok: problems.length === 0, problems, archive, dom };
}

export async function fetchLivePage(url = LIVE_URL, { fetchImpl = fetch } = {}) {
  // Cache-buster plus no-cache: Pages sits behind a CDN, and a cached copy is
  // indistinguishable from a deploy that never happened. Query strings are
  // ignored for static files, so this is free.
  const bust = `${url}${url.includes('?') ? '&' : '?'}_verify=${Date.now()}`;
  const res = await fetchImpl(bust, { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// GitHub Pages can still be serving the previous build for a little while after
// the workflow run reports success, so a single miss is not yet a failure.
export async function fetchUntil({
  url = LIVE_URL, expectWeek, attempts = 6, delayMs = 20_000,
  fetchImpl = fetch, sleep = defaultSleep, log = () => {},
} = {}) {
  let last = { ok: false, problems: ['never attempted'] };
  for (let i = 1; i <= attempts; i++) {
    try {
      const html = await fetchLivePage(url, { fetchImpl });
      last = checkLive({ html, expectWeek });
    } catch (err) {
      last = { ok: false, problems: [`fetch failed: ${err.message}`], archive: null };
    }
    if (last.ok) {
      log(`attempt ${i}/${attempts}: ${expectWeek} is being served`);
      return last;
    }
    log(`attempt ${i}/${attempts}: ${last.problems.join('; ')}`);
    if (i < attempts) await sleep(delayMs);
  }
  return last;
}

// --- the CI run --------------------------------------------------------------

// Newest "Refresh & deploy" run for the commit, ignoring every other workflow.
// Newest rather than first: the `pages` concurrency group cancels in-progress
// runs, so if the daily schedule fires while we wait, the run that will actually
// deploy is the later one — following it is correct, not a bug.
export function pickRun(runs, { workflow = WORKFLOW_NAME } = {}) {
  if (!Array.isArray(runs)) return null;
  return runs
    .filter((r) => r && r.workflowName === workflow)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .at(-1) ?? null;
}

const RUN_FIELDS = 'workflowName,status,conclusion,url,createdAt,event,databaseId';

export const ghListRuns = (sha) => JSON.parse(execFileSync(
  'gh', ['run', 'list', '--commit', sha, '--limit', '50', '--json', RUN_FIELDS],
  { encoding: 'utf8', cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
));

const elapsedText = (ms) => `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;

// Poll until the run for `sha` completes. `timeoutMs` allows for the ~3-minute
// `npm run fetch` plus tests, build, artifact upload and the deploy job.
export async function awaitRun({
  sha, listRuns = ghListRuns, sleep = defaultSleep, log = () => {},
  timeoutMs = 15 * 60_000, pollMs = 20_000, now = () => Date.now(),
} = {}) {
  const started = now();
  for (let poll = 1; ; poll++) {
    let run = null;
    let error = null;
    try {
      run = pickRun(listRuns(sha));
    } catch (err) {
      // A transient `gh` failure is not a failed deploy. Keep polling and let
      // the overall timeout be the thing that gives up.
      error = err.message;
    }
    const at = `poll ${poll} (${elapsedText(now() - started)})`;
    if (run && run.status === 'completed') {
      log(`${at}: run completed — ${run.conclusion} ${run.url}`);
      return { ok: run.conclusion === 'success', run, timedOut: false };
    }
    if (error) log(`${at}: could not list runs (${error}) — will retry`);
    else if (!run) log(`${at}: no "${WORKFLOW_NAME}" run for ${sha} yet`);
    else log(`${at}: run is ${run.status} — ${run.url}`);

    if (now() - started >= timeoutMs) {
      log(`${at}: giving up after ${elapsedText(now() - started)}`);
      return { ok: false, run, timedOut: true };
    }
    await sleep(pollMs);
  }
}

// --- the daily health check --------------------------------------------------

// Pure: every input is handed in, so the whole matrix (fresh/stale,
// matching/mismatched, reachable/not) is unit-testable without a network.
export function runChecks({ liveHtml, liveError, archive, today = localToday(), marker = {} }) {
  const checks = [];
  const add = (name, ok, detail, opts = {}) => checks.push({ name, ok, detail, ...opts });

  const weeks = [...(archive?.weeks ?? [])]
    .sort((a, b) => String(a?.week).localeCompare(String(b?.week)));
  const newest = weeks.at(-1) ?? null;

  // 1. Is the live page there, and does it render?
  let live = null;
  let dom;
  if (liveError) {
    add('live page', false, `unreachable — ${liveError}`);
  } else {
    const problems = [];
    try {
      live = parseEmbeddedArchive(liveHtml);
    } catch (err) {
      problems.push(err.message);
    }
    // See checkLive: rendering a page that is not the weekly page reports the
    // stub's shortcomings, not the deploy's.
    if (live) {
      try {
        dom = renderLive(liveHtml);
      } catch (err) {
        problems.push(err.message);
      }
    }
    add('live page', problems.length === 0, problems.length
      ? problems.join('; ')
      : `${liveHtml.length} bytes, embedded archive parses, page script renders ${dom.length} bytes of DOM`);
  }

  // 2. Does it serve what we committed? A mismatch is either a push that never
  //    deployed or a deploy that served a stale build — both invisible otherwise.
  if (!newest) {
    add('default week', false, 'the committed archive has no weeks');
  } else if (!live) {
    add('default week', true, 'skipped — the live page did not parse', { skipped: true });
  } else {
    const problems = weekProblems({ archive: live, dom, expectWeek: newest.week });
    add('default week', problems.length === 0, problems.length
      ? problems.join('; ')
      : `live and committed agree on ${newest.week}`);
  }

  // 3. Would today's build even validate? A hand-edit that breaks one week
  //    fails the CI `npm test`, which stops publishing every week after it.
  const bad = [];
  for (const w of weeks) {
    try {
      validateSnapshot(w);
    } catch (err) {
      bad.push(`${w?.week ?? '(no week id)'}: ${err.message}`);
    }
  }
  add('archive valid', bad.length === 0, bad.length
    ? bad.join('; ')
    : `${weeks.length} week${weeks.length === 1 ? ' passes' : 's pass'} validateSnapshot`);

  // 4. Did a Saturday go missing?
  if (!newest) {
    add('snapshot fresh', false, 'no snapshots at all');
  } else {
    const age = daysBetween(newest.builtAt, today);
    if (!Number.isFinite(age)) {
      add('snapshot fresh', false, `${newest.week} has an unparseable builtAt: ${show(newest.builtAt)}`);
    } else {
      add('snapshot fresh', age <= MAX_SNAPSHOT_AGE_DAYS,
        `newest is ${newest.week}, built ${newest.builtAt} — ${age} day${age === 1 ? '' : 's'} ago (limit ${MAX_SNAPSHOT_AGE_DAYS})`);
    }
  }

  // 5. Warning only: the tickets collector degrades to no-data rather than
  //    reporting a false zero when the Linear half is stale, and the refresh is
  //    being automated separately. Worth saying, not worth failing the check.
  if (marker.present) {
    const age = Number.isFinite(marker.ageDays) ? `${marker.ageDays} day${marker.ageDays === 1 ? '' : 's'} old` : 'age unknown';
    add('linear refresh', false, `NEEDS-LINEAR-REFRESH present (${age}) at ${marker.path ?? LINEAR_MARKER} — tickets degrade to no-data until it clears`, { warn: true });
  } else {
    add('linear refresh', true, 'no NEEDS-LINEAR-REFRESH marker');
  }

  const failed = checks.filter((c) => !c.ok && !c.warn && !c.skipped);
  return { checks, failed, ok: failed.length === 0 };
}

export function readMarker(path = LINEAR_MARKER, { now = Date.now() } = {}) {
  if (!existsSync(path)) return { present: false, path };
  let ageDays = NaN;
  try {
    ageDays = Math.floor((now - statSync(path).mtimeMs) / DAY_MS);
  } catch { /* unreadable marker still counts as present */ }
  return { present: true, path, ageDays };
}

// --- CLI ---------------------------------------------------------------------

const USAGE = 'usage: node verify-weekly.mjs [--live=YYYY-Wnn | --await-run=SHA] '
  + '[--url=URL] [--attempts=N] [--delay=SECONDS] [--timeout=MINUTES]';
const WEEK_RE = /^\d{4}-W\d{2}$/;

export function parseArgs(argv) {
  const known = ['--live=', '--await-run=', '--url=', '--attempts=', '--delay=', '--timeout='];
  for (const a of argv) {
    if (!known.some((k) => a.startsWith(k))) throw new Error(`unknown argument "${a}" — ${USAGE}`);
  }
  const arg = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(hit.indexOf('=') + 1);
  };
  const num = (name, fallback) => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, got "${raw}"`);
    return n;
  };
  const week = arg('live');
  if (week !== undefined && !WEEK_RE.test(week)) {
    throw new Error(`--live must be YYYY-Wnn, got "${week}" — ${USAGE}`);
  }
  const sha = arg('await-run');
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`--await-run must be a commit SHA, got "${sha}" — ${USAGE}`);
  }
  if (week !== undefined && sha !== undefined) throw new Error(`--live and --await-run are separate modes — ${USAGE}`);
  return {
    week, sha,
    url: arg('url') ?? LIVE_URL,
    attempts: num('attempts', 6),
    delayMs: num('delay', 20) * 1000,
    timeoutMs: num('timeout', 15) * 60_000,
  };
}

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (msg) => console.log(`[${stamp()}] ${msg}`);

async function cli(argv) {
  const opts = parseArgs(argv);

  // Mode: wait for CI. Used by refresh-weekly.sh straight after the push.
  if (opts.sha) {
    const { ok, run, timedOut } = await awaitRun({
      sha: opts.sha, log: say, timeoutMs: opts.timeoutMs, pollMs: opts.delayMs,
    });
    if (ok) {
      console.log(`✓ "${WORKFLOW_NAME}" succeeded for ${opts.sha} — ${run.url}`);
      return 0;
    }
    const why = timedOut
      ? `still ${run ? run.status : 'missing'} after the timeout`
      : `concluded ${run.conclusion}${run.conclusion === 'cancelled' ? ' (the pages concurrency group cancels superseded runs)' : ''}`;
    console.error(`✗ "${WORKFLOW_NAME}" did not succeed for ${opts.sha} — ${why}${run ? ` — ${run.url}` : ''}`);
    return 1;
  }

  // Mode: assert the live page serves one specific week.
  if (opts.week) {
    const { ok, problems } = await fetchUntil({
      url: opts.url, expectWeek: opts.week, attempts: opts.attempts, delayMs: opts.delayMs, log: say,
    });
    if (ok) {
      console.log(`✓ ${opts.week} live`);
      return 0;
    }
    console.error(`✗ ${opts.week} NOT live — ${problems.join('; ')}`);
    return 1;
  }

  // Mode: the daily health check.
  let liveHtml;
  let liveError;
  try {
    liveHtml = await fetchLivePage(opts.url);
  } catch (err) {
    liveError = err.message;
  }
  const { checks, ok } = runChecks({
    liveHtml, liveError,
    archive: readArchive(ARCHIVE_PATH),
    today: localToday(),
    marker: readMarker(),
  });
  for (const c of checks) {
    const mark = c.skipped ? '·' : c.ok ? '✓' : c.warn ? '⚠' : '✗';
    console.log(`${mark} ${c.name.padEnd(14)} ${c.detail}`);
  }
  const warns = checks.filter((c) => c.warn && !c.ok).length;
  const tail = warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '';
  if (ok) {
    console.log(`✓ weekly page healthy (${opts.url}${tail})`);
    return 0;
  }
  console.error(`✗ weekly page UNHEALTHY — ${checks.filter((c) => !c.ok && !c.warn && !c.skipped)
    .map((c) => c.name).join(', ')} failed${tail}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await cli(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}
