#!/bin/sh
# Runs Behique on hardac2 itself, so a check keeps going with this laptop closed: copies the working tree (never .env), installs Node 24 and
# Chromium for the user, and runs the dashboard as a user service on 127.0.0.1:8790. Rerun it after changing the code; it restarts the service.
#   sh tools/hardac2/deploy.sh [host]                 needs no root
#   ssh -N -L 8790:127.0.0.1:8790 hardac2             then open http://127.0.0.1:8790/dashboard
set -e
HOST="${1:-hardac2}"; ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; NODE=v24.22.2
rsync -az --delete --exclude '.env*' --exclude node_modules --exclude out --exclude test-results --exclude 'bench/runs' "$ROOT/" "$HOST:dev/behique/"
ssh "$HOST" 'mkdir -p dev/behique/out ~/.config/behique'
rsync -az "$ROOT/out/crawl" "$HOST:dev/behique/out/" 2>/dev/null || true
rsync -az --ignore-existing "$ROOT/out/evidence" "$HOST:dev/behique/out/"
ssh "$HOST" NODE="$NODE" 'sh -s' <<'REMOTE'
set -e
N="$HOME/.local/node-$NODE"
if [ ! -x "$N/bin/node" ]; then mkdir -p "$N"; curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ --strip-components=1 -C "$N"; fi
export PATH="$N/bin:$PATH"
cd "$HOME/dev/behique"
npm ci --no-audit --no-fund >/dev/null
npx playwright install chromium >/dev/null
[ -f out/settings.json ] || printf '%s\n' '{ "sandbox": { "mode": "local", "host": "", "memoryMb": 12288, "cpus": 8 }, "speed": { "pool": 3, "cache": true } }' > out/settings.json
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/behique.service" <<UNIT
[Unit]
Description=Behique dashboard and checks
After=network-online.target

[Service]
WorkingDirectory=%h/dev/behique
Environment=PATH=$N/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$N/bin/node demo/server.mjs 8790
Restart=on-failure
KillMode=mixed

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable behique.service >/dev/null 2>&1
systemctl --user restart behique.service
sleep 3
systemctl --user is-active behique.service
curl -fsS -m 10 http://127.0.0.1:8790/api/ui/apps >/dev/null && echo dashboard answers
REMOTE
