import { Hono } from "hono";
import crypto from "node:crypto";
import {
    signInUser,
    storeToken,
    getUserTimezone,
    getMealsByDate,
    getWaterByDate,
    getWeightInRange,
    getLatestWeight,
    getNutritionGoals,
    type Meal,
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
    const byDay = new Map<string, number>();
    for (const w of weights) byDay.set(dateInTz(w.logged_at, tz), w.weight_g);
    const series = [...byDay].map(([date, weight_g]) => ({ date, weight_g }));

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
            logged_at: m.logged_at,
        })),
    };
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

    return api;
}
