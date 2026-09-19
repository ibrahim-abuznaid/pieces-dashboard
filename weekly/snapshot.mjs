#!/usr/bin/env node
// weekly/snapshot.mjs
// LOCAL ONLY. Appends one immutable week to weekly/data/weeks.json, which is
// committed. CI must never run this: CI rebuilds daily, so recomputing here
// would rewrite history. CI only runs weekly/build.mjs.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isoWeekId, mondayOfWeekId, latestSealedWeek, windowForWeekId } from '../lib/isoweek.mjs';
import { readArchive, appendWeek, writeArchive } from './lib/archive.mjs';
// One grammar for the whole product: the decision lines this file writes end up
// in the same band as everything view.mjs phrases, so they share the helper.
import { plural } from './lib/view.mjs';
import { collectOutputSchema } from './collect/output-schema.mjs';
import { collectAiActions } from './collect/ai-actions.mjs';
import { collectUiImprovements } from './collect/ui-improvements.mjs';
import { collectTesting } from './collect/testing.mjs';
import { collectTickets } from './collect/tickets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const TEAM_DASHBOARD = process.env.PIECES_TEAM_DASHBOARD
  ?? '/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard';

const WORKSTREAMS = ['outputSchema', 'aiActions', 'uiImprovements', 'testing', 'tickets'];

export function buildSnapshot({ weekId, today, collectors }) {
  const { start, end } = windowForWeekId(weekId);
  const snap = { week: weekId, start, end, builtAt: today };
  for (const key of WORKSTREAMS) {
    try {
      snap[key] = collectors[key]();
    } catch (err) {
      // A collector that throws instead of degrading must not lose the other three.
      snap[key] = { status: 'no-data', reason: `${key} collector threw (${err.message})` };
    }
  }
  snap.decisions = deriveDecisions(snap);
  return snap;
}

// Only ASKS live here: a line belongs in this list if a person has to go and do
// something about it. Counts that are merely the state of play — PRs sitting in
// review, blockers still open — are already the tiles' job, and a degraded
// workstream is already the tile's "no data". Listing them here padded the band
// out to four lines of which one mattered, which is how a "needs you" section
// becomes something readers scroll past. The view filters these shapes out on
// render as well, so weeks already committed to the archive read clean too.
export function deriveDecisions(snap) {
  const lines = [];
  const os = snap.outputSchema;
  if (os?.status === 'ok' && os.mergedNotLive > 0) {
    const n = os.mergedNotLive;
    lines.push(`${n} ${plural(n, 'piece')} merged but not live — needs a cloud release`);
  }
  // The same ask, for the same reason, about the other rollout that ships
  // metadata through the cloud registry. Derived rather than stored: the
  // collector records `merged` and `live`, and a third count on disk is one
  // more number that can disagree with the two it came from.
  // `typeof`, not arithmetic: a week with no cloud measurement leaves `live`
  // absent, and `5 - undefined > 0` is false only because NaN comparisons are.
  // Asking the question explicitly is what keeps that an intention rather than
  // a coincidence one refactor away from becoming an ask nobody can act on.
  const ui = snap.uiImprovements;
  if (ui?.status === 'ok' && typeof ui.live === 'number' && ui.merged - ui.live > 0) {
    const n = ui.merged - ui.live;
    lines.push(`${n} ${plural(n, 'piece')} with the new property UI merged but not live — needs a cloud release`);
  }
  return lines;
}

// --- CLI argument parsing ----------------------------------------------------
// lib/isoweek.mjs is deliberately permissive: isoWeekId() yields 'NaN-WNaN' for
// an unparseable date, and mondayOfWeekId() checks only the YYYY-Wnn shape, not
// that the week number exists in that ISO year. Both values arrive here from a
// human, so this is the boundary that must reject a typo — otherwise a mistyped
// week lands in the archive as a real, permanent, immutable snapshot.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const USAGE = 'usage: node weekly/snapshot.mjs [--week=YYYY-Wnn] [--today=YYYY-MM-DD] [--force-week]';

function requireDate(value, flag) {
  if (!DATE_RE.test(value)) throw new Error(`--${flag} must be YYYY-MM-DD, got "${value}" — ${USAGE}`);
  // Date rolls overflow silently ('2026-02-30' → 2026-03-02), so round-trip it.
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`--${flag} is not a real calendar date: "${value}"`);
  }
  return value;
}

function requireWeekId(value) {
  if (!WEEK_RE.test(value)) throw new Error(`--week must be YYYY-Wnn, got "${value}" — ${USAGE}`);
  // A week id exists only if it round-trips: '2026-W54' and '2026-W00' both
  // resolve to Mondays in a neighbouring ISO year.
  if (isoWeekId(mondayOfWeekId(value)) !== value) {
    throw new Error(`--week ${value} is not a real ISO week`);
  }
  return value;
}

const FLAGS = ['--week=', '--today=', '--force-week'];

export function parseArgs(argv) {
  for (const a of argv) {
    // Reject unknown args rather than ignoring them: `--week 2026-W31` with a
    // space would otherwise silently snapshot the default week instead.
    if (!FLAGS.some((f) => (f.endsWith('=') ? a.startsWith(f) : a === f))) {
      throw new Error(`unknown argument "${a}" — ${USAGE}`);
    }
  }
  const arg = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(hit.indexOf('=') + 1);
  };
  const rawToday = arg('today');
  const today = rawToday === undefined
    ? new Date().toISOString().slice(0, 10)
    : requireDate(rawToday, 'today');
  const rawWeek = arg('week');
  // SEALED, not merely complete — the job runs daily now, so the default has to
  // be right on a Friday too. refresh-weekly.sh resolves the same week the same
  // way; the two disagreeing by a day would be a silent off-by-one nobody sees
  // until a week is written with a day still left in it.
  const weekId = rawWeek === undefined ? latestSealedWeek(today) : requireWeekId(rawWeek);
  return { today, weekId, force: argv.includes('--force-week') };
}

// The tester is not an open endpoint. server/src/index.ts mounts `requireAuth`
// in front of everything under /api, so a bare GET of /api/coverage 401s -- which
// is what the coverage half of the testing collector had been doing unnoticed,
// reading as "tester unreachable". Auth is one shared password exchanged for a
// session cookie, so: log in once here, keep the cookie for the life of this
// process, and hand the collector the same `curl(url)` it already takes. The
// collector stays a pure "GET this URL" consumer and knows nothing about login.
//
// The password goes in on STDIN, never in argv: a snapshot can run under cron
// beside anything else on this machine, and an argument is world-readable in
// `ps` for as long as the call takes.
//
// FAILING to log in is not fatal and does not stop the snapshot. Whether the
// secret is absent, wrong, or the host is down, the collector gets the plain
// curl, that call 401s or times out, and coverage degrades alone -- PRs and
// commits are still measured, and the reason lands in `coverageError` where the
// operator already looks. One missing secret must never cost the whole week.
export function testerClient({ baseUrl, password, exec, warn = console.warn,
                               jarPath = join(tmpdir(), `pieces-dashboard-tester-${process.pid}.cookies`) }) {
  const plain = (url) => exec('curl', ['-fsS', '--max-time', '30', url],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (!baseUrl || !password) return { curl: plain, cleanup: () => {} };

  const cleanup = () => { try { rmSync(jarPath, { force: true }); } catch { /* best effort */ } };
  try {
    exec('curl', ['-fsS', '--max-time', '30', '-c', jarPath, '-X', 'POST',
      '-H', 'Content-Type: application/json', '--data-binary', '@-',
      `${baseUrl.replace(/\/$/, '')}/api/auth/login`],
    { encoding: 'utf8', input: JSON.stringify({ password }) });
  } catch (err) {
    // The message, never the password: curl echoes the request body on some
    // failures and this line ends up in a log file the operator keeps.
    warn(`⚠ tester login failed (${err.message}) — coverage will degrade`);
    cleanup();
    return { curl: plain, cleanup: () => {} };
  }
  return {
    curl: (url) => exec('curl', ['-fsS', '--max-time', '30', '-b', jarPath, url],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }),
    cleanup,
  };
}

export function main(argv) {
  const { today, weekId, force } = parseArgs(argv);
  const window = windowForWeekId(weekId);

  const readRepoJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  const readTeamJson = (name) => JSON.parse(readFileSync(join(TEAM_DASHBOARD, 'data', name), 'utf8'));
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // The tester's address and password are deployment detail, kept out of this
  // public repo: they reach the collector only through the environment of the
  // (local-only) machine that takes snapshots. `-f` turns HTTP errors into exit
  // codes so a 500 degrades the coverage half instead of parsing an error page
  // as JSON — and so a 401 is a failure rather than a page of login HTML
  // arriving where a coverage array was expected.
  const testerUrl = process.env.PIECE_TESTER_URL;
  const { curl, cleanup } = testerClient({
    baseUrl: testerUrl, password: process.env.PIECE_TESTER_PASSWORD, exec: execFileSync,
  });

  let snap;
  try {
    snap = buildSnapshot({
      weekId, today,
      collectors: {
        outputSchema: () => collectOutputSchema({ readJson: readRepoJson }),
        aiActions: () => collectAiActions({ readJson: readRepoJson }),
        uiImprovements: () => collectUiImprovements({ readJson: readRepoJson }),
        testing: () => collectTesting({ window, gh, curl, testerUrl }),
        tickets: () => collectTickets({
          window, weekId, readJson: readTeamJson,
          linearRefreshPending: existsSync(join(TEAM_DASHBOARD, 'NEEDS-LINEAR-REFRESH')),
        }),
      },
    });
  } finally {
    // The jar outlives nothing: it holds a live 7-day session for a host whose
    // address this repo deliberately does not carry.
    cleanup();
  }

  writeArchive(ARCHIVE, appendWeek(readArchive(ARCHIVE), snap, { force }));
  const degraded = WORKSTREAMS.filter((k) => snap[k].status === 'no-data');
  console.log(`✓ snapshot ${weekId} (${snap.start}→${snap.end}) appended`);
  if (degraded.length) console.warn(`⚠ degraded: ${degraded.join(', ')}`);
  // A coverage miss is not a degraded workstream (PRs and commits landed), but
  // the operator standing at this terminal is the only person who can fix it.
  if (snap.testing?.coverageError) console.warn(`⚠ testing: ${snap.testing.coverageError}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // A bad flag or a re-snapshot attempt is operator error, not a crash: one
    // clear line and a non-zero exit so refresh-weekly.sh stops.
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}
