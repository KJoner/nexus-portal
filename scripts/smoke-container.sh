#!/usr/bin/env sh
# Start an image the way compose.yaml runs it (read-only root, no capabilities), run the smoke
# test, restart, and check that data survived.   Usage: scripts/smoke-container.sh <image>
set -eu
IMAGE="$1"
NAME="nexus-smoke-$$"
PORT="${SMOKE_PORT:-18787}"
export SMOKE_PASSWORD="smoke-password-$$"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs"
    docker logs "$NAME" 2>&1 | tail -50 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$NAME-data" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

wait_healthy() {
  i=0
  while [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" != healthy ]; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then echo "container did not become healthy"; return 1; fi
    sleep 2
  done
}

docker run -d --name "$NAME" \
  -p "127.0.0.1:$PORT:8787" \
  -v "$NAME-data:/data" \
  -e NEXUS_PASSWORD="$SMOKE_PASSWORD" \
  -e NEXUS_SECRET="smoke-secret-0123456789abcdef" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  "$IMAGE" >/dev/null

wait_healthy
docker exec "$NAME" id -u | grep -qx 1000 || { echo "container is not running as uid 1000"; exit 1; }
node scripts/smoke.mjs "http://127.0.0.1:$PORT"

docker restart "$NAME" >/dev/null
wait_healthy
node scripts/smoke.mjs "http://127.0.0.1:$PORT" --persisted
docker logs "$NAME" 2>&1 | head -3
