#!/usr/bin/env bash
# refresh-weekly.sh — the snapshot job. Cron runs it at 09:00, 13:00, 17:00 and
# 21:00 +03 every day, not weekly.
#
# Often because a week cannot be re-collected. Every collector here reads
# NOW-state, so a run that dies takes its week with it permanently -- which is
# exactly what happened to W35: the Saturday job started at 09:00:01, one
# unretried curl to the cloud catalog blipped six seconds later, `set -e` ended
# the run, and nothing ever tried again. One attempt per week meant one
# five-second network failure per week was enough to lose it.
#
# The guard below makes a re-run free (54ms to decide there is nothing to do),
# so almost every run is a no-op. It has three answers, not two: a week that is
# missing is collected, a week that is complete is left alone, and a week that
# was archived with a no-data tile is collected AGAIN and replaced only if the
# retry is strictly better (snapshot.mjs --heal). Asking only "is the week in
# weeks.json?" sealed W33, W41 and W42 with tiles missing; nothing retried them.
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
# Alicent is his assistant. The CLI is the cron-safe door into her -- the MCP
# endpoint needs a bearer token and this script must not carry one. `report`
# files the row in her inbox for the record; `notify` is what reaches him: it
# posts to his Discord webhook (desktop or outbox as fallbacks) and holds the
# message through quiet hours. Report alone was not enough: W42's two alerts
# sat unread in the inbox among dozens of rows while the page stayed broken.
#
# NEVER fatal, and never inside the ERR trap's blast radius: an alerting path
# that can itself abort the job is worse than no alerting at all. Absent binary,
# stopped daemon, bad argument -- all swallowed.
ALICENT="${ALICENT_BIN:-/home/ibrahim/AP_work/Activepieces_v/Alicent/.venv/bin/alicent}"
ALICENT_HOME="${ALICENT_HOME:-/home/ibrahim/AP_work/Activepieces_v/Alicent}"
tell() {
  [ -x "$ALICENT" ] || return 0
  ALICENT_HOME="$ALICENT_HOME" "$ALICENT" notify --kind alert --urgency critical \
    "pieces weekly page: $1" "${2:-}" >/dev/null 2>&1 || true
}
alert() {
  tell "$1" "${2:-}"
  [ -x "$ALICENT" ] || return 0
  "$ALICENT" report --kind error --project pieces-dashboard --urgency high \
    --summary "$1" --body "${2:-}" >/dev/null 2>&1 || true
}

# For a week that stays degraded: every run until it heals would say the same
# thing, and the cause is usually one only a person can clear (a login), so one
# message a day per week is enough.
alert_once_today() {
  local dir="$HOME/.cache/pieces-dashboard"
  local stamp="$dir/degraded-alert-$WEEK-$TODAY"
  [ -e "$stamp" ] && return 0
  { mkdir -p "$dir" && touch "$stamp"; } >/dev/null 2>&1 || true
  alert "$1" "${2:-}"
}

fail() {
  log "ERROR line $1 — aborting"
  alert "weekly snapshot aborted at line $1 (week ${WEEK:-unresolved})" \
    "refresh-weekly.sh died before publishing. Log: ${REPO:-.}/refresh-weekly.log — the job retries at its next run (09/13/17/21h); a week is only lost if every run until next Saturday also fails."
}

# What the internal refresh died of, in words that say what to do. The detail
# is in refresh.log; this reads only the current run (after its start banner)
# so an old failure can't be reported as today's. A headless-Claude login is
# the one cause no retry can fix, so it is named first.
internal_failure() {
  local run
  run="$(awk '/weekly full refresh start/{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "$DASHBOARD/refresh.log" 2>/dev/null || true)"
  case "$run" in
    *"OAuth session expired"*|*"Failed to authenticate"*|*"Please run /login"*)
      echo "headless Claude is logged out, so the Linear half failed. Run \`claude\` in a terminal and /login (or set up the long-lived token, see $DASHBOARD/REFRESH.md). The next run heals the week." ;;
    *"pull-github.mjs failed"*)
      echo "the GitHub half failed (GitHub API error or network). Usually transient; the next run retries." ;;
    *"refresh-linear.sh failed"*)
      echo "the Linear half failed (headless Claude or the Linear MCP). Detail: tail -80 $DASHBOARD/refresh.log" ;;
    *)
      echo "see $DASHBOARD/refresh.log" ;;
  esac
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

# The PRIVATE AI-actions report: the static audit's findings by piece, with
# file:line, and the rollout pieces that are stuck. The public page carries the
# counts; the names live only here, because a public list of agent actions
# that silently rewrite saved settings is not something this repo can publish.
#
# Once per ISO week (the stamp is written only on success, so a failed run is
# retried at the next 09/13/17/21h), and BEFORE the snapshot guard below, which
# exits early on most runs. It writes only to AI_AUDIT_PRIVATE_DIR, outside the
# repo -- fetch-ai-audit.mjs refuses a --private dir inside it -- so nothing it
# makes can be committed or pushed. Set AI_AUDIT_PRIVATE_DIR="" to turn it off.
#
# It must never cost the week. It runs as its own process, under a timeout, in
# a function called from `||`: errexit is off in there and the ERR trap does not
# fire, so every step is checked by hand and a failure is a WARN line, never an
# exit. ~2 min when it runs; a stamp check when it does not.
AI_AUDIT_PRIVATE_DIR="${AI_AUDIT_PRIVATE_DIR-/home/ibrahim/AP_work/Activepieces_v/pieces-team/ai-actions-eval/audit}"
ai_audit_private() {
  [ -n "$AI_AUDIT_PRIVATE_DIR" ] || return 0
  local week stamp
  week="$(node -e 'import("./lib/isoweek.mjs").then(m=>console.log(m.isoWeekId(process.argv[1])))' "$TODAY")" || return 1
  stamp="$AI_AUDIT_PRIVATE_DIR/.done-week"
  [ "$(cat "$stamp" 2>/dev/null)" = "$week" ] && return 0
  log "ai-audit: private weekly report for $week → $AI_AUDIT_PRIVATE_DIR"
  if ! timeout 1200 node scripts/fetch-ai-audit.mjs --private "$AI_AUDIT_PRIVATE_DIR" </dev/null; then
    return 1
  fi
  printf '%s\n' "$week" > "$stamp" || return 1
  log "ai-audit: private report for $week written"
}
ai_audit_private || log "WARN ai-audit private report failed — the snapshot job carries on; the next run retries"

# Cheapest check first. Re-running the job in the same week is a normal
# outcome, not a failure: without this guard a re-run burns the internal
# refresh plus a ~3-minute fetch before discovering it has nothing to do,
# and exits non-zero so cron mails it as an error.
# SEALED, not merely complete: this job runs every day now, so it has to be
# right on a Friday too -- and `latestCompleteWeek` counts the current Friday as
# done, which would seal a week at 09:00 with a working day still to go in it.
WEEK="$(node -e 'import("./lib/isoweek.mjs").then(m=>console.log(m.latestSealedWeek(process.argv[1])))' "$TODAY")"
# missing | complete | the comma list of its no-data tiles
week_state() {
  node -e 'const{readArchive,degradedWorkstreams}=await import("./weekly/lib/archive.mjs");const w=readArchive("weekly/data/weeks.json").weeks.find(w=>w.week===process.argv[1]);console.log(!w?"missing":degradedWorkstreams(w).join(",")||"complete")' "$WEEK"
}
STATE="$(week_state)"
SNAPSHOT_FLAGS=()
case "$STATE" in
  complete)
    log "$WEEK already snapshotted and complete — nothing to do (use --force-week deliberately to replace it)"
    exit 0 ;;
  missing) ;;
  *)
    SNAPSHOT_FLAGS=(--heal)
    log "$WEEK is archived but degraded ($STATE) — collecting it again to heal it" ;;
esac

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
INTERNAL_OK=1
if ! bash "$DASHBOARD/refresh.sh"; then
  INTERNAL_OK=0
  log "WARN internal refresh failed — tickets will degrade to no-data: $(internal_failure)"
  # tickets and shipping are the only tiles fed by the internal refresh. When
  # they are all a degraded week is missing, a heal cannot succeed this run, so
  # stop before the ~7-minute fetch instead of spending it four times a day.
  OTHER="${STATE//tickets/}"; OTHER="${OTHER//shipping/}"; OTHER="${OTHER//,/}"
  if [ "${#SNAPSHOT_FLAGS[@]}" -gt 0 ] && [ -z "$OTHER" ]; then
    log "$WEEK still degraded ($STATE) — it heals once the internal refresh succeeds; the next run retries"
    alert_once_today "$WEEK is still missing $STATE" "$(internal_failure)"
    exit 1
  fi
fi

log "2/6 fetch + build this repo (populates dist/*/summary.json)"
# The landing scan credits each finished piece to its PR author, and this job's
# snapshot archives that credit for good. Best-effort is right for CI's daily
# rebuild; here a scan that lost a call would archive someone's 0/20 as a
# measured number, or hand a piece to the wrong person. REQUIRED makes an
# incomplete scan fail the fetch, so the trap alerts and tomorrow's run retries
# the week.
export LANDINGS_REQUIRED=1
npm run fetch
npm run build

log "3/6 append $WEEK"
node weekly/snapshot.mjs --today="$TODAY" "${SNAPSHOT_FLAGS[@]}"

log "4/6 commit + push (CI renders and deploys)"
# HEAD, not the bare form: a prior run that died between add and commit leaves
# the change staged, where `git diff --quiet` reports no change and the week
# would go unpublished.
if git diff --quiet HEAD -- weekly/data/weeks.json; then
  # Nothing was pushed, so there is no run to wait for and no new week to see on
  # the live page. verify-weekly.sh checks liveness daily anyway.
  log "no archive change — nothing to push"
  if [ "${#SNAPSHOT_FLAGS[@]}" -gt 0 ]; then
    log "$WEEK is still degraded ($STATE) — this retry was no better; the next run tries again"
    alert_once_today "$WEEK is still missing $STATE" \
      "A full retry ran and was no better, so the archived week was kept. Detail: $REPO/refresh-weekly.log"
    exit 1
  fi
  log "✓ $WEEK needed no change — nothing published"
  exit 0
fi

AFTER="$(week_state)"
git add weekly/data/weeks.json
if [ "${#SNAPSHOT_FLAGS[@]}" -gt 0 ]; then
  git commit -m "chore(weekly): re-snapshot $WEEK"
else
  git commit -m "chore(weekly): snapshot $WEEK"
fi
# Teammates push to this repo too (claims, blockers), so main can move while the
# job runs. A rejected push used to strand the week: the commit stayed local and
# the next day's guard saw the week as done, so nothing retried it (W40,
# 2026-10-03). --autostash because the fetch leaves data/*.json modified.
git pull --rebase --autostash
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

# The week is live. Say so only when it changes what he knows: a week that went
# out with tiles missing (the job keeps healing it, and he may need to clear the
# cause), or a heal that closed one he was already told about.
if [ "$AFTER" != "complete" ]; then
  alert_once_today "$WEEK is live but missing $AFTER" \
    "The page moved on to $WEEK with those tiles showing 'no data'. The job retries at 09/13/17/21h and replaces the week once a run is better. Cause: $( [ "$INTERNAL_OK" = 1 ] && echo "see $REPO/refresh-weekly.log" || internal_failure )"
elif [ "${#SNAPSHOT_FLAGS[@]}" -gt 0 ]; then
  tell "$WEEK healed" "The re-collected $WEEK is live with every tile. Nothing to do."
fi
