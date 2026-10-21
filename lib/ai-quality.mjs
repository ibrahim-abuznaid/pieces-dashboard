// lib/ai-quality.mjs
// The "Quality & rollout" section of the AI-actions page: is the rollout going
// as planned (K1), is what merged actually live (K3), does it pass the checks
// that have a real failure behind them (K4, K9) -- METHODOLOGY.md §4.
//
// COUNTS ONLY, by construction: it is handed data/ai-audit.json and
// data/ai-rollout.json, which carry no piece or action name, and the weekly
// archive's numbers. It never sees a finding, so it cannot leak one.
//
// Two rules from the council (C §2) shape every field:
//   - "not measured" is null and renders as a grey gap, never as 0;
//   - merged, approved and served are separate numbers, never added together.
import { deltaFor, pick } from '../weekly/lib/deltas.mjs';
import { isoWeekId, previousWeekId } from './isoweek.mjs';

const DAY = 86400000;
const sum = (o) => (o && typeof o === 'object' ? Object.values(o).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) : 0);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// The weekly window runs Saturday → Friday, so the week a day belongs to is
// the ISO week of the Monday after a Saturday: shift two days and ask ISO.
export const windowWeekOf = (today) => isoWeekId(new Date(Date.parse(`${today}T00:00:00Z`) + 2 * DAY));

// K1: pieces that gained AI actions per week, MERGED ONLY, against the target.
//
// The weekly page already counts AI-actions work against per-person targets,
// but by its own rule: an approved PR is done, and from W40 an open PR counts
// the week it opens. That is the right rule for crediting a person and the
// wrong one for the plan, which is about what landed. So this reads the same
// archive and takes the week-over-week change in `aiActions.merged` -- the
// number the build derives from main -- with approved on its own line.
//
// The target is the sum of the per-person aiActions targets in force that week
// (the archive copies them in; targets.json covers a week archived without).
// Pace is Σ gained / Σ target over the weeks that could be measured; a week
// with a gap before it (W35 was lost) or a degraded tile is skipped, not 0.
//
// `mergedNow` is today's build of the same number, for the week in progress,
// read off main at `mainAt`. A reading of main older than the last archived
// week cannot say what happened after it (a checkout that has not fetched),
// so the week in progress is then a gap rather than a negative number.
export function k1Pace({ weeks = [], targetsFile = null, mergedNow = null, approvedNow = null, mainAt = null, today = null }) {
  const from = targetsFile?.from;
  if (!from) return null;
  const rows = weeks.filter((w) => w.week >= from).map((w) => {
    const target = sum(w.targets?.aiActions ?? targetsFile.targets?.aiActions) || null;
    return { week: w.week, gained: deltaFor(weeks, w.week, 'aiActions.merged'), approved: pick(w, 'aiActions.approved'), target };
  });
  const measured = rows.filter((r) => r.gained != null && r.target);
  const gained = measured.reduce((s, r) => s + r.gained, 0);
  const targetSum = measured.reduce((s, r) => s + r.target, 0);
  // The tripwire: under half the target for two weeks running means re-plan.
  let belowHalfStreak = 0;
  for (const r of [...rows].reverse()) {
    if (r.gained == null || !r.target || r.gained >= r.target / 2) break;
    belowHalfStreak++;
  }
  let thisWeek = null;
  const last = weeks.at(-1);
  if (today && last && Number.isFinite(mergedNow)) {
    const week = windowWeekOf(today);
    const before = pick(last, 'aiActions.merged');
    const fresh = Date.parse(mainAt) > Date.parse(`${last.end}T23:59:59Z`);
    if (last.week === previousWeekId(week) && before != null && fresh) thisWeek = { week, soFar: mergedNow - before, approved: approvedNow };
  }
  return {
    from,
    target: rows.at(-1)?.target ?? null,
    weeks: rows,
    measuredWeeks: measured.length,
    perWeek: measured.length ? Math.round((gained / measured.length) * 10) / 10 : null,
    pacePct: pct(gained, targetSum),
    belowHalfStreak,
    thisWeek,
  };
}

// The rest of the section, from the two counts files. Either may be absent (a
// checkout that has not fetched) or say `measured: false` (a rollout fetch that
// failed); both are null here and gaps on the page.
export function qualityModel({ audit = null, rollout = null, pace = null }) {
  const ok = (r) => (r && r.measured !== false ? r : null);
  const ro = ok(rollout);
  const c = audit?.checks;
  return {
    audit: audit ? { commit: audit.commit, committedAt: audit.committedAt, fetched: audit.fetched, latestRelease: audit.latestRelease } : null,
    rollout: rollout ? { commit: rollout.commit ?? null, fetched: rollout.fetched ?? null } : null,
    k1: pace,
    k3: ro
      ? {
        pieces: ro.pieces,
        npm: ro.npm ? { atMain: ro.npm.atMain, measured: ro.npm.measured, pct: ro.npm.atMainPct, lag: ro.npm.lagMinutes, collisions: ro.npm.collisions, behind: ro.npm.behind } : null,
        cloud: ro.cloud ? { served: ro.cloud.served, servedWithAi: ro.cloud.servedWithAi, measured: ro.cloud.measured,
          pct: ro.cloud.servedPct, withAiPct: ro.cloud.servedWithAiPct } : null,
        stuck24h: ro.stuck24h ? ro.stuck24h.count : null,
      }
      : null,
    k4: audit
      ? { passPct: audit.k4.p1PassPct, failing: audit.k4.p1Actions, actions: audit.ai.actions, pieces: audit.ai.pieces,
        piecesClean: audit.k4.piecesCleanOfP1, piecesCleanIncludingS2: audit.k4.piecesCleanIncludingS2 }
      : null,
    k9: c?.S2 && c.S2.actions != null
      ? { actions: c.S2.actions, pieces: c.S2.pieces, demoted: c.S2.demoted, baselineCommit: audit.baseline?.commit ?? null, baselineAt: audit.baseline?.committedAt ?? null }
      : null,
    checks: c ? Object.entries(c).map(([id, v]) => ({ id, severity: v.severity, actions: v.actions, pieces: v.pieces })) : null,
    floor: audit ? { unresolvedProps: audit.ai.unresolvedProps, s1All: c?.S1?.allOptionalCheckbox ?? null, s8Exempt: c?.S8?.exempt ?? null } : null,
    soft: audit?.soft ?? null,
  };
}
