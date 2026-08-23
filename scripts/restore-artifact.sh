#!/usr/bin/env bash
# Restore the latest successful run's artifact into a local directory.
#
# Usage: restore-artifact.sh <artifact-name> <target-dir>
#
# Downloads the most recent (non-expired) artifact of the given name from ANY
# prior workflow run via the GitHub API and unzips it into <target-dir>. This is
# how workflows carry the accumulated data/ store (odds DB, recommendations,
# staking slips, ...) across ephemeral runners WITHOUT committing to `main`.
#
# Best-effort: on any failure it logs and exits 0 so the workflow proceeds with
# a fresh (or partially-stale) store rather than hard-failing.
set -uo pipefail

NAME="${1:-}"
DIR="${2:-}"
if [ -z "$NAME" ] || [ -z "$DIR" ]; then
  echo "usage: restore-artifact.sh <artifact-name> <target-dir>" >&2
  exit 0
fi
if [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "restore: GITHUB_REPOSITORY/GITHUB_TOKEN not set; starting fresh"
  exit 0
fi

API="https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts"
echo "restore: fetching latest artifact '$NAME'"

ID=$(curl -sS -f -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "${API}?name=${NAME}&per_page=100" 2>/dev/null \
  | NAME="$NAME" python3 -c "
import sys, json, os
name = os.environ['NAME']
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
arts = [a for a in d.get('artifacts', []) if a.get('name') == name and not a.get('expired')]
arts.sort(key=lambda a: a.get('created_at', ''), reverse=True)
print(arts[0]['id'] if arts else '')
" 2>/dev/null) || ID=""

if [ -z "$ID" ]; then
  echo "restore: no artifact '$NAME' found; starting fresh"
  exit 0
fi

if curl -sSL -f -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "${API}/${ID}/zip" -o /tmp/restore-artifact.zip 2>/dev/null; then
  mkdir -p "$DIR"
  unzip -o -q /tmp/restore-artifact.zip -d "$DIR"
  echo "restore: restored artifact $ID into $DIR"
else
  echo "restore: download failed; starting fresh"
fi
