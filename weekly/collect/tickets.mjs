// weekly/collect/tickets.mjs
// Tickets come from the internal pieces-team dashboard's already-refreshed data
// files, NOT from a fresh Linear query — the Linear MCP is not reachable
// headless, and refresh.sh already solves that. One Linear pipeline, not two.
import { mondayOfWeekId } from '../../lib/isoweek.mjs';

const PEOPLE = ['kishan', 'sanket'];
const zeroed = () => Object.fromEntries(PEOPLE.map((p) => [p, 0]));
const inWindow = (day, { start, end }) => Boolean(day) && day >= start && day <= end;

// The queue the headline cannot show. `total` counts tickets CLOSED inside the
// window, so a week spent waiting on review reads there as a week of nothing --
// the same gap the rollouts' pill closes, and the one board this tile reads
// measures it directly: Pieces and GIT both carry an explicit `In Review` state
// between `In Progress` and `Done`, and the internal dashboard's refresh already
// records a per-person count of it. Nothing here is inferred from a PR.
//
// A CURRENT-STATE count, exactly like the rollouts' queues: what sits in review
// when the snapshot runs, not what sat there during the week. It cannot be
// windowed -- `summary` carries counts, not dates -- and a queue is a state, so
// there is nothing to window.
//
// Scoped to PEOPLE for the same reason `total` is: this box reports the two
// people it names underneath, and a third person's queue appearing in the
// number but not in the line below it is a discrepancy a reader cannot resolve.
//
// null, not 0, when the file predates the field or carries no usable row: a week
// that never measured the queue must report no queue rather than an empty one.
// A real 0 -- rows present, nothing in review -- survives as 0; the view keeps
// the two apart and the template draws neither.
function inReviewOf(rows) {
  if (!Array.isArray(rows)) return null;
  let total = null;
  for (const r of rows) {
    if (!PEOPLE.includes(r?.person) || typeof r?.inReview !== 'number') continue;
    total = (total ?? 0) + r.inReview;
  }
  return total;
}

export function collectTickets({ window, weekId, readJson, linearRefreshPending }) {
  if (linearRefreshPending) {
    return { status: 'no-data', reason: 'Linear refresh pending — internal dashboard wrote NEEDS-LINEAR-REFRESH' };
  }
  try {
    const linear = readJson('linear.json');
    const github = readJson('github.json');
    if (!Array.isArray(linear?.events)) throw new Error('linear.json has no `events` array');
    if (!Array.isArray(github?.mergedEvents)) throw new Error('github.json has no `mergedEvents` array');

    // Freshness gate. The internal dashboard runs on its own rolling window, so
    // data that simply predates this week yields 0 everywhere — indistinguishable
    // from a genuinely quiet week. Absent this, a stale snapshot would publish
    // "0 tickets" as fact. The NEEDS-LINEAR-REFRESH marker does not cover it:
    // that flags Linear staleness, not whether the window reaches this week.
    const covered = [linear.stamp, github.stamp].filter(Boolean).sort()[0];
    if (!covered) throw new Error('data files carry no `stamp` — cannot establish freshness');
    if (covered < window.end) {
      return { status: 'no-data',
        reason: `internal dashboard data only reaches ${covered}, but this week ends ${window.end} — needs a full refresh` };
    }

    const byPerson = zeroed();
    for (const e of linear.events) {
      if (inWindow(e.d, window) && e.p in byPerson) byPerson[e.p] += 1;
    }

    const prsMerged = zeroed();
    for (const e of github.mergedEvents) {
      if (inWindow(e.d, window) && e.p in prsMerged) prsMerged[e.p] += 1;
    }

    const monday = mondayOfWeekId(weekId);
    const bucket = (github.reviews?.weekly ?? []).find((w) => w.w === monday);
    const reviews = Object.fromEntries(PEOPLE.map((p) => [p, Number(bucket?.[p] ?? 0)]));

    const shipped = (linear.recent ?? [])
      .filter((i) => inWindow(i.completedAt?.slice(0, 10), window))
      .map(({ id, title, assignee, team }) => ({ id, title, assignee, team }));

    return {
      status: 'ok',
      total: PEOPLE.reduce((sum, p) => sum + byPerson[p], 0),
      inReview: inReviewOf(linear.summary),
      byPerson, prsMerged, reviews, shipped,
    };
  } catch (err) {
    return { status: 'no-data', reason: `internal dashboard data unavailable (${err.message})` };
  }
}
