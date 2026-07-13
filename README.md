# Nutrition MCP

A remote MCP server for personal nutrition tracking — log meals, track macros, log water and body weight, and review nutrition history through conversation.

## Quick Start

Connect it to your MCP client:

```
https://nutrition.viapip.com/mcp
```

**On Claude.ai:** Customize → Connectors → + → Add custom connector → paste the URL → Connect

On first connect you'll be asked to register with an email and password. Your data persists across reconnections.

## Tech Stack

- **Bun** — runtime and package manager (`Bun.sql`, `Bun.password`)
- **Hono** — HTTP framework
- **MCP SDK** — Model Context Protocol over Streamable HTTP
- **PostgreSQL** — database, self-hosted via docker-compose
- **OAuth 2.0** — authentication for Claude.ai connectors (email/password + Google)

## MCP Tools

| Tool                       | Description                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `log_meal`                 | Log a meal with description, type, calories, macros, notes                                               |
| `lookup_barcode`           | Look up a packaged product's verified macros by barcode via Open Food Facts (read from a photo or typed) |
| `get_meals_today`          | Get all meals logged today                                                                               |
| `get_meals_by_date`        | Get meals for a specific date (YYYY-MM-DD)                                                               |
| `get_meals_by_date_range`  | Get meals between two dates (inclusive)                                                                  |
| `get_nutrition_summary`    | Daily nutrition totals + goal progress for a date range                                                  |
| `update_meal`              | Update any fields of an existing meal                                                                    |
| `delete_meal`              | Delete a meal by ID                                                                                      |
| `set_nutrition_goals`      | Set daily calorie, macro, and water targets, plus an optional target weight                              |
| `get_nutrition_goals`      | Get the current daily targets                                                                            |
| `get_goal_progress`        | Get intake vs. targets for a given day (default: today), plus latest weight vs. target                   |
| `log_water`                | Log a hydration entry in milliliters                                                                     |
| `get_water_today`          | Get today's water intake total and entries                                                               |
| `get_water_by_date`        | Get water intake for a specific date                                                                     |
| `delete_water`             | Delete a water log entry by ID                                                                           |
| `log_weight`               | Log a body-weight measurement in kg or lb (converted and stored server-side)                             |
| `get_weight_today`         | Get today's weight entries                                                                               |
| `get_weight_by_date`       | Get weight entries for a specific date                                                                   |
| `get_weight_by_date_range` | Get weight entries between two dates (inclusive), grouped by day                                         |
| `get_weight_trends`        | Weight trend: latest, overall change, 7/14/30-day moving averages, min/max, and goal progress            |
| `update_weight`            | Update an existing weight entry                                                                          |
| `delete_weight`            | Delete a weight entry by ID                                                                              |
| `set_weight_unit`          | Set the preferred weight unit (`kg` or `lb`; null to clear)                                              |
| `get_weight_unit`          | Get the preferred weight unit                                                                            |
| `get_trends`               | 7/14/30-day averages, std dev, streaks, day-of-week, best/worst day                                      |
| `get_meal_patterns`        | Pre-aggregated behavioural patterns (breakfast effect, late dinner, weekend vs weekday, outliers)        |
| `export_meals`             | Export all meals as a CSV and return a 60-minute download link                                           |
| `set_timezone`             | Set the user's IANA timezone (e.g. `America/Los_Angeles`)                                                |
| `get_timezone`             | Get the user's configured timezone                                                                       |
| `delete_account`           | Permanently delete account and all associated data                                                       |

## MCP Resources

| URI                          | Description                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `nutrition://weekly-summary` | Rolling 7-day digest (averages vs targets, best/roughest day) for proactive pulls |

## Self-hosting

### 1. docker-compose

The stack is two containers: the app and an official `postgres` image. The
schema in [`db/init/001_schema.sql`](db/init/001_schema.sql) is applied
automatically on the first start (empty volume).

```bash
cp .env.example .env   # set POSTGRES_PASSWORD, BASE_URL, OAuth credentials
docker compose up -d
curl -f http://localhost:8080/health   # → ok
```

Postgres data lives in the named `pgdata` volume; the app starts only after
the database reports healthy.

> Migrating an existing Supabase deployment? See
> [`docs/migrate-from-supabase.md`](docs/migrate-from-supabase.md).

### 2. Environment variables

| Variable               | Description                                                                   |
| ---------------------- | ----------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`    | Password for the compose-managed Postgres (feeds the app's `DATABASE_URL`)    |
| `DATABASE_URL`         | Postgres connection string — only needed when running outside docker compose  |
| `BASE_URL`             | Public origin of the server; used for absolute CSV-export links               |
| `OAUTH_CLIENT_ID`      | Random string for OAuth client identification                                 |
| `OAUTH_CLIENT_SECRET`  | Random string for OAuth client authentication                                 |
| `GOOGLE_CLIENT_ID`     | _(optional)_ Google OAuth client ID for "Sign in with Google"                 |
| `GOOGLE_CLIENT_SECRET` | _(optional)_ Google OAuth client secret                                       |
| `OFF_USER_AGENT`       | Open Food Facts User-Agent for barcode lookups, in the form `AppName (email)` |
| `PORT`                 | Server port (default: `8080`)                                                 |

> **Making it yours:** The public site carries this deployment's domain (`nutrition.viapip.com`). Run `bun run depersonalize` to strip personal bits in one pass (analytics + CSP, Support/Contact sections, social links, and the domain → a `your-domain.com` placeholder). Use `bun run depersonalize --dry` to preview without writing. Afterwards, swap in your own `public/og.png`, `favicon.ico`, and `apple-touch-icon.png`, and replace the domain placeholder with your real domain.

Generate OAuth credentials:

```bash
openssl rand -hex 16   # use as OAUTH_CLIENT_ID
openssl rand -hex 32   # use as OAUTH_CLIENT_SECRET
```

### 3. Google sign-in (optional)

Email/password works out of the box. To also offer **"Continue with Google"**,
follow [`docs/google-auth-setup.md`](docs/google-auth-setup.md) to create a
Google OAuth client and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Development

```bash
bun install
cp .env.example .env    # fill in your credentials, uncomment DATABASE_URL
docker compose up -d postgres   # or point DATABASE_URL at any Postgres
bun run dev             # starts with hot reload on http://localhost:8080
```

## Connect to Claude.ai

1. Open [Claude.ai](https://claude.ai) and click **Customize**
2. Click **Connectors**, then the **+** button
3. Click **Add custom connector**
4. Fill in:
    - **Name**: Nutrition Tracker
    - **Remote MCP Server URL**: `https://nutrition.viapip.com/mcp`
5. Click **Connect** — sign in or register when prompted
6. After signing in, Claude can use your nutrition tools. If you reconnect later, sign in with the same email and password to keep your data.

## Mobile app (Android APK)

The [`mobile/`](mobile) directory is an [Expo](https://expo.dev) (SDK 57) app —
dashboard, meal/water/weight editors, a stats screen, and an LLM chat assistant,
all talking to the same server. The app targets your server through the
build-time `EXPO_PUBLIC_API_URL` variable, so point it at your own origin (it
runs against fixture data if left unset).

The native `mobile/android/` project is generated and git-ignored, so a build is
two steps: generate the native project, then assemble a release APK.

### Option A — Docker (no local Android SDK)

Prebuild with Bun, then run Gradle inside the official React Native Android
image. From the repo root:

```bash
cd mobile
bun install
bunx expo prebuild --platform android --clean          # generates android/

docker run --rm \
  -v "$PWD:/app" -w /app/android \
  -e EXPO_PUBLIC_API_URL=https://your-domain.com \
  reactnativecommunity/react-native-android:latest \
  ./gradlew assembleRelease --no-daemon
```

### Option B — Local toolchain

With a JDK and the Android SDK installed:

```bash
cd mobile
bun install
EXPO_PUBLIC_API_URL=https://your-domain.com bunx expo run:android --variant release
```

Either way the APK lands at:

```
mobile/android/app/build/outputs/apk/release/app-release.apk
```

> **Notes.** `EXPO_PUBLIC_API_URL` is baked in at build time — rebuild whenever
> the server URL changes. The release build is signed with the debug key, so
> it's ready to sideload but not for the Play Store. Before publishing, set your
> own Android `package` and app `name` in [`mobile/app.json`](mobile/app.json).

## API Endpoints

| Endpoint                                      | Description                            |
| --------------------------------------------- | -------------------------------------- |
| `GET /health`                                 | Health check                           |
| `GET /.well-known/oauth-authorization-server` | OAuth metadata discovery               |
| `POST /register`                              | Dynamic client registration            |
| `GET /authorize`                              | OAuth authorization (shows login page) |
| `POST /approve`                               | Login/register handler                 |
| `POST /token`                                 | Token exchange                         |
| `GET /favicon.ico`                            | Server icon                            |
| `GET /exports/:token/meals.csv`               | CSV export download (60-minute token)  |
| `ALL /mcp`                                    | MCP endpoint (authenticated)           |

## Deploy

Any host that can run docker compose works:

1. Copy the repo (or just `docker-compose.yml`, `Dockerfile`, `db/`) to the server
2. Fill in `.env` (see the table above)
3. `docker compose up -d` — the app listens on port `8080`
4. Point your domain / reverse proxy at it and set `BASE_URL` accordingly

The standalone `Dockerfile` also still works for platforms that build
containers themselves (e.g. DigitalOcean App Platform) — provide an external
`DATABASE_URL` in that case.

## License

[MIT](LICENSE)
