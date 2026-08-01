#!/usr/bin/env bash
# refresh-weekly.sh — the single Saturday job (09:00 +03).
#
# Order matters: the tickets collector reads the internal dashboard's data
# files, and the outputSchema/AI-actions collectors read dist/, which is
# gitignored and therefore absent until a local build runs.
set -euo pipefail

# cron gives us /usr/bin:/bin, but node/npm are nvm-installed and gh may not be
# on the default path either. Match what the internal refresh.sh and the other
# crontab entries already do rather than relying on the cron line to set it.
export PATH="/home/ibrahim/.nvm/versions/node/v24.14.0/bin:/home/ibrahim/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="${HOME:-/home/ibrahim}"

DASHBOARD="${PIECES_TEAM_DASHBOARD:-/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODAY="$(date +%F)"

log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { log "ERROR line $1 — aborting"; }
trap 'fail "$LINENO"' ERR

cd "$REPO"

for cmd in node npm git gh; do
  command -v "$cmd" >/dev/null || { log "ERROR $cmd not on PATH"; exit 1; }
done

# Deploy only fires on pushes to main (plus the daily schedule), so a snapshot
# committed anywhere else would never render.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  log "ERROR on branch '$BRANCH', not main — a snapshot pushed here would never deploy"
  exit 1
fi

# Cheapest check first. Re-running the job in the same week is a normal
# outcome, not a failure: without this guard a re-run burns the internal
# refresh plus a ~3-minute fetch before discovering it has nothing to do,
# and exits non-zero so cron mails it as an error.
WEEK="$(node -e 'import("./lib/isoweek.mjs").then(m=>console.log(m.latestCompleteWeek(process.argv[1])))' "$TODAY")"
if node -e 'const{readArchive}=await import("./weekly/lib/archive.mjs");process.exit(readArchive("weekly/data/weeks.json").weeks.some(w=>w.week===process.argv[1])?0:1)' "$WEEK"; then
  log "$WEEK already snapshotted — nothing to do (use --force-week deliberately to replace it)"
  exit 0
fi

log "1/4 internal dashboard refresh (Linear + GitHub) — see $DASHBOARD/refresh.log for its output"
# Non-fatal. Note refresh.sh does NOT run the Linear half (the MCP is
# interactive-only); it writes NEEDS-LINEAR-REFRESH whenever the Linear data is
# stale. Either way the tickets collector degrades to no-data rather than
# reporting a false zero — including when the data simply predates this week.
bash "$DASHBOARD/refresh.sh" || log "WARN internal refresh failed — tickets will degrade to no-data"

log "2/4 fetch + build this repo (populates dist/*/summary.json)"
npm run fetch
npm run build

log "3/4 append $WEEK"
node weekly/snapshot.mjs --today="$TODAY"

log "4/4 commit + push (CI renders and deploys)"
# HEAD, not the bare form: a prior run that died between add and commit leaves
# the change staged, where `git diff --quiet` reports no change and the week
# would go unpublished.
if git diff --quiet HEAD -- weekly/data/weeks.json; then
  log "no archive change — nothing to push"
else
  git add weekly/data/weeks.json
  git commit -m "chore(weekly): snapshot $WEEK"
  git push
  log "pushed $WEEK — GitHub Pages deploy will pick it up"
fi

log "done"
