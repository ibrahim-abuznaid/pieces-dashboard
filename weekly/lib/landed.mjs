// weekly/lib/landed.mjs
// Which pieces crossed the line THIS week: done in the selected snapshot, not
// done in the immediately-preceding one. On the rollout tiles the pieces strip
// labels these "Done this week" and the per-person targets credit them, so both
// read ONE diff and can never disagree about what a week delivered. The testing
// tile's targets read the same diff, but its strip is the cumulative coverage
// (coveredStrip in view.mjs), so there the two do not list the same pieces.
import { previousWeekId } from '../../lib/isoweek.mjs';

// The roster of the immediately-preceding archive entry, or null when there is
// nothing legitimate to diff against. Mirrors the gap guard in `deltaFor`: the
// preceding ENTRY is only the preceding WEEK if it literally is, so a hole in
// the archive yields no comparison instead of two weeks' work labelled as one.
// An empty roster counts as no roster — the collectors return `[]` for a lost
// pieces.json, so "[] last week" cannot be read as "nothing was done last week".
export function priorRoster(weeks, selected, key) {
  const at = weeks.findIndex((w) => w.week === selected.week);
  if (at <= 0) return null;
  if (weeks[at - 1].week !== previousWeekId(selected.week)) return null;
  const ws = weeks[at - 1][key];
  if (ws?.status !== 'ok' || !Array.isArray(ws.roster) || !ws.roster.length) return null;
  return ws.roster;
}

// A row's stable identity, or null when it carries none. `folder` is the piece's
// directory: the catalog's own key, unique across every row, and the one thing
// about a piece that does not change.
//
// A DISPLAY NAME is not an identity, which is exactly why a row may carry one for
// the chip to render (see `toChip` in view.mjs) and the diff still reads this. It
// is editorial — the cloud catalog renames pieces, 'Telegram Bot' and 'Google
// Gemini' among them — and it is not unique:
// two folders publish 'Cashfree Payments' and two publish 'Weekdone' today. Both
// failures land in the diff below, and since the strip is the tile's headline
// claim they land above the fold: a rename re-reports finished work as this
// week's output, and a duplicated name hides a genuinely new piece behind its
// twin, so the tile's delta pill and its strip contradict each other.
const folderOf = (r) => (typeof r.folder === 'string' && r.folder ? r.folder : null);

// "Was this piece already done a week ago?", keyed on identity.
//
// Falls back to matching by NAME when last week's roster is not fully
// folder-keyed. That is not a preference, it is a bridge: the AI-actions roster
// identifies a piece by SLUG in `name`, which already is stable and unique, and
// every snapshot written before `folder` existed is name-keyed — comparing this
// week's folders against those rows would find nothing in common and report the
// whole finished backlog as one week's work. When in doubt this errs toward
// "already done", because the one rule this page has is never to overstate a
// week.
export function alreadyDone(priorDone) {
  const folders = new Set(priorDone.map(folderOf).filter(Boolean));
  const names = new Set(priorDone.map((r) => r.name));
  const keyedByFolder = priorDone.length > 0 && folders.size === priorDone.length;
  return (r) => (keyedByFolder && folderOf(r) ? folders.has(folderOf(r)) : names.has(r.name));
}

// Null when there is nothing honest to diff: this week recorded no roster, or
// there is no legitimate prior roster (first week, a gap, an empty or degraded
// prior — see priorRoster). The targets render null as "not measured"; the
// pieces strip falls back to "Done in total". An empty array is a real answer,
// a week that finished nothing.
//
// `filter` copies: the collector's ordering is preserved and the snapshot's own
// roster is never sorted in place.
export function landedRows(weeks, selected, key, isDone) {
  const rows = selected?.[key]?.roster;
  if (!Array.isArray(rows)) return null;
  const prior = priorRoster(weeks, selected, key);
  if (!prior) return null;
  const before = alreadyDone(prior.filter(isDone));
  return rows.filter(isDone).filter((r) => !before(r));
}
