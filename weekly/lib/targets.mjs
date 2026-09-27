// weekly/lib/targets.mjs
// Per-person weekly targets: what the lead expects of each person in the tile
// that measures it, and what each person actually did that week.
//
// The targets are curated in weekly/data/targets.json and COPIED into each
// snapshot from `from` on (weekly/snapshot.mjs). The archive keeps the targets
// in force that week, so a later change never rewrites history, and no week
// before `from` can show a miss against a target that did not exist yet.
import { PEOPLE, personOf, displayName } from '../collect/people.mjs';
import { landedRows } from './landed.mjs';

// The four tiles a target can sit in, by archive key. Anything else is a typo,
// and a typo here silently drops a person's row from the page — so it throws.
export const TARGET_KEYS = ['aiActions', 'uiImprovements', 'testing', 'tickets'];

const WEEK_RE = /^\d{4}-W\d{2}$/;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// `roster` is who a person key may name. The file boundary checks it against
// today's team; the archive passes null, because a past week keeps the names
// its targets were set with — someone leaving the team must not turn every
// week that named them invalid. With no roster only the shape is checked.
export function validateTargets(targets, at = 'targets', { roster = PEOPLE } = {}) {
  if (!isObject(targets)) throw new Error(`${at} must be an object`);
  for (const [key, byPerson] of Object.entries(targets)) {
    if (!TARGET_KEYS.includes(key)) {
      throw new Error(`${at}.${key}: no such workstream — use one of ${TARGET_KEYS.join(', ')}`);
    }
    if (!isObject(byPerson)) throw new Error(`${at}.${key} must be an object of person → target`);
    for (const [person, n] of Object.entries(byPerson)) {
      if (!person) throw new Error(`${at}.${key} has an empty person key`);
      if (Array.isArray(roster) && !roster.includes(person)) {
        throw new Error(`${at}.${key}.${person}: not on the team roster (${roster.join(', ')})`);
      }
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${at}.${key}.${person} must be a positive integer, got ${JSON.stringify(n)}`);
      }
    }
  }
}

export function validateTargetsFile(file) {
  if (!isObject(file)) throw new Error('targets.json must be an object');
  if (!WEEK_RE.test(file.from ?? '')) {
    throw new Error(`targets.json from must be YYYY-Wnn, got ${JSON.stringify(file.from)}`);
  }
  validateTargets(file.targets, 'targets.json targets');
}

// Week ids are zero-padded `YYYY-Wnn`, so string order is week order.
export function targetsForWeek(file, weekId) {
  return file && weekId >= file.from ? structuredClone(file.targets) : null;
}

// ── what each person actually did ───────────────────────────────────────────
// A per-person map is only usable when it is all numbers AND adds up to the
// total it sits under — the check the tickets tile's name line has always made
// (view.mjs personLine now calls this). A map that disagrees with its own total
// is not a measurement.
export function checkedByPerson(byPerson, total) {
  const entries = Object.entries(byPerson ?? {});
  if (!entries.length) return null;
  if (entries.some(([, n]) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  if (entries.reduce((sum, [, n]) => sum + n, 0) !== total) return null;
  return Object.fromEntries(entries);
}

// Credit for a piece that crossed the line this week. The rollouts credit the
// PR author the build resolved (lib/credit.mjs) — a login off the team is
// "others", no login is "not credited", never a guess. The tester is Sanket's
// project and piece-tester-web records no per-plan author, so every piece it
// newly covers is his.
const OTHERS = 'others';
const UNCREDITED = 'uncredited';
const byAuthor = (r) => (typeof r.author === 'string' && r.author ? (personOf(r.author) ?? OTHERS) : UNCREDITED);
const CREDIT = { aiActions: byAuthor, uiImprovements: byAuthor, testing: () => 'sanket' };

// Counts per credit key, or null when the week cannot be measured. Pieces use
// the tile's own "done this week" diff (landed.mjs). On the rollout tiles that
// makes the per-person numbers plus the "also" line exactly the strip's pieces;
// the testing tile runs the same diff, but its strip shows the cumulative
// coverage instead. `spec.done` absent means every roster row is done — the
// tester's roster lists only covered pieces.
//
// A rollout roster that is EMPTY this week is not measured. The collectors
// (weekly/collect/ai-actions.mjs) return `roster: []` with status ok when
// pieces.json is lost or one row is malformed, so "[]" there is a broken
// reading, and every target would draw it as 0. priorRoster already refuses an
// empty PRIOR roster for the same reason. The tester's empty roster is a real
// reading — nothing covered — so testing keeps it.
//
// Known limit: the diff only compares against the week before. A piece whose
// approval is withdrawn (approved → pr-open → merged) is done, then not, then
// done again, and counts for its author in both weeks it crossed the line.
function countsFor(spec, ws, weeks, selected) {
  if (spec.key === 'tickets') return checkedByPerson(ws.byPerson, ws.total);
  const credit = CREDIT[spec.key];
  if (!credit) return null;
  if (spec.done && Array.isArray(ws.roster) && !ws.roster.length) return null;
  const isDone = spec.done ? (r) => spec.done.includes(r.stage) : () => true;
  const landed = landedRows(weeks, selected, spec.key, isDone);
  if (!landed) return null;
  const counts = {};
  for (const r of landed) {
    const who = credit(r);
    counts[who] = (counts[who] ?? 0) + 1;
  }
  return counts;
}

// Everything a target row does not show, so nothing done this week is hidden:
// team members without a target here, then people off the team, then pieces
// no author could be found for.
function alsoLine(counts, goals) {
  const parts = PEOPLE.filter((p) => !(p in goals) && counts[p] > 0).map((p) => `${displayName(p)} ${counts[p]}`);
  if (counts[OTHERS] > 0) parts.push(`${counts[OTHERS]} ${counts[OTHERS] === 1 ? 'other' : 'others'}`);
  if (counts[UNCREDITED] > 0) parts.push(`${counts[UNCREDITED]} not credited`);
  return parts.join(' · ');
}

// The target block for one tile, or null when the week set none for it or the
// tile is degraded (it already says "not measured this week"). Rows follow
// targets.json order. `actual` is null — "not measured" — whenever the counts
// are; the template never draws that as 0.
export function targetsFor(spec, weeks, selected) {
  const goals = selected?.targets?.[spec.key];
  if (!goals || !Object.keys(goals).length) return null;
  const ws = selected[spec.ws ?? spec.key];
  if (ws?.status !== 'ok') return null;
  const counts = countsFor(spec, ws, weeks, selected);
  const rows = Object.entries(goals).map(([person, target]) => {
    const actual = counts ? (counts[person] ?? 0) : null;
    return { person, name: displayName(person), actual, target, hit: actual !== null && actual >= target };
  });
  return { rows, also: counts ? alsoLine(counts, goals) : '' };
}
