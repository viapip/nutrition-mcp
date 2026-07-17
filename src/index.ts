import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { createOAuthRouter } from "./oauth.js";
import { createApiRouter } from "./api.js";
import { createChatRouter } from "./chat.js";
import { authenticateBearer, rateLimit } from "./middleware.js";
import { handleMcp } from "./mcp.js";
import { startExportCleanup } from "./export.js";
import {
    getLandingStats,
    getMealExportCsv,
    getSql,
    isServiceUnavailableError,
    type LandingStats,
} from "./db.js";
import { getBaseUrl } from "./url.js";
import { maskIp } from "./net.js";
import { addCspNonce, contentSecurityPolicy, createCspNonce } from "./csp.js";

const app = new Hono();

// Access log — records every non-health HTTP request (method, path, status,
// duration, masked client subnet) so traffic that never reaches a tool handler
// — and is therefore invisible to tool analytics — is still attributable in the
// runtime logs: unauthenticated /mcp probes (401), rate-limited hits (429),
// OAuth discovery crawls, vuln scanners. Registered first so it runs outermost
// and observes the final response status. /health is skipped to keep the
// platform's frequent health checks from evicting real traffic from the buffer.
app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === "/health") return next();
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    const ip = maskIp(c.req.header("x-forwarded-for"));
    console.log(
        `[req] ${c.req.method} ${path} ${c.res.status} ${ms}ms ip=${ip}`,
    );
});

// Security headers
app.use("*", async (c, next) => {
    const nonce = createCspNonce();
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.get("Content-Security-Policy")) {
        c.header("Content-Security-Policy", contentSecurityPolicy(nonce));
    }
    c.header("Referrer-Policy", "no-referrer");

    if (c.res.headers.get("Content-Type")?.startsWith("text/html")) {
        const response = c.res;
        c.res = new Response(addCspNonce(await response.text(), nonce), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }
});

// Body limit; /api/chat gets a higher cap for inline food photos (data URLs).
const defaultBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
});
const chatBodyLimit = bodyLimit({
    maxSize: 8 * 1024 * 1024,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
});
app.use("*", (c, next) =>
    (new URL(c.req.url).pathname === "/api/chat"
        ? chatBodyLimit
        : defaultBodyLimit)(c, next),
);

// CORS
app.use(
    "*",
    cors({
        origin: (origin) => {
            if (!origin) return null;
            if (
                origin.match(/^https?:\/\/localhost(:\d+)?$/) ||
                origin.match(/^https?:\/\/127\.0\.0\.1(:\d+)?$/)
            ) {
                return origin;
            }
            const allowed =
                process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ??
                [];
            return allowed.includes(origin) ? origin : null;
        },
        allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: [
            "Content-Type",
            "Authorization",
            "Mcp-Session-Id",
            "Mcp-Protocol-Version",
            "Last-Event-ID",
            "Accept",
        ],
        exposeHeaders: [
            "Mcp-Session-Id",
            "Mcp-Protocol-Version",
            "Content-Type",
        ],
        credentials: false,
        maxAge: 86400,
    }),
);

// Protected resource metadata (MCP spec requirement)
app.get("/.well-known/oauth-protected-resource", (c) => {
    const baseUrl = getBaseUrl(c);
    return c.json({
        resource: baseUrl,
        authorization_servers: [baseUrl],
    });
});

// OAuth authorization server metadata
app.get("/.well-known/oauth-authorization-server", (c) => {
    const baseUrl = getBaseUrl(c);
    return c.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
});

// OAuth routes
app.route("/", createOAuthRouter());

// Mobile app REST API (/api/login, /api/dashboard)
app.route("/", createApiRouter());

// Mobile app chat (/api/chat) — LLM with tool-use over the data layer
app.route("/", createChatRouter());

// MCP endpoint (protected)
app.all("/mcp", authenticateBearer, rateLimit, handleMcp);

// Meal CSV export downloads. The unguessable token minted by the export_meals
// tool is the only credential; expired or unknown tokens get a plain 404.
app.get("/exports/:token/meals.csv", async (c) => {
    const csv = await getMealExportCsv(c.req.param("token"));
    if (csv == null) return c.text("Not found", 404);
    return c.body(csv, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="meals.csv"',
        "Cache-Control": "no-store",
    });
});

// Aggregate landing-page stats, cached in-memory so page views don't each hit
// the DB. The numbers move slowly, so a stale value for a few minutes is fine.
const STATS_TTL_MS = 5 * 60 * 1000;
let statsCache: { data: LandingStats; expiresAt: number } | null = null;
let statsRefresh: Promise<LandingStats> | null = null;

app.get("/api/stats", async (c) => {
    try {
        if (!statsCache || statsCache.expiresAt < Date.now()) {
            statsRefresh ??= getLandingStats().finally(() => {
                statsRefresh = null;
            });
            statsCache = {
                data: await statsRefresh,
                expiresAt: Date.now() + STATS_TTL_MS,
            };
        }
        return c.json(statsCache.data, 200, {
            "Cache-Control": "public, max-age=300",
        });
    } catch (err) {
        console.error("Failed to load landing stats:", err);
        // Serve the last good value if we have one, even if expired.
        if (statsCache) return c.json(statsCache.data);
        return c.json({ error: "stats_unavailable" }, 503);
    }
});

// Static world-map data (land dot-matrix + projected timezone coords) for the
// landing page. Generated offline; safe to cache aggressively.
app.get("/map-data.json", async (c) => {
    return c.body(await Bun.file("./public/map-data.json").text(), 200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
    });
});

// Static images (social card + touch icon)
app.get("/og.png", async (c) => {
    return c.body(await Bun.file("./public/og.png").arrayBuffer(), 200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
    });
});
app.get("/apple-touch-icon.png", async (c) => {
    return c.body(
        await Bun.file("./public/apple-touch-icon.png").arrayBuffer(),
        200,
        {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
        },
    );
});

// SEO crawl files
app.get("/robots.txt", async (c) => {
    return c.body(await Bun.file("./public/robots.txt").text(), 200, {
        "Content-Type": "text/plain",
    });
});
app.get("/sitemap.xml", async (c) => {
    return c.body(await Bun.file("./public/sitemap.xml").text(), 200, {
        "Content-Type": "application/xml",
    });
});

// Landing page
app.get("/", async (c) => {
    return c.html(await Bun.file("./public/index.html").text());
});

// Privacy & Terms
app.get("/privacy", async (c) => {
    return c.html(await Bun.file("./public/privacy.html").text());
});

// CSS
app.get("/styles.css", async (c) => {
    const file = Bun.file("./public/styles.css");
    return c.body(await file.text(), 200, { "Content-Type": "text/css" });
});

// Favicon endpoint
app.get("/favicon.ico", async (c) => {
    try {
        const file = Bun.file("./public/favicon.ico");
        return c.body(await file.arrayBuffer(), 200, {
            "Content-Type": "image/x-icon",
        });
    } catch {
        return c.notFound();
    }
});

// Health check
app.get("/health", (c) => c.text("ok"));

// Error handler
app.onError((_err, c) => {
    console.error("Unhandled error:", _err);
    if (isServiceUnavailableError(_err)) {
        return c.json({ error: "service_unavailable" }, 503);
    }
    return c.json({ error: "internal_server_error" }, 500);
});

const port = parseInt(process.env.PORT || "8080");

console.log(`Nutrition MCP server listening on 0.0.0.0:${port}`);

if (!process.env.BASE_URL) {
    console.warn(
        "BASE_URL is not set — CSV export links will point at localhost " +
            "and be unusable for remote clients.",
    );
}

// ponytail: idempotent startup DDL instead of a migration framework — db/init
// only runs on a fresh data dir, so existing deployments need these. Awaited so
// no request can hit a missing column/table mid-migration. Table/column
// migrations are mandatory: if one fails the schema is inconsistent and the app
// would 500 in confusing ways, so we exit rather than serve a broken server.
try {
    await getSql()`alter table profiles add column if not exists llm_api_key text`;
    await getSql()`alter table meals add column if not exists nutrition_source text`;
    await getSql()`
        do $$ begin
            if not exists (select 1 from pg_constraint where conname = 'meals_nutrients_nonnegative') then
                alter table meals add constraint meals_nutrients_nonnegative
                    check (calories >= 0 and protein_g >= 0 and carbs_g >= 0 and fat_g >= 0) not valid;
            end if;
            if not exists (select 1 from pg_constraint where conname = 'meals_nutrition_source_valid') then
                alter table meals add constraint meals_nutrition_source_valid
                    check (nutrition_source in ('estimate', 'barcode', 'dish', 'manual')) not valid;
            end if;
            if not exists (select 1 from pg_constraint where conname = 'nutrition_goals_nonnegative') then
                alter table nutrition_goals add constraint nutrition_goals_nonnegative
                    check (daily_calories >= 0 and daily_protein_g >= 0 and daily_carbs_g >= 0 and daily_fat_g >= 0 and daily_water_ml >= 0) not valid;
            end if;
        end $$`;
    await getSql()`
        create table if not exists dishes (
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
        )`;
    await getSql()`create unique index if not exists uniq_dishes_user_lower_name on dishes (user_id, lower(name))`;
    await getSql()`
        do $$ begin
            if not exists (select 1 from pg_constraint where conname = 'dishes_nutrients_nonnegative') then
                alter table dishes add constraint dishes_nutrients_nonnegative
                    check (calories >= 0 and protein_g >= 0 and carbs_g >= 0 and fat_g >= 0) not valid;
            end if;
        end $$`;
} catch (err) {
    console.error("Startup migration failed:", err);
    process.exit(1);
}

// Index migration is performance-only, so a failure logs but does not abort the
// boot. Replaces the separate (user_id) / (logged_at) indexes with a composite
// per log table (matching "where user_id=? and logged_at [range] order by
// logged_at") and drops singles already covered by a composite/unique prefix.
try {
    const db = getSql();
    await db`create index if not exists idx_meals_user_logged_at on meals (user_id, logged_at)`;
    await db`create index if not exists idx_water_log_user_logged_at on water_log (user_id, logged_at)`;
    await db`create index if not exists idx_weight_log_user_logged_at on weight_log (user_id, logged_at)`;
    await db`create index if not exists idx_refresh_tokens_expires_at on refresh_tokens (expires_at)`;
    await db`drop index if exists idx_meals_user_id`;
    await db`drop index if exists idx_meals_logged_at`;
    await db`drop index if exists idx_water_log_user_id`;
    await db`drop index if exists idx_water_log_logged_at`;
    await db`drop index if exists idx_weight_log_user_id`;
    await db`drop index if exists idx_weight_log_logged_at`;
    await db`drop index if exists idx_dishes_user_id`;
    await db`drop index if exists idx_tool_analytics_user_id`;
} catch (err) {
    console.error("Startup index migration failed:", err);
}

// Periodically delete expired exports/auth credentials and old analytics.
startExportCleanup();

// Exit cleanly on shutdown signals (e.g. deploys). /mcp is stateless — no
// server-side sessions are held, so there is nothing to tear down; just exit.
let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default {
    port,
    hostname: "0.0.0.0",
    // Long-lived MCP streams (StreamableHTTP GET/SSE) can idle between events;
    // Bun's 10s default closes them and logs "request timed out after 10
    // seconds". Raise it so legitimate streaming connections aren't severed.
    idleTimeout: 120,
    fetch: app.fetch,
};
