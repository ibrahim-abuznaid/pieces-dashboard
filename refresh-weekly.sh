#!/usr/bin/env bash
# refresh-weekly.sh — the snapshot job. DAILY at 09:00 +03, not weekly.
#
# Daily because a week cannot be re-collected. Every collector here reads
# NOW-state, so a run that dies takes its week with it permanently -- which is
# exactly what happened to W35: the Saturday job started at 09:00:01, one
# unretried curl to the cloud catalog blipped six seconds later, `set -e` ended
# the run, and nothing ever tried again. One attempt per week meant one
# five-second network failure per week was enough to lose it.
#
# The guard below makes a re-run free (54ms to decide there is nothing to do),
# so six of every seven runs are no-ops and the seventh is the one that works.
# A week now survives any six consecutive failures instead of none.
#
# Order matters: the tickets collector reads the internal dashboard's data
# files, and the outputSchema/AI-actions collectors read dist/, which is
# gitignored and therefore absent until a local build runs.
#
# The job does not finish at the push. Steps 5 and 6 wait for CI and then read
# the live page back, so "the Saturday job succeeded" means a reader can see the
# week — not that a commit left this machine. verify-weekly.sh re-checks the
# same liveness daily.
set -euo pipefail

# cron gives us /usr/bin:/bin, but node/npm are nvm-installed and gh may not be
# on the default path either. Match what the internal refresh.sh and the other
# crontab entries already do rather than relying on the cron line to set it.
export PATH="/home/ibrahim/.nvm/versions/node/v24.14.0/bin:/home/ibrahim/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="${HOME:-/home/ibrahim}"

DASHBOARD="${PIECES_TEAM_DASHBOARD:-/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODAY="$(date +%F)"

# Local-only settings the snapshot needs but the repo must not carry:
# PIECE_TESTER_URL and PIECE_TESTER_PASSWORD. The tester's address is deployment
# detail and its password is a secret, and this repo is public. BOTH are needed
# for coverage — the tester mounts requireAuth in front of every /api route, so
# the URL alone buys a 401. Optional on purpose: without the file the coverage
# half of the testing collector is simply off and the snapshot still lands.
if [ -f "$REPO/.env.local" ]; then . "$REPO/.env.local"; fi

log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# Where a failure actually reaches Ibrahim.
#
# This used to be cron's exit code and nothing else, which on a laptop means
# local mail nobody has ever read. W35 died at 09:00:12 on a Saturday and the
# first anyone knew of it was a hole in the archive found three weeks later.
#
# Alicent is his assistant's local inbox; she triages within minutes. The CLI is
# the cron-safe door into it -- the MCP endpoint needs a bearer token and this
# script must not carry one.
#
# NEVER fatal, and never inside the ERR trap's blast radius: an alerting path
# that can itself abort the job is worse than no alerting at all. Absent binary,
# stopped daemon, bad argument -- all swallowed.
ALICENT="${ALICENT_BIN:-/home/ibrahim/AP_work/Activepieces_v/Alicent/.venv/bin/alicent}"
alert() {
  [ -x "$ALICENT" ] || return 0
  "$ALICENT" report --kind error --project pieces-dashboard --urgency high \
    --summary "$1" --body "${2:-}" >/dev/null 2>&1 || true
}

fail() {
  log "ERROR line $1 — aborting"
  alert "weekly snapshot aborted at line $1 (week ${WEEK:-unresolved})" \
    "refresh-weekly.sh died before publishing. Log: ${REPO:-.}/refresh-weekly.log — the job retries tomorrow; a week is only lost if every day until next Saturday also fails."
}
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
# SEALED, not merely complete: this job runs every day now, so it has to be
# right on a Friday too -- and `latestCompleteWeek` counts the current Friday as
# done, which would seal a week at 09:00 with a working day still to go in it.
WEEK="$(node -e 'import("./lib/isoweek.mjs").then(m=>console.log(m.latestSealedWeek(process.argv[1])))' "$TODAY")"
if node -e 'const{readArchive}=await import("./weekly/lib/archive.mjs");process.exit(readArchive("weekly/data/weeks.json").weeks.some(w=>w.week===process.argv[1])?0:1)' "$WEEK"; then
  log "$WEEK already snapshotted — nothing to do (use --force-week deliberately to replace it)"
  exit 0
fi

log "1/6 internal dashboard refresh (Linear + GitHub) — see $DASHBOARD/refresh.log for its output"
# Non-fatal, and slow: refresh.sh now runs BOTH halves over a window ending
# today — the GitHub half plus a headless-Claude Linear half — so budget ~15 min
# here, bounded by refresh-linear.sh's own 1800s cap. The Linear MCP turned out
# to be reachable headless; what blocked it was a missing --allowedTools grant,
# not connectivity.
#
# On any failure it fails closed: the previous data files are restored and
# NEEDS-LINEAR-REFRESH is written, so the tickets collector degrades to no-data
# rather than reporting a false zero — including when the data merely predates
# this week, which the old frozen window used to guarantee forever.
bash "$DASHBOARD/refresh.sh" || log "WARN internal refresh failed — tickets will degrade to no-data"

log "2/6 fetch + build this repo (populates dist/*/summary.json)"
npm run fetch
npm run build

log "3/6 append $WEEK"
node weekly/snapshot.mjs --today="$TODAY"

log "4/6 commit + push (CI renders and deploys)"
# HEAD, not the bare form: a prior run that died between add and commit leaves
# the change staged, where `git diff --quiet` reports no change and the week
# would go unpublished.
if git diff --quiet HEAD -- weekly/data/weeks.json; then
  # Nothing was pushed, so there is no run to wait for and no new week to see on
  # the live page. verify-weekly.sh checks liveness daily anyway.
  log "no archive change — nothing to push"
  log "✓ $WEEK needed no change — nothing published"
  exit 0
fi

git add weekly/data/weeks.json
git commit -m "chore(weekly): snapshot $WEEK"
git push
SHA="$(git rev-parse HEAD)"
log "pushed $WEEK as $SHA"

# Everything above this line is the job doing its work; everything below is the
# job proving the work landed. The push used to be the last step, which meant a
# red CI run or a Pages deploy that never happened looked exactly like success.
#
# `|| exit 1` rather than letting the ERR trap fire: each mode already prints its
# own verdict line with the run URL, and the trap's "ERROR line N" would land
# after it and bury the one line that says what happened.
log "5/6 waiting for the 'Refresh & deploy' run for $SHA"
# `|| ...` handles the failure, so the ERR trap does NOT fire here and these two
# steps would otherwise exit in silence -- the half of the job that exists
# purely to prove the work landed, failing invisibly.
node verify-weekly.mjs --await-run="$SHA" || {
  alert "$WEEK pushed but CI did not go green" "Commit $SHA is on main and the archive has the week, but the deploy run failed. The page is serving the previous build."
  exit 1
}

# CI green is not the same as published: the run can succeed while Pages serves
# the previous build for a little longer, and only the live page can settle
# whether a reader would see this week. --live retries for that lag.
log "6/6 asserting the live page serves $WEEK"
node verify-weekly.mjs --live="$WEEK" || {
  alert "$WEEK is committed and CI is green, but the live page does not serve it" "Pages deployed something other than $SHA, or is still serving a cached build. Check https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/"
  exit 1
}
