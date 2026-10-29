#!/usr/bin/env bash
# Nexus Portal 一键部署：首次安装、更新（自动备份，失败自动回滚）、备份、恢复、修改密码。
#
#   curl -fsSL https://raw.githubusercontent.com/KJoner/nexus-portal/main/scripts/deploy.sh -o deploy.sh
#   bash deploy.sh                       # 没有部署就安装；已有部署就更新到最新版本
#
# 选项：
#   --install-dir DIR    部署目录（默认自动识别：正在运行的 Nexus 容器 → 当前目录 → ~/nexus 或 /opt/nexus）
#   --version X.Y.Z      安装或更新到指定版本（默认：GitHub 上最新的正式版本）
#   --domain DOMAIN      首次安装时的访问域名（写入 NEXUS_PUBLIC_URL=https://DOMAIN）
#   --password-stdin     从标准输入读取密码（非交互安装或 --password 时使用）
#   --yes                不再询问确认
#   --backup             只做一次备份
#   --restore [NAME]     恢复备份（默认最近一次）
#   --verify-backup [NAME]  在隔离的临时容器中还原并启动备份，确认它可以恢复（默认最近一次）
#   --list-backups       列出备份
#   --password           修改访问密码
#   --status             查看部署状态
#
# 安全约定：密码只经由隐藏输入或标准输入传给镜像里的 cli.mjs 生成 Argon2id 哈希，
# 不进入命令参数、日志或屏幕输出；.env 与备份目录权限为 600 / 700；数据卷从不删除。
set -Eeuo pipefail
umask 077

REPO="KJoner/nexus-portal"
DEFAULT_IMAGE="kjoner/nexus-portal"
# Where compose.yaml / .env.example come from: a GitHub ref (default) or a local directory (tests, offline).
SOURCE="${NEXUS_DEPLOY_SOURCE:-https://raw.githubusercontent.com/$REPO}"
KEEP_BACKUPS=3
HEALTH_TIMEOUT="${NEXUS_HEALTH_TIMEOUT:-150}"
# SHA-256 of every compose.yaml a release has shipped. Any other content means local edits,
# which are kept (never overwritten); they belong in compose.override.yaml.
OFFICIAL_COMPOSE=(
  3eefc9640c9211f07fda7623be7157c3ec84c6f0d69fd6fe4efb61c2c2768d62 # 0.1.0
  8f7a742a2dbed83df2f769f0331fa3c04d7f5ba2c0bfbc6313f73342ac85f9d3 # 0.2.0
  b8e5479a248f2e52bd52e0565b371a90a59d9880a1535197584e367fa78065cf # 0.2.1
)

# ── 输出 ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then C_B=$'\e[1m' C_G=$'\e[32m' C_Y=$'\e[33m' C_R=$'\e[31m' C_0=$'\e[0m'; else C_B='' C_G='' C_Y='' C_R='' C_0=''; fi
LOG_FILE=""
log() { [ -n "$LOG_FILE" ] && printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }
step() { printf '%s==>%s %s\n' "$C_B" "$C_0" "$*"; log "$*"; }
ok() { printf '%s✓%s %s\n' "$C_G" "$C_0" "$*"; log "ok: $*"; }
warn() { printf '%s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; log "warn: $*"; }
die() { printf '%s✗ %s%s\n' "$C_R" "$*" "$C_0" >&2; log "error: $*"; exit 1; }

# ── 参数 ───────────────────────────────────────────────────────────────────
INSTALL_DIR="" VERSION="" DOMAIN="" PASSWORD_STDIN=0 YES=0 ACTION="auto" RESTORE_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:?--install-dir 需要目录}"; shift 2 ;;
    --install-dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --version) VERSION="${2:?--version 需要版本号}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --domain) DOMAIN="${2:?--domain 需要域名}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --password-stdin) PASSWORD_STDIN=1; shift ;;
    --yes | -y) YES=1; shift ;;
    --backup) ACTION="backup"; shift ;;
    --restore) ACTION="restore"; if [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; then RESTORE_NAME="$2"; shift; fi; shift ;;
    --verify-backup) ACTION="verify"; if [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; then RESTORE_NAME="$2"; shift; fi; shift ;;
    --list-backups) ACTION="list"; shift ;;
    --password) ACTION="password"; shift ;;
    --status) ACTION="status"; shift ;;
    -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done
VERSION="${VERSION#v}"

# ── 工具 ───────────────────────────────────────────────────────────────────
TTY_IN=""
if [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then TTY_IN=/dev/tty; fi

ask() { # ask VAR "提示" "默认值"
  local __var="$1" __prompt="$2" __def="${3:-}" __ans=""
  if [ -z "$TTY_IN" ] || [ "$YES" = 1 ]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "$__prompt${__def:+ [$__def]}: " __ans <"$TTY_IN" || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

confirm() { # confirm "问题" → 0 = 是
  [ "$YES" = 1 ] && return 0
  [ -z "$TTY_IN" ] && die "需要确认：$1（非交互运行请加 --yes）"
  local a=""
  read -r -p "$1 [y/N]: " a <"$TTY_IN" || true
  [ "$a" = y ] || [ "$a" = Y ] || [ "$a" = yes ]
}

# Numeric version compare (pre-release suffixes ignored): ver_lt 0.2.0 0.10.1 → true.
ver_lt() {
  local IFS=. i va vb
  read -r -a va <<<"${1%%-*}"
  read -r -a vb <<<"${2%%-*}"
  for i in 0 1 2; do
    if [ "${va[i]:-0}" -lt "${vb[i]:-0}" ]; then return 0; fi
    if [ "${va[i]:-0}" -gt "${vb[i]:-0}" ]; then return 1; fi
  done
  return 1
}

fetch() { # fetch <path in repo> <dest>; from the release tag, or from a local source directory
  local path="$1" dest="$2"
  if [ -d "$SOURCE" ]; then cp "$SOURCE/$path" "$dest"; return; fi
  local url="$SOURCE/v$TARGET/$path"
  if command -v curl >/dev/null; then curl -fsSL --retry 2 "$url" -o "$dest"
  elif command -v wget >/dev/null; then wget -qO "$dest" "$url"
  else die "需要 curl 或 wget 来下载 $path"; fi
}

latest_version() {
  if [ -n "${NEXUS_LATEST_VERSION:-}" ]; then echo "${NEXUS_LATEST_VERSION#v}"; return; fi
  local api="https://api.github.com/repos/$REPO/releases/latest" body=""
  if command -v curl >/dev/null; then body="$(curl -fsSL --retry 2 "$api" 2>/dev/null || true)"; else body="$(wget -qO- "$api" 2>/dev/null || true)"; fi
  local tag
  tag="$(printf '%s' "$body" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || die "无法获取最新版本号（网络或 GitHub API 不可用）。请用 --version X.Y.Z 指定"
  echo "$tag"
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ── .env（只读写指定键；密钥值从不打印）──────────────────────────────────────
env_get() { # 仅用于非敏感键
  [ -f "$ENV_FILE" ] || return 0
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%%[[:space:]]#*}"
  line="${line#\"}"; line="${line%\"}"; line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}
env_has() { [ -f "$ENV_FILE" ] && grep -Eq "^[[:space:]]*$1=['\"]?[^'\"[:space:]#]" "$ENV_FILE"; }
env_set() { # env_set KEY VALUE：单引号写入（Compose 不会展开其中的 $），保持原有顺序
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  K="$1" V="$1='$2'" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    $0 ~ "^[ \t]*" k "=" { if (!done) print v; done = 1; next }
    { print }
    END { if (!done) print v }' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}
env_unset() {
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  K="$1" awk 'BEGIN { k = ENVIRON["K"] } $0 !~ "^[ \t]*" k "=" { print }' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
}

# ── Docker ─────────────────────────────────────────────────────────────────
preflight() {
  command -v docker >/dev/null || die "没有找到 docker。请先安装 Docker Engine：https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "无法连接 Docker：请确认 Docker 正在运行，并用 root 或 docker 组用户执行"
  docker compose version >/dev/null 2>&1 || die "没有找到 Docker Compose v2（docker compose）。请安装 docker-compose-plugin"
}

DIR="" ENV_FILE="" PROJECT="" FILE_ARGS=() CONFIG_FILES=() CID="" MOUNT="" OTHER_DEPLOY=""

compose() { docker compose --project-directory "$DIR" ${PROJECT:+-p "$PROJECT"} "${FILE_ARGS[@]}" "$@"; }

# Finds an existing deployment: an explicit directory, a Nexus container's Compose labels
# (works from any directory, keeps the exact file combination and project name), the current
# directory, or the default directory.
locate() {
  local found="" n
  if [ -n "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR" 2>/dev/null || true
    DIR="$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" || die "无法使用目录 $INSTALL_DIR"
  fi
  found="$(docker ps -a --filter label=com.docker.compose.service=nexus --format '{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.ID}}' 2>/dev/null || true)"
  n="$(printf '%s' "$found" | grep -c . || true)"
  OTHER_DEPLOY="$(printf '%s' "$found" | head -n 1 | cut -d'|' -f1)"
  if [ "$n" -gt 1 ] && [ -z "$DIR" ]; then
    printf '%s\n' "$found" | cut -d'|' -f1 >&2
    die "发现多个 Nexus 部署，请用 --install-dir 指定要操作的目录"
  fi
  local line=""
  if [ -n "$DIR" ]; then line="$(printf '%s\n' "$found" | awk -F'|' -v d="$DIR" '$1 == d' | head -n 1)"
  elif [ "$n" = 1 ]; then line="$found"; fi
  if [ -n "$line" ]; then
    DIR="${line%%|*}"
    PROJECT="$(printf '%s' "$line" | cut -d'|' -f2)"
    IFS=, read -r -a CONFIG_FILES <<<"$(printf '%s' "$line" | cut -d'|' -f3)"
    CID="$(printf '%s' "$line" | cut -d'|' -f4)"
    OTHER_DEPLOY=""
  fi
  if [ -z "$DIR" ]; then
    if [ -f "$PWD/.env" ] && grep -q '^NEXUS_' "$PWD/.env" 2>/dev/null && { [ -f "$PWD/compose.yaml" ] || [ -f "$PWD/docker-compose.yml" ]; }; then
      DIR="$PWD"
    elif [ "$(id -u)" = 0 ]; then DIR=/opt/nexus
    else DIR="$HOME/nexus"; fi
  fi
  ENV_FILE="$DIR/.env"
  FILE_ARGS=()
  local f
  for f in "${CONFIG_FILES[@]}"; do [ -f "$f" ] && FILE_ARGS+=(-f "$f"); done
  # Without labels, Compose picks compose.yaml + compose.override.yaml (and COMPOSE_FILE from .env) itself.
}

container() { # refresh CID / MOUNT from Compose
  CID="$(compose ps -a -q nexus 2>/dev/null | head -n 1 || true)"
  MOUNT=""
  if [ -n "$CID" ]; then
    local m
    m="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.Name}}|{{.Source}}{{end}}{{end}}' "$CID" 2>/dev/null || true)"
    case "$m" in volume\|*) MOUNT="$(printf '%s' "$m" | cut -d'|' -f2)" ;; bind\|*) MOUNT="$(printf '%s' "$m" | cut -d'|' -f3)" ;; esac
  fi
  if [ -z "$MOUNT" ]; then
    MOUNT="${PROJECT:-nexus}_nexus-data"
    docker volume inspect "$MOUNT" >/dev/null 2>&1 || MOUNT=""
  fi
}

state() { [ -n "$CID" ] && docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CID" 2>/dev/null || echo "absent|"; }

running_version() { # version of the image the container was created from (labels / image env, never container env)
  [ -n "$CID" ] || return 0
  local img v
  img="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null || true)"
  [ -n "$img" ] || return 0
  v="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$img" 2>/dev/null || true)"
  [ -n "$v" ] && [ "$v" != "<no value>" ] || v="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$img" 2>/dev/null | sed -n 's/^NEXUS_VERSION=//p' | head -n 1)"
  printf '%s' "${v#v}"
}

ensure_image() { # ensure_image REF：拉取；离线时允许使用本地已有镜像
  if docker pull -q "$1" >/dev/null 2>&1; then ok "镜像 $1 已就绪"; return 0; fi
  if docker image inspect "$1" >/dev/null 2>&1; then warn "无法从镜像仓库拉取 $1，使用本地已有镜像"; return 0; fi
  die "镜像 $1 不存在或无法下载（检查版本号与网络）。现有部署没有任何改动"
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) s
  container
  while [ $SECONDS -lt $deadline ]; do
    s="$(state)"
    case "$s" in
      running\|healthy) return 0 ;;
      running\|) return 0 ;; # an image without a health check
      exited* | dead*) break ;;
    esac
    # restart: unless-stopped turns a crash into a loop; three restarts are enough to know.
    [ "$(docker inspect -f '{{.RestartCount}}' "$CID" 2>/dev/null || echo 0)" -ge 3 ] && break
    sleep 2
  done
  if [ $SECONDS -ge $deadline ]; then warn "服务没有在 ${HEALTH_TIMEOUT} 秒内变为健康（状态：$(state)），最近日志："
  else warn "服务启动失败（状态：$(state)，已重启 $(docker inspect -f '{{.RestartCount}}' "$CID" 2>/dev/null) 次），最近日志："; fi
  docker logs --tail 15 "$CID" 2>&1 | sed 's/^/    /' >&2 || true
  return 1
}

# ── 备份（.env、Compose 文件、数据库一致性快照、持久化数据）───────────────────
BACKUP=""

backup_now() { # backup_now <tool image> <label>
  local tool="$1" label="$2" ts uid gid code=0
  container
  [ -n "$MOUNT" ] || die "找不到 Nexus 的数据卷，无法备份"
  ts="$(date +%Y%m%d-%H%M%S)"
  BACKUP="$DIR/backups/$ts-$label"
  mkdir -p "$BACKUP/config"
  chmod 700 "$DIR/backups" "$BACKUP"
  cp -p "$ENV_FILE" "$BACKUP/config/.env"
  local f
  for f in "$DIR"/compose*.y*ml "$DIR"/docker-compose*.y*ml "${CONFIG_FILES[@]}"; do [ -f "$f" ] && cp -p "$f" "$BACKUP/config/"; done
  # 1) Consistent SQLite snapshot (VACUUM INTO), taken as the app's own user even while it runs;
  #    the report says whether the target image can read it (blocks downgrades and corrupt data).
  set +e
  docker run --rm --network none -v "$MOUNT:/data" --entrypoint node "$tool" server/cli.mjs db-backup /data/nexus.db /data/.deploy-snapshot.db >"$BACKUP/db-check.json" 2>"$BACKUP/db-check.err"
  code=$?
  set -e
  case $code in
    0) ;;
    5) rm -f "$BACKUP/db-check.json" "$BACKUP/db-check.err"; warn "数据卷中还没有数据库，只备份配置" ;;
    3) die "数据库版本比目标版本新（$(cat "$BACKUP/db-check.json")）：不能降级，请改用 --restore 恢复对应的备份" ;;
    4) die "数据库完整性检查失败（$(cat "$BACKUP/db-check.json")），已停止。请先排查，不要更新" ;;
    *) die "数据库备份失败：$(cat "$BACKUP/db-check.err")" ;;
  esac
  # 2) Move the snapshot out and archive the rest of /data (uploads, icons, secret.key), skipping
  #    the live database files and caches that rebuild themselves.
  uid="$(id -u)" gid="$(id -g)"
  docker run --rm --network none --user 0 -v "$MOUNT:/data" -v "$BACKUP:/backup" --entrypoint sh "$tool" -c '
    set -e
    if [ -f /data/.deploy-snapshot.db ]; then mv /data/.deploy-snapshot.db /backup/nexus.db; fi
    tar czf /backup/data.tar.gz -C /data --exclude=./nexus.db --exclude=./nexus.db-wal --exclude=./nexus.db-shm \
      --exclude=./.deploy-snapshot.db --exclude=./backups --exclude=./icon-cache --exclude=./gallery-previews .
    chown -R '"$uid:$gid"' /backup
    chmod -R go-rwx /backup' >/dev/null
  rm -f "$BACKUP/db-check.err"
  {
    echo "created=$(date '+%F %T')"
    echo "version=${CURRENT:-unknown}"
    echo "image=${IMAGE}:${CURRENT:-unknown}"
    echo "data=$MOUNT"
    echo "project=${PROJECT:-nexus}"
    echo "reason=$label"
  } >"$BACKUP/manifest"
  find "$BACKUP" -type d -exec chmod 700 {} +
  find "$BACKUP" -type f -exec chmod 600 {} +
  ok "已备份到 $BACKUP"
  prune_backups "$BACKUP"
}

prune_backups() { # keep the newest $KEEP_BACKUPS (never the one in $1)
  local keep="${1:-}" all n i
  [ -d "$DIR/backups" ] || return 0
  all="$(find "$DIR/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort)"
  n="$(printf '%s' "$all" | grep -c . || true)"
  i=0
  printf '%s\n' "$all" | while IFS= read -r d; do
    [ -n "$d" ] || continue
    i=$((i + 1))
    if [ $((n - i)) -ge "$KEEP_BACKUPS" ] && [ "$d" != "$keep" ]; then rm -rf "$d" && log "pruned $d"; fi
  done
}

# Puts a backup's database (and, for --restore, its files) back into the data volume.
restore_data() { # restore_data <backup dir> <tool image> <with files: 0|1>
  local b="$1" tool="$2" files="$3"
  [ -f "$b/nexus.db" ] || { warn "备份中没有数据库，跳过数据恢复"; return 0; }
  # The backup directory is root/700 on the host: read it as root, check a private copy.
  docker run --rm --network none --user 0 -v "$b:/backup:ro" --entrypoint sh "$tool" -c 'cp /backup/nexus.db /tmp/check.db && node server/cli.mjs db-check /tmp/check.db' >/dev/null ||
    die "备份 $b 中的数据库无法通过检查，未做任何恢复"
  docker run --rm --network none --user 0 -v "$MOUNT:/data" -v "$b:/backup:ro" --entrypoint sh "$tool" -c '
    set -e
    rm -f /data/nexus.db-wal /data/nexus.db-shm
    cp /backup/nexus.db /data/nexus.db.restore && mv -f /data/nexus.db.restore /data/nexus.db
    if [ "'"$files"'" = 1 ] && [ -f /backup/data.tar.gz ]; then tar xzf /backup/data.tar.gz -C /data; fi
    chown -R 1000:1000 /data' >/dev/null
}

# Proves a backup can be restored: its database and files go into a scratch volume, and the image
# that wrote them boots on it in an isolated container (no network, no ports) until /api/healthz
# answers. Nothing of the live deployment is touched; the scratch container and volume are removed.
verify_backup() { # verify_backup <backup dir> <image that wrote it> <tool image>
  local b="$1" img="$2" tool="$3" name="nexus-verify-$$" i okay=1
  [ -f "$b/nexus.db" ] || { warn "备份中没有数据库，跳过恢复验证"; return 0; }
  docker volume create "$name" >/dev/null
  docker run --rm --network none --user 0 -v "$name:/data" -v "$b:/backup:ro" --entrypoint sh "$tool" -c '
    set -e
    cp /backup/nexus.db /data/nexus.db
    if [ -f /backup/data.tar.gz ]; then tar xzf /backup/data.tar.gz -C /data; fi
    chown -R 1000:1000 /data' >/dev/null || okay=0
  if [ $okay = 1 ] && docker run -d --name "$name" --network none -v "$name:/data" "$img" >/dev/null 2>&1; then
    okay=0
    for i in $(seq 45); do
      if docker exec "$name" wget -qO- http://127.0.0.1:8787/api/healthz >/dev/null 2>&1; then okay=1; break; fi
      [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || break
      sleep 2
    done
    [ $okay = 1 ] || docker logs --tail 10 "$name" 2>&1 | sed 's/^/    /' >&2
  else okay=0; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm -f "$name" >/dev/null 2>&1 || true
  [ $okay = 1 ]
}

restore_config() { # restore_config <backup dir>
  local f
  for f in "$1"/config/.env "$1"/config/*; do
    [ -f "$f" ] || continue
    cp -p "$f" "$DIR/$(basename "$f")"
  done
  chmod 600 "$ENV_FILE"
}

# ── 密码 ───────────────────────────────────────────────────────────────────
read_password() { # → PASSWORD（只在内存中；调用方用完立即 unset）
  PASSWORD=""
  if [ "$PASSWORD_STDIN" = 1 ]; then
    IFS= read -r PASSWORD || true
  else
    [ -n "$TTY_IN" ] || die "需要在终端中输入密码，或使用 --password-stdin"
    local again=""
    while :; do
      IFS= read -r -s -p "设置访问密码（至少 8 位，输入时不显示）: " PASSWORD <"$TTY_IN" || true
      echo >&2
      IFS= read -r -s -p "再输入一次: " again <"$TTY_IN" || true
      echo >&2
      if [ "${#PASSWORD}" -lt 8 ]; then warn "密码至少需要 8 个字符"; continue; fi
      [ "$PASSWORD" = "$again" ] && break
      warn "两次输入不一致，请重新输入"
    done
    again=""
  fi
  [ "${#PASSWORD}" -ge 8 ] || die "密码至少需要 8 个字符"
}

hash_password() { # stdin → Argon2id，由目标镜像计算；密码不经过命令参数
  local tool="$1" h
  h="$(printf '%s' "$PASSWORD" | docker run --rm -i --network none --entrypoint node "$tool" server/cli.mjs hash-password)" || die "生成密码哈希失败"
  PASSWORD=""
  printf '%s' "$h"
}

# A plain NEXUS_PASSWORD from an older .env becomes NEXUS_PASSWORD_HASH. The value is read from
# `docker compose config` (exactly what the container receives) and hashed inside the image, so
# the password never reaches this shell's variables, arguments or output.
migrate_password() { # migrate_password <tool image>
  env_has NEXUS_PASSWORD || return 0
  if env_has NEXUS_PASSWORD_HASH; then env_unset NEXUS_PASSWORD; ok "已删除 .env 中多余的明文密码"; return 0; fi
  local h code
  set +e
  h="$(compose config --format json 2>/dev/null | docker run --rm -i --network none --entrypoint node "$1" server/cli.mjs hash-from-compose 2>/dev/null)"
  code=$?
  set -e
  [ $code = 0 ] && [ -n "$h" ] || { warn "无法迁移明文密码，保持原样（仍然可以正常登录）"; return 0; }
  env_set NEXUS_PASSWORD_HASH "$h"
  env_unset NEXUS_PASSWORD
  MIGRATED=1
  ok "已把 .env 中的明文密码迁移为 Argon2id 哈希（登录密码不变；各设备需要重新登录一次）"
}

# After a migration: the password from the backed-up (pre-update) configuration must still sign in
# to the new server. compose config → stdin of the image's CLI, which logs in over the container's
# own network and logs out again; the password never passes through this shell.
login_check() { # login_check <backup dir> <tool image>
  local cfg="$1/config" args=() f
  for f in "${CONFIG_FILES[@]}"; do [ -f "$cfg/$(basename "$f")" ] && args+=(-f "$cfg/$(basename "$f")"); done
  if [ ${#args[@]} = 0 ]; then
    for f in compose.yaml docker-compose.yml compose.override.yaml docker-compose.override.yml; do [ -f "$cfg/$f" ] && args+=(-f "$cfg/$f"); done
  fi
  container
  docker compose --project-directory "$DIR" "${args[@]}" --env-file "$cfg/.env" config --format json 2>/dev/null |
    docker run --rm -i --network "container:$CID" --entrypoint node "$2" server/cli.mjs login-from-compose http://127.0.0.1:8787 >/dev/null 2>&1
}

# ── Compose 文件 ───────────────────────────────────────────────────────────
is_official() { local s x; s="$(sha256 "$1")"; for x in "${OFFICIAL_COMPOSE[@]}"; do [ "$s" = "$x" ] && return 0; done; return 1; }

# Replaces compose.yaml with the target version's file, unless it has local edits.
update_compose() {
  local cur="$DIR/compose.yaml" new
  new="$(mktemp "$DIR/.compose.XXXXXX")"
  fetch compose.yaml "$new" || { rm -f "$new"; die "无法下载 v$TARGET 的 compose.yaml"; }
  chmod 644 "$new"
  if [ ! -f "$cur" ]; then
    if ls "$DIR"/docker-compose*.y*ml >/dev/null 2>&1; then
      mv -f "$new" "$DIR/compose.yaml.v$TARGET"
      warn "这个部署使用 docker-compose.yml，未改动；新版文件另存为 compose.yaml.v$TARGET"
      COMPOSE_LOCAL=1
    else mv -f "$new" "$cur"; fi
    return 0
  fi
  if cmp -s "$new" "$cur"; then rm -f "$new"; return 0; fi
  if is_official "$cur"; then
    mv -f "$new" "$cur"
    ok "compose.yaml 已更新到 v$TARGET 版本"
  else
    mv -f "$new" "$DIR/compose.yaml.v$TARGET"
    warn "compose.yaml 有本地修改，未覆盖；新版文件另存为 compose.yaml.v$TARGET。建议把修改移到 compose.override.yaml 后用新版替换"
    COMPOSE_LOCAL=1
  fi
}

# ── 操作 ───────────────────────────────────────────────────────────────────
print_summary() {
  local url bind port
  bind="$(env_get NEXUS_BIND)"; port="$(env_get NEXUS_PORT)"
  url="$(env_get NEXUS_PUBLIC_URL)"
  echo
  ok "Nexus ${1:-} 运行正常"
  echo "    部署目录：$DIR"
  echo "    本机地址：http://${bind:-127.0.0.1}:${port:-8787}"
  [ -n "$url" ] && echo "    访问地址：$url（需要反向代理，见 docs/deploy.md）"
  echo "    备份目录：$DIR/backups（保留最近 $KEEP_BACKUPS 次）"
}

do_install() {
  [ -z "$CID" ] || die "目录 $DIR 没有 .env，但已经存在 Nexus 容器：请用 --install-dir 指向它的部署目录"
  [ -z "$OTHER_DEPLOY" ] || die "这台主机已经部署在 $OTHER_DEPLOY：更新请运行 bash deploy.sh（或加 --install-dir $OTHER_DEPLOY），不要重复安装"
  docker inspect nexus >/dev/null 2>&1 && die "已经存在名为 nexus 的容器（不是由 Compose 创建）。请先确认它的用途，再处理后重新运行"
  TARGET="${VERSION:-$(latest_version)}"
  step "首次安装 Nexus v$TARGET 到 $DIR"
  mkdir -p "$DIR"
  chmod 755 "$DIR"
  LOG_FILE="$DIR/deploy.log"
  [ -n "$DOMAIN" ] || ask DOMAIN "访问域名（例如 home.example.com，留空则只在本机访问）" ""
  DOMAIN="${DOMAIN#http*://}"; DOMAIN="${DOMAIN%%/*}"
  local port bind
  ask bind "监听地址（反向代理在本机时保持 127.0.0.1）" "127.0.0.1"
  ask port "监听端口" "8787"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then die "端口 $port 已被占用，请换一个端口"; fi
  read_password
  IMAGE="$DEFAULT_IMAGE"
  ensure_image "$IMAGE:$TARGET"
  local hash secret
  hash="$(hash_password "$IMAGE:$TARGET")"
  PASSWORD=""
  if command -v openssl >/dev/null; then secret="$(openssl rand -base64 32)"; else secret="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"; fi
  fetch compose.yaml "$DIR/compose.yaml"
  chmod 644 "$DIR/compose.yaml"
  : >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  {
    echo "# 由 deploy.sh 生成（$(date '+%F')）。权限 600，切勿提交到 Git。"
    echo "NEXUS_VERSION=$TARGET"
    echo "# 访问密码的 Argon2id 哈希（不是密码本身）；修改密码：bash deploy.sh --password"
  } >>"$ENV_FILE"
  env_set NEXUS_PASSWORD_HASH "$hash"
  {
    echo "# 加密服务凭据（如 Linkwarden 令牌）的密钥，与访问密码无关，请另外妥善保存"
  } >>"$ENV_FILE"
  env_set NEXUS_SECRET "$secret"
  env_set NEXUS_PUBLIC_URL "${DOMAIN:+https://$DOMAIN}"
  env_set NEXUS_BIND "$bind"
  env_set NEXUS_PORT "$port"
  step "启动服务"
  compose up -d >/dev/null 2>&1 || { compose up -d; die "启动失败"; }
  wait_healthy || die "服务启动失败，见上方日志。配置保存在 $ENV_FILE，修正后重新运行本脚本即可"
  cp -f "$0" "$DIR/deploy.sh" 2>/dev/null && chmod 700 "$DIR/deploy.sh" || true
  print_summary "v$TARGET"
  if [ -n "$TTY_IN" ] && [ -t 1 ]; then
    echo
    echo "${C_Y}${C_B}请保存下面的加密密钥（NEXUS_SECRET，只显示这一次）：${C_0}"
    echo "    $secret"
    echo "它也保存在 $ENV_FILE 中；迁移服务器或丢失 .env 时需要它来解密已保存的服务凭据。"
  fi
  secret=""
  echo
  echo "以后更新：bash $DIR/deploy.sh"
}

do_update() {
  LOG_FILE="$DIR/deploy.log"
  container
  CURRENT="$(running_version)"
  [ -n "$CURRENT" ] || CURRENT="$(env_get NEXUS_VERSION)"
  [ "$CURRENT" = latest ] && CURRENT="unknown"
  IMAGE="$(env_get NEXUS_IMAGE)"; IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
  TARGET="${VERSION:-$(latest_version)}"
  local s pinned
  s="$(state)"
  pinned="$(env_get NEXUS_VERSION)"
  step "部署目录 $DIR · 当前 v$CURRENT（容器：${s%%|*}）→ 目标 v$TARGET"
  if [ "$CURRENT" != unknown ] && ver_lt "$TARGET" "$CURRENT"; then
    die "目标版本 v$TARGET 低于当前 v$CURRENT：不能直接降级（新版本可能已经升级了数据）。回滚请用 --restore"
  fi

  local needs_migration=0
  MIGRATED=0
  env_has NEXUS_PASSWORD && needs_migration=1
  if [ "$CURRENT" = "$TARGET" ] && [ "$pinned" = "$TARGET" ] && [ $needs_migration = 0 ] && [ "$s" = "running|healthy" ]; then
    ok "已经是 v$TARGET，服务运行正常，无需更新"
    return 0
  fi
  if [ "$CURRENT" = "$TARGET" ] && [ "$pinned" = "$TARGET" ] && [ $needs_migration = 0 ]; then
    step "版本一致，启动服务"
    compose up -d >/dev/null 2>&1 || compose up -d
    wait_healthy || die "服务无法启动，见上方日志"
    print_summary "v$TARGET"
    return 0
  fi

  ensure_image "$IMAGE:$TARGET"
  local tool="$IMAGE:$TARGET" rollback=""
  if [ -n "$MOUNT" ]; then
    step "更新前备份"
    backup_now "$tool" "v$CURRENT"
    rollback="$BACKUP"
    step "验证备份可以恢复（在隔离的临时容器中启动 v$CURRENT）"
    local was
    was="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null || true)"
    if [ -n "$was" ]; then
      verify_backup "$rollback" "$was" "$tool" || die "备份无法在临时容器中恢复启动，已停止更新（现有部署没有任何改动）。备份在 $rollback"
      ok "备份可以恢复"
    else
      warn "没有更新前的容器镜像，跳过启动验证（数据库一致性检查已通过）"
    fi
  else
    warn "还没有数据卷（服务从未启动过），无需备份"
  fi

  COMPOSE_LOCAL=0
  update_compose
  if [ "$COMPOSE_LOCAL" = 1 ] && ! grep -q NEXUS_PASSWORD_HASH "$DIR/compose.yaml"; then
    warn "本地 compose.yaml 不支持 NEXUS_PASSWORD_HASH，暂不迁移明文密码"
  else
    migrate_password "$tool"
  fi
  env_set NEXUS_VERSION "$TARGET"

  step "启动 v$TARGET"
  local started=0
  if compose up -d >/dev/null 2>&1 && wait_healthy; then
    started=1
    if [ "$MIGRATED" = 1 ] && [ -n "$rollback" ]; then
      if login_check "$rollback" "$tool"; then ok "已用原来的密码实际登录验证，登录正常"
      else warn "迁移后用原来的密码无法登录"; started=0; fi
    fi
  fi
  if [ $started = 1 ]; then
    print_summary "v$TARGET"
    log "updated $CURRENT -> $TARGET"
    return 0
  fi

  [ -n "$rollback" ] || die "服务没有正常启动，见上方日志（配置在 $ENV_FILE）"
  warn "更新失败，正在回滚到 v$CURRENT"
  compose stop >/dev/null 2>&1 || true
  restore_config "$rollback"
  # An old .env may say `latest`, which now means the failed version: pin what actually ran.
  case "$(env_get NEXUS_VERSION)" in "" | latest) [ "$CURRENT" != unknown ] && env_set NEXUS_VERSION "$CURRENT" ;; esac
  container
  restore_data "$rollback" "$tool" 0
  if compose up -d >/dev/null 2>&1 && wait_healthy; then
    die "已回滚到更新前的状态（v$CURRENT），服务恢复正常。更新失败的原因见上方日志"
  fi
  die "回滚后服务仍未正常，请手动检查：备份在 $rollback（见 README「回滚」）"
}

do_backup() {
  [ -f "$ENV_FILE" ] || die "没有找到部署（$DIR/.env 不存在）"
  LOG_FILE="$DIR/deploy.log"
  container
  CURRENT="$(running_version)"; [ -n "$CURRENT" ] || CURRENT="$(env_get NEXUS_VERSION)"
  IMAGE="$(env_get NEXUS_IMAGE)"; IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
  local tool="$IMAGE:$CURRENT"
  docker image inspect "$tool" >/dev/null 2>&1 && docker run --rm --entrypoint sh "$tool" -c 'test -f server/cli.mjs' 2>/dev/null ||
    { tool="$IMAGE:$(latest_version)"; ensure_image "$tool"; }
  backup_now "$tool" "v$CURRENT-manual"
}

do_verify() {
  [ -f "$ENV_FILE" ] || die "没有找到部署（$DIR/.env 不存在）"
  container
  local b
  if [ -n "$RESTORE_NAME" ] && [ "$RESTORE_NAME" != latest ]; then b="$DIR/backups/${RESTORE_NAME##*/}"
  else b="$(find "$DIR/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' 2>/dev/null | sort | tail -n 1)"; fi
  [ -n "$b" ] && [ -d "$b" ] || die "没有找到备份 ${RESTORE_NAME:-（最近一次）}"
  IMAGE="$(env_get NEXUS_IMAGE)"; IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
  local version img tool
  version="$(sed -n 's/^version=//p' "$b/manifest" 2>/dev/null)"
  img="$IMAGE:$version"
  [ -n "$version" ] && [ "$version" != unknown ] && docker image inspect "$img" >/dev/null 2>&1 || img="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null || true)"
  [ -n "$img" ] || die "找不到用于验证的镜像（$IMAGE:$version）"
  tool="$(docker inspect -f '{{.Image}}' "$CID" 2>/dev/null || echo "$img")"
  docker run --rm --entrypoint sh "$tool" -c 'test -f server/cli.mjs' >/dev/null 2>&1 || { tool="$IMAGE:$(latest_version)"; ensure_image "$tool"; }
  step "在隔离的临时容器中验证 $(basename "$b")（v${version:-?}）"
  verify_backup "$b" "$img" "$tool" || die "备份无法恢复启动"
  ok "备份 $(basename "$b") 可以恢复"
}

list_backups() {
  [ -d "$DIR/backups" ] || { echo "没有备份"; return 0; }
  local d
  for d in $(find "$DIR/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort -r); do
    printf '%s  %s  %s\n' "$(basename "$d")" "$(sed -n 's/^version=//p' "$d/manifest" 2>/dev/null)" "$(du -sh "$d" 2>/dev/null | cut -f1)"
  done
}

do_restore() {
  [ -f "$ENV_FILE" ] || die "没有找到部署（$DIR/.env 不存在）"
  LOG_FILE="$DIR/deploy.log"
  local b
  if [ -n "$RESTORE_NAME" ] && [ "$RESTORE_NAME" != latest ]; then b="$DIR/backups/${RESTORE_NAME##*/}"
  else b="$(find "$DIR/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' 2>/dev/null | sort | tail -n 1)"; fi
  [ -n "$b" ] && [ -d "$b" ] || die "没有找到备份 ${RESTORE_NAME:-（最近一次）}，用 --list-backups 查看"
  local version
  version="$(sed -n 's/^version=//p' "$b/manifest" 2>/dev/null)"
  step "恢复备份 $(basename "$b")（v${version:-?}）"
  confirm "恢复会用备份覆盖当前配置和数据库（恢复前会先备份当前状态），继续吗？" || die "已取消"
  container
  CURRENT="$(running_version)"; [ -n "$CURRENT" ] || CURRENT="$(env_get NEXUS_VERSION)"
  IMAGE="$(env_get NEXUS_IMAGE)"; IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
  local tool="$IMAGE:$CURRENT"
  docker run --rm --entrypoint sh "$tool" -c 'test -f server/cli.mjs' >/dev/null 2>&1 || { tool="$IMAGE:$(latest_version)"; ensure_image "$tool"; }
  backup_now "$tool" "v$CURRENT-before-restore"
  local safety="$BACKUP"
  compose stop >/dev/null 2>&1 || true
  restore_config "$b"
  restore_data "$b" "$tool" 1
  local v
  v="$(env_get NEXUS_VERSION)"
  ensure_image "$IMAGE:${v:-latest}"
  if compose up -d >/dev/null 2>&1 && wait_healthy; then
    print_summary "v${v:-?}"
    echo "    恢复前的状态已备份到 $safety"
    return 0
  fi
  die "恢复后服务未能启动，见上方日志。恢复前的状态在 $safety"
}

do_password() {
  [ -f "$ENV_FILE" ] || die "没有找到部署（$DIR/.env 不存在）"
  LOG_FILE="$DIR/deploy.log"
  container
  IMAGE="$(env_get NEXUS_IMAGE)"; IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
  CURRENT="$(running_version)"; [ -n "$CURRENT" ] || CURRENT="$(env_get NEXUS_VERSION)"
  local tool="$IMAGE:$CURRENT"
  docker run --rm --entrypoint sh "$tool" -c 'test -f server/cli.mjs' >/dev/null 2>&1 || die "当前版本 v$CURRENT 不支持密码哈希，请先更新：bash deploy.sh"
  grep -q NEXUS_PASSWORD_HASH "$DIR/compose.yaml" 2>/dev/null || die "compose.yaml 不支持 NEXUS_PASSWORD_HASH，请先更新：bash deploy.sh"
  read_password
  local h
  h="$(hash_password "$tool")"
  PASSWORD=""
  cp -p "$ENV_FILE" "$ENV_FILE.bak"
  env_set NEXUS_PASSWORD_HASH "$h"
  env_unset NEXUS_PASSWORD
  step "重启服务以应用新密码"
  if compose up -d >/dev/null 2>&1 && wait_healthy; then
    rm -f "$ENV_FILE.bak"
    ok "访问密码已更新，所有设备需要重新登录"
  else
    mv -f "$ENV_FILE.bak" "$ENV_FILE"
    compose up -d >/dev/null 2>&1 || true
    die "重启失败，已恢复原来的密码设置"
  fi
}

do_status() {
  container
  echo "部署目录：$DIR"
  echo "Compose 项目：${PROJECT:-nexus}${CONFIG_FILES[*]:+ · 文件：${CONFIG_FILES[*]}}"
  echo "容器：$(state) · 版本：v$(running_version)"
  echo "数据卷：${MOUNT:-（未找到）}"
  echo ".env：$([ -f "$ENV_FILE" ] && stat -c '%a' "$ENV_FILE" 2>/dev/null) · 密码：$(env_has NEXUS_PASSWORD_HASH && echo Argon2id 哈希 || { env_has NEXUS_PASSWORD && echo 明文（运行本脚本更新即可迁移）; } || echo 未设置)"
  echo "备份："
  list_backups | sed 's/^/    /'
}

# ── 入口 ───────────────────────────────────────────────────────────────────
preflight
locate
LOCK="$DIR/.deploy.lock"
if [ "$ACTION" != status ] && [ "$ACTION" != list ] && [ -d "$DIR" ]; then
  mkdir "$LOCK" 2>/dev/null || die "另一个 deploy.sh 正在操作 $DIR（如确认没有，删除 $LOCK）"
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
fi
case "$ACTION" in
  status) do_status ;;
  list) list_backups ;;
  backup) do_backup ;;
  restore) do_restore ;;
  verify) do_verify ;;
  password) do_password ;;
  auto) if [ -f "$ENV_FILE" ]; then do_update; else do_install; fi ;;
esac
