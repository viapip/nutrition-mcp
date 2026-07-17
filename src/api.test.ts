import { test, expect, afterEach } from "bun:test";
import {
    buildDashboard,
    buildStats,
    createApiRouter,
    mealFields,
    optionalLoggedAt,
} from "./api.js";
import {
    setSqlForTests,
    type Meal,
    type WaterEntry,
    type WeightEntry,
    type NutritionGoals,
} from "./db.js";

interface SqlCall {
    text: string;
    values: unknown[];
}

function installApiSql(script: unknown[][]): SqlCall[] {
    const calls: SqlCall[] = [];
    setSqlForTests(((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = [...strings].join("?").trim();
        calls.push({ text, values });
        const rows = script.shift();
        if (!rows) throw new Error(`unexpected query: ${text}`);
        return Promise.resolve(rows);
    }) as unknown);
    return calls;
}

afterEach(() => {
    setSqlForTests(() => {
        throw new Error("no fake sql installed");
    });
});

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
    nutrition_source: null,
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

test("past dashboard uses the latest weight even beyond its 30-day series", async () => {
    const oldWeight = weight({
        id: "old",
        weight_g: 81500,
        logged_at: "2026-03-01T08:00:00.000Z",
    });
    const calls = installApiSql([
        [{ user_id: "u1" }],
        [
            {
                user_id: "u1",
                timezone: "UTC",
                preferred_weight_unit: null,
                llm_api_key: null,
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
            },
        ],
        [],
        [],
        [],
        [oldWeight],
        [],
    ]);

    const response = await createApiRouter().request(
        "http://localhost/api/dashboard?date=2026-05-01",
        { headers: { Authorization: "Bearer access" } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
        weight: {
            current_g: number | null;
            target_g: number | null;
            series: unknown[];
        };
    };
    expect(body.weight).toEqual({
        current_g: 81500,
        target_g: null,
        series: [],
    });

    const rangeQuery = calls[4]!.text.toLowerCase();
    const asOfQuery = calls[5]!.text.toLowerCase();
    expect(rangeQuery).toContain("logged_at >=");
    expect(asOfQuery).toContain("logged_at <");
    expect(asOfQuery).not.toContain("logged_at >=");
});

test("POST /api/logout-all revokes every refresh token for the user", async () => {
    const calls = installApiSql([[{ user_id: "u1" }], []]);
    const response = await createApiRouter().request(
        "http://localhost/api/logout-all",
        {
            method: "POST",
            headers: { Authorization: "Bearer access" },
        },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls[1]!.text.toLowerCase()).toContain(
        "delete from refresh_tokens where user_id",
    );
    expect(calls[1]!.values).toEqual(["u1"]);
});

test("mealFields: PATCH null clears a macro, junk is rejected", () => {
    expect(mealFields({ calories: null }, true)).toEqual({ calories: null });
    expect(mealFields({ protein_g: 12 }, true)).toEqual({ protein_g: 12 });
    // Zero is a valid value (0-calorie drink), only negatives are rejected.
    expect(mealFields({ calories: 0 }, true)).toEqual({ calories: 0 });
    // on POST null just means "not given"
    expect(
        mealFields(
            { description: "x", meal_type: "snack", calories: null },
            false,
        ),
    ).toEqual({
        description: "x",
        meal_type: "snack",
        nutrition_source: "manual",
    });
    expect(() => mealFields({ calories: "junk" }, true)).toThrow();
    expect(() => mealFields({ calories: -1 }, true)).toThrow();
    // Empty/blank strings, booleans and arrays must not coerce to 0.
    for (const junk of ["", "  ", false, []]) {
        expect(() => mealFields({ calories: junk }, true)).toThrow();
    }
});

test("optionalLoggedAt preserves a valid timestamp and rejects bad input", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(optionalLoggedAt(undefined, now)).toBeUndefined();
    expect(optionalLoggedAt("2026-07-14T19:30:00.000Z", now)).toBe(
        "2026-07-14T19:30:00.000Z",
    );
    expect(() => optionalLoggedAt("2026-99-99T00:00:00.000Z", now)).toThrow();
    expect(() => optionalLoggedAt(false, now)).toThrow();
});

test("buildStats: day fill, pending-today streak, frequent meals", () => {
    const meals = [
        meal({
            id: "a1",
            logged_at: "2026-07-04T08:00:00.000Z",
            description: "Овсянка",
            calories: 400,
        }),
        meal({
            id: "a2",
            logged_at: "2026-07-05T08:00:00.000Z",
            description: "овсянка ",
            calories: 410,
        }),
        meal({
            id: "a3",
            logged_at: "2026-07-06T12:00:00.000Z",
            description: "Суп",
            calories: 300,
        }),
    ];
    const s = buildStats(
        "2026-07-07",
        7,
        "UTC",
        meals,
        [],
        [weight({})],
        goals,
    );
    expect(s.start).toBe("2026-07-01");
    expect(s.days).toHaveLength(7);
    expect(s.days[3]).toMatchObject({
        date: "2026-07-04",
        calories: 400,
        logged: true,
    });
    // Сегодня (07-07) пусто — стрик держится по вчерашний день: 04,05,06.
    expect(s.streak).toEqual({ current: 3, best: 3 });
    // «овсянка» дважды (без учёта регистра/пробелов), поля из свежей записи.
    expect(s.frequent).toHaveLength(1);
    expect(s.frequent[0]).toMatchObject({
        description: "овсянка",
        calories: 410,
        count: 2,
    });
    expect(s.weight.series).toEqual([{ date: "2026-07-07", weight_g: 80000 }]);
    expect(s.goals.daily_calories).toBe(2200);
});

test("buildStats: today logged counts in streak, empty range is zeroed", () => {
    const s0 = buildStats("2026-07-07", 7, "UTC", [], [], [], null);
    expect(s0.streak).toEqual({ current: 0, best: 0 });
    expect(s0.frequent).toEqual([]);
    expect(s0.days.every((d) => !d.logged)).toBe(true);

    const s1 = buildStats(
        "2026-07-07",
        7,
        "UTC",
        [meal({ logged_at: "2026-07-07T08:00:00.000Z" })],
        [],
        [],
        null,
    );
    expect(s1.streak.current).toBe(1);
});

test("buildStats: streak hitting the window edge is not undercounted", () => {
    // 7 дней подряд по вчера включительно (окно days=7 + запасной день)
    const dates = [
        "06-30",
        "07-01",
        "07-02",
        "07-03",
        "07-04",
        "07-05",
        "07-06",
    ];
    const meals = dates.map((d, i) =>
        meal({ id: `s${i}`, logged_at: `2026-${d}T08:00:00.000Z` }),
    );
    const s = buildStats("2026-07-07", 7, "UTC", meals, [], [], null);
    // Сегодня пусто, но серия упирается в край окна — полные 7, не 6.
    expect(s.streak.current).toBe(7);
    expect(s.days).toHaveLength(7);
    expect(s.days[0]!.date).toBe("2026-07-01");
});
