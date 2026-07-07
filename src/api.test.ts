import { test, expect } from "bun:test";
import { buildDashboard } from "./api.js";
import type { Meal, WaterEntry, WeightEntry, NutritionGoals } from "./db.js";

const meal = (over: Partial<Meal>): Meal => ({
    id: "m1",
    user_id: "u1",
    logged_at: "2026-07-07T08:00:00.000Z",
    meal_type: "breakfast",
    description: "test",
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    notes: null,
    idempotency_key: null,
    ...over,
});

const water = (over: Partial<WaterEntry>): WaterEntry => ({
    id: "w1",
    user_id: "u1",
    amount_ml: 250,
    logged_at: "2026-07-07T08:00:00.000Z",
    notes: null,
    created_at: "2026-07-07T08:00:00.000Z",
    idempotency_key: null,
    ...over,
});

const weight = (over: Partial<WeightEntry>): WeightEntry => ({
    id: "kg1",
    user_id: "u1",
    weight_g: 80000,
    logged_at: "2026-07-07T07:00:00.000Z",
    notes: null,
    created_at: "2026-07-07T07:00:00.000Z",
    idempotency_key: null,
    ...over,
});

const goals: NutritionGoals = {
    user_id: "u1",
    daily_calories: 2200,
    daily_protein_g: 140,
    daily_carbs_g: null,
    daily_fat_g: 70,
    daily_water_ml: 2500,
    target_weight_g: 74000,
    updated_at: "2026-07-01T00:00:00.000Z",
};

test("buildDashboard aggregates macros, water buckets and weight series", () => {
    const d = buildDashboard(
        "2026-07-07",
        "UTC",
        [
            meal({ calories: 400, protein_g: 30, fat_g: 10 }),
            meal({ id: "m2", calories: 600, protein_g: 40, carbs_g: 50 }),
        ],
        [
            // 08:00 UTC → bucket 2; 22:30 UTC → bucket 7
            water({ amount_ml: 300 }),
            water({
                id: "w2",
                amount_ml: 200,
                logged_at: "2026-07-07T22:30:00.000Z",
            }),
        ],
        [
            // Sorted asc as getWeightInRange returns; two entries share the
            // local day 07-07 — the later reading wins the series point.
            weight({
                id: "kg0",
                weight_g: 81000,
                logged_at: "2026-07-05T07:00:00.000Z",
            }),
            weight({ weight_g: 80100 }),
            weight({
                id: "kg2",
                weight_g: 79900,
                logged_at: "2026-07-07T20:00:00.000Z",
            }),
        ],
        weight({ weight_g: 79900 }),
        goals,
    );

    expect(d.calories).toEqual({ eaten: 1000, goal: 2200 });
    expect(d.macros.protein).toEqual({ eaten: 70, goal: 140 });
    expect(d.macros.carbs).toEqual({ eaten: 50, goal: null });
    expect(d.water.total_ml).toBe(500);
    expect(d.water.by_hour).toEqual([0, 0, 300, 0, 0, 0, 0, 200]);
    expect(d.water.entries.map((e) => e.id)).toEqual(["w1", "w2"]);
    expect(d.weight.current_g).toBe(79900);
    expect(d.weight.target_g).toBe(74000);
    expect(d.weight.series).toEqual([
        { date: "2026-07-05", id: "kg0", weight_g: 81000 },
        { date: "2026-07-07", id: "kg2", weight_g: 79900 },
    ]);
    expect(d.meals).toHaveLength(2);
    expect(d.meals[0]).not.toHaveProperty("notes");
});

test("buildDashboard with no data and no goals is all zeros/nulls", () => {
    const d = buildDashboard("2026-07-07", "UTC", [], [], [], null, null);
    expect(d.calories).toEqual({ eaten: 0, goal: null });
    expect(d.water.by_hour).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(d.water.entries).toEqual([]);
    expect(d.weight).toEqual({ current_g: null, target_g: null, series: [] });
    expect(d.meals).toEqual([]);
});
