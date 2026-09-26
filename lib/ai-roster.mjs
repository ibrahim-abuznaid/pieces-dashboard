// Which pieces have AI actions, and where is each one in the pipeline?
//
// The roster used to BE ai-actions/pieces.json: a curated list, and a piece
// absent from it did not exist as far as the page was concerned. That is the
// same fault lib/discover.mjs fixed for work in flight, left standing for work
// that had LANDED, and it cost more. It hid four pieces in September (fixed by
// hand in 2e3fddb), and in W39 it hid twenty-two: Kishan and Odai gave agent
// atomics to 23 pieces across 17 PRs -- #15722 alone carried four -- and the
// weekly page reported one, because only Pinterest had a row.
//
// So main is now the record for MERGED, read straight off the code by
// scripts/fetch-repo-ai.sh: a piece with at least one `audience: 'ai'` action
// on main has AI actions, whether or not anyone wrote it down. The curated file
// keeps what the code cannot say -- Tier-2 results, notes, held reasons, the PR
// a rollout row shipped in -- and stops being the only way a piece is counted.
//
// PURE on purpose, like lib/discover.mjs: handed the curated rows, the claims,
// the PR states and main's per-piece counts, never a network or a file.
import { deriveStage, assigneesOf } from './stages.mjs';
import { claimedPr } from './discover.mjs';

const later = (a, b) => typeof a === 'string' && typeof b === 'string' && Date.parse(a) > Date.parse(b);

// Did this MERGED PR land on main? A stacked PR merges into its parent branch
// first (#15758 targets feat/asana-ai-actions-a), and reads MERGED on a day main
// has none of it. States fetched before `base` was recorded carry none, and are
// taken to be main, which is what every one of them was.
const intoMain = (st) => st?.base == null || st.base === 'main';

// An open PR the lead has approved is `approved`: done as far as the team's work
// goes, and counted so by the weekly page, but not on main -- it is its own
// stage so nothing can mistake it for `merged`. See lib/reviews.mjs.
const stageFor = (claim, prStates) => {
  const stage = deriveStage(claim, prStates);
  return stage === 'pr-open' && prStates[claim.pr]?.approved === true ? 'approved' : stage;
};

// `onMain` is { slug: count of audience:'ai' actions } at commit time `mainAt`,
// or null when main was never read -- a checkout that has not fetched. Null
// means "not measured", so the build falls back to the curated claims alone,
// exactly as it ran before main was read at all. An EMPTY object is a reading.
//
// Returns the rows and the warnings a maintainer should act on. Warnings are
// printed, never fatal: each one names a curated row the code contradicts, and
// the code wins for the count either way.
export function buildAiRoster({ curated = [], overrides = {}, discovered = {}, prStates = {}, onMain = null, mainAt = null }) {
  const warnings = [];
  const count = (slug) => (onMain && onMain[slug] > 0 ? onMain[slug] : 0);

  // A PR that reads MERGED while main has nothing of the piece. Believed only
  // when it merged into main AFTER main was read -- the minutes-wide race
  // between the two fetches. Otherwise it shipped something else (pubrio and
  // quizell were counted merged off #13979, which merged without them) or it
  // landed on a parent branch that has not reached main yet.
  const mergedOffMain = (pr) => {
    const st = prStates[pr];
    return !(intoMain(st) && later(st?.mergedAt, mainAt));
  };

  const rows = curated.map((p) => {
    const ov = overrides[p.slug] ?? {};
    const claim = { assignee: ov.assignee ?? null, pr: claimedPr(p.pr ?? ov.pr ?? null, discovered, p.slug) };
    const live = count(p.slug);
    let stage;
    if (live) {
      // On main beats a held reason: the reason was true once, the code is true now.
      stage = 'merged';
    } else if (p.held) {
      stage = 'held';
    } else {
      stage = stageFor(claim, prStates) ?? 'held';
      if (onMain && stage === 'merged' && mergedOffMain(claim.pr)) {
        const retry = discovered[p.slug];
        const retryStage = retry != null && retry !== claim.pr ? stageFor({ pr: retry }, prStates) : null;
        if (retryStage === 'pr-open' || retryStage === 'approved') {
          // The curated PR is stale, but a newer open one carries the piece: it
          // is in review, not shelved. Curated still wins for everything else.
          warnings.push(`${p.slug}: PR #${claim.pr} merged without its audience:'ai' actions; #${retry} is open with them — point the row at #${retry}.`);
          claim.pr = retry;
          stage = retryStage;
        } else {
          warnings.push(`${p.slug}: PR #${claim.pr} merged but main carries no audience:'ai' action for it — counted held. Give it a held reason, or point it at the PR that shipped it.`);
          stage = 'held';
        }
      }
    }
    return {
      ...p,
      // Main's count for a landed piece, the authored count otherwise. Trello
      // read 46 for the month after #15539 took it to 66.
      atomics: live || p.atomics,
      pr: claim.pr,
      stage,
      assignees: assigneesOf(claim, prStates),
      prState: claim.pr ? (prStates[claim.pr]?.state ?? null) : null,
    };
  });

  const known = new Set(curated.map((p) => p.slug));

  // Landed and never written down. No PR: main is read from a shallow clone,
  // which has no history to find one in, and a guessed number is worse than a
  // dash. Tier-2 is null for the reason the curated header gives -- our harness
  // did not run it -- so these rows add 0 to the verified tile, not a fiction.
  const fromMain = Object.keys(onMain ?? {}).filter((slug) => !known.has(slug) && count(slug)).sort();
  for (const slug of fromMain) {
    known.add(slug);
    rows.push({ slug, atomics: count(slug), pr: null, t2v: null, t2t: null,
      stage: 'merged', assignees: [], prState: null, source: 'main' });
  }

  // In flight and never written down: an open PR whose diff adds agent atomics
  // to a piece main does not have them on yet. One PR carrying two pieces is two
  // rows under one number. The count is 0, not a guess: what a PR adds is only
  // known when it lands, and main will say so the day it does.
  for (const slug of Object.keys(discovered).sort()) {
    if (known.has(slug)) continue;
    const claim = { assignee: null, pr: discovered[slug] };
    let stage = stageFor(claim, prStates);
    if (stage == null) continue;
    // Discovery only lists OPEN PRs, so a MERGED one here merged since. Into a
    // parent branch it is still on its way to main; into main, only the race
    // explains main not having it -- anything else is a reading we cannot place.
    if (onMain && stage === 'merged' && mergedOffMain(claim.pr)) {
      if (intoMain(prStates[claim.pr])) continue;
      stage = 'pr-open';
    }
    known.add(slug);
    rows.push({ slug, atomics: 0, pr: claim.pr, t2v: null, t2t: null,
      stage, assignees: assigneesOf(claim, prStates), prState: prStates[claim.pr]?.state ?? null, source: 'pr' });
  }

  return { rows, warnings };
}

// The numbers behind the tiles, from the rows and nothing else, so a tile and
// the roster under it can never disagree.
//
// `atomics` is MERGED rows only. The tile reads "audience:'ai' actions on main",
// and a held or in-flight row's count is what a PR proposes, not what shipped --
// pubrio and quizell added 18 atomics nobody could call.
//
// `prsMerged` counts the PR numbers the roster can NAME, which is curated rows
// only: a piece found on main carries no PR (see above). It is not "the PRs
// that shipped AI actions", and the tile that shows it has to say so.
export function summarizeAiRoster(rows) {
  const sum = (fn) => rows.reduce((a, p) => a + fn(p), 0);
  const stageCount = (s) => rows.filter((p) => p.stage === s).length;
  return {
    pieces: rows.length,
    atomics: sum((p) => (p.stage === 'merged' ? p.atomics : 0)),
    t2v: sum((p) => p.t2v ?? 0),
    t2t: sum((p) => p.t2t ?? 0),
    stages: { held: stageCount('held'), assigned: stageCount('assigned'), prOpen: stageCount('pr-open'),
      approved: stageCount('approved'), merged: stageCount('merged') },
    prsOpen: new Set(rows.filter((p) => p.prState === 'OPEN').map((p) => p.pr)).size,
    prsMerged: new Set(rows.filter((p) => p.prState === 'MERGED').map((p) => p.pr)).size,
    fromMain: rows.filter((p) => p.source === 'main').length,
    fromPrs: rows.filter((p) => p.source === 'pr').length,
  };
}
