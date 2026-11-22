#!/bin/bash
# Keeps the demo server alive (restarts if it crashes). Usage: ./run.sh &
cd "$(dirname "$0")"
set -a; [ -f private/creds.env ] && . private/creds.env; set +a
[ -f /home/box/.ffd/report-token.sha256 ] && export REPORT_TOKEN_SHA256=$(cat /home/box/.ffd/report-token.sha256)
while true; do PORT=${PORT:-4300} node src/server.js >> data/server.log 2>&1; echo "restart $(date)" >> data/server.log; sleep 2; done
