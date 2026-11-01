#!/usr/bin/env bash
# Run FRIMS on macOS / Linux. Needs Node.js 20+ (https://nodejs.org).
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Install the LTS version from https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
( sleep 2; (command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) ) >/dev/null 2>&1 &
npm start
