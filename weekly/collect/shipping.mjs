// weekly/collect/shipping.mjs
// What the team actually did with its week: PRs merged into activepieces, and
// reviews given on other people's.
//
// The page had four rollout tiles and a ticket count, and none of them is how
// this team spends most of its time. Kishan merged 82 PRs and gave 179 reviews
// inside the dashboard's own four-month window; a page reporting the team's
// output showed neither number. The data was already being collected -- the
// tickets collector has read `prsMerged` and `reviews` out of the same file for
// months and rendered them as a footnote under a different number.
//
// Same source and same reasoning as tickets.mjs: the internal dashboard's
// already-refreshed data files, not a second GitHub pull. One pipeline.
import { mondayOfWeekId } from '../../lib/isoweek.mjs';
import { PEOPLE, zeroed, sumOverPeople } from './people.mjs';

const inWindow = (day, { start, end }) => Boolean(day) && day >= start && day <= end;

// A merged PR that touched `packages/pieces/**`. `mixed` counts: a PR that
// changes a piece and the engine together is still a piece landing, and
// excluding it would under-report the team's own subject.
const TOUCHED_A_PIECE = new Set(['pieces', 'mixed']);

export function collectShipping({ window, weekId, readJson }) {
  try {
    const github = readJson('github.json');
    if (!Array.isArray(github?.mergedEvents)) throw new Error('github.json has no `mergedEvents` array');

    // Same freshness gate as the tickets collector, for the same reason: the
    // internal dashboard runs its own rolling window, and data that simply
    // predates this week yields 0 everywhere -- indistinguishable from a week
    // in which nobody merged anything. Absent this, a stale file publishes
    // "0 PRs" as a fact about the team.
    if (!github.stamp) throw new Error('github.json carries no `stamp` — cannot establish freshness');
    if (github.stamp < window.end) {
      return { status: 'no-data',
        reason: `internal dashboard GitHub data only reaches ${github.stamp}, but this week ends ${window.end} — needs a full refresh` };
    }

    const byPerson = zeroed();
    let piecePrs = 0;
    for (const e of github.mergedEvents) {
      if (!inWindow(e.d, window) || !(e.p in byPerson)) continue;
      byPerson[e.p] += 1;
      if (TOUCHED_A_PIECE.has(e.kind)) piecePrs += 1;
    }

    // Reviews are weekly at best -- GitHub's search API cannot resolve them
    // finer, which is why the internal pull buckets them by the Monday of each
    // week and stamps `approx`. A week with no bucket is 0 rather than null:
    // the buckets span the whole window, so a missing one means the week had
    // none, not that nobody counted.
    const bucket = (github.reviews?.weekly ?? []).find((w) => w.w === mondayOfWeekId(weekId));
    const reviewsByPerson = Object.fromEntries(PEOPLE.map((p) => [p, Number(bucket?.[p]) || 0]));

    // Chips for the strip, from the internal pull's recent-PR list. That list
    // is capped upstream, so it can fall short of the headline on a big week --
    // the count comes from `mergedEvents`, which is complete, and the strip
    // shows what it can. A short strip under a true number beats a true strip
    // under a number trimmed to match it.
    const shipped = (github.recentPrs ?? [])
      .filter((pr) => pr?.state === 'MERGED' && inWindow(pr.mergedAt?.slice(0, 10), window))
      .map(({ number, title, url, author, kind }) => ({ number, title, url, author, kind }));

    return {
      status: 'ok',
      prsMerged: sumOverPeople(byPerson),
      piecePrs,
      byPerson,
      reviews: sumOverPeople(reviewsByPerson),
      reviewsByPerson,
      reviewsApprox: github.reviews?.approx === true,
      shipped,
    };
  } catch (err) {
    return { status: 'no-data', reason: `internal dashboard data unavailable (${err.message})` };
  }
}
