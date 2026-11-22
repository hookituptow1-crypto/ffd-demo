#!/usr/bin/env bash
# FFD daily deployment report → JSON on stdout.
#   scripts/daily-report.sh [YYYY-MM-DD]      (default: today in America/Los_Angeles)
# Auth: read-only report token from /home/box/.ffd/report-token (chmod 600, never in the repo).
# The token only works on GET /api/admin/reports/daily; the server keeps just its SHA-256 (Render env REPORT_TOKEN_SHA256).
set -euo pipefail
BASE="${FFD_BASE:-https://ffd-demo-tyop.onrender.com}"
TOKEN_FILE="${FFD_REPORT_TOKEN_FILE:-/home/box/.ffd/report-token}"
DAY="${1:-$(TZ=America/Los_Angeles date +%F)}"
[[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "usage: $0 [YYYY-MM-DD]" >&2; exit 2; }
[[ -r "$TOKEN_FILE" ]] || { echo "report token not found at $TOKEN_FILE" >&2; exit 3; }
perm=$(stat -c %a "$TOKEN_FILE"); [[ "$perm" == "600" || "$perm" == "400" ]] || { echo "refusing: $TOKEN_FILE must be chmod 600 (is $perm)" >&2; exit 3; }
# token goes in via a header file on stdin so it never shows up in the process list
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
code=$(printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$TOKEN_FILE")" | curl -sS --max-time 90 --retry 3 --retry-delay 10 --retry-all-errors \
  -H @- -H 'Accept: application/json' -o "$tmp" -w '%{http_code}' "$BASE/api/admin/reports/daily?date=$DAY")
if [[ "$code" != "200" ]]; then echo "FFD report request failed: HTTP $code $(head -c 200 "$tmp")" >&2; exit 4; fi
if command -v python3 >/dev/null; then python3 -m json.tool < "$tmp"; else cat "$tmp"; fi
