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
  `
  -- v8 (v0.4 · 我的收藏): items and pins in their own tables (需求 §8, 契约 §6). The home page's
  -- config.apps / config.pins become a view over them; an account's apps move here on first use
  -- (user_config.items_migrated), keeping their ids and the pin order.
  create table items (
    owner_id text not null references users (id),
    id text not null,
    kind text not null,
    source text not null,
    catalog_id text,
    title text not null,
    url text not null,
    url_key text not null,
    folder_id text not null,
    tags text not null default '[]',
    note text not null default '',
    icon_ref text not null default '',
    extra text not null default '',
    position double precision not null default 0,
    version integer not null,
    field_versions text not null default '{}',
    import_id text,
    created_at integer not null,
    updated_at integer not null,
    deleted_at integer,
    primary key (owner_id, id)
  );
  create index items_live on items (owner_id, deleted_at, position);
  create index items_url on items (owner_id, url_key);
  create index items_import on items (owner_id, import_id);
  -- A pin can only point at an item of the same account (composite key).
  create table pins (
    owner_id text not null,
    item_id text not null,
    layout text not null,
    position integer not null,
    primary key (owner_id, layout, item_id),
    foreign key (owner_id, item_id) references items (owner_id, id)
  );
  -- Per-account change sequence: what a client that has seen sequence N must apply next.
  create table item_changes (
    owner_id text not null references users (id),
    seq integer not null,
    entity text not null,
    entity_id text not null,
    version integer not null,
    action text not null,
    at integer not null,
    primary key (owner_id, seq)
  );
  -- Idempotency of item writes: the same opId replays its stored answer; a different request
  -- under the same opId is refused (IDEMPOTENCY_KEY_REUSED).
  create table item_ops (
    owner_id text not null references users (id),
    op_id text not null,
    request_hash text not null,
    status integer not null,
    result text not null,
    created_at integer not null,
    primary key (owner_id, op_id)
  );
  alter table user_config add column items_migrated integer not null default 0;
  alter table user_config add column item_seq integer not null default 0;
  `,
  `
  -- v9 (v0.4.1 · ADR-019 账号撤销): every account has an authorization epoch that only grows. Sessions,
  -- devices and approved pairings remember the epoch they were issued under; a different epoch means
  -- revoked, whatever raced with the revocation. Existing rows start at 0, so nothing changes on upgrade.
  alter table users add column auth_epoch integer not null default 0;
  -- When the identity service last confirmed the account is still enabled (中心停用检查, §2.5).
  alter table users add column identity_checked_at integer;
  alter table sessions add column auth_epoch integer not null default 0;
  alter table devices add column auth_epoch integer not null default 0;
  -- A device revoked by 退出全部设备 stays listed for a while; its token hash is replaced at the same
  -- moment, so even an older release (which only looks the hash up) can never use it again.
  alter table devices add column revoked_at integer;
  alter table devices add column revoked_reason text;
  -- Cross-product revocation (§2.4): events this product sends to the other one (an outbox: stored
  -- in the same transaction as the local revocation, delivered once at once, then retried)…
  create table revocation_outbox (
    id text primary key,
    user_id text not null references users (id),
    peer text not null,
    body text not null,
    reason text not null,
    state text not null,
    result text,
    attempts integer not null default 0,
    next_attempt_at integer,
    last_error text,
    created_at integer not null,
    expires_at integer not null,
    delivered_at integer,
    updated_at integer not null
  );
  create index revocation_outbox_due on revocation_outbox (state, next_attempt_at);
  create index revocation_outbox_user on revocation_outbox (user_id, created_at);
  -- …and events it received: deduplicated by event id, and the audit of who signed whom out.
  create table revocation_inbox (
    event_id text primary key,
    origin text not null,
    issuer text not null,
    subject text not null,
    scope text not null,
    reason text not null,
    occurred_at text not null,
    user_id text,
    result text not null,
    received_at integer not null
  );
  create index revocation_inbox_user on revocation_inbox (user_id, received_at);
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
  `
  -- v2 (v0.4 · 我的收藏): items and pins in their own tables (需求 §8, 契约 §6). The home page's
  -- config.apps / config.pins become a view over them; an account's apps move here on first use
  -- (user_config.items_migrated), keeping their ids and the pin order.
  create table items (
    owner_id text not null references users (id),
    id text not null,
    kind text not null,
    source text not null,
    catalog_id text,
    title text not null,
    url text not null,
    url_key text not null,
    folder_id text not null,
    tags text not null default '[]',
    note text not null default '',
    icon_ref text not null default '',
    extra text not null default '',
    position double precision not null default 0,
    version bigint not null,
    field_versions text not null default '{}',
    import_id text,
    created_at bigint not null,
    updated_at bigint not null,
    deleted_at bigint,
    primary key (owner_id, id)
  );
  create index items_live on items (owner_id, deleted_at, position);
  create index items_url on items (owner_id, url_key);
  create index items_import on items (owner_id, import_id);
  -- A pin can only point at an item of the same account (composite key).
  create table pins (
    owner_id text not null,
    item_id text not null,
    layout text not null,
    position integer not null,
    primary key (owner_id, layout, item_id),
    foreign key (owner_id, item_id) references items (owner_id, id)
  );
  -- Per-account change sequence: what a client that has seen sequence N must apply next.
  create table item_changes (
    owner_id text not null references users (id),
    seq bigint not null,
    entity text not null,
    entity_id text not null,
    version bigint not null,
    action text not null,
    at bigint not null,
    primary key (owner_id, seq)
  );
  -- Idempotency of item writes: the same opId replays its stored answer; a different request
  -- under the same opId is refused (IDEMPOTENCY_KEY_REUSED).
  create table item_ops (
    owner_id text not null references users (id),
    op_id text not null,
    request_hash text not null,
    status integer not null,
    result text not null,
    created_at bigint not null,
    primary key (owner_id, op_id)
  );
  alter table user_config add column items_migrated integer not null default 0;
  alter table user_config add column item_seq bigint not null default 0;
  `,
  `
  -- v3 (v0.4.1 · ADR-019 账号撤销): see SQLite v9.
  alter table users add column auth_epoch bigint not null default 0;
  alter table users add column identity_checked_at bigint;
  alter table sessions add column auth_epoch bigint not null default 0;
  alter table devices add column auth_epoch bigint not null default 0;
  alter table devices add column revoked_at bigint;
  alter table devices add column revoked_reason text;
  create table revocation_outbox (
    id text primary key,
    user_id text not null references users (id),
    peer text not null,
    body text not null,
    reason text not null,
    state text not null,
    result text,
    attempts integer not null default 0,
    next_attempt_at bigint,
    last_error text,
    created_at bigint not null,
    expires_at bigint not null,
    delivered_at bigint,
    updated_at bigint not null
  );
  create index revocation_outbox_due on revocation_outbox (state, next_attempt_at);
  create index revocation_outbox_user on revocation_outbox (user_id, created_at);
  create table revocation_inbox (
    event_id text primary key,
    origin text not null,
    issuer text not null,
    subject text not null,
    scope text not null,
    reason text not null,
    occurred_at text not null,
    user_id text,
    result text not null,
    received_at bigint not null
  );
  create index revocation_inbox_user on revocation_inbox (user_id, received_at);
  `,
];

