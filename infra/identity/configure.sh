#!/bin/sh
# 统一身份的日常运维（Keycloak 只在 realm 不存在时导入模板，之后的修改走这里）。
#
#   ./configure.sh registration closed|invite|open   切换身份服务侧的自助注册
#   ./configure.sh smtp                              按 .env 里的 SMTP_* 重新设置发信
#   ./configure.sh rotate-secret nexus-web|litesync-web
#                                                    重新生成 client secret 并输出一次；
#                                                    随后必须更新对应产品的配置并重启它
#   ./configure.sh revocation                        账号撤销（ADR-019）：两个 client 开启只读服务账号，
#                                                    加上 roles 作用域与 manage-account / view-users 映射；
#                                                    已部署的 realm 用它补上模板的新内容，可重复执行
#   ./configure.sh texts                             账号中心「设备活动」页改成如实的说法（只管浏览器登录，
#                                                    不含 Obsidian 与扩展）；已部署的 realm 用它补上，可重复执行
#   ./configure.sh theme on|off                      账号中心主题（themes/）：on 让登录、账号、邮件使用 accounts，
#                                                    两个产品的登录页用各自的子主题；off 回到 Keycloak 自带主题。
#                                                    需要 compose 已挂载 ./themes（改动 compose 后要重建容器）
#
# 不用 compose 时（例如一次性的本机容器），KC_EXEC 指定进入 Keycloak 容器的方式：
#   KC_EXEC="docker exec -i <容器名>" ./configure.sh revocation
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

# shellcheck disable=SC2086 # KC_EXEC is a command line on purpose
kc() { ${KC_EXEC:-docker compose exec -T keycloak} /opt/keycloak/bin/kcadm.sh "$@"; }
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
  revocation)
    # ADR-019：用户本人结束自己的全部会话（Account REST，需要令牌带 account/manage-account），
    # 产品查询账号是否被停用 / 删除（只读服务账号，realm-management/view-users，不授 manage-users）。
    # 两个 client 都是 fullScopeAllowed=false：令牌只带作用域映射里的角色，所以两项都要进映射，
    # 并且要有 roles 作用域（它把 resource_access 与 aud 写进令牌）。普通用户没有 view-users，
    # 这条映射不会给他们任何权限。
    login
    realm_mgmt="$(client_uuid realm-management)"
    account="$(client_uuid account)"
    roles_scope="$(kc get client-scopes -r accounts --fields id,name --format csv --noquotes | sed -n 's/^\([^,]*\),roles$/\1/p' | head -n 1)"
    if [ -z "$realm_mgmt" ] || [ -z "$account" ] || [ -z "$roles_scope" ]; then echo "找不到 realm-management / account client 或 roles 作用域" >&2; exit 1; fi
    view_users="$(kc get "clients/$realm_mgmt/roles/view-users" -r accounts --fields id,name)"
    manage_account="$(kc get "clients/$account/roles/manage-account" -r accounts --fields id,name)"
    for client in nexus-web litesync-web; do
      id="$(client_uuid "$client")"
      [ -n "$id" ] || { echo "找不到 client $client" >&2; exit 1; }
      kc update "clients/$id" -r accounts -s serviceAccountsEnabled=true
      kc update "clients/$id/default-client-scopes/$roles_scope" -r accounts -b '{}'
      kc create "clients/$id/scope-mappings/clients/$account" -r accounts -b "[$manage_account]"
      kc create "clients/$id/scope-mappings/clients/$realm_mgmt" -r accounts -b "[$view_users]"
      kc add-roles -r accounts --uusername "service-account-$client" --cclientid realm-management --rolename view-users
      echo "$client：服务账号只读（realm-management/view-users）；作用域映射 account/manage-account + realm-management/view-users"
    done
    echo "完成。Nexus 设置 NEXUS_IDENTITY_STATUS_CHECK=on，LiteSync 按它的文档开启中心停用检查，重启后在各自的管理员页面确认生效；"
    echo "然后运行 node scripts/smoke/verify-realm.mjs 回读核对（本机一次性实例）。"
    ;;
  theme)
    login
    # off：显式写回 Keycloak 自带主题名（kcadm 的部分更新会忽略空值与 null，清不掉）
    case "${2:-}" in
      on) login_theme=accounts account_theme=accounts email_theme=accounts nexus_theme=accounts-nexus litesync_theme=accounts-litesync ;;
      off) login_theme=keycloak.v2 account_theme=keycloak.v3 email_theme=keycloak nexus_theme='' litesync_theme='' ;;
      *) echo "用法：$0 theme on|off" >&2; exit 2 ;;
    esac
    kc update realms/accounts -s "loginTheme=$login_theme" -s "accountTheme=$account_theme" -s "emailTheme=$email_theme"
    for pair in "nexus-web:$nexus_theme" "litesync-web:$litesync_theme"; do
      client=${pair%%:*}
      kc update "clients/$(client_uuid "$client")" -r accounts -s "attributes.login_theme=${pair#*:}"
    done
    echo "账号中心主题：$([ "$login_theme" = accounts ] && echo 已启用 || echo 已恢复 Keycloak 自带主题)"
    ;;
  texts)
    # 账号中心「设备活动」页的说法（ADR-019「账号中心自带的设备页」）：它只列、只退出浏览器里的账号中心登录，
    # 已连接的 Obsidian 与浏览器扩展是产品发的设备凭据，不在那里。Keycloak 自带的「登出所有设备 /
    # 此操作将登出所有已登入您帐号的设备」会让人以为 Obsidian 也断开了（预发布真机验收实测：点了之后 Obsidian 照常同步）。
    # 用 realm 本地化覆盖改成「网页登录 / 退出所有浏览器」，并指向产品里的「退出所有产品与设备」。
    # 模板首次导入时已带上（localizationTexts）；已部署的 realm 用这里补上，可重复执行（按键合并写入，不动其他覆盖）。
    login
    for locale in zh-CN en; do
      kc create "realms/accounts/localization/$locale" -f - < "texts/account-texts.$locale.json"
      echo "已写入账号中心文案覆盖：$locale"
    done
    ;;
  *)
    sed -n '2,23p' "$0"
    exit 2
    ;;
esac
