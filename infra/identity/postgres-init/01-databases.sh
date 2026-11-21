#!/bin/sh
# 首次初始化：三个数据库、三个角色、互不可连（ADR-018：同一实例 ≠ 共用万能账号）。
# 只在空数据目录第一次启动时由 postgres 镜像执行；之后改密码请用 ALTER ROLE。
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v keycloak_pw="$KEYCLOAK_DB_PASSWORD" \
  -v nexus_pw="$NEXUS_DB_PASSWORD" \
  -v litesync_pw="$LITESYNC_DB_PASSWORD" <<'SQL'
-- 角色：只能登录，不能建库、建角色，也不继承超级用户权限
CREATE ROLE keycloak     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'keycloak_pw';
CREATE ROLE nexus_app    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'nexus_pw';
CREATE ROLE litesync_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'litesync_pw';

CREATE DATABASE keycloak OWNER keycloak;
CREATE DATABASE nexus    OWNER nexus_app;
-- LiteSync 必须是字节序（C）排序：文件路径的排序与分页游标要和它的 SQLite（BINARY）逐字节一致，
-- 按语言区域排序（镜像默认 en_US.utf8）会让对账与游标漂移；LiteSync 的 PostgreSQL 模式启动时
-- 检查 datcollate ∈ {C, POSIX, C.UTF-8}，不满足就拒绝启动。template0 才允许指定与模板不同的排序。
CREATE DATABASE litesync OWNER litesync_app TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';

-- 默认任何角色都能连接任何库；收回，只留给各自的属主
REVOKE CONNECT, TEMPORARY ON DATABASE keycloak FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE nexus    FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE litesync FROM PUBLIC;
GRANT CONNECT ON DATABASE keycloak TO keycloak;
GRANT CONNECT ON DATABASE nexus    TO nexus_app;
GRANT CONNECT ON DATABASE litesync TO litesync_app;
SQL

# 每个库的 public schema 只给属主建表（PostgreSQL 15 起默认已收回 PUBLIC 的 CREATE，这里显式再写一遍）
for pair in keycloak:keycloak nexus:nexus_app litesync:litesync_app; do
  db=${pair%%:*}
  owner=${pair#*:}
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO $owner;
ALTER SCHEMA public OWNER TO $owner;
SQL
done
