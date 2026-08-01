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
