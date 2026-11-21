/**
 * SQLite schema, append-only; `user_version` records how many have run. v1–v6 are the single-user
 * releases (0.1–0.3); v7 (0.4) turns the database into accounts with an owner on every row.
 */
export const MIGRATIONS: readonly string[] = [
  `
  create table meta (key text primary key, value text not null);

  -- The whole portal configuration is one validated JSON document. All writes go through the
  -- shared op reducer, so the document is the single source of truth for apps, pins and settings.
  create table config (
    id integer primary key check (id = 1),
    revision integer not null,
    updated_at text not null,
    data text not null
  );

  -- Applied op batches: makes retries idempotent and keeps a short audit trail.
  create table op_log (
    revision integer primary key,
    batch_id text not null unique,
    client_id text not null,
    ops text not null,
    created_at text not null
  );

  create table auth (
    id integer primary key check (id = 1),
    password_hash text not null,
    updated_at text not null
  );

  create table sessions (
    id_hash text primary key,
    created_at integer not null,
    expires_at integer not null,
    last_seen integer not null,
    user_agent text not null default ''
  );
  create index sessions_expiry on sessions (expires_at);

  create table wallpapers (
    id text primary key,
    name text not null,
    width integer not null,
    height integer not null,
    widths text not null,
    placeholder text not null,
    created_at text not null
  );
  `,
  `
  -- Last health result per service; the checker resumes from here after a restart.
  create table health_status (
    app_id text primary key,
    level text not null,
    message text not null,
    checked_at text not null,
    latency_ms integer,
    fails integer not null default 0,
    key text not null,
    via text not null default 'ext'
  );
  `,
  `
  -- Credentials for read-only integrations; token_enc is AES-256-GCM (see integrations/secret.ts).
  create table integrations (
    id text primary key,
    base_url text not null,
    token_enc text not null,
    token_last4 text not null,
    last_ok_at text,
    last_error text,
    updated_at text not null
  );
  `,
  `
  -- v0.2: the configuration document can hold up to 36 pins and new settings that v0.1 cannot
  -- read (it would silently fall back to defaults). Bumping the version makes older releases
  -- refuse this database instead; rolling back means restoring the automatic backup.
  insert or replace into meta (key, value) values ('config_format', '2');
  `,
  `
  -- v0.2: wallpapers from public sources (精选图库, 每日一图, Unsplash, imported addresses).
  alter table wallpapers add column source text not null default 'upload';
  alter table wallpapers add column ref text not null default '';
  alter table wallpapers add column credit text not null default '';
  alter table wallpapers add column luma real;
  alter table wallpapers add column focal text not null default '';
  alter table wallpapers add column remote text not null default '';
  create index wallpapers_source_ref on wallpapers (source, ref);
  `,
  `
  -- v0.3: devices (the Chrome extension) that read the configuration with their own token.
  -- Only the token's SHA-256 is stored; deleting a row revokes the device.
  create table devices (
    id text primary key,
    name text not null,
    token_hash text not null unique,
    created_at integer not null,
    last_used_at integer,
    user_agent text not null default ''
  );
  `,
  `
  -- v0.4 (公开化批次 C): accounts. Everything that existed before belongs to the one person who
  -- ran this portal: the legacy administrator. Nothing is ever handed to a new account.
  create table users (
    id text primary key,
    issuer text,
    subject text,
    email text not null default '',
    email_verified integer not null default 0,
    display_name text not null default '',
    is_admin integer not null default 0,
    disabled integer not null default 0,
    created_via text not null,
    created_at integer not null,
    last_login_at integer
  );
  create unique index users_identity on users (issuer, subject) where issuer is not null;
  insert into users (id, display_name, is_admin, created_via, created_at) values ('legacy-admin', '管理员', 1, 'legacy', cast(strftime('%s', 'now') as integer) * 1000);

  -- One configuration document per account (it was a single row).
  create table user_config (
    owner_id text primary key references users (id),
    revision integer not null,
    updated_at text not null,
    data text not null
  );
  insert into user_config (owner_id, revision, updated_at, data) select 'legacy-admin', revision, updated_at, data from config where id = 1;
  drop table config;

  -- Idempotent op batches, per account (one person's retry must never match another's batch id).
  create table op_log_v7 (
    owner_id text not null references users (id),
    revision integer not null,
    batch_id text not null,
    client_id text not null,
    ops text not null,
    created_at text not null,
    primary key (owner_id, revision)
  );
  insert into op_log_v7 select 'legacy-admin', revision, batch_id, client_id, ops, created_at from op_log;
  drop table op_log;
  alter table op_log_v7 rename to op_log;
  create unique index op_log_batch on op_log (owner_id, batch_id);

  -- Sessions name their account; password sessions so far were the administrator's.
  create table sessions_v7 (
    id_hash text primary key,
    user_id text not null references users (id),
    created_at integer not null,
    expires_at integer not null,
    last_seen integer not null,
    user_agent text not null default '',
    kind text not null default 'password',
    oidc_sid text,
    refresh_enc text,
    id_token_enc text,
    revalidate_at integer
  );
  insert into sessions_v7 (id_hash, user_id, created_at, expires_at, last_seen, user_agent) select id_hash, 'legacy-admin', created_at, expires_at, last_seen, user_agent from sessions;
  drop table sessions;
  alter table sessions_v7 rename to sessions;
  create index sessions_expiry on sessions (expires_at);
  create index sessions_user on sessions (user_id);
  create index sessions_sid on sessions (oidc_sid);

  create table wallpapers_v7 (
    id text primary key,
    owner_id text not null references users (id),
    name text not null,
    width integer not null,
    height integer not null,
    widths text not null,
    placeholder text not null,
    created_at text not null,
    source text not null default 'upload',
    ref text not null default '',
    credit text not null default '',
    luma real,
    focal text not null default '',
    remote text not null default ''
  );
  insert into wallpapers_v7 select id, 'legacy-admin', name, width, height, widths, placeholder, created_at, source, ref, credit, luma, focal, remote from wallpapers;
  drop table wallpapers;
  alter table wallpapers_v7 rename to wallpapers;
  create index wallpapers_owner on wallpapers (owner_id, created_at);
  create index wallpapers_source_ref on wallpapers (owner_id, source, ref);

  -- Uploaded app icons, so each one is served to its owner only (rows for existing files are
  -- added at start-up, see backfillIcons).
  create table icons (
    id text primary key,
    owner_id text not null references users (id),
    created_at integer not null
  );
  create index icons_owner on icons (owner_id);

  -- Health checks and integrations are the administrator's tools; rows name the account anyway.
  create table health_status_v7 (
    owner_id text not null references users (id),
    app_id text not null,
    level text not null,
    message text not null,
    checked_at text not null,
    latency_ms integer,
    fails integer not null default 0,
    key text not null,
    via text not null default 'ext',
    primary key (owner_id, app_id)
  );
  insert into health_status_v7 select 'legacy-admin', app_id, level, message, checked_at, latency_ms, fails, key, via from health_status;
  drop table health_status;
  alter table health_status_v7 rename to health_status;

  create table integrations_v7 (
    owner_id text not null references users (id),
    id text not null,
    base_url text not null,
    token_enc text not null,
    token_last4 text not null,
    last_ok_at text,
    last_error text,
    updated_at text not null,
    primary key (owner_id, id)
  );
  insert into integrations_v7 select 'legacy-admin', id, base_url, token_enc, token_last4, last_ok_at, last_error, updated_at from integrations;
  drop table integrations;
  alter table integrations_v7 rename to integrations;

  -- Paired devices name their account and what they may do. Tokens issued before v0.4 could only
  -- read the configuration, and that is all they keep (never upgraded silently).
  create table devices_v7 (
    id text primary key,
    owner_id text not null references users (id),
    name text not null,
    token_hash text not null unique,
    scopes text not null default 'config:read',
    created_at integer not null,
    last_used_at integer,
    user_agent text not null default ''
  );
  insert into devices_v7 (id, owner_id, name, token_hash, scopes, created_at, last_used_at, user_agent) select id, 'legacy-admin', name, token_hash, 'config:read', created_at, last_used_at, user_agent from devices;
  drop table devices;
  alter table devices_v7 rename to devices;
  create index devices_owner on devices (owner_id);

  -- OIDC sign-in in progress (state, nonce, PKCE verifier), bound to the browser that started it.
  create table login_intents (
    id_hash text primary key,
    kind text not null,
    state text not null,
    nonce text not null,
    verifier text not null,
    return_to text not null,
    link_user_id text,
    invite_code text,
    created_at integer not null,
    expires_at integer not null
  );

  create table invites (
    code_hash text primary key,
    created_by text not null references users (id),
    created_at integer not null,
    expires_at integer not null,
    used_at integer,
    used_by text
  );

  -- Product notification mail (契约 §7): an outbox, so a provider outage never loses a message
  -- and a retry never sends it twice.
  create table mail_outbox (
    id text primary key,
    idempotency_key text not null unique,
    template text not null,
    recipient text not null,
    recipient_hash text not null,
    data text not null,
    status text not null,
    attempts integer not null default 0,
    next_attempt_at integer not null,
    last_error_code text,
    provider_message_id text,
    created_at integer not null,
    updated_at integer not null
  );
  create index mail_outbox_due on mail_outbox (status, next_attempt_at);
  create table mail_suppression (
    recipient_hash text primary key,
    reason text not null,
    created_at integer not null
  );

  insert or replace into meta (key, value) values ('config_format', '3');
  `,
];

/**
 * PostgreSQL schema (public deployments, `NEXUS_DATABASE_URL`). Starts at the multi-account form of
 * SQLite v7; applied versions are recorded in `schema_migrations`. Integers that can exceed 2³¹
 * (timestamps in ms, revisions) are bigint. Keep the two schemas equivalent: the same repository
 * code and tests run against both.
 */
export const PG_MIGRATIONS: readonly string[] = [
  `
  create table meta (key text primary key, value text not null);

  create table users (
    id text primary key,
    issuer text,
    subject text,
    email text not null default '',
    email_verified integer not null default 0,
    display_name text not null default '',
    is_admin integer not null default 0,
    disabled integer not null default 0,
    created_via text not null,
    created_at bigint not null,
    last_login_at bigint
  );
  create unique index users_identity on users (issuer, subject) where issuer is not null;
  insert into users (id, display_name, is_admin, created_via, created_at) values ('legacy-admin', '管理员', 1, 'legacy', (extract(epoch from now()) * 1000)::bigint) on conflict do nothing;

  create table user_config (
    owner_id text primary key references users (id),
    revision bigint not null,
    updated_at text not null,
    data text not null
  );

  create table op_log (
    owner_id text not null references users (id),
    revision bigint not null,
    batch_id text not null,
    client_id text not null,
    ops text not null,
    created_at text not null,
    primary key (owner_id, revision)
  );
  create unique index op_log_batch on op_log (owner_id, batch_id);

  create table auth (
    id integer primary key check (id = 1),
    password_hash text not null,
    updated_at text not null
  );

  create table sessions (
    id_hash text primary key,
    user_id text not null references users (id),
    created_at bigint not null,
    expires_at bigint not null,
    last_seen bigint not null,
    user_agent text not null default '',
    kind text not null default 'password',
    oidc_sid text,
    refresh_enc text,
    id_token_enc text,
    revalidate_at bigint
  );
  create index sessions_expiry on sessions (expires_at);
  create index sessions_user on sessions (user_id);
  create index sessions_sid on sessions (oidc_sid);

  create table wallpapers (
    id text primary key,
    owner_id text not null references users (id),
    name text not null,
    width integer not null,
    height integer not null,
    widths text not null,
    placeholder text not null,
    created_at text not null,
    source text not null default 'upload',
    ref text not null default '',
    credit text not null default '',
    luma double precision,
    focal text not null default '',
    remote text not null default ''
  );
  create index wallpapers_owner on wallpapers (owner_id, created_at);
  create index wallpapers_source_ref on wallpapers (owner_id, source, ref);

  create table icons (
    id text primary key,
    owner_id text not null references users (id),
    created_at bigint not null
  );
  create index icons_owner on icons (owner_id);

  create table health_status (
    owner_id text not null references users (id),
    app_id text not null,
    level text not null,
    message text not null,
    checked_at text not null,
    latency_ms integer,
    fails integer not null default 0,
    key text not null,
    via text not null default 'ext',
    primary key (owner_id, app_id)
  );

  create table integrations (
    owner_id text not null references users (id),
    id text not null,
    base_url text not null,
    token_enc text not null,
    token_last4 text not null,
    last_ok_at text,
    last_error text,
    updated_at text not null,
    primary key (owner_id, id)
  );

  create table devices (
    id text primary key,
    owner_id text not null references users (id),
    name text not null,
    token_hash text not null unique,
    scopes text not null default 'config:read',
    created_at bigint not null,
    last_used_at bigint,
    user_agent text not null default ''
  );
  create index devices_owner on devices (owner_id);

  create table login_intents (
    id_hash text primary key,
    kind text not null,
    state text not null,
    nonce text not null,
    verifier text not null,
    return_to text not null,
    link_user_id text,
    invite_code text,
    created_at bigint not null,
    expires_at bigint not null
  );

  create table invites (
    code_hash text primary key,
    created_by text not null references users (id),
    created_at bigint not null,
    expires_at bigint not null,
    used_at bigint,
    used_by text
  );

  create table mail_outbox (
    id text primary key,
    idempotency_key text not null unique,
    template text not null,
    recipient text not null,
    recipient_hash text not null,
    data text not null,
    status text not null,
    attempts integer not null default 0,
    next_attempt_at bigint not null,
    last_error_code text,
    provider_message_id text,
    created_at bigint not null,
    updated_at bigint not null
  );
  create index mail_outbox_due on mail_outbox (status, next_attempt_at);
  create table mail_suppression (
    recipient_hash text primary key,
    reason text not null,
    created_at bigint not null
  );

  -- Where this database came from when it was migrated from SQLite (re-running is a no-op).
  create table migration_source (
    id integer primary key check (id = 1),
    fingerprint text not null,
    migrated_at bigint not null,
    report text not null
  );

  insert into meta (key, value) values ('config_format', '3') on conflict (key) do update set value = excluded.value;
  `,
];
