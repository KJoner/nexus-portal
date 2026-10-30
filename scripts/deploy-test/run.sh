#!/usr/bin/env bash
# deploy.sh 场景测试：在 Docker-in-Docker 里模拟一台全新服务器，运行 scenarios.sh。
#   docker build -t kjoner/nexus-portal:0.3.1 --build-arg NEXUS_VERSION=0.3.1 .   # 待测镜像
#   bash scripts/deploy-test/run.sh 0.3.1
set -euo pipefail
export MSYS_NO_PATHCONV=1
NEW="${1:-0.3.1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
command -v cygpath >/dev/null && ROOT="$(cygpath -m "$ROOT")"
NAME=nx-deploy-test

docker rm -f "$NAME" >/dev/null 2>&1 || true
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker pull -q kjoner/nexus-portal:0.1.0 >/dev/null
docker run -d --privileged --name "$NAME" -e DOCKER_TLS_CERTDIR= -v "$ROOT:/src:ro" docker:28-dind >/dev/null
for _ in $(seq 30); do docker exec "$NAME" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$NAME" apk add --no-cache -q bash curl jq openssl >/dev/null
docker save kjoner/nexus-portal:0.1.0 "kjoner/nexus-portal:$NEW" | docker exec -i "$NAME" docker load -q >/dev/null
docker exec "$NAME" mkdir -p /fixtures
git -C "$ROOT" show v0.1.0:compose.yaml | docker exec -i "$NAME" sh -c 'cat > /fixtures/compose-v0.1.0.yaml'
docker exec -e NEW="$NEW" "$NAME" bash /src/scripts/deploy-test/scenarios.sh
