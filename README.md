# Pieces Team — Dashboards

Live site: **https://ibrahim-abuznaid.github.io/pieces-dashboard/**

| Page | Tracks |
|---|---|
| [/](https://ibrahim-abuznaid.github.io/pieces-dashboard/) | Combined KPIs + stage funnels |
| [/output-schema/](https://ibrahim-abuznaid.github.io/pieces-dashboard/output-schema/) | `outputSchema` rollout across the published piece catalog (computed from the cloud API + upstream repo) |
| [/ai-actions/](https://ibrahim-abuznaid.github.io/pieces-dashboard/ai-actions/) | `audience:'ai'` agent-atomics coverage + blockers |
| [/weekly/](https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/) | One week of team progress across all four workstreams, with an archive of past weeks |

## How it stays fresh

Every push to `main` and a daily 06:00 UTC cron run [deploy.yml](.github/workflows/deploy.yml):
fetch live data (Activepieces cloud API, upstream repo tree, GitHub PR states) → tests → build → GitHub Pages.
**Generated files are never committed** — `dist/` is build output only.

## Weekly progress page

[/weekly/](https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/) shows one week of team progress
across the four workstreams. The counting window is the **7 days ending Friday** (Sat 00:00 → Fri 23:59 UTC).

Snapshots are appended **locally, never in CI**: the Saturday job runs `npm run snapshot`, which writes one
week into `weekly/data/weeks.json` — and that file **is** committed. CI only renders what is already
committed (`npm run build` → `dist/weekly/`); it runs daily, so a CI-computed snapshot would recompute and
rewrite past weeks every morning.

`weeks.json` is append-only and past weeks are immutable — re-snapshotting an existing week fails unless you
pass `--force-week`.

### Verification

Neither job ends at "I pushed it". After the push, `refresh-weekly.sh` waits for the **Refresh & deploy** run
for that exact commit (filtered by workflow name *and* SHA — "Claim bot" also runs here) and then reads the
live page back, so a red run or a deploy that never landed exits non-zero and cron mails it.

`verify-weekly.sh` is the same assertion on a **daily** cron, read-only: live page reachable and rendering,
its default week equal to the newest committed week, every archived week passing `validateSnapshot`, and the
newest snapshot no older than 8 days (a missed Saturday blanks the *following* week's deltas too). Run it any
time; `--url=` points it at another build. Schedule it well away from the Saturday 09:00 +03 job — a run
inside that window would see the new commit before the deploy finishes and report a false mismatch.

Both read the page the way a reader gets it: the DOM is built client-side from an embedded `const ARCHIVE`
blob, so grepping the served HTML for a week id proves nothing. `verify-weekly.mjs` parses that blob and
executes the page's scripts in a `node:vm` sandbox.

The page is written for a **project manager**: the week, four numbers, the pieces behind each number, and
anything that needs a decision. Engineering caveats are recorded here rather than on the page.

### Known limitation — piece testing is build progress, not piece health

The `Piece testing` number counts **merged PRs on `piece-tester-web`** (with commits collected alongside it).
It says nothing about how many pieces pass or fail. Run results live in a local SQLite DB that the repo's
export script does not dump, so pass/fail counts are not reachable yet: unlocking them needs a
**stats endpoint on `piece-tester-web`**, or a committed `health.json`. Until then do not read that box as
"pieces tested" — see `weekly/collect/testing.mjs`.

## Claiming work (the 3-stage model)

Stages are **derived, never hand-edited**: assignee only → `assigned` · open PR → `PR open` · merged PR → `merged`.
To claim a piece or record a PR you edit ONE json file and push — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Local dev

```bash
npm run fetch    # needs curl, jq, gh (authed); ~3 min
npm test
npm run build    # writes dist/ — open dist/index.html
```

## Layout

- `shared/theme.css` — one palette/light+dark theme, inlined into every page at build
- `lib/` — render + stage derivation (unit-tested)
- `scripts/` — data fetchers (also run in CI)
- `output-schema/`, `ai-actions/`, `site/` — one build.mjs + template.html each
- Manual state lives ONLY in `output-schema/overrides.json`, `ai-actions/overrides.json`, and the curated `ai-actions/{pieces,blockers}.json`

## Public-data policy

This repo is public. Never commit real names/locations, Linear ticket titles, bounty or velocity data, or secrets.
GitHub handles and bare `PIE-###` ids are the ceiling.
