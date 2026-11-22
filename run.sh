#!/bin/bash
# Keeps the demo server alive (restarts if it crashes). Usage: ./run.sh &
cd "$(dirname "$0")"
while true; do PORT=${PORT:-4300} node src/server.js >> data/server.log 2>&1; echo "restart $(date)" >> data/server.log; sleep 2; done
