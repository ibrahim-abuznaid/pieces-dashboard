// weekly/collect/testing.mjs
// Progress on Sanket's piece-tester-web: BUILD progress (PRs merged, commits)
// always, and — when the running tester itself is reachable — which pieces the
// project COVERS, read from its /api/coverage endpoint.
//
// Coverage needs the live server because run state lives in its local SQLite
// DB; the repo's committed export is a one-off migration dump, months stale by
// now, and publishing it as "covered" would date the page without saying so.
// The server's address is deployment detail that must not live in a public
// repo, so it arrives via PIECE_TESTER_URL — set where snapshots are taken
// (they only ever run locally; see snapshot.mjs). Unset means the coverage
// half of this collector is simply off, and the tile reports build progress
// exactly as before.
export const REPO = 'ibrahim-abuznaid/piece-tester-web';

const dayOf = (iso) => String(iso).slice(0, 10);
const inWindow = (iso, { start, end }) => {
  const d = dayOf(iso);
  return Boolean(iso) && d >= start && d <= end;
};

// '@activepieces/piece-google-sheets' → 'google-sheets': the catalog folder
// name, which is the identity convention the other rosters already use.
const slugOf = (pieceName) => String(pieceName).replace(/^@activepieces\/piece-/, '');

const orNull = (v) => (typeof v === 'string' && v ? v : null);

// Covered = the piece has at least one test plan written for it. The cockpit's
// own `covered` flag means "enrolled in an enabled schedule", but one legacy
// wildcard schedule sets it on the entire catalog at once — a page reporting
// "720 covered" off the back of that would be the overstatement this dashboard
// exists to avoid. Plans are per-piece work someone actually did.
function coverageFrom(raw) {
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('coverage endpoint did not return an array');
  const covered = rows
    .filter((r) => typeof r?.piece_name === 'string' && r.piece_name && Number(r.plan_count) > 0)
    .sort((a, b) => Number(b.plan_count) - Number(a.plan_count));
  return {
    catalogPieces: rows.length,
    roster: covered.map((r) => ({
      name: slugOf(r.piece_name),
      folder: slugOf(r.piece_name),
      displayName: orNull(r.display_name),
      logo: orNull(r.logo_url),
      actions: Number(r.plan_count),
      stage: 'covered',
    })),
  };
}

export function collectTesting({ window, gh, curl, testerUrl }) {
  let base;
  try {
    const prs = JSON.parse(gh(['pr', 'list', '--repo', REPO, '--state', 'merged',
      '--limit', '100', '--json', 'number,title,mergedAt,url']));
    const merged = prs.filter((pr) => inWindow(pr.mergedAt, window));
    const commits = JSON.parse(gh(['api',
      `repos/${REPO}/commits?since=${window.start}T00:00:00Z&until=${window.end}T23:59:59Z&per_page=100`]));
    base = {
      status: 'ok',
      prsMerged: merged.length,
      commits: Array.isArray(commits) ? commits.length : 0,
      shipped: merged.map(({ number, title, url }) => ({ number, title, url })),
    };
  } catch (err) {
    return { status: 'no-data', reason: `piece-tester-web unreachable (${err.message})` };
  }

  if (!testerUrl || !curl) return base;
  try {
    return { ...base, ...coverageFrom(curl(`${testerUrl.replace(/\/$/, '')}/api/coverage`)) };
  } catch (err) {
    // Coverage degrades ALONE: PRs and commits were measured, so the workstream
    // stays ok and the miss is recorded where the operator looks — the snapshot
    // itself (committed) and snapshot.mjs's warning line, not the page.
    return { ...base, coverageError: `coverage unreachable (${err.message})` };
  }
}
