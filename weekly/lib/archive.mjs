// weekly/lib/archive.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const WEEK_RE = /^\d{4}-W\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Numeric fields every `status: 'ok'` workstream must carry. Absence is an
// error; zero is not — a silent 0 is exactly what the no-data path exists to
// prevent, so a genuine 0 has to be distinguishable from a missing field.
const REQUIRED = {
  outputSchema: ['live', 'mergedNotLive', 'review', 'todo', 'totalPieces'],
  aiActions: ['merged', 'prOpen', 'assigned', 'held', 'totalPieces', 'blockersOpen'],
  testing: ['prsMerged', 'commits'],
  tickets: ['total'],
};

// The three optional string fields a roster row may carry. All three are optional
// for the same reason as `roster` itself — rows written before each field existed
// must keep validating — and each is rejected rather than coerced when present,
// because each one reaches the page: as an `<img src>`, as the chip's name, or as
// the key that decides which pieces get claimed for this week.
//
// `nullable` is the difference between them, and it tracks what a null MEANS:
//
// · `logo` and `displayName` are DECORATION resolved per row from the catalog, and
//   `null` is a recorded answer — "the catalog had none for this piece" — in
//   preference to guessing. Both degrade visibly and harmlessly (no image; the
//   slug), so tolerating it costs a chip its polish and never the week's snapshot.
// · `folder` is the piece's directory: the catalog's own key and the identity the
//   "done this week" diff is computed on. Absence already says "not recorded" and
//   the diff falls back to the name for that row, so a null spells nothing new —
//   while junk in it would quietly change which pieces the page claims.
function optionalString(at, field, value, { nullable }) {
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== 'string' || !value) {
    throw new Error(`${at}.${field} must be a non-empty string${nullable ? ' or null' : ''} when present, got ${
      value === null ? 'null' : typeof value === 'string' ? 'an empty string' : typeof value}`);
  }
}

// `roster` is the optional per-piece detail a workstream may carry. It is
// OPTIONAL on purpose: snapshots taken before the field existed must keep
// validating, so absence is fine — but a present roster has to be usable by the
// renderer, which means every row needs a label and a count.
function validateRoster(key, ws) {
  if (ws.roster === undefined) return;
  if (!Array.isArray(ws.roster)) throw new Error(`${key}.roster must be an array, got ${typeof ws.roster}`);
  ws.roster.forEach((row, i) => {
    const at = `${key}.roster[${i}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${at} must be an object`);
    if (typeof row.name !== 'string' || !row.name) throw new Error(`${at}.name must be a non-empty string`);
    if (typeof row.actions !== 'number') throw new Error(`${at}.actions must be a number`);
    optionalString(at, 'folder', row.folder, { nullable: false });
    optionalString(at, 'logo', row.logo, { nullable: true });
    // `name` is the row's identity — a display name is what the reader is SHOWN,
    // so it rides alongside rather than replacing it. The AI-actions roster puts a
    // slug in `name` and the catalog's editorial name here.
    optionalString(at, 'displayName', row.displayName, { nullable: true });
  });
}

// `catalogPieces` is the whole-catalog denominator a workstream may record
// alongside its own tracked count. OPTIONAL for the same reason as `roster`:
// snapshots written before it existed must keep validating. When it IS present
// the page divides by it, so a string or a null has to fail here rather than
// render as "of undefined pieces".
function validateCatalogPieces(key, ws) {
  if (ws.catalogPieces === undefined) return;
  if (typeof ws.catalogPieces !== 'number') {
    throw new Error(`${key}.catalogPieces must be a number when present, got ${
      ws.catalogPieces === null ? 'null' : typeof ws.catalogPieces}`);
  }
}

export function validateSnapshot(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('snapshot must be an object');
  if (!WEEK_RE.test(snap.week ?? '')) throw new Error(`bad week id: ${snap.week}`);
  for (const f of ['start', 'end', 'builtAt']) {
    if (!DATE_RE.test(snap[f] ?? '')) throw new Error(`${f} must be YYYY-MM-DD, got ${snap[f]}`);
  }
  if (!Array.isArray(snap.decisions) || snap.decisions.some((d) => typeof d !== 'string')) {
    throw new Error('decisions must be an array of strings');
  }
  for (const [key, fields] of Object.entries(REQUIRED)) {
    const ws = snap[key];
    if (!ws || typeof ws !== 'object') throw new Error(`missing workstream: ${key}`);
    validateRoster(key, ws);
    validateCatalogPieces(key, ws);
    if (ws.status === 'no-data') {
      if (typeof ws.reason !== 'string' || !ws.reason) throw new Error(`${key}: no-data needs a reason`);
      continue;
    }
    if (ws.status !== 'ok') throw new Error(`${key}: status must be "ok" or "no-data", got ${ws.status}`);
    for (const f of fields) {
      if (typeof ws[f] !== 'number') throw new Error(`${key}.${f} must be a number`);
    }
  }
}

export function appendWeek(archive, snap, { force = false } = {}) {
  validateSnapshot(snap);
  const weeks = [...(archive?.weeks ?? [])];
  const at = weeks.findIndex((w) => w.week === snap.week);
  if (at !== -1 && !force) throw new Error(`${snap.week} already exists — pass --force-week to replace it`);
  if (at !== -1) weeks[at] = snap;
  else weeks.push(snap);
  weeks.sort((a, b) => a.week.localeCompare(b.week));
  return { ...archive, weeks };
}

export function readArchive(path) {
  if (!existsSync(path)) return { weeks: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  // A corrupt or hand-edited archive must surface as empty here rather than as
  // a TypeError three call frames later in the renderer.
  return { ...parsed, weeks: Array.isArray(parsed?.weeks) ? parsed.weeks : [] };
}

export function writeArchive(path, archive) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`);
}
