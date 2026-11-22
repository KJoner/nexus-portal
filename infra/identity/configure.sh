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
#   ./configure.sh profile show|apply|rollback <备份>
#                                                    用户名 / 昵称 / 邮箱（profiles/user-profile.json 与注册、登录开关）：
#                                                    apply 先备份到 backup/，再应用并回读核对；rollback 用备份恢复。
#                                                    与 theme 互不影响（theme off 不会撤回这里的改动）
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
  profile)
    # 用户名、昵称、邮箱各司其职（v12.0.3 I1）：用户名用于登录（注册后不能改，旧账号的用户名就是邮箱，照常可用），
    # 昵称用于展示（可重复、可留空），邮箱用于验证与找回；姓 / 名保留旧值，只对管理员可见。定义在
    # profiles/user-profile.json（不放进 realm/：导入目录里的每个 .json 都会被当成 realm 解析）。
    # 模板首次导入只带开关，资料定义一律由这里应用；可重复执行。账号身份（issuer + sub）与资产归属不受影响。
    #   show              打印当前的用户资料定义、相关开关与 nickname 声明的映射
    #   apply             先把当前定义与开关存进 backup/profile-<UTC 时间>.*，再应用并回读核对（不一致即失败）
    #   rollback <备份>   用 apply 存下的备份（profile-<时间>，不带后缀）恢复定义与开关。不删除任何数据：
    #                     已填的昵称、已注册的非邮箱用户名都留着（不重建账号，不改 sub）
    login
    flags='registrationEmailAsUsername,loginWithEmailAllowed,editUsernameAllowed,duplicateEmailsAllowed'
    squash() { tr -d ' \t\r\n'; }
    profile_scope="$(kc get client-scopes -r accounts --fields id,name --format csv --noquotes | sed -n 's/^\([^,]*\),profile$/\1/p' | head -n 1)"
    [ -n "$profile_scope" ] || { echo "找不到 profile 作用域" >&2; exit 1; }
    has_nickname_mapper() {
      kc get "client-scopes/$profile_scope/protocol-mappers/models" -r accounts | squash | grep -q '"claim.name":"nickname"'
    }
    case "${2:-}" in
      show)
        kc get users/profile -r accounts
        kc get realms/accounts --fields "$flags"
        if has_nickname_mapper; then echo "profile 作用域：有 nickname 声明的映射"; else echo "profile 作用域：没有 nickname 声明的映射"; fi
        ;;
      apply)
        [ -f profiles/user-profile.json ] || { echo "缺少 profiles/user-profile.json" >&2; exit 1; }
        mkdir -p backup
        stamp="backup/profile-$(date -u +%Y%m%dT%H%M%SZ)"
        kc get users/profile -r accounts > "$stamp.user-profile.json"
        kc get realms/accounts --fields "$flags" > "$stamp.realm.json"
        echo "已备份当前定义与开关：$stamp.user-profile.json、$stamp.realm.json"
        kc update users/profile -r accounts --no-merge -f - < profiles/user-profile.json
        kc update realms/accounts -s registrationEmailAsUsername=false -s loginWithEmailAllowed=true \
          -s editUsernameAllowed=false -s duplicateEmailsAllowed=false
        # 两个产品从 ID Token 的 nickname 取显示名：Keycloak 自带的 profile 作用域带这条映射；没有就补上
        if ! has_nickname_mapper; then
          kc create "client-scopes/$profile_scope/protocol-mappers/models" -r accounts -b '{"name":"nickname","protocol":"openid-connect","protocolMapper":"oidc-usermodel-attribute-mapper","config":{"user.attribute":"nickname","claim.name":"nickname","jsonType.label":"String","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true","introspection.token.claim":"true"}}'
          echo "已在 profile 作用域补上 nickname 声明的映射"
        fi
        # 回读核对：资料定义逐字（忽略空白）一致，开关逐项一致，映射存在
        if [ "$(kc get users/profile -r accounts | squash)" != "$(squash < profiles/user-profile.json)" ]; then
          echo "回读的用户资料定义与 profiles/user-profile.json 不一致（备份在 $stamp.*）" >&2; exit 1
        fi
        got="$(kc get realms/accounts --fields "$flags" | squash)"
        for want in '"registrationEmailAsUsername":false' '"loginWithEmailAllowed":true' '"editUsernameAllowed":false' '"duplicateEmailsAllowed":false'; do
          case "$got" in *"$want"*) ;; *) echo "回读的开关不对：缺少 $want（备份在 $stamp.*）" >&2; exit 1 ;; esac
        done
        has_nickname_mapper || { echo "回读：profile 作用域没有 nickname 声明的映射" >&2; exit 1; }
        echo "用户资料已应用并回读一致：注册填 用户名 / 昵称 / 邮箱（密码在验证邮箱后设置），登录用用户名或邮箱。"
        echo "回滚：$0 profile rollback $stamp"
        ;;
      rollback)
        base="${3:-}"
        base="${base%.user-profile.json}"; base="${base%.realm.json}"
        [ -n "$base" ] && [ -f "$base.user-profile.json" ] && [ -f "$base.realm.json" ] || { echo "用法：$0 profile rollback backup/profile-<时间>" >&2; exit 2; }
        kc update users/profile -r accounts --no-merge -f - < "$base.user-profile.json"
        kc update realms/accounts -f - < "$base.realm.json"
        if [ "$(kc get users/profile -r accounts | squash)" != "$(squash < "$base.user-profile.json")" ]; then
          echo "回读的用户资料定义与备份不一致" >&2; exit 1
        fi
        echo "已按 $base 恢复用户资料定义与开关。已有的昵称、用户名、账号与资产都没有改动。"
        ;;
      *) echo "用法：$0 profile show|apply|rollback <备份>" >&2; exit 2 ;;
    esac
    ;;
  *)
    sed -n '2,27p' "$0"
    exit 2
    ;;
esac
