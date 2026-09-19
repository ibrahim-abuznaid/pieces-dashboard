#!/usr/bin/env bash
# verify-weekly.sh — the daily health check for the weekly page.
#
# The Saturday job (refresh-weekly.sh) verifies its own push. This exists for
# everything that can rot between Saturdays: a deploy that started serving a
# stale build, an archive somebody hand-edited into failing validation, or a
# Saturday that simply never ran. The machine is always on, so a break should
# surface within a day instead of at the next weekly meeting.
#
# READ-ONLY by construction: it runs no snapshot, stages nothing, commits
# nothing, pushes nothing. All it does is fetch the live page and read the
# committed archive. Safe to run at any time, including mid-refresh.
set -euo pipefail

# cron gives us /usr/bin:/bin, but node is nvm-installed. Same line as
# refresh-weekly.sh rather than relying on the crontab entry to set it.
export PATH="/home/ibrahim/.nvm/versions/node/v24.14.0/bin:/home/ibrahim/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="${HOME:-/home/ibrahim}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

command -v node >/dev/null || { echo "✗ node not on PATH — check the PATH line in $0"; exit 1; }

# Not exec: the check has to be able to say something when it fails. Cron's exit
# code used to be the whole alarm, and on a laptop that is local mail nobody
# reads -- which is how a missing W35 went unnoticed for three weeks.
#
# Alicent is the assistant's local inbox and the CLI is the cron-safe door into
# it (the MCP endpoint wants a bearer token this script must not carry).
# Alerting is best-effort by construction: a stopped daemon must not turn a
# healthy check into a failing one, nor a failing one into a crash.
#
# "$@" passes through --url/--attempts for a human running it by hand against a
# different build.
ALICENT="${ALICENT_BIN:-/home/ibrahim/AP_work/Activepieces_v/Alicent/.venv/bin/alicent}"

if node verify-weekly.mjs "$@"; then exit 0; fi

if [ -x "$ALICENT" ]; then
  "$ALICENT" report --kind error --project pieces-dashboard --urgency high \
    --summary "the weekly page failed its daily health check" \
    --body "verify-weekly.sh is red. Causes it checks for: the archive stopped validating, the newest snapshot is more than 8 days old (a Saturday that never landed), a NEEDS-LINEAR-REFRESH marker is sitting in the team dashboard, or the live page is not serving. Detail in $REPO/verify-weekly.log." \
    >/dev/null 2>&1 || true
fi
exit 1
