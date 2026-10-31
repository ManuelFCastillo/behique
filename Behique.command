#!/bin/zsh
# Double-click to start Behique and open the dashboard. Close this window (or press Control-C) to stop it.
cd "$(dirname "$0")" || exit 1
exec node demo/server.mjs --open
