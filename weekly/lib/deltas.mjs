// weekly/lib/deltas.mjs
// Pure reads over the snapshot archive. A metric is unavailable (null) rather
// than zero whenever its workstream degraded — the page must never imply "0"
// when it means "we don't know".
import { previousWeekId } from '../../lib/isoweek.mjs';

// NaN and Infinity are "we do not know", not numbers: arithmetic across a
// degraded workstream (`undefined + 9`) produces NaN, and a NaN that survived
// to the page would render as a value the collectors never measured.
const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// `path` is either a dotted string ('tickets.total') or an accessor called with
// the whole snapshot. The accessor form exists because some headline numbers
// are derived rather than stored — "outputSchema merged" is live + mergedNotLive
// — and deriving it at read time keeps every snapshot already in the archive
// valid, with no schema change and no backfill. An accessor may reach through
// a workstream that degraded, so it is allowed to throw: that is a null.
export function pick(snap, path) {
  if (typeof path === 'function') {
    try {
      return asNumber(path(snap));
    } catch {
      return null;
    }
  }
  let cur = snap;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    if (cur.status === 'no-data') return null;
    cur = cur[key];
  }
  return asNumber(cur);
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
