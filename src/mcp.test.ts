import { expect, test } from "bun:test";
import { formatMealSearchResults } from "./mcp.js";
import type { Meal } from "./db.js";

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
