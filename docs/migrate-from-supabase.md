# Migrating data from Supabase to self-hosted Postgres

One-time runbook for moving an existing Supabase deployment onto the
docker-compose stack (`docker-compose.yml` + `db/init/001_schema.sql`).

What moves and what doesn't:

| Data                             | Action                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| `auth.users` / `auth.identities` | → `users` (same UUIDs, bcrypt hashes kept, google_sub)             |
| `public.*` user tables           | → copied as-is                                                     |
| `oauth_tokens`, `refresh_tokens` | → copied, so connected clients keep working                        |
| `auth_codes`                     | not copied (10-minute lifetime; any in-flight login just restarts) |
| Storage bucket `exports`         | not copied (links expire after 60 minutes anyway)                  |

## 1. Freeze writes

Stop the app (or scale it to zero) so nothing writes to Supabase while you
dump. Connected MCP clients will see errors for the duration of the migration;
their tokens stay valid because `oauth_tokens`/`refresh_tokens` are carried
over.

## 2. Dump from Supabase

Use the session pooler / direct connection string from the Supabase dashboard
(Project Settings → Database).

```bash
SUPA_DSN='postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres'

# Per-user auth rows: id, email, bcrypt hash, google identity, verified flag.
psql "$SUPA_DSN" -c "\copy (
    select u.id,
           lower(u.email) as email,
           u.encrypted_password as password_hash,
           i.provider_id as google_sub,
           (u.email_confirmed_at is not null) as email_verified,
           u.created_at
    from auth.users u
    left join auth.identities i
        on i.user_id = u.id and i.provider = 'google'
) to 'users.csv' with (format csv, header)"

# Public tables (auth_codes and the storage bucket are deliberately skipped).
for t in profiles nutrition_goals meals water_log weight_log \
         oauth_tokens refresh_tokens tool_analytics food_cache; do
    psql "$SUPA_DSN" -c "\copy public.$t to '$t.csv' with (format csv, header)"
done
```

Notes:

- `encrypted_password` is a bcrypt hash (`$2a$…`). `Bun.password.verify`
  accepts it as-is, so users keep their passwords; new passwords are stored as
  argon2id. Exotic edge: bcrypt truncates at 72 bytes while Bun pre-hashes
  longer passwords, so a >72-byte legacy password would need a reset.
- Google-only users have an empty `password_hash` — that is expected; the
  login form rejects them with the generic message and Google sign-in matches
  them by `google_sub`.

## 3. Start the new stack and import

```bash
cp .env.example .env   # set POSTGRES_PASSWORD, BASE_URL, OAuth vars
docker compose up -d postgres
```

`POSTGRES_PASSWORD` is interpolated into the app's `DATABASE_URL` verbatim —
keep it URL-safe (letters/digits/dashes; no `@ : / # ?`).

The empty volume triggers `db/init/001_schema.sql` automatically. Then import
— **users first**, everything else references them:

```bash
LOCAL_DSN='postgres://nutrition:<POSTGRES_PASSWORD>@localhost:5432/nutrition'

psql "$LOCAL_DSN" -c "\copy users (id, email, password_hash, google_sub, email_verified, created_at) from 'users.csv' with (format csv, header)"

for t in profiles nutrition_goals meals water_log weight_log \
         oauth_tokens refresh_tokens tool_analytics food_cache; do
    psql "$LOCAL_DSN" -c "\copy $t from '$t.csv' with (format csv, header)"
done
```

Caveats:

- `tool_analytics.user_id` was `varchar` on Supabase and is `uuid` now (no
  FK), so the values import as-is — including rows for since-deleted users.
- `food_cache` is safe to drop instead of migrating — it refills itself.

## 4. Verify, then switch traffic

```bash
docker compose up -d
curl -f http://localhost:8080/health          # → ok
docker compose exec postgres pg_isready       # → accepting connections
```

Spot-check before pointing DNS at the new host:

- password login with a migrated account (bcrypt path),
- Google sign-in with a migrated account (matched by `google_sub`),
- an existing MCP client calling a tool with its old bearer token,
- `export_meals` → download link works, 404s after 60 minutes.

Once traffic is switched and verified, pause (and later delete) the Supabase
project so there is no second live copy of user data.
