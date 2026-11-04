#!/bin/sh
# Bakes the seeded Jellyfin server on the sandbox host: a pinned server image plus open-licensed posters, NFOs and placeholder clips,
# with the first-run wizard finished through the API. Rerun it to change the library or the server version.
#   sh tools/jellyfin-seed/build-image.sh [sshHost] [serverTag]     after fetch-assets.mjs and plan-media.mjs
set -e
HOST="${1:-hardac2}"; TAG="${2:-12.0-rc4.20260802-222750}"; PORT=18096; NAME=jf-seed-build; IMAGE=behique/jellyfin-seeded:1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; OUT="$ROOT/out/jellyfin-seed"
ssh "$HOST" 'mkdir -p ~/jf-seed && rm -rf ~/jf-seed/media'
scp -q -r "$OUT/media" "$HOST:jf-seed/media"
scp -q "$OUT/CREDITS.md" "$HOST:jf-seed/CREDITS.md"
ssh "$HOST" "cat > ~/jf-seed/Dockerfile" <<DOCKER
FROM jellyfin/jellyfin:$TAG
ENV JELLYFIN_DATA_DIR=/seed/config JELLYFIN_CACHE_DIR=/seed/cache JELLYFIN_CONFIG_DIR=/seed/config/config JELLYFIN_LOG_DIR=/seed/config/log XDG_CACHE_HOME=/seed/cache
COPY media /media
COPY CREDITS.md /media/CREDITS.md
DOCKER
ssh "$HOST" "cd ~/jf-seed && docker build -q -t behique/jellyfin-seed-base:1 . && docker rm -f $NAME >/dev/null 2>&1; docker run -d --name $NAME -p 127.0.0.1:$PORT:8096 behique/jellyfin-seed-base:1 >/dev/null"
ssh -f -N -o ExitOnForwardFailure=yes -L "$PORT:127.0.0.1:$PORT" "$HOST" & TUN=$!
sleep 2
node "$ROOT/tools/jellyfin-seed/bootstrap.mjs" "http://127.0.0.1:$PORT" "$OUT/seed.json"
pkill -f "ssh -f -N -o ExitOnForwardFailure=yes -L $PORT" || true
ssh "$HOST" "docker stop -t 15 $NAME >/dev/null && docker commit --change 'ENTRYPOINT [\"/usr/bin/env\"]' $NAME $IMAGE >/dev/null && docker rm $NAME >/dev/null && docker images $IMAGE --format '{{.Repository}}:{{.Tag}} {{.Size}}'"
