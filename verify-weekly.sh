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

# exec so the node exit code is this script's exit code: non-zero is what makes
# cron mail the output. "$@" passes through --url/--attempts for a human running
# it by hand against a different build.
exec node verify-weekly.mjs "$@"
