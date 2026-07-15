-- Consolidated schema for a self-hosted Postgres (replaces supabase/migrations/*).
-- Applied automatically by the official postgres image on first start via
-- /docker-entrypoint-initdb.d. The app server is the single point of access,
-- so there is no RLS and no per-role grants: every query filters by user_id.

-- Users (replaces Supabase Auth). UUIDs are preserved on import from
-- auth.users so all FKs keep working. password_hash is null for Google-only
-- accounts; google_sub is null for password-only accounts.
create table users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    password_hash text,
    google_sub text unique,
    email_verified boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- The app lowercases emails before writing; the functional index guards
-- against duplicates sneaking in through imports.
create unique index users_email_lower_key on users (lower(email));

-- User profiles. One row per user; stores IANA timezone and display prefs.
create table profiles (
    user_id uuid primary key references users (id) on delete cascade,
    timezone text not null default 'UTC',
    -- Deliberately nullable with NO default: NULL means "never chosen", which
    -- lets write paths refuse to guess a unit. Display paths fall back to kg.
    preferred_weight_unit text check (
        preferred_weight_unit is null
        or preferred_weight_unit in ('kg', 'lb')
    ),
    -- User's own LLM API key for /api/chat; NULL falls back to the server key.
    llm_api_key text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Daily nutrition targets per user. One row per user, upserted on set.
create table nutrition_goals (
    user_id uuid primary key references users (id) on delete cascade,
    daily_calories integer,
    daily_protein_g numeric(6, 2),
    daily_carbs_g numeric(6, 2),
    daily_fat_g numeric(6, 2),
    daily_water_ml integer,
    -- Target body weight, stored canonically in grams.
    target_weight_g integer check (target_weight_g > 0),
    updated_at timestamptz not null default now()
);

create table meals (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    logged_at timestamptz not null default now(),
    meal_type text check (
        meal_type = any (array['breakfast', 'lunch', 'dinner', 'snack'])
    ),
    description text not null,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    notes text,
    idempotency_key text
);

create index idx_meals_user_id on meals (user_id);

create index idx_meals_logged_at on meals (logged_at);

-- Retry-safe writes: a second insert with the same (user_id, idempotency_key)
-- hits 23505 and the app returns the original row instead of duplicating.
create unique index uniq_meals_user_idem on meals (user_id, idempotency_key)
where
    idempotency_key is not null;

-- Personal catalog of recurring dishes (protein shake, home-baked buns, own
-- recipes). Macros are per portion; meal_type is an optional hint. Used by the
-- mobile meal editor as a quick-pick and by the chat assistant before it
-- estimates a named/recurring item.
create table dishes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    name text not null,
    meal_type text check (
        meal_type = any (array['breakfast', 'lunch', 'dinner', 'snack'])
    ),
    calories integer,
    protein_g numeric(6, 1),
    carbs_g numeric(6, 1),
    fat_g numeric(6, 1),
    created_at timestamptz not null default now()
);

create index idx_dishes_user_id on dishes (user_id);

-- One saved dish per name (case-insensitive) so "remember this" upserts
-- instead of piling up duplicates.
create unique index uniq_dishes_user_lower_name on dishes (user_id, lower(name));

-- Hydration log. One row per drink; amount_ml is always positive.
create table water_log (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    amount_ml integer not null check (amount_ml > 0),
    logged_at timestamptz not null default now(),
    notes text,
    created_at timestamptz not null default now(),
    idempotency_key text
);

create index idx_water_log_user_id on water_log (user_id);

create index idx_water_log_logged_at on water_log (logged_at);

create unique index uniq_water_log_user_idem on water_log (user_id, idempotency_key)
where
    idempotency_key is not null;

-- Body weight tracking. Weight is stored canonically as integer grams so
-- kg/lb conversion happens server-side without float drift.
create table weight_log (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users (id) on delete cascade,
    weight_g integer not null check (weight_g > 0),
    logged_at timestamptz not null default now(),
    notes text,
    created_at timestamptz not null default now(),
    idempotency_key text
);

create index idx_weight_log_user_id on weight_log (user_id);

create index idx_weight_log_logged_at on weight_log (logged_at);

create unique index uniq_weight_log_user_idem on weight_log (user_id, idempotency_key)
where
    idempotency_key is not null;

-- OAuth access tokens issued to MCP clients.
create table oauth_tokens (
    token text primary key,
    user_id uuid references users (id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index idx_oauth_tokens_user_id on oauth_tokens (user_id);

create index idx_oauth_tokens_expires_at on oauth_tokens (expires_at);

-- Single-use refresh tokens (rotated on every /token refresh grant).
create table refresh_tokens (
    token text primary key,
    user_id uuid not null references users (id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

-- Short-lived authorization codes, consumed atomically on /token exchange.
create table auth_codes (
    code text primary key,
    redirect_uri text not null,
    code_challenge text,
    user_id uuid not null references users (id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index idx_auth_codes_expires_at on auth_codes (expires_at);

-- Telemetry: who registers a client (fire-and-forget insert).
create table registered_clients (
    id uuid primary key default gen_random_uuid(),
    client_name text,
    redirect_uris jsonb not null default '[]'::jsonb,
    registered_at timestamptz default now()
);

-- Tool call analytics (duration, success/failure, error category).
-- Deliberately no FK to users: the delete_account tool's own analytics row is
-- written after the user is gone, and imported telemetry may reference
-- since-deleted users. deleteAllUserData clears it explicitly.
create table tool_analytics (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    tool_name text not null,
    success boolean not null,
    duration_ms integer not null,
    error_category text,
    date_range_days integer,
    mcp_session_id text,
    invoked_at timestamptz not null default now(),
    created_at timestamptz default now()
);

create index idx_tool_analytics_user_id on tool_analytics (user_id);

create index idx_tool_analytics_tool_name on tool_analytics (tool_name);

create index idx_tool_analytics_invoked_at on tool_analytics (invoked_at);

create index idx_tool_analytics_user_tool on tool_analytics (user_id, tool_name);

-- Shared cache of resolved food lookups (Open Food Facts; later USDA).
-- Global, not per-user: a barcode resolves to the same product for everyone.
create table food_cache (
    source text not null,
    source_id text not null,
    payload jsonb not null,
    fetched_at timestamptz not null default now(),
    primary key (source, source_id)
);

-- On-demand meal CSV exports (replaces the Supabase Storage bucket). Rows are
-- handed out as short-lived tokened links and swept after expires_at.
create table meal_exports (
    token text primary key,
    user_id uuid not null references users (id) on delete cascade,
    csv_text text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);

create index idx_meal_exports_user_id on meal_exports (user_id);

create index idx_meal_exports_expires_at on meal_exports (expires_at);
