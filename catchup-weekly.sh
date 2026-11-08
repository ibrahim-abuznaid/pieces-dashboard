#!/usr/bin/env bash
# catchup-weekly.sh — the check that runs AFTER the machine comes back.
#
# The snapshot job (refresh-weekly.sh) is a cron line at 09/13/17/21h, and cron
# has no memory: a slot the machine was off or asleep for is simply skipped. On
# a desktop that gets switched off this is the whole remaining way to lose a
# week — every run until next Saturday has to be missed, which is four chances
# a day, but "off for the weekend" is exactly the shape that misses them all.
# And when the page IS stale, nothing on this machine says so until the daily
# verify at 20:00, which the same shutdown also skips.
#
# So this runs from a systemd user timer (pieces-weekly-catchup.timer) that
# fires a few minutes after boot, and — being Persistent — right after any
# calendar slot the machine slept through. It asks the one question that
# matters, "is the latest sealed week live?", by running the same job the cron
# runs: refresh-weekly.sh's guard answers it in 54 ms when the week is complete,
# and collects the week when it is missing. Then it runs the read-only verify,
# so a page that is stale for any other reason is reported the same day.
#
# It says something to Ibrahim only when it had to do something — a week that
# was missing or degraded when it woke up — or when the verify is red after it.
# A quiet boot stays quiet: the machine is rebooted several times a week, and a
# message that says "nothing to do" every time is one he will stop reading.
#
# Safe against the cron job: if refresh-weekly.sh is running right now (the
# Saturday run takes ~50 min), the lock is held, and this exits without
# touching anything — including the verify, which would see the new commit
# before the deploy finished and report a false mismatch.
set -uo pipefail

export PATH="/home/ibrahim/.nvm/versions/node/v24.14.0/bin:/home/ibrahim/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="${HOME:-/home/ibrahim}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"
LOG="$REPO/catchup-weekly.log"
STATE_DIR="$HOME/.cache/pieces-dashboard"
mkdir -p "$STATE_DIR"

log() { printf '[%s] %s\n' "$(date '+%F %H:%M:%S')" "$*" | tee -a "$LOG"; }

ALICENT="${ALICENT_BIN:-/home/ibrahim/AP_work/Activepieces_v/Alicent/.venv/bin/alicent}"
ALICENT_HOME="${ALICENT_HOME:-/home/ibrahim/AP_work/Activepieces_v/Alicent}"
tell() {
  [ -x "$ALICENT" ] || return 0
  ALICENT_HOME="$ALICENT_HOME" "$ALICENT" notify --kind alert --urgency critical \
    "pieces weekly page: $1" "${2:-}" >/dev/null 2>&1 || true
}

# Why this run exists: `boot` right after a start, `timer` for a calendar slot
# (including one systemd is replaying because the machine slept through it),
# `manual` when a person runs it. systemd does not say which trigger fired, so
# the first run after a boot is called the boot run.
REASON="${1:-manual}"
if [ "$REASON" = "timer" ]; then
  up_s="$(cut -d. -f1 /proc/uptime)"
  [ "$up_s" -lt 900 ] && REASON="boot"
fi

# The job needs GitHub for everything after the guard, and the first run after
# a boot can land before the network does. Wait for it, bounded: a machine with
# no network for ten minutes gets the next slot's retry, not a stuck service.
net_ok() { curl -fsS -m 10 -o /dev/null https://api.github.com/ 2>/dev/null; }
tries=0
until net_ok; do
  tries=$((tries + 1))
  if [ "$tries" -ge 40 ]; then
    log "$REASON: no network after 10 min — giving up; the next timer slot retries"
    exit 0
  fi
  sleep 15
done

WEEK="$(node -e 'import("./lib/isoweek.mjs").then(m=>console.log(m.latestSealedWeek(process.argv[1])))' "$(date +%F)")"
week_state() {
  node -e 'const{readArchive,degradedWorkstreams}=await import("./weekly/lib/archive.mjs");const w=readArchive("weekly/data/weeks.json").weeks.find(w=>w.week===process.argv[1]);console.log(!w?"missing":degradedWorkstreams(w).join(",")||"complete")' "$WEEK"
}

# A refresh in progress owns the tree; see the header.
exec 8>"$STATE_DIR/refresh-weekly.lock"
if ! flock -n 8; then
  log "$REASON: a refresh-weekly run is in progress (lock held) — not interfering; it verifies its own push"
  exit 0
fi
exec 8>&-

BEFORE="$(week_state)"
log "$REASON: $WEEK is $BEFORE in the local archive — running refresh-weekly.sh"
{ printf '[%s] catch-up (%s): run started\n' "$(date +%H:%M:%S)" "$REASON"; } >> refresh-weekly.log
./refresh-weekly.sh >> refresh-weekly.log 2>&1
REFRESH_RC=$?
AFTER="$(week_state)"

./verify-weekly.sh >> verify-weekly.log 2>&1
VERIFY_RC=$?

verdict="$REASON: $WEEK $BEFORE → $AFTER · refresh exit $REFRESH_RC · verify exit $VERIFY_RC"
log "$verdict"
printf '%s %s\n' "$(date '+%F %H:%M:%S')" "$verdict" > "$STATE_DIR/last-catchup"

# Speak only when the wake-up mattered. refresh-weekly.sh already alerts on its
# own failures and on a week that stays degraded; the one outcome it is silent
# about is the good one — a MISSING week collected and published — and that is
# the one a person who switched the machine off wants to hear about.
if [ "$BEFORE" = "missing" ] && [ "$AFTER" = "complete" ] && [ "$VERIFY_RC" -eq 0 ]; then
  tell "$WEEK caught up after the machine was off" \
    "The weekly page had not snapshotted $WEEK (the machine was off at every scheduled run). The catch-up run collected it and it is live now. Nothing to do."
elif [ "$VERIFY_RC" -ne 0 ]; then
  tell "the catch-up check after boot found the page red" \
    "$WEEK is $AFTER after a catch-up run (refresh exit $REFRESH_RC). Detail: $REPO/catchup-weekly.log, refresh-weekly.log and verify-weekly.log. The job retries at 09/13/17/21h."
fi
exit 0
