#!/usr/bin/env bash
# deploy.sh 的场景测试，在一台「干净的 Linux + Docker」里运行（见 run.sh：Docker-in-Docker）。
# 需要的镜像：kjoner/nexus-portal:0.1.0（旧版，明文密码）与待发布的 kjoner/nexus-portal:$NEW。
set -uo pipefail
NEW="${NEW:-0.3.0}"
DEPLOY="/src/scripts/deploy.sh"
export NEXUS_DEPLOY_SOURCE=/src NEXUS_LATEST_VERSION="$NEW" NEXUS_HEALTH_TIMEOUT=90
PASS=0 FAIL=0
pass() { PASS=$((PASS + 1)); printf '  \e[32mPASS\e[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
show() { [ "$FAIL" = "$1" ] || { printf '  --- %s
' "$2"; sed 's/^/    /' "$2"; }; } # show <fail count before> <log>
section() { printf '\n\e[1m== %s\e[0m\n' "$*"; }

H=(-H 'X-Nexus-Client: 1' -H 'content-type: application/json' -H 'origin: http://127.0.0.1:8787')
login() { curl -s -o /dev/null -w '%{http_code}' -c /tmp/jar "${H[@]}" --data "$(jq -cn --arg p "$1" '{password:$p}')" http://127.0.0.1:8787/api/auth/login; }
api() { curl -s -b /tmp/jar "${H[@]}" "$@"; }
pins() { api http://127.0.0.1:8787/api/config | jq -c '.config.pins'; }
health() { [ "$(docker inspect -f '{{.State.Health.Status}}' nexus 2>/dev/null)" = healthy ]; }
backups() { find "$1/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l; }
run() { # run <log> <args…>: deploy.sh with output captured
  local log="$1"; shift
  bash "$DEPLOY" "$@" >"$log" 2>&1
}

section "1. 全新服务器首次部署（非交互：--password-stdin）"
printf 'first-password-123\n' | bash "$DEPLOY" --install-dir /root/nexus --version "$NEW" --domain home.example.com --password-stdin --yes >/tmp/install.log 2>&1
code=$?
check "安装成功退出" test $code = 0
check "容器健康" health
check ".env 权限 600" test "$(stat -c %a /root/nexus/.env)" = 600
check ".env 只有 Argon2id 哈希" grep -qF "NEXUS_PASSWORD_HASH='\$argon2id\$v=19\$" /root/nexus/.env
check ".env 中没有明文密码" bash -c '! grep -q first-password-123 /root/nexus/.env'
check "输出与日志中没有密码" bash -c '! grep -q first-password-123 /tmp/install.log /root/nexus/deploy.log'
check "生成了 NEXUS_SECRET" grep -q "^NEXUS_SECRET='[A-Za-z0-9+/=]\{40,\}'" /root/nexus/.env
check "域名写入 NEXUS_PUBLIC_URL" grep -q "^NEXUS_PUBLIC_URL='https://home.example.com'" /root/nexus/.env
check "首次部署不做备份" test "$(backups /root/nexus)" = 0
check "能用新密码登录" test "$(login first-password-123)" = 200
check "错误密码被拒绝" test "$(login wrong-password-1)" = 401
check "复制了 deploy.sh 到部署目录" test -x /root/nexus/deploy.sh

section "2. 在部署目录内重复执行"
(cd /root/nexus && bash deploy.sh --yes) >/tmp/rerun.log 2>&1
check "重复执行成功" grep -q "无需更新" /tmp/rerun.log
check "没有产生多余备份" test "$(backups /root/nexus)" = 0
check "容器没有被重建" test "$(docker inspect -f '{{.RestartCount}}' nexus)" = 0

section "重复安装保护：同一主机上另一个目录"
printf 'x-password-123\n' | bash "$DEPLOY" --install-dir /root/second --password-stdin --yes >/tmp/second.log 2>&1
check "拒绝在另一个目录重复安装" grep -q "已经部署在 /root/nexus" /tmp/second.log
check "没有生成第二份配置" test ! -f /root/second/.env
(cd /root/nexus && docker compose down -v) >/dev/null 2>&1

section "3/4/6. 旧版部署：明文密码 + 多个 Compose 文件，从其他目录更新"
mkdir -p /srv/legacy && cd /srv/legacy || exit 1
cp /fixtures/compose-v0.1.0.yaml compose.yaml
cat >compose.override.yaml <<'EOF'
services:
  nexus:
    environment:
      NEXUS_SESSION_DAYS: "45"
EOF
cat >.env <<'EOF'
NEXUS_VERSION=latest
NEXUS_PASSWORD='legacy pa$s word'
NEXUS_SECRET=legacy-secret-0123456789abcdef
NEXUS_PUBLIC_URL=
NEXUS_BIND=127.0.0.1
NEXUS_PORT=8787
EOF
chmod 644 .env
docker tag kjoner/nexus-portal:0.1.0 kjoner/nexus-portal:latest
docker compose up -d >/dev/null 2>&1
for _ in $(seq 60); do health && break; sleep 2; done
check "旧版 0.1.0 运行中" health
check "旧版可用明文密码登录" test "$(login 'legacy pa$s word')" = 200
api -X POST http://127.0.0.1:8787/api/config/ops --data '{"clientId":"t","batchId":"seed-1","ops":[{"type":"pin.add","appId":"vercel"},{"type":"pin.move","appId":"notion","toIndex":0},{"type":"app.setHidden","appId":"reddit","hidden":true},{"type":"settings.patch","section":"home","patch":{"dockSize":6}}]}' >/dev/null
BEFORE="$(pins)"
cd /tmp || exit 1
run /tmp/update.log --yes
code=$?
check "从 /tmp 更新成功" test $code = 0
check "识别到 /srv/legacy" grep -q "部署目录 /srv/legacy" /tmp/update.log
check "已更新到 v$NEW" bash -c "docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \$(docker inspect -f '{{.Image}}' nexus) | grep -q NEXUS_VERSION=$NEW"
check ".env 固定为 v$NEW" grep -q "^NEXUS_VERSION='$NEW'" /srv/legacy/.env
check "明文密码已迁移为哈希" bash -c "grep -q '^NEXUS_PASSWORD_HASH=' /srv/legacy/.env && ! grep -q '^NEXUS_PASSWORD=' /srv/legacy/.env"
check "迁移后同一密码仍能登录" test "$(login 'legacy pa$s word')" = 200
check "脚本自己用原密码验证了登录" grep -q "登录正常" /tmp/update.log
check "固定顺序等数据完整" test "$(pins)" = "$BEFORE"
check "隐藏与设置保留" bash -c "curl -s -b /tmp/jar -H 'X-Nexus-Client: 1' http://127.0.0.1:8787/api/config | jq -e '.config.settings.home.dockSize == 6 and (.config.apps[] | select(.id==\"reddit\") | .hidden)'"
check "覆盖文件仍然生效" bash -c "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' nexus | grep -q NEXUS_SESSION_DAYS=45"
check "生成 1 份备份" test "$(backups /srv/legacy)" = 1
B="$(find /srv/legacy/backups -mindepth 1 -maxdepth 1 -type d | head -n 1)"
check "备份目录权限 700" test "$(stat -c %a "$B")" = 700
check "备份含 .env（600）" test "$(stat -c %a "$B/config/.env")" = 600
check "备份含两份 Compose 文件" test -f "$B/config/compose.yaml" -a -f "$B/config/compose.override.yaml"
check "备份含一致的数据库快照" grep -q '"integrity":"ok"' "$B/db-check.json"
check "备份含数据归档" test -s "$B/data.tar.gz"
check "更新输出不含明文密码" bash -c "! grep -q 'pa\$s word' /tmp/update.log /srv/legacy/deploy.log"
check "明文密码只留在备份的旧 .env 中" grep -q "legacy pa" "$B/config/.env"
check "更新前在临时容器中验证了备份" grep -q "备份可以恢复" /tmp/update.log
check "验证用的临时容器与数据卷已清理" bash -c '! docker ps -a --format "{{.Names}}" | grep -q nexus-verify && ! docker volume ls -q | grep -q nexus-verify'

section "5. 容器停止 / 不存在"
(cd /srv/legacy && docker compose stop) >/dev/null 2>&1
run /tmp/stopped.log --install-dir /srv/legacy --yes
check "停止的容器被启动" health
(cd /srv/legacy && docker compose down) >/dev/null 2>&1
run /tmp/absent.log --install-dir /srv/legacy --yes
check "删除的容器被重建" health
check "数据卷与数据保留" bash -c "test \"\$(curl -s -o /dev/null -w '%{http_code}' -c /tmp/jar -H 'X-Nexus-Client: 1' -H 'content-type: application/json' -H 'origin: http://127.0.0.1:8787' --data '{\"password\":\"legacy pa\$s word\"}' http://127.0.0.1:8787/api/auth/login)\" = 200"
check "固定顺序仍完整" test "$(pins)" = "$BEFORE"
check "没有多余备份" test "$(backups /srv/legacy)" = 1

section "7a. 更新失败自动回滚"
F0=$FAIL
printf 'FROM kjoner/nexus-portal:%s\nCMD ["node", "-e", "process.exit(1)"]\n' "$NEW" | docker build -q -t kjoner/nexus-portal:9.9.9 - >/dev/null
run /tmp/broken.log --install-dir /srv/legacy --version 9.9.9 --yes
code=$?
check "失败的更新返回非零" test $code != 0
check "提示已回滚" grep -q "已回滚到更新前的状态" /tmp/broken.log
check "回滚后健康" health
check ".env 回到 v$NEW" grep -q "^NEXUS_VERSION='$NEW'" /srv/legacy/.env
check "回滚后能登录" test "$(login 'legacy pa$s word')" = 200
check "回滚后数据完整" test "$(pins)" = "$BEFORE"
show "$F0" /tmp/broken.log

section "7b. 只保留最近 3 次备份"
for _ in 1 2 3 4; do run /tmp/backup.log --install-dir /srv/legacy --backup; sleep 1; done
check "只剩 3 份" test "$(backups /srv/legacy)" = 3

section "7b'. 单独验证备份，以及损坏的备份会被发现"
run /tmp/verify.log --install-dir /srv/legacy --verify-backup
check "最近一次备份可以恢复" grep -q "可以恢复" /tmp/verify.log
LATEST="$(find /srv/legacy/backups -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
cp -a "$LATEST" "${LATEST}-corrupt"
head -c 4096 "$LATEST/nexus.db" >"${LATEST}-corrupt/nexus.db"
run /tmp/verify-bad.log --install-dir /srv/legacy --verify-backup "$(basename "$LATEST")-corrupt"
check "损坏的备份验证失败" bash -c '! grep -q "可以恢复" /tmp/verify-bad.log'
rm -rf "${LATEST}-corrupt"

section "7c. 从备份恢复"
api -X POST http://127.0.0.1:8787/api/config/ops --data '{"clientId":"t","batchId":"after-1","ops":[{"type":"pin.remove","appId":"github"}]}' >/dev/null
check "恢复前确实改动了数据" test "$(pins)" != "$BEFORE"
run /tmp/restore.log --install-dir /srv/legacy --restore --yes
check "恢复成功" health
login 'legacy pa$s word' >/dev/null
AFTER_RESTORE="$(pins)"
check "恢复到最近一次备份的数据" test "$AFTER_RESTORE" = "$BEFORE"
check "恢复前状态也做了备份，总数仍为 3" test "$(backups /srv/legacy)" = 3

section "降级保护"
run /tmp/down.log --install-dir /srv/legacy --version 0.1.0 --yes
check "拒绝降级到 0.1.0" grep -q "不能直接降级" /tmp/down.log
check "降级被拒后仍健康" health

section "修改密码"
printf 'brand-new-pass-99\n' | bash "$DEPLOY" --install-dir /srv/legacy --password --password-stdin --yes >/tmp/pw.log 2>&1
check "新密码可以登录" test "$(login brand-new-pass-99)" = 200
check "旧密码失效" test "$(login 'legacy pa$s word')" = 401
check "输出不含新密码" bash -c '! grep -q brand-new-pass-99 /tmp/pw.log /srv/legacy/deploy.log'

section "状态"
bash "$DEPLOY" --install-dir /srv/legacy --status | sed 's/^/  /'

printf '\n共 %d 项通过，%d 项失败\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
