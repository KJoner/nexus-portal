#!/bin/sh
# 统一身份的日常运维（Keycloak 只在 realm 不存在时导入模板，之后的修改走这里）。
#
#   ./configure.sh registration closed|invite|open   切换身份服务侧的自助注册
#   ./configure.sh smtp                              按 .env 里的 SMTP_* 重新设置发信
#   ./configure.sh rotate-secret nexus-web|litesync-web
#                                                    重新生成 client secret 并输出一次；
#                                                    随后必须更新对应产品的配置并重启它
#
# 注册开关是两层的：身份服务（这里）决定能不能在账号中心创建账号；每个产品自己的
# NEXUS_REGISTRATION_MODE / OBSYNC_REGISTRATION_MODE 决定新身份第一次进入时能不能建立
# 产品账号（invite 模式需要一次性邀请码）。紧急关闭注册：两层都设成 closed。
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "缺少 .env（复制 .env.example 后填写）" >&2; exit 1; }
set -a
. ./.env
set +a

kc() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
login() {
  # 管理员口令只经过容器内进程参数，不写入任何文件或日志
  kc config credentials --server http://localhost:8080 --realm master \
    --user "${KEYCLOAK_BOOTSTRAP_ADMIN:-temp-admin}" --password "$KEYCLOAK_BOOTSTRAP_PASSWORD" >/dev/null
}
client_uuid() {
  kc get clients -r accounts -q "clientId=$1" --fields id | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -n 1
}

case "${1:-}" in
  registration)
    mode="${2:-}"
    case "$mode" in
      closed) allowed=false ;;
      invite|open) allowed=true ;;
      *) echo "用法：$0 registration closed|invite|open" >&2; exit 2 ;;
    esac
    login
    kc update realms/accounts -s "registrationAllowed=$allowed"
    echo "身份服务自助注册：$allowed。请同时把各产品设为 $mode："
    echo "  Nexus：NEXUS_REGISTRATION_MODE=$mode    LiteSync：OBSYNC_REGISTRATION_MODE=$mode    然后重启它们"
    ;;
  smtp)
    # 加密方式：465 端口默认 ssl（隐式 TLS），其它端口默认 starttls；none 只用于本机测试收信器
    security="${SMTP_SECURITY:-}"
    [ -n "$security" ] || { if [ "$SMTP_PORT" = 465 ]; then security=ssl; else security=starttls; fi; }
    case "$security" in
      ssl) ssl=true starttls=false ;;
      starttls) ssl=false starttls=true ;;
      none) ssl=false starttls=false ;;
      *) echo "SMTP_SECURITY 只能是 starttls / ssl / none" >&2; exit 2 ;;
    esac
    # 没有 SMTP_USER 就不做 SMTP 认证（服务商的 relay 一般都需要；本机测试收信器不需要）
    if [ -n "${SMTP_USER:-}" ]; then auth=true; else auth=false; fi
    login
    kc update realms/accounts \
      -s "smtpServer.host=$SMTP_HOST" -s "smtpServer.port=$SMTP_PORT" \
      -s "smtpServer.from=$SMTP_FROM" -s "smtpServer.fromDisplayName=$SMTP_FROM_NAME" \
      -s "smtpServer.replyTo=${SMTP_REPLY_TO:-}" -s "smtpServer.auth=$auth" \
      -s "smtpServer.user=${SMTP_USER:-}" -s "smtpServer.password=${SMTP_PASSWORD:-}" \
      -s "smtpServer.starttls=$starttls" -s "smtpServer.ssl=$ssl"
    echo "已更新发信设置（加密：$security，认证：$auth）。请在管理控制台 Realm settings › Email 点「Test connection」实测。"
    ;;
  rotate-secret)
    client="${2:-}"
    case "$client" in nexus-web|litesync-web) ;; *) echo "用法：$0 rotate-secret nexus-web|litesync-web" >&2; exit 2 ;; esac
    login
    id="$(client_uuid "$client")"
    [ -n "$id" ] || { echo "找不到 client $client" >&2; exit 1; }
    kc create "clients/$id/client-secret" -r accounts >/dev/null
    secret="$(kc get "clients/$id/client-secret" -r accounts | sed -n 's/.*"value" *: *"\([^"]*\)".*/\1/p')"
    echo "新的 $client secret（只显示这一次，旧值已失效）："
    echo "$secret"
    if [ "$client" = nexus-web ]; then echo "→ 写入 Nexus 的 NEXUS_OIDC_CLIENT_SECRET 并重启 Nexus"; else echo "→ 写入 LiteSync 的 OBSYNC_OIDC_CLIENT_SECRET 并重启 LiteSync"; fi
    ;;
  *)
    sed -n '2,15p' "$0"
    exit 2
    ;;
esac
