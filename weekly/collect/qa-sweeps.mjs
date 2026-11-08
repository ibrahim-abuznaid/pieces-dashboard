// weekly/collect/qa-sweeps.mjs
// The QA sweeps: the bug tickets the automated QA sweeps file in Linear, and
// how far the Pieces team has worked through them.
//
// Linked to Linear by KEYWORD, not by project id. Every Linear project whose
// name contains "qa" is a sweep (Ibrahim, 2026-11-08: "there will be another
// project with qa in the name, use it as a keyword"), so the next sweep lands
// on the page without an edit here. The internal dashboard's refresh-qa.sh
// does the lookup — list_projects, then list_issues per project, through the
// headless-Claude road the tickets tile already rides — and writes
// dashboard/data/qa.json after validate-qa.mjs has accepted it. As with
// tickets.mjs: one Linear pipeline, not two, and this file does no I/O of its
// own beyond reading that one JSON.
//
// SCOPE is the Pieces team's tickets: team "Pieces", or assigned to someone on
// the roster. Three of the four sweeps today are Engineering projects whose
// tickets are not this team's work (604 tickets in all, 149 in scope,
// 2026-11-08). The fetch already keeps only these; the rule is applied again
// here because this is the module a test can hold to it.
//
// Two readings of the same tickets. The LIVE reading classifies by the board
// — fixed / in review / in progress / open / canceled — and records the
// assignment, which is what the per-person rows need. The DATES-ONLY reading
// (`asOf`) says only what a ticket's createdAt / completedAt / canceledAt
// decide, and claims no board state: it is how the weeks before this tile
// existed are restated (scripts/backfill-qa-sweeps.mjs), on the same rule as
// the UI-improvements and connection-identifier backfills. A block that lacks
// `open` is a dates-only block, and the view draws no queue and no bars for it.
//
// Null, never 0, for anything unmeasured: a missing file, a stale one, or a
// malformed row is a no-data week.
import { PEOPLE } from './people.mjs';

const LINEAR_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Linear's state types, as validate-qa.mjs admits them. `duplicate` is its own
// type; it is closed-without-a-fix, like canceled.
const OPEN_TYPES = ['triage', 'backlog', 'unstarted'];
const CLOSED_TYPES = ['canceled', 'duplicate'];

// A ticket's state on the board today. Started is split on the status NAME,
// because "In Review" is the queue the lead watches; Blocked and every other
// started state read as in progress.
function liveState(t) {
  if (t.statusType === 'completed') return 'fixed';
  if (CLOSED_TYPES.includes(t.statusType)) return 'canceled';
  if (t.statusType === 'started') return t.status === 'In Review' ? 'inReview' : 'inProgress';
  if (OPEN_TYPES.includes(t.statusType)) return 'open';
  throw new Error(`${t.id}: unknown statusType ${JSON.stringify(t.statusType)}`);
}

// What the dates decide as of a day: fixed from completedAt, canceled from
// canceledAt (the later event wins when both are set), otherwise merely
// existing — `null`, because the board state on a past day is not knowable.
// A ticket created after the day did not exist yet.
function dateState(t, asOf) {
  if (t.createdAt > asOf) return undefined;
  const fixedAt = isDate(t.completedAt) && t.completedAt <= asOf ? t.completedAt : null;
  const closedAt = isDate(t.canceledAt) && t.canceledAt <= asOf ? t.canceledAt : null;
  if (fixedAt && (!closedAt || fixedAt >= closedAt)) return 'fixed';
  if (closedAt) return 'canceled';
  return null;
}

function checkTicket(t) {
  if (!isObject(t)) throw new Error('a ticket row is not an object');
  if (typeof t.id !== 'string' || !LINEAR_ID.test(t.id)) throw new Error(`ticket id ${JSON.stringify(t.id)} is not a Linear id`);
  if (typeof t.project !== 'string' || !t.project) throw new Error(`${t.id}: no project`);
  if (typeof t.team !== 'string' || !t.team) throw new Error(`${t.id}: no team`);
  if (!(t.assignee === null || t.assignee === 'other' || PEOPLE.includes(t.assignee))) {
    throw new Error(`${t.id}: assignee ${JSON.stringify(t.assignee)} is not a roster key, "other" or null`);
  }
  if (!isDate(t.createdAt)) throw new Error(`${t.id}: createdAt is not a date`);
  if (t.completedAt !== null && !isDate(t.completedAt)) throw new Error(`${t.id}: completedAt is neither a date nor null`);
  if (t.canceledAt !== null && t.canceledAt !== undefined && !isDate(t.canceledAt)) throw new Error(`${t.id}: canceledAt is neither a date nor null`);
}

const inScope = (t) => t.team === 'Pieces' || PEOPLE.includes(t.assignee);
const inWindow = (day, { start, end }) => isDate(day) && day >= start && day <= end;

// Who a ticket counts for: a roster key, `others` for a login off the team,
// `unassigned` for none. Every ticket lands in exactly one, so the three add
// up to the totals and the archive can check that they do.
const whose = (t) => (PEOPLE.includes(t.assignee) ? t.assignee : t.assignee === 'other' ? 'others' : 'unassigned');

// Id order a reader expects: by number within a key, so PIE-892 precedes
// PIE-1017 — plain string order would not.
const byIdNumber = (a, b) => {
  const [ka, na] = [a.slice(0, a.lastIndexOf('-')), Number(a.slice(a.lastIndexOf('-') + 1))];
  const [kb, nb] = [b.slice(0, b.lastIndexOf('-')), Number(b.slice(b.lastIndexOf('-') + 1))];
  return ka.localeCompare(kb) || na - nb;
};

// PURE. `qa` is the parsed qa.json; `window` the Sat→Fri week; `asOf` a
// YYYY-MM-DD for the dates-only reading, or null for the live one.
export function qaSweepsForWindow(qa, window, { asOf = null } = {}) {
  if (!isObject(qa)) throw new Error('qa.json is not an object');
  if (!Array.isArray(qa.projects)) throw new Error('qa.json has no `projects` array');
  if (!Array.isArray(qa.tickets)) throw new Error('qa.json has no `tickets` array');
  if (!isDate(qa.stamp)) throw new Error('qa.json carries no `stamp` date');
  if (asOf !== null && !isDate(asOf)) throw new Error(`asOf must be YYYY-MM-DD, got ${JSON.stringify(asOf)}`);
  if (asOf !== null && qa.stamp < asOf) throw new Error(`qa.json is stamped ${qa.stamp}, before the day asked for (${asOf})`);
  const live = asOf === null;

  const projects = new Map();
  for (const p of qa.projects) {
    if (!isObject(p) || typeof p.id !== 'string' || !p.id) throw new Error('a project row has no id');
    if (typeof p.name !== 'string' || !p.name) throw new Error(`${p.id}: no name`);
    const row = { id: p.id, name: p.name, total: 0, fixed: 0, fixedThisWeek: 0 };
    if (typeof p.url === 'string' && /^https:\/\//.test(p.url)) row.url = p.url;
    if (live) Object.assign(row, { inReview: 0, inProgress: 0, open: 0 });
    projects.set(p.id, row);
  }

  const person = () => (live
    ? { assigned: 0, fixed: 0, fixedThisWeek: 0, inReview: 0, inProgress: 0 }
    : { fixed: 0, fixedThisWeek: 0 });
  const byPerson = Object.fromEntries(PEOPLE.map((p) => [p, person()]));
  const others = person();
  const unassigned = person();
  const bucketOf = (t) => (whose(t) === 'others' ? others : whose(t) === 'unassigned' ? unassigned : byPerson[whose(t)]);

  const out = { status: 'ok', total: 0, fixed: 0, fixedThisWeek: 0 };
  if (live) Object.assign(out, { inReview: 0, inProgress: 0, open: 0, canceled: 0 });
  const fixedIds = [];

  for (const t of qa.tickets) {
    checkTicket(t);
    if (!inScope(t)) continue;
    const project = projects.get(t.project);
    if (!project) throw new Error(`${t.id}: project ${t.project} is not in qa.json's projects`);
    const state = live ? liveState(t) : dateState(t, asOf);
    if (state === undefined) continue;                 // not created yet, as of that day
    if (state === 'canceled') { if (live) out.canceled += 1; continue; }
    const who = bucketOf(t);
    out.total += 1; project.total += 1;
    if (live) who.assigned += 1;
    if (state === 'fixed') {
      out.fixed += 1; project.fixed += 1; who.fixed += 1;
      if (inWindow(t.completedAt, window)) {
        out.fixedThisWeek += 1; project.fixedThisWeek += 1; who.fixedThisWeek += 1;
        fixedIds.push(t.id);
      }
    } else if (live && state === 'inReview') {
      out.inReview += 1; project.inReview += 1; who.inReview += 1;
    } else if (live && state === 'inProgress') {
      out.inProgress += 1; project.inProgress += 1; who.inProgress += 1;
    } else if (live) {
      out.open += 1; project.open += 1;
    }
  }

  return {
    ...out,
    byPerson, others, unassigned,
    projects: [...projects.values()],
    fixedIds: fixedIds.sort(byIdNumber),
  };
}

export function collectQaSweeps({ window, readJson, qaRefreshPending }) {
  if (qaRefreshPending) {
    return { status: 'no-data', reason: 'QA refresh pending — internal dashboard wrote NEEDS-QA-REFRESH' };
  }
  try {
    const qa = readJson('qa.json');
    if (!isDate(qa?.stamp)) throw new Error('qa.json carries no `stamp` — cannot establish freshness');
    // Freshness gate, as on the tickets tile: a file that predates the week's
    // end would publish last week's board as this week's.
    if (qa.stamp < window.end) {
      return { status: 'no-data',
        reason: `qa.json only reaches ${qa.stamp}, but this week ends ${window.end} — needs a QA refresh` };
    }
    return qaSweepsForWindow(qa, window);
  } catch (err) {
    return { status: 'no-data', reason: `QA sweeps data unavailable (${err.message})` };
  }
}
