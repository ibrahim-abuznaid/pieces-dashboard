// weekly/lib/targets.mjs
// Per-person weekly targets: what the lead expects of each person in the tile
// that measures it, and — Task 4 — what they actually did.
//
// The targets are curated in weekly/data/targets.json and COPIED into each
// snapshot from `from` on (weekly/snapshot.mjs). The archive keeps the targets
// in force that week, so a later change never rewrites history, and no week
// before `from` can show a miss against a target that did not exist yet.
import { PEOPLE } from '../collect/people.mjs';

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
