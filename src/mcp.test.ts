import { expect, test } from "bun:test";
import {
    formatMealSearchResults,
    formatProductSearchResults,
    formatCalorieBank,
    formatTopContributors,
    formatWeeklySummary,
} from "./mcp.js";
import type { Meal, PersonalProduct } from "./db.js";

function meal(overrides: Partial<Meal> = {}): Meal {
    return {
        id: "meal-1",
        user_id: "user-1",
        logged_at: "2026-07-14T08:20:00.000Z",
        meal_type: "snack",
        description: "Булка с маком, 1 шт",
        calories: 310,
        protein_g: 8,
        carbs_g: 48,
        fat_g: 10,
        nutrition_source: "barcode",
        notes: null,
        idempotency_key: null,
        ...overrides,
    };
}

test("meal search output groups equal descriptions and macros but keeps variants", () => {
    const text = formatMealSearchResults(
        [
            meal({
                id: "old",
                logged_at: "2026-07-01T08:20:00.000Z",
            }),
            meal({ id: "new" }),
            meal({ id: "variant", calories: 250 }),
        ],
        8,
    );

    expect(text).toContain("Candidate 1 (occurrences: 2)");
    expect(text).toContain("Last logged: 2026-07-14T08:20:00.000Z");
    expect(text).toContain("Nutrition source: barcode");
    expect(text).toContain("Candidate 2 (occurrences: 1)");
    expect(text).toContain("Calories: 250");
    expect(text).toContain("call log_meal");
    expect(text).toContain("do not ask for another photo or barcode");
});

test("empty meal search output forbids asking for a previous date", () => {
    const text = formatMealSearchResults([], 8);

    expect(text).toContain("retry search_meals once");
    expect(text).toContain(
        "Do not ask the user for the date or time of a previous meal.",
    );
});

test("product search output carries exact reuse data and local next action", () => {
    const product: PersonalProduct = {
        id: "44d68a5c-b24c-4acd-87af-b12aa88fe238",
        user_id: "user-1",
        name: "Хлебцы Ого, 1 штука",
        barcode: "12345678",
        calories: 27,
        protein_g: 0.8,
        carbs_g: 5.2,
        fat_g: 0.3,
        nutrition_source: "barcode",
        last_eaten_at: "2026-07-20T10:00:00.000Z",
        created_at: "2026-07-01T10:00:00.000Z",
        updated_at: "2026-07-20T10:00:00.000Z",
    };

    const text = formatProductSearchResults([product]);
    expect(text).toContain(`Product ID: ${product.id}`);
    expect(text).toContain("Nutrition source: barcode");
    expect(text).toContain("Last eaten: 2026-07-20T10:00:00.000Z");
    expect(text).toContain("call log_saved_product");
    expect(text).toContain("without another photo, barcode, date");
});

test("calorie bank mirrors daily overage and remaining weekly balance", () => {
    const text = formatCalorieBank(
        {
            date: "2026-07-22",
            week_start: "2026-07-20",
            week_end: "2026-07-26",
            daily_target: 2000,
            day_calories: 2400,
            day_delta: 400,
            weekly_budget: 14000,
            week_calories: 13100,
            weekly_remaining: 900,
        },
        "Europe/Moscow",
    );
    expect(text).toContain("+400 kcal over");
    expect(text).toContain("bank 900 kcal remaining");
    expect(text).toContain("not labeled as a violation");
});

test("top contributor output includes calories, macro contribution, and neutral framing", () => {
    const text = formatTopContributors(
        [
            {
                description: "Хлебцы Ого",
                occurrences: 3,
                calories: 810,
                protein_g: 24,
                carbs_g: 144,
                fat_g: 30,
                calorie_share_pct: 42.6,
                last_logged_at: "2026-07-22T20:00:00.000Z",
            },
        ],
        "2026-07-20",
        "2026-07-26",
    );
    expect(text).toContain("810 kcal (42.6% of logged calories)");
    expect(text).toContain("P 24g · C 144g · F 30g");
    expect(text).toContain("does not prescribe removals or replacements");
});

test("weekly summary contains daily macros, bank, contributors, and mirror tone", () => {
    const text = formatWeeklySummary(
        [
            {
                date: "2026-07-20",
                meal_count: 2,
                calories: 2400,
                protein_g: 100,
                carbs_g: 260,
                fat_g: 80,
            },
            {
                date: "2026-07-26",
                meal_count: 0,
                calories: 0,
                protein_g: 0,
                carbs_g: 0,
                fat_g: 0,
            },
        ],
        {
            date: "2026-07-20",
            week_start: "2026-07-20",
            week_end: "2026-07-26",
            daily_target: 2000,
            day_calories: 2400,
            day_delta: 400,
            weekly_budget: 14000,
            week_calories: 13100,
            weekly_remaining: 900,
        },
        [
            {
                description: "Хлебцы Ого",
                occurrences: 3,
                calories: 810,
                protein_g: 24,
                carbs_g: 144,
                fat_g: 30,
                calorie_share_pct: 42.6,
                last_logged_at: "2026-07-22T20:00:00.000Z",
            },
        ],
        "Europe/Moscow",
    );

    expect(text).toContain("2026-07-20 to 2026-07-26");
    expect(text).toContain("P 100g · C 260g · F 80g");
    expect(text).toContain("900 kcal remaining");
    expect(text).toContain("Хлебцы Ого — 810 kcal");
    expect(text).toContain("no directive to remove, replace, or compensate");
});
