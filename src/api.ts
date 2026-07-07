import { Hono } from "hono";
import crypto from "node:crypto";
import {
    signInUser,
    signUpUser,
    storeToken,
    getUserTimezone,
    getMealsByDate,
    getWaterByDate,
    getWeightInRange,
    getLatestWeight,
    getNutritionGoals,
    upsertNutritionGoals,
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
import { todayInTz, shiftLocalDate, hourInTz, dateInTz } from "./tz.js";

/**
 * Plain REST API for the mobile app — a thin layer over the same data-layer
 * functions the MCP tools use. Tokens are the same oauth_tokens rows, so a
 * mobile login and an MCP client session are interchangeable.
 */

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

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;

/** Positive finite number or throws — trust-boundary check for body fields. */
function posNum(v: unknown): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error("bad number");
    return n;
}

/** Extracts meal fields from a request body; `partial` allows omitting all. */
function mealFields(
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
        if (body[k] !== undefined) {
            out[k] = body[k] === null ? undefined : posNum(body[k]);
        }
    }
    return out;
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
        try {
            const body = await c.req.json();
            email = String(body.email ?? "");
            password = String(body.password ?? "");
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
        // Optional gate: signup burns LLM tokens, so a shared invite code
        // keeps strangers out without building real invitations.
        const required = process.env.SIGNUP_CODE;
        if (required && body.code !== required) {
            return c.json({ error: "invalid_code" }, 403);
        }
        if (loginRateLimited(c, email)) {
            return c.json({ error: "rate_limited" }, 429);
        }
        try {
            const userId = await signUpUser(email, password);
            const token = crypto.randomUUID();
            await storeToken(token, userId);
            return c.json({ token });
        } catch (err) {
            return c.json(
                {
                    error: "signup_failed",
                    message: err instanceof Error ? err.message : "failed",
                },
                400,
            );
        }
    });

    api.get("/api/dashboard", authenticateBearer, async (c) => {
        const userId = c.get("userId") as string;
        const tz = await getUserTimezone(userId);
        const today = todayInTz(tz);
        const [meals, water, weights, latest, goals] = await Promise.all([
            getMealsByDate(userId, today, tz),
            getWaterByDate(userId, today, tz),
            getWeightInRange(userId, shiftLocalDate(today, -30), today, tz),
            getLatestWeight(userId),
            getNutritionGoals(userId),
        ]);
        return c.json(
            buildDashboard(today, tz, meals, water, weights, latest, goals),
        );
    });

    // ----- manual editing (the chat logs things, these correct them) -----

    api.post("/api/meals", authenticateBearer, async (c) => {
        try {
            const fields = mealFields(await jsonBody(c), false);
            const { meal } = await insertMeal(
                c.get("userId") as string,
                fields as MealInput,
            );
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
        await deleteMeal(c.get("userId") as string, c.req.param("id"));
        return c.json({ ok: true });
    });

    api.post("/api/water", authenticateBearer, async (c) => {
        try {
            const body = await jsonBody(c);
            const { entry } = await insertWater(c.get("userId") as string, {
                amount_ml: posNum(body.amount_ml),
            });
            return c.json({ entry }, 201);
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
    });

    api.delete("/api/water/:id", authenticateBearer, async (c) => {
        await deleteWater(c.get("userId") as string, c.req.param("id"));
        return c.json({ ok: true });
    });

    api.post("/api/weight", authenticateBearer, async (c) => {
        try {
            const body = await jsonBody(c);
            const { entry } = await insertWeight(c.get("userId") as string, {
                weight_g: Math.round(posNum(body.weight_kg) * 1000),
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
            weightG = Math.round(posNum(body.weight_kg) * 1000);
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
                            : Math.round(posNum(body.target_weight_kg) * 1000),
                },
            );
            return c.json({ goals });
        } catch {
            return c.json({ error: "invalid_request" }, 400);
        }
    });

    return api;
}
