import { Hono } from "hono";
import crypto from "node:crypto";
import {
    signInUser,
    signUpUser,
    storeToken,
    getUserTimezone,
    getMealsByDate,
    getMealsInRange,
    getWaterByDate,
    getWaterInRange,
    getWeightInRange,
    getLatestWeight,
    getNutritionGoals,
    upsertNutritionGoals,
    getProfile,
    upsertProfile,
    insertMeal,
    updateMeal,
    deleteMeal,
    insertWater,
    deleteWater,
    insertWeight,
    updateWeight,
    deleteWeight,
    type Meal,
    type MealInput,
    type WaterEntry,
    type WeightEntry,
    type NutritionGoals,
} from "./db.js";
import { authenticateBearer } from "./middleware.js";
import { loginRateLimited } from "./oauth.js";
import { isPlausibleWeightGrams } from "./units.js";
import { todayInTz, shiftLocalDate, hourInTz, dateInTz } from "./tz.js";
import {
    buildDailyBuckets,
    currentStreak,
    longestStreak,
    nonEmpty,
} from "./insights.js";

/**
 * Plain REST API for the mobile app — a thin layer over the same data-layer
 * functions the MCP tools use. Tokens are the same oauth_tokens rows, so a
 * mobile login and an MCP client session are interchangeable.
 */

/** A valid IANA zone the profile can store; anything Intl rejects is dropped. */
function validTimezone(tz: unknown): string | null {
    if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) {
        return null;
    }
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return tz;
    } catch {
        return null;
    }
}

/** Client-supplied idempotency key so a retried POST doesn't double-insert. */
function idempotencyKey(body: Record<string, unknown>): string | undefined {
    const k = body.idempotency_key;
    return typeof k === "string" && k.length > 0 && k.length <= 200
        ? k
        : undefined;
}

/** Aggregates one day of logs into the shape the mobile dashboard renders. */
export function buildDashboard(
    today: string,
    tz: string,
    meals: Meal[],
    water: WaterEntry[],
    weights: WeightEntry[],
    latest: WeightEntry | null,
    goals: NutritionGoals | null,
) {
    const sum = (f: (m: Meal) => number | null) =>
        meals.reduce((acc, m) => acc + (f(m) ?? 0), 0);

    // 8 three-hour buckets, 00–24 local — matches the app's WaterBars chart
    const byHour = new Array(8).fill(0) as number[];
    for (const w of water) {
        byHour[Math.floor(hourInTz(w.logged_at, tz) / 3)]! += w.amount_ml;
    }

    // One point per local day; entries come sorted asc, so the last one wins.
    // The entry id rides along so the app can edit/delete that day's reading.
    const byDay = new Map<string, { id: string; weight_g: number }>();
    for (const w of weights) {
        byDay.set(dateInTz(w.logged_at, tz), {
            id: w.id,
            weight_g: w.weight_g,
        });
    }
    const series = [...byDay].map(([date, p]) => ({ date, ...p }));

    return {
        date: today,
        calories: {
            eaten: sum((m) => m.calories),
            goal: goals?.daily_calories ?? null,
        },
        macros: {
            protein: {
                eaten: sum((m) => m.protein_g),
                goal: goals?.daily_protein_g ?? null,
            },
            carbs: {
                eaten: sum((m) => m.carbs_g),
                goal: goals?.daily_carbs_g ?? null,
            },
            fat: {
                eaten: sum((m) => m.fat_g),
                goal: goals?.daily_fat_g ?? null,
            },
        },
        water: {
            total_ml: water.reduce((acc, w) => acc + w.amount_ml, 0),
            goal_ml: goals?.daily_water_ml ?? null,
            by_hour: byHour,
            entries: water.map((w) => ({
                id: w.id,
                amount_ml: w.amount_ml,
                logged_at: w.logged_at,
            })),
        },
        weight: {
            current_g: latest?.weight_g ?? null,
            target_g: goals?.target_weight_g ?? null,
            series,
        },
        meals: meals.map((m) => ({
            id: m.id,
            meal_type: m.meal_type,
            description: m.description,
            calories: m.calories,
            protein_g: m.protein_g,
            carbs_g: m.carbs_g,
            fat_g: m.fat_g,
            logged_at: m.logged_at,
        })),
    };
}

/**
 * Aggregates a trailing window of logs into the shape the mobile stats
 * screen renders: per-day totals, logging streaks and frequent meals.
 */
export function buildStats(
    endDate: string,
    days: number,
    tz: string,
    meals: Meal[],
    water: WaterEntry[],
    weights: WeightEntry[],
    goals: NutritionGoals | null,
) {
    const startDate = shiftLocalDate(endDate, -(days - 1));
    // Стрики считаются с одним днём запаса перед окном: иначе серия,
    // упирающаяся в край выборки, занижалась бы на день при пустом сегодня.
    const buckets = buildDailyBuckets(
        meals,
        water,
        shiftLocalDate(endDate, -days),
        endDate,
        tz,
    );

    // Утро без записей не должно гасить огонёк: если сегодня пусто,
    // стрик считается по вчерашний день включительно.
    const strict = currentStreak(buckets, nonEmpty);
    const current =
        strict > 0 ? strict : currentStreak(buckets.slice(0, -1), nonEmpty);

    // Частые блюда: одинаковые описания за окно, топ-6 с count >= 2.
    // Поля берутся из самой свежей записи (запись идёт по возрастанию даты).
    const freq = new Map<string, { latest: Meal; count: number }>();
    for (const m of meals) {
        const key = m.description.trim().toLowerCase();
        const cur = freq.get(key);
        if (cur) {
            cur.count += 1;
            cur.latest = m;
        } else {
            freq.set(key, { latest: m, count: 1 });
        }
    }
    const frequent = [...freq.values()]
        .filter((f) => f.count >= 2)
        .sort(
            (a, b) =>
                b.count - a.count ||
                b.latest.logged_at.localeCompare(a.latest.logged_at),
        )
        .slice(0, 6)
        .map(({ latest, count }) => ({
            description: latest.description.trim(),
            meal_type: latest.meal_type,
            calories: latest.calories,
            protein_g: latest.protein_g,
            carbs_g: latest.carbs_g,
            fat_g: latest.fat_g,
            count,
        }));

    // Одна точка веса на локальный день — последняя запись дня побеждает.
    const byDay = new Map<string, number>();
    for (const w of weights) {
        byDay.set(dateInTz(w.logged_at, tz), w.weight_g);
    }
    const weightSeries = [...byDay].map(([date, weight_g]) => ({
        date,
        weight_g,
    }));

    return {
        start: startDate,
        end: endDate,
        // Запасной день в выдачу не попадает — наружу уходит ровно окно.
        days: buckets.slice(1).map((b) => ({
            date: b.date,
            calories: b.calories,
            protein_g: b.protein_g,
            carbs_g: b.carbs_g,
            fat_g: b.fat_g,
            water_ml: b.waterMl,
            logged: nonEmpty(b),
        })),
        streak: {
            current: Math.min(current, days),
            best: Math.min(longestStreak(buckets, nonEmpty), days),
        },
        frequent,
        weight: {
            series: weightSeries,
            target_g: goals?.target_weight_g ?? null,
        },
        goals: {
            daily_calories: goals?.daily_calories ?? null,
            daily_protein_g: goals?.daily_protein_g ?? null,
            daily_carbs_g: goals?.daily_carbs_g ?? null,
            daily_fat_g: goals?.daily_fat_g ?? null,
            daily_water_ml: goals?.daily_water_ml ?? null,
        },
    };
}

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;

/** Positive finite number or throws — trust-boundary check for body fields. */
function posNum(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error("bad number");
    return n;
}

/** Extracts meal fields from a request body; `partial` allows omitting all. */
export function mealFields(
    body: Record<string, unknown>,
    partial: boolean,
): Partial<MealInput> {
    const out: Partial<MealInput> = {};
    if (body.description !== undefined || !partial) {
        const d = String(body.description ?? "").trim();
        if (!d) throw new Error("description required");
        out.description = d;
    }
    if (body.meal_type !== undefined || !partial) {
        if (!MEAL_TYPES.includes(body.meal_type as never)) {
            throw new Error("bad meal_type");
        }
        out.meal_type = body.meal_type as MealInput["meal_type"];
    }
    for (const k of ["calories", "protein_g", "carbs_g", "fat_g"] as const) {
        if (body[k] === undefined) continue;
        // null on PATCH clears the stored value; on POST it means "not given"
        if (body[k] === null) {
            if (partial) out[k] = null;
        } else {
            out[k] = posNum(body[k]);
        }
    }
    return out;
}

/** kg from the request body → integer grams, rejecting implausible values. */
function weightGrams(v: unknown): number {
    const g = Math.round(posNum(v) * 1000);
    if (!isPlausibleWeightGrams(g)) throw new Error("implausible weight");
    return g;
}

async function jsonBody(c: {
    req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
    try {
        const body = await c.req.json();
        if (body && typeof body === "object") {
            return body as Record<string, unknown>;
        }
    } catch {
        // fall through
    }
    throw new Error("bad body");
}

export function createApiRouter() {
    const api = new Hono();

    api.post("/api/login", async (c) => {
        let email = "";
        let password = "";
        let tz: string | null = null;
        try {
            const body = await c.req.json();
            email = String(body.email ?? "");
            password = String(body.password ?? "");
            tz = validTimezone(body.timezone);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
        if (!email || !password) {
            return c.json({ error: "invalid_request" }, 400);
        }
        if (loginRateLimited(c, email)) {
            return c.json({ error: "rate_limited" }, 429);
        }
        try {
            const userId = await signInUser(email, password);
            // Keep the profile's zone current with the device — the app has no
            // other way to set it, and without it every day/streak is UTC.
            if (tz) await upsertProfile(userId, { timezone: tz });
            const token = crypto.randomUUID();
            await storeToken(token, userId);
            return c.json({ token });
        } catch {
            return c.json({ error: "invalid_credentials" }, 401);
        }
    });

    api.post("/api/signup", async (c) => {
        let body: Record<string, unknown>;
        try {
            body = await jsonBody(c);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
        const email = String(body.email ?? "");
        const password = String(body.password ?? "");
        if (!email || !password) {
            return c.json({ error: "invalid_request" }, 400);
        }
        // Rate-limit before the invite-code check so the code can't be
        // brute-forced with unlimited attempts.
        if (loginRateLimited(c, email)) {
            return c.json({ error: "rate_limited" }, 429);
        }
        // Optional gate: signup burns LLM tokens, so a shared invite code
        // keeps strangers out without building real invitations.
        const required = process.env.SIGNUP_CODE;
        if (required && body.code !== required) {
            return c.json({ error: "invalid_code" }, 403);
        }
        try {
            const userId = await signUpUser(email, password);
            const tz = validTimezone(body.timezone);
            if (tz) await upsertProfile(userId, { timezone: tz });
            const token = crypto.randomUUID();
            await storeToken(token, userId);
            return c.json({ token });
        } catch {
            // Generic on purpose: a verbatim "user already registered" lets an
            // unauthenticated caller enumerate which emails have accounts.
            return c.json({ error: "signup_failed" }, 400);
        }
    });

    api.get("/api/dashboard", authenticateBearer, async (c) => {
        const userId = c.get("userId") as string;
        const tz = await getUserTimezone(userId);
        const today = todayInTz(tz);
        // ?date=YYYY-MM-DD lets the app browse past days; future is clamped.
        const q = c.req.query("date");
        let day = today;
        if (q !== undefined) {
            // Regex catches the shape, the round-trip catches 2026-02-31.
            const real =
                /^\d{4}-\d{2}-\d{2}$/.test(q) &&
                new Date(`${q}T12:00:00Z`).toISOString().slice(0, 10) === q;
            if (!real || q > today) {
                return c.json({ error: "bad date" }, 400);
            }
            day = q;
        }
        const [meals, water, weights, latest, goals] = await Promise.all([
            getMealsByDate(userId, day, tz),
            getWaterByDate(userId, day, tz),
            getWeightInRange(userId, shiftLocalDate(day, -30), day, tz),
            getLatestWeight(userId),
            getNutritionGoals(userId),
        ]);
        // Browsing the past: "current weight" is the last reading known by
        // that day, not today's — otherwise the card contradicts the chart.
        const asOf = day === today ? latest : (weights.at(-1) ?? null);
        return c.json(
            buildDashboard(day, tz, meals, water, weights, asOf, goals),
        );
    });

    // Trailing-window aggregates for the stats screen. ?days=7..90 (30 дефолт).
    // Не /api/stats — этот путь занят публичной статистикой лендинга.
    api.get("/api/summary", authenticateBearer, async (c) => {
        const userId = c.get("userId") as string;
        const tz = await getUserTimezone(userId);
        const today = todayInTz(tz);
        const raw = Number(c.req.query("days") ?? 30);
        const days = Number.isFinite(raw)
            ? Math.min(90, Math.max(7, Math.round(raw)))
            : 30;
        // Один день сверх окна, чтобы стрик ровно в окно не резался в N-1.
        const start = shiftLocalDate(today, -days);
        const [meals, water, weights, goals] = await Promise.all([
            getMealsInRange(userId, start, today, tz),
            getWaterInRange(userId, start, today, tz),
            getWeightInRange(userId, start, today, tz),
            getNutritionGoals(userId),
        ]);
        return c.json(
            buildStats(today, days, tz, meals, water, weights, goals),
        );
    });

    // ----- manual editing (the chat logs things, these correct them) -----

    api.post("/api/meals", authenticateBearer, async (c) => {
        try {
            const body = await jsonBody(c);
            const fields = mealFields(body, false);
            const { meal } = await insertMeal(c.get("userId") as string, {
                ...(fields as MealInput),
                idempotency_key: idempotencyKey(body),
            });
            return c.json({ meal }, 201);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
    });

    api.patch("/api/meals/:id", authenticateBearer, async (c) => {
        let fields: Partial<MealInput>;
        try {
            fields = mealFields(await jsonBody(c), true);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
        try {
            const meal = await updateMeal(
                c.get("userId") as string,
                c.req.param("id"),
                fields,
            );
            return c.json({ meal });
        } catch {
            return c.json({ error: "not_found" }, 404);
        }
    });

    api.delete("/api/meals/:id", authenticateBearer, async (c) => {
        const deleted = await deleteMeal(
            c.get("userId") as string,
            c.req.param("id"),
        );
        return deleted
            ? c.json({ ok: true })
            : c.json({ error: "not_found" }, 404);
    });

    api.post("/api/water", authenticateBearer, async (c) => {
        try {
            const body = await jsonBody(c);
            const { entry } = await insertWater(c.get("userId") as string, {
                amount_ml: posNum(body.amount_ml),
                idempotency_key: idempotencyKey(body),
            });
            return c.json({ entry }, 201);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
    });

    api.delete("/api/water/:id", authenticateBearer, async (c) => {
        const deleted = await deleteWater(
            c.get("userId") as string,
            c.req.param("id"),
        );
        return deleted
            ? c.json({ ok: true })
            : c.json({ error: "not_found" }, 404);
    });

    api.post("/api/weight", authenticateBearer, async (c) => {
        try {
            const body = await jsonBody(c);
            const { entry } = await insertWeight(c.get("userId") as string, {
                weight_g: weightGrams(body.weight_kg),
                idempotency_key: idempotencyKey(body),
            });
            return c.json({ entry }, 201);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
    });

    api.patch("/api/weight/:id", authenticateBearer, async (c) => {
        let weightG: number;
        try {
            const body = await jsonBody(c);
            weightG = weightGrams(body.weight_kg);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
        try {
            const entry = await updateWeight(
                c.get("userId") as string,
                c.req.param("id"),
                { weight_g: weightG },
            );
            return c.json({ entry });
        } catch {
            return c.json({ error: "not_found" }, 404);
        }
    });

    api.delete("/api/weight/:id", authenticateBearer, async (c) => {
        const deleted = await deleteWeight(
            c.get("userId") as string,
            c.req.param("id"),
        );
        return deleted
            ? c.json({ ok: true })
            : c.json({ error: "not_found" }, 404);
    });

    // Settings. The key itself never leaves the server — only a boolean flag.
    api.get("/api/settings", authenticateBearer, async (c) => {
        const profile = await getProfile(c.get("userId") as string);
        return c.json({
            has_llm_key: !!profile?.llm_api_key,
            chat_available: !!profile?.llm_api_key || !!process.env.LLM_API_KEY,
        });
    });

    api.put("/api/settings/llm", authenticateBearer, async (c) => {
        try {
            const body = await jsonBody(c);
            let key: string | null = null;
            if (body.api_key != null) {
                key = String(body.api_key).trim();
                if (!key || key.length > 256 || /\s/.test(key)) {
                    throw new Error("bad key");
                }
            }
            await upsertProfile(c.get("userId") as string, {
                llm_api_key: key,
            });
            return c.json({
                has_llm_key: !!key,
                chat_available: !!key || !!process.env.LLM_API_KEY,
            });
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
    });

    // Full replace: omitted fields become null (clears that goal).
    api.put("/api/goals", authenticateBearer, async (c) => {
        try {
            const body = await jsonBody(c);
            const opt = (v: unknown) => (v == null ? null : posNum(v));
            const goals = await upsertNutritionGoals(
                c.get("userId") as string,
                {
                    daily_calories: opt(body.daily_calories),
                    daily_protein_g: opt(body.daily_protein_g),
                    daily_carbs_g: opt(body.daily_carbs_g),
                    daily_fat_g: opt(body.daily_fat_g),
                    daily_water_ml: opt(body.daily_water_ml),
                    target_weight_g:
                        body.target_weight_kg == null
                            ? null
                            : weightGrams(body.target_weight_kg),
                },
            );
            return c.json({ goals });
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
    });

    return api;
}
