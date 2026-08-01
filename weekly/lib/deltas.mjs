// weekly/lib/deltas.mjs
// Pure reads over the snapshot archive. A metric is unavailable (null) rather
// than zero whenever its workstream degraded — the page must never imply "0"
// when it means "we don't know".
import { previousWeekId } from '../../lib/isoweek.mjs';

export function pick(snap, path) {
  let cur = snap;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    if (cur.status === 'no-data') return null;
    cur = cur[key];
  }
  return typeof cur === 'number' ? cur : null;
}

const indexOfWeek = (weeks, weekId) => weeks.findIndex((w) => w.week === weekId);

export function deltaFor(weeks, weekId, path) {
  const at = indexOfWeek(weeks, weekId);
  if (at <= 0) return null;
  // A gap in the archive must not silently become a two-week delta reported as
  // one week's progress. If the preceding entry is not literally the previous
  // ISO week, the week-over-week comparison is unavailable.
  if (weeks[at - 1].week !== previousWeekId(weekId)) return null;
  const current = pick(weeks[at], path);
  const previous = pick(weeks[at - 1], path);
  if (current === null || previous === null) return null;
  return current - previous;
}

export function seriesFor(weeks, weekId, path, count = 6) {
  const at = indexOfWeek(weeks, weekId);
  if (at === -1) return [];
  return weeks
    .slice(Math.max(0, at + 1 - count), at + 1)
    .map((w) => ({ week: w.week, value: pick(w, path) }));
}
