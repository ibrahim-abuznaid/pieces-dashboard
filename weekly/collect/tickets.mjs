// weekly/collect/tickets.mjs
// Tickets come from the internal pieces-team dashboard's already-refreshed data
// files, NOT from a fresh Linear query — the Linear MCP is not reachable
// headless, and refresh.sh already solves that. One Linear pipeline, not two.
import { mondayOfWeekId } from '../../lib/isoweek.mjs';

const PEOPLE = ['kishan', 'sanket'];
const zeroed = () => Object.fromEntries(PEOPLE.map((p) => [p, 0]));
const inWindow = (day, { start, end }) => Boolean(day) && day >= start && day <= end;

export function collectTickets({ window, weekId, readJson, linearRefreshPending }) {
  if (linearRefreshPending) {
    return { status: 'no-data', reason: 'Linear refresh pending — internal dashboard wrote NEEDS-LINEAR-REFRESH' };
  }
  try {
    const linear = readJson('linear.json');
    const github = readJson('github.json');
    if (!Array.isArray(linear?.events)) throw new Error('linear.json has no `events` array');
    if (!Array.isArray(github?.mergedEvents)) throw new Error('github.json has no `mergedEvents` array');

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
      byPerson, prsMerged, reviews, shipped,
    };
  } catch (err) {
    return { status: 'no-data', reason: `internal dashboard data unavailable (${err.message})` };
  }
}
