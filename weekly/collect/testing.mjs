// weekly/collect/testing.mjs
// Progress on Sanket's piece-tester-web. Reports BUILD progress (PRs merged,
// commits) — not piece health. Run results live in a local SQLite DB that the
// repo's export script does not dump, so pass/fail counts are not reachable
// yet; unlocking them needs a stats endpoint or a committed health.json.
export const REPO = 'ibrahim-abuznaid/piece-tester-web';
export const TESTING_NOTE = 'Build progress only — piece health numbers need a stats endpoint on piece-tester-web.';

const dayOf = (iso) => String(iso).slice(0, 10);
const inWindow = (iso, { start, end }) => {
  const d = dayOf(iso);
  return Boolean(iso) && d >= start && d <= end;
};

export function collectTesting({ window, gh }) {
  try {
    const prs = JSON.parse(gh(['pr', 'list', '--repo', REPO, '--state', 'merged',
      '--limit', '100', '--json', 'number,title,mergedAt,url']));
    const merged = prs.filter((pr) => inWindow(pr.mergedAt, window));
    const commits = JSON.parse(gh(['api',
      `repos/${REPO}/commits?since=${window.start}T00:00:00Z&until=${window.end}T23:59:59Z&per_page=100`]));
    return {
      status: 'ok',
      prsMerged: merged.length,
      commits: Array.isArray(commits) ? commits.length : 0,
      shipped: merged.map(({ number, title, url }) => ({ number, title, url })),
    };
  } catch (err) {
    return { status: 'no-data', reason: `piece-tester-web unreachable (${err.message})` };
  }
}
