import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Context } from "hono";
import {
    insertMeal,
    getMealsByDate,
    getMealsInRange,
    deleteMeal,
    updateMeal,
    deleteAllUserData,
    patchNutritionGoals,
    getNutritionGoals,
    insertWater,
    getWaterByDate,
    getWaterInRange,
    deleteWater,
    insertWeight,
    getWeightByDate,
    getWeightInRange,
    getLatestWeight,
    updateWeight,
    deleteWeight,
    getUserTimezone,
    getPreferredWeightUnit,
    upsertProfile,
    getProfile,
    searchMeals,
    savePersonalProduct,
    getPersonalProduct,
    getPersonalProductByBarcode,
    searchPersonalProducts,
    markPersonalProductEaten,
    getCalorieBankSnapshot,
    getTopContributors,
    getDailyNutritionTotals,
    type Meal,
    type CalorieBankSnapshot,
    type DailyNutritionTotal,
    type PeriodContributor,
    type PersonalProduct,
    type NutritionGoals,
    type WaterEntry,
    type WeightEntry,
    type NutritionGoalsInput,
} from "./db.js";
import { withAnalytics } from "./analytics.js";
import {
    calendarWeekBounds,
    todayInTz,
    validateTz,
    shiftLocalDate,
    dateInTz,
} from "./tz.js";
import {
    buildDailyBuckets,
    computeTrends,
    computeMealPatterns,
    computeWeightTrend,
} from "./insights.js";
import {
    toGrams,
    formatWeight,
    fromGrams,
    isWeightUnit,
    pickWriteUnit,
    isPlausibleWeightGrams,
    type WeightUnit,
} from "./units.js";
import { exportMeals } from "./export.js";
import { normalizeBarcode, lookupBarcode, formatFoodResult } from "./foods.js";
import {
    nonNegativeNumber,
    validateDate,
    validateDateRange,
    validateLoggedAt,
} from "./validate.js";

interface DailyTotals {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    water_ml: number;
}

function sumMeals(meals: Meal[]): DailyTotals {
    const totals: DailyTotals = {
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 0,
        water_ml: 0,
    };
    for (const m of meals) {
        totals.calories += m.calories ?? 0;
        totals.protein_g += m.protein_g ?? 0;
        totals.carbs_g += m.carbs_g ?? 0;
        totals.fat_g += m.fat_g ?? 0;
    }
    return totals;
}

function sumWater(entries: WaterEntry[]): number {
    let total = 0;
    for (const e of entries) total += e.amount_ml;
    return total;
}

function formatGoalLine(
    label: string,
    unit: string,
    actual: number,
    target: number | null,
): string {
    if (target == null || target <= 0) {
        return `${label}: ${Math.round(actual * 10) / 10}${unit}`;
    }
    const pct = Math.round((actual / target) * 100);
    const delta = Math.round((target - actual) * 10) / 10;
    const deltaStr =
        delta > 0 ? `${delta}${unit} to go` : `${Math.abs(delta)}${unit} over`;
    return `${label}: ${Math.round(actual * 10) / 10} / ${target}${unit} (${pct}%, ${deltaStr})`;
}

function formatProgress(
    totals: DailyTotals,
    goals: NutritionGoals | null,
): string {
    const lines = [
        formatGoalLine(
            "Calories",
            " kcal",
            totals.calories,
            goals?.daily_calories ?? null,
        ),
        formatGoalLine(
            "Protein",
            "g",
            totals.protein_g,
            goals?.daily_protein_g ?? null,
        ),
        formatGoalLine(
            "Carbs",
            "g",
            totals.carbs_g,
            goals?.daily_carbs_g ?? null,
        ),
        formatGoalLine("Fat", "g", totals.fat_g, goals?.daily_fat_g ?? null),
        formatGoalLine(
            "Water",
            " ml",
            totals.water_ml,
            goals?.daily_water_ml ?? null,
        ),
    ];
    return lines.join("\n");
}

function formatGoals(
    goals: NutritionGoals | null,
    weightUnit: WeightUnit = "kg",
): string {
    if (!goals) {
        return "No nutrition goals set. Use set_nutrition_goals to define daily targets.";
    }
    const parts: string[] = ["Current daily goals:"];
    parts.push(
        `- Calories: ${goals.daily_calories != null ? `${goals.daily_calories} kcal` : "not set"}`,
    );
    parts.push(
        `- Protein: ${goals.daily_protein_g != null ? `${goals.daily_protein_g}g` : "not set"}`,
    );
    parts.push(
        `- Carbs: ${goals.daily_carbs_g != null ? `${goals.daily_carbs_g}g` : "not set"}`,
    );
    parts.push(
        `- Fat: ${goals.daily_fat_g != null ? `${goals.daily_fat_g}g` : "not set"}`,
    );
    parts.push(
        `- Water: ${goals.daily_water_ml != null ? `${goals.daily_water_ml} ml` : "not set"}`,
    );
    parts.push(
        `- Target weight: ${goals.target_weight_g != null ? formatWeight(goals.target_weight_g, weightUnit) : "not set"}`,
    );
    return parts.join("\n");
}

export function formatCalorieBank(
    snapshot: CalorieBankSnapshot | null,
    tz: string,
): string {
    if (!snapshot) {
        return "Calorie bank unavailable because no positive daily calorie target is set.";
    }
    const daily =
        snapshot.day_delta === 0
            ? "on target"
            : snapshot.day_delta > 0
              ? `+${snapshot.day_delta} kcal over`
              : `${Math.abs(snapshot.day_delta)} kcal under`;
    const bank =
        snapshot.weekly_remaining >= 0
            ? `${snapshot.weekly_remaining} kcal remaining`
            : `${Math.abs(snapshot.weekly_remaining)} kcal over`;
    return [
        `Calorie bank — ${snapshot.week_start} to ${snapshot.week_end} (${tz})`,
        `Day ${snapshot.date}: ${snapshot.day_calories} / ${snapshot.daily_target} kcal (${daily}).`,
        `Calendar week: ${snapshot.week_calories} / ${snapshot.weekly_budget} kcal; bank ${bank}.`,
        snapshot.weekly_remaining >= 0
            ? "The weekly bank is non-negative; late or overnight intake is included in this balance, not labeled as a violation."
            : "The weekly bank is negative; this states the recorded balance without a change recommendation.",
    ].join("\n");
}

export function formatTopContributors(
    contributors: PeriodContributor[],
    startDate: string,
    endDate: string,
): string {
    if (contributors.length === 0) {
        return `No logged meals between ${startDate} and ${endDate}; there are no contributors to rank.`;
    }
    return [
        `Top calorie contributors — ${startDate} to ${endDate}`,
        ...contributors.map(
            (item, index) =>
                `${index + 1}. ${item.description} — ${item.calories} kcal (${item.calorie_share_pct}% of logged calories), P ${item.protein_g}g · C ${item.carbs_g}g · F ${item.fat_g}g; ${item.occurrences} entr${item.occurrences === 1 ? "y" : "ies"}, last ${item.last_logged_at}`,
        ),
        "This ranking states recorded contributions; it does not prescribe removals or replacements.",
    ].join("\n");
}

export function formatWeeklySummary(
    daily: DailyNutritionTotal[],
    bank: CalorieBankSnapshot | null,
    contributors: PeriodContributor[],
    tz: string,
): string {
    const startDate = daily[0]?.date ?? bank?.week_start ?? "unknown";
    const endDate =
        daily[daily.length - 1]?.date ?? bank?.week_end ?? "unknown";
    const lines = [
        `Weekly nutrition summary — ${startDate} to ${endDate} (${tz})`,
        "",
        "Daily totals:",
        ...daily.map(
            (day) =>
                `- ${day.date}: ${day.calories} kcal · P ${day.protein_g}g · C ${day.carbs_g}g · F ${day.fat_g}g (${day.meal_count} meal${day.meal_count === 1 ? "" : "s"})`,
        ),
        "",
        "Calorie bank:",
    ];
    if (bank) {
        const remaining =
            bank.weekly_remaining >= 0
                ? `${bank.weekly_remaining} kcal remaining`
                : `${Math.abs(bank.weekly_remaining)} kcal over`;
        lines.push(
            `- ${bank.week_calories} / ${bank.weekly_budget} kcal; ${remaining}.`,
            `- ${bank.date}: ${bank.day_calories} / ${bank.daily_target} kcal (${bank.day_delta > 0 ? `+${bank.day_delta} over` : bank.day_delta < 0 ? `${Math.abs(bank.day_delta)} under` : "on target"}).`,
        );
    } else {
        lines.push(
            "- Unavailable because no positive daily calorie target is set.",
        );
    }
    lines.push("", "Top contributors:");
    if (contributors.length === 0) {
        lines.push("- No logged meals to rank.");
    } else {
        lines.push(
            ...contributors.map(
                (item, index) =>
                    `${index + 1}. ${item.description} — ${item.calories} kcal (${item.calorie_share_pct}%), P ${item.protein_g}g · C ${item.carbs_g}g · F ${item.fat_g}g; ${item.occurrences} entr${item.occurrences === 1 ? "y" : "ies"}.`,
            ),
        );
    }
    lines.push(
        "",
        "This is a factual digest of recorded intake, with no directive to remove, replace, or compensate.",
    );
    return lines.join("\n");
}

async function weeklySummaryForUser(
    userId: string,
    date?: string,
): Promise<string> {
    const tz = await getUserTimezone(userId);
    const targetDate = date ?? todayInTz(tz);
    validateDate(targetDate);
    const { startDate, endDate } = calendarWeekBounds(targetDate);
    const [daily, bank, contributors] = await Promise.all([
        getDailyNutritionTotals(userId, startDate, endDate, tz),
        getCalorieBankSnapshot(userId, targetDate, tz),
        getTopContributors(userId, startDate, endDate, tz, 10),
    ]);
    return formatWeeklySummary(daily, bank, contributors, tz);
}

function formatWeightEntry(entry: WeightEntry, unit: WeightUnit): string {
    return `- ${formatWeight(entry.weight_g, unit)} at ${entry.logged_at}${entry.notes ? ` (${entry.notes})` : ""} [id: ${entry.id}]`;
}

// Resolve the unit to use when WRITING a weight value: an explicit unit wins,
// otherwise the user's saved preference. If neither exists, refuse rather than
// guess — silently assuming kg for someone who meant lb is exactly the mis-log
// this feature exists to prevent.
async function resolveWriteWeightUnit(
    userId: string,
    explicit: WeightUnit | undefined,
): Promise<WeightUnit> {
    return pickWriteUnit(explicit, await getPreferredWeightUnit(userId));
}

// Reject magnitude mistakes (value typed in grams, an extra digit, a sub-unit
// typo). Suggests the other unit when the same number would be plausible there.
function assertPlausibleWeight(grams: number, unit: WeightUnit): void {
    if (isPlausibleWeightGrams(grams)) return;
    const other: WeightUnit = unit === "kg" ? "lb" : "kg";
    const asOther = toGrams(fromGrams(grams, unit), other);
    const hint = isPlausibleWeightGrams(asOther)
        ? ` If you meant ${fromGrams(grams, unit)} ${other}, pass unit: '${other}'.`
        : "";
    throw new Error(
        `${formatWeight(grams, unit)} is outside the plausible body-weight range (20–500 kg / 44–1102 lb). Double-check the number and unit.${hint}`,
    );
}

function formatMeal(meal: Meal): string {
    const parts = [
        `ID: ${meal.id}`,
        `Time: ${meal.logged_at}`,
        meal.meal_type ? `Type: ${meal.meal_type}` : null,
        `Description: ${meal.description}`,
        meal.calories != null ? `Calories: ${meal.calories}` : null,
        meal.protein_g != null ? `Protein: ${meal.protein_g}g` : null,
        meal.carbs_g != null ? `Carbs: ${meal.carbs_g}g` : null,
        meal.fat_g != null ? `Fat: ${meal.fat_g}g` : null,
        meal.notes ? `Notes: ${meal.notes}` : null,
    ];
    return parts.filter(Boolean).join("\n");
}

export function formatMealSearchResults(meals: Meal[], limit: number): string {
    if (meals.length === 0) {
        return [
            "No meal history matches.",
            "Next: retry search_meals once with fewer food words or a likely synonym. If there is still no match, ask for a barcode/photo or estimate. Do not ask the user for the date or time of a previous meal.",
        ].join("\n\n");
    }

    const grouped = new Map<string, { meal: Meal; occurrences: number }>();
    for (const meal of meals) {
        const key = JSON.stringify([
            meal.description.trim().toLowerCase(),
            meal.calories,
            meal.protein_g,
            meal.carbs_g,
            meal.fat_g,
        ]);
        const existing = grouped.get(key);
        if (existing) {
            existing.occurrences += 1;
            if (meal.logged_at > existing.meal.logged_at) existing.meal = meal;
        } else {
            grouped.set(key, { meal, occurrences: 1 });
        }
    }

    const candidates = [...grouped.values()].slice(0, limit);
    const sections = candidates.map(({ meal, occurrences }, index) => {
        const lines = [
            `Candidate ${index + 1} (occurrences: ${occurrences})`,
            `Description: ${meal.description}`,
            `Last logged: ${meal.logged_at}`,
            meal.meal_type ? `Type: ${meal.meal_type}` : null,
            `Calories: ${meal.calories ?? "not recorded"}`,
            `Protein: ${meal.protein_g != null ? `${meal.protein_g}g` : "not recorded"}`,
            `Carbs: ${meal.carbs_g != null ? `${meal.carbs_g}g` : "not recorded"}`,
            `Fat: ${meal.fat_g != null ? `${meal.fat_g}g` : "not recorded"}`,
            `Nutrition source: ${meal.nutrition_source ?? "unknown"}`,
            meal.notes ? `Notes: ${meal.notes}` : null,
        ];
        return lines.filter(Boolean).join("\n");
    });

    return [
        sections.join("\n\n"),
        "Next: if one candidate is clearly the same product and portion, call log_meal with its nutrition values and nutrition source; do not ask for another photo or barcode. If the portion differs, ask for the amount and scale the values. If multiple candidates are plausible, ask which one; do not guess.",
    ].join("\n\n");
}

function formatPersonalProduct(product: PersonalProduct): string {
    return [
        `Product ID: ${product.id}`,
        `Name: ${product.name}`,
        product.barcode ? `Barcode: ${product.barcode}` : null,
        `Calories: ${product.calories ?? "not recorded"}`,
        `Protein: ${product.protein_g != null ? `${product.protein_g}g` : "not recorded"}`,
        `Carbs: ${product.carbs_g != null ? `${product.carbs_g}g` : "not recorded"}`,
        `Fat: ${product.fat_g != null ? `${product.fat_g}g` : "not recorded"}`,
        `Nutrition source: ${product.nutrition_source}`,
        `Last eaten: ${product.last_eaten_at ?? "not eaten since saved"}`,
    ]
        .filter(Boolean)
        .join("\n");
}

export function formatProductSearchResults(
    products: PersonalProduct[],
): string {
    if (products.length === 0) {
        return [
            "No personal product matches.",
            "Next: retry search_products once with fewer identifying words or a likely synonym, then try search_meals. Do not ask for a previous date, photo, or barcode while local search options remain.",
        ].join("\n\n");
    }

    return [
        products
            .map(
                (product, index) =>
                    `Candidate ${index + 1}\n${formatPersonalProduct(product)}`,
            )
            .join("\n\n"),
        "Next: when one candidate matches, call log_saved_product with its Product ID; its stored macros and nutrition source are reused without another photo, barcode, date, or external lookup. If several candidates remain plausible, ask which one.",
    ].join("\n\n");
}

function registerTools(server: McpServer, userId: string) {
    server.registerTool(
        "remember_product",
        {
            title: "Remember Personal Product",
            description:
                "Save or refresh a packaged product in the user's private product memory without logging a meal. Call this whenever structured package nutrition is available from a photo parsed by the agent, user-provided label values, a purchase registration, or a failed external barcode lookup. The MCP server cannot inspect photos: pass the extracted name and complete calories/macros as numbers. Include a barcode when known so future lookup_barcode calls resolve locally. Do not ask for the photo again when the structured values are already in context.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .trim()
                    .min(1)
                    .max(200)
                    .describe(
                        "Product name including the nutrition basis or portion when relevant, e.g. 'Хлебцы Ого, 1 штука'.",
                    ),
                calories: z
                    .number()
                    .min(0)
                    .describe("Calories for the named basis or portion."),
                protein_g: z
                    .number()
                    .min(0)
                    .describe("Protein grams for the named basis or portion."),
                carbs_g: z
                    .number()
                    .min(0)
                    .describe(
                        "Carbohydrate grams for the named basis or portion.",
                    ),
                fat_g: z
                    .number()
                    .min(0)
                    .describe("Fat grams for the named basis or portion."),
                barcode: z
                    .string()
                    .optional()
                    .describe(
                        "Optional EAN/UPC/GTIN barcode digits read from the package. Separators are ignored.",
                    ),
            },
        },
        async ({ name, calories, protein_g, carbs_g, fat_g, barcode }) => {
            return withAnalytics(
                "remember_product",
                async () => {
                    const normalized = barcode
                        ? normalizeBarcode(barcode)
                        : null;
                    if (barcode && !normalized) {
                        throw new Error(
                            "barcode must contain 8–14 digits (EAN/UPC/GTIN)",
                        );
                    }
                    const product = await savePersonalProduct(userId, {
                        name,
                        barcode: normalized,
                        calories: nonNegativeNumber(calories),
                        protein_g: nonNegativeNumber(protein_g),
                        carbs_g: nonNegativeNumber(carbs_g),
                        fat_g: nonNegativeNumber(fat_g),
                        nutrition_source: normalized ? "barcode" : "manual",
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Product saved in personal memory; no meal was logged.\n${formatPersonalProduct(product)}\n\nIf the user also reported eating it, log_saved_product records that saved portion.`,
                            },
                        ],
                    };
                },
                { userId },
                { barcode: barcode ?? null },
            );
        },
    );

    server.registerTool(
        "search_products",
        {
            title: "Find Personal Product",
            description:
                "Search the user's private product memory by free-form product words; no previous date is needed. Call this first when the user names a familiar packaged product or says they ate the same product again. It ranks Russian full-text and literal matches, and returns exact stored macros, source, barcode, and last-eaten time. Use search_meals only if personal product search has no match. Do not request another photo, barcode, or date before searching locally.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                query: z
                    .string()
                    .min(1)
                    .max(200)
                    .describe(
                        "Only identifying product words from the user's phrase, e.g. 'хлебцы Ого'; omit verbs, dates, and meal times.",
                    ),
                limit: z.coerce
                    .number()
                    .int()
                    .min(1)
                    .max(20)
                    .optional()
                    .describe("Maximum candidates to return; defaults to 8."),
            },
        },
        async ({ query, limit }) => {
            return withAnalytics(
                "search_products",
                async () => {
                    if (!query.trim()) throw new Error("query required");
                    const products = await searchPersonalProducts(
                        userId,
                        query.trim(),
                        limit ?? 8,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatProductSearchResults(products),
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "log_saved_product",
        {
            title: "Log Saved Product",
            description:
                "Log a meal directly from a product returned by search_products or lookup_barcode. Stored calories/macros and nutrition source are reused; a barcode-sourced product remains barcode-sourced. Call this instead of asking for another photo, barcode, nutrition label, or previous date. Quantity defaults to one saved portion. This tool is for a product the user reported eating, not merely buying or saving.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                product_id: z
                    .string()
                    .uuid()
                    .describe(
                        "Product ID returned by search_products, remember_product, or lookup_barcode.",
                    ),
                quantity: z
                    .number()
                    .positive()
                    .max(100)
                    .optional()
                    .describe(
                        "Number of saved portions eaten; defaults to 1. Use an explicit amount from the user when provided.",
                    ),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .optional()
                    .describe(
                        "Meal type when stated or clear from context. Omit rather than asking; omission is recorded as snack.",
                    ),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 eating time when the user specified one; defaults to now. Do not ask for a previous date.",
                    ),
                idempotency_key: z
                    .string()
                    .min(1)
                    .max(255)
                    .optional()
                    .describe(
                        "Stable retry key. Do not reuse it for a different meal.",
                    ),
            },
        },
        async ({
            product_id,
            quantity = 1,
            meal_type,
            logged_at,
            idempotency_key,
        }) => {
            return withAnalytics(
                "log_saved_product",
                async () => {
                    if (logged_at !== undefined)
                        validateLoggedAt(logged_at, Date.now());
                    const product = await getPersonalProduct(
                        userId,
                        product_id,
                    );
                    if (!product) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Saved product not found in this user's personal memory. No meal was logged.",
                                },
                            ],
                        };
                    }
                    const scaled = (value: number | null) =>
                        value == null
                            ? undefined
                            : Math.round(value * quantity * 100) / 100;
                    const { meal, deduplicated } = await insertMeal(userId, {
                        description:
                            quantity === 1
                                ? product.name
                                : `${product.name} × ${quantity}`,
                        meal_type: meal_type ?? "snack",
                        calories:
                            product.calories == null
                                ? undefined
                                : Math.round(product.calories * quantity),
                        protein_g: scaled(product.protein_g),
                        carbs_g: scaled(product.carbs_g),
                        fat_g: scaled(product.fat_g),
                        nutrition_source: product.nutrition_source,
                        logged_at,
                        idempotency_key,
                    });
                    await markPersonalProductEaten(
                        userId,
                        product.id,
                        meal.logged_at,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${deduplicated ? "Meal already logged (idempotent retry):" : "Saved product logged:"}\n${formatMeal(meal)}\nProduct source retained: ${product.nutrition_source}.`,
                            },
                        ],
                    };
                },
                { userId },
                { product_id, quantity },
            );
        },
    );

    server.registerTool(
        "log_meal",
        {
            title: "Log Meal",
            description:
                "Log a meal entry with nutritional information. If the user doesn't specify the quantity or portion size, ask how much they ate before estimating calories and macros. Routing: when the user provides barcode digits, call lookup_barcode first. For a familiar named packaged product or 'the same product again', call search_products and then log_saved_product. For other previously eaten food, call search_meals before asking for another photo/barcode or using web search or estimation. When structured package values came from the agent's photo parsing, call remember_product so the product is available next time.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                description: z.string().describe("What was eaten"),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .describe(
                        "Type of meal (breakfast, lunch, dinner, or snack). Always ask the user if not provided.",
                    ),
                calories: z
                    .number()
                    .min(0)
                    .optional()
                    .describe("Total calories"),
                protein_g: z
                    .number()
                    .min(0)
                    .optional()
                    .describe("Protein in grams"),
                carbs_g: z
                    .number()
                    .min(0)
                    .optional()
                    .describe("Carbohydrates in grams"),
                fat_g: z.number().min(0).optional().describe("Fat in grams"),
                nutrition_source: z
                    .enum(["estimate", "barcode", "dish", "manual"])
                    .optional()
                    .describe(
                        "Where the nutrition values came from (defaults to estimate).",
                    ),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). If you don't know the current date or time, ask the user before calling this tool.",
                    ),
                notes: z.string().optional().describe("Additional notes"),
                idempotency_key: z
                    .string()
                    .min(1)
                    .max(255)
                    .optional()
                    .describe(
                        "Stable client-supplied key for retry deduplication. Without one, retries may create another meal. Do NOT reuse a key for genuinely different meals.",
                    ),
            },
        },
        async (args) => {
            return withAnalytics(
                "log_meal",
                async () => {
                    if (args.logged_at !== undefined)
                        validateLoggedAt(args.logged_at, Date.now());
                    for (const key of [
                        "calories",
                        "protein_g",
                        "carbs_g",
                        "fat_g",
                    ] as const) {
                        if (args[key] !== undefined)
                            args[key] = nonNegativeNumber(args[key]);
                    }
                    const { meal, deduplicated } = await insertMeal(userId, {
                        ...args,
                        nutrition_source: args.nutrition_source ?? "estimate",
                    });
                    const header = deduplicated
                        ? "Meal already logged (idempotent retry):"
                        : "Meal logged:";

                    const tz = await getUserTimezone(userId);
                    const mealDate = dateInTz(meal.logged_at, tz);
                    const [meals, waterEntries, goals] = await Promise.all([
                        getMealsByDate(userId, mealDate, tz),
                        getWaterByDate(userId, mealDate, tz),
                        getNutritionGoals(userId),
                    ]);

                    const totals = sumMeals(meals);
                    totals.water_ml = sumWater(waterEntries);

                    let progressSection: string;
                    if (goals) {
                        progressSection = `\n\nDaily progress (${mealDate}):\n${formatProgress(totals, goals)}`;
                    } else {
                        progressSection =
                            "\n\nNo nutrition goals set — use the set_nutrition_goals tool to track progress against daily targets.";
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: `${header}\n${formatMeal(meal)}${progressSection}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "lookup_barcode",
        {
            title: "Look Up Barcode",
            description:
                "Look up a packaged product by barcode, checking the user's personal product memory before Open Food Facts. Pass EAN/UPC/GTIN digits typed by the user or read by the agent from a package photo. A successful external result is saved to personal memory automatically; a barcode previously paired with structured photo-parsed nutrition resolves locally thereafter. If the user ate the returned saved portion, call log_saved_product so the barcode nutrition source is retained.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                barcode: z
                    .string()
                    .describe(
                        "Product barcode digits (EAN-8/13, UPC-A/E, or GTIN-14). Spaces and separators are ignored.",
                    ),
            },
        },
        async ({ barcode }) => {
            return withAnalytics(
                "lookup_barcode",
                async () => {
                    const normalized = normalizeBarcode(barcode);
                    if (!normalized) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `"${barcode}" is not a valid barcode (expected 8–14 digits). Double-check the number, or estimate the macros from the product description instead.`,
                                },
                            ],
                        };
                    }

                    const remembered = await getPersonalProductByBarcode(
                        userId,
                        normalized,
                    );
                    if (remembered) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Personal product memory match; no external API was called.\n${formatPersonalProduct(remembered)}\n\nNext: if the user ate this saved portion, call log_saved_product with Product ID ${remembered.id}; no photo, barcode, or date clarification is needed.`,
                                },
                            ],
                        };
                    }

                    let food;
                    try {
                        food = await lookupBarcode(normalized);
                    } catch (err) {
                        const msg =
                            err instanceof Error ? err.message : String(err);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Couldn't reach Open Food Facts right now (${msg}). Estimate the macros from the product description or ask the user, then log the meal.`,
                                },
                            ],
                        };
                    }

                    if (!food) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No personal or Open Food Facts product was found for barcode ${normalized}. If structured package nutrition is already available from the agent's photo parsing, remember_product can save it with this barcode without requesting the photo again; no meal has been logged.`,
                                },
                            ],
                        };
                    }

                    const title = [
                        food.name,
                        food.brand ? `(${food.brand})` : null,
                        food.serving ? `— ${food.serving}` : null,
                    ]
                        .filter(Boolean)
                        .join(" ");
                    const product = await savePersonalProduct(userId, {
                        name: title,
                        barcode: food.barcode,
                        calories: food.calories,
                        protein_g: food.protein_g,
                        carbs_g: food.carbs_g,
                        fat_g: food.fat_g,
                        nutrition_source: "barcode",
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${formatFoodResult(food)}\nSaved to personal product memory as Product ID ${product.id}.\n\nNext: if the user ate this saved portion, call log_saved_product; the barcode source is retained.`,
                            },
                        ],
                    };
                },
                { userId },
                { barcode },
            );
        },
    );

    server.registerTool(
        "get_meals_today",
        {
            title: "Get Today's Meals",
            description: "Get all meals logged today",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_meals_today",
                async () => {
                    const tz = await getUserTimezone(userId);
                    const meals = await getMealsByDate(
                        userId,
                        todayInTz(tz),
                        tz,
                    );
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No meals logged today.",
                                },
                            ],
                        };
                    }
                    const text = meals.map(formatMeal).join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_meals_by_date",
        {
            title: "Get Meals by Date",
            description: "Get all meals for a specific date",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z.string().describe("Date in YYYY-MM-DD format"),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_meals_by_date",
                async () => {
                    validateDate(date);
                    const tz = await getUserTimezone(userId);
                    const meals = await getMealsByDate(userId, date, tz);
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals logged on ${date}.`,
                                },
                            ],
                        };
                    }
                    const text = meals.map(formatMeal).join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
                { date },
            );
        },
    );

    server.registerTool(
        "get_meals_by_date_range",
        {
            title: "Get Meals by Date Range",
            description:
                "Get all meals between two dates (inclusive). Use this instead of multiple get_meals_by_date calls when you need meals for more than one day.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_meals_by_date_range",
                async () => {
                    validateDateRange(start_date, end_date);
                    const tz = await getUserTimezone(userId);
                    const meals = await getMealsInRange(
                        userId,
                        start_date,
                        end_date,
                        tz,
                    );
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals found between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }

                    // Group by date for readability (local to user timezone)
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = dateInTz(meal.logged_at, tz);
                        const existing = byDate.get(date) ?? [];
                        existing.push(meal);
                        byDate.set(date, existing);
                    }

                    const sections: string[] = [];
                    for (const [date, dateMeals] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const header = `## ${date} (${dateMeals.length} meal${dateMeals.length === 1 ? "" : "s"})`;
                        const formatted = dateMeals
                            .map(formatMeal)
                            .join("\n\n---\n\n");
                        sections.push(`${header}\n\n${formatted}`);
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: sections.join("\n\n===\n\n"),
                            },
                        ],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    server.registerTool(
        "search_meals",
        {
            title: "Find Previously Eaten Food",
            description:
                "Search the user's entire meal history by food or product name; no date is required. Call this before asking for another photo, barcode, nutrition label, web search, or estimating whenever the user refers to something eaten before — for example 'the same one', 'that bun', 'as usual', 'again', or a familiar named product without nutrition values. Pass only identifying food/product words, not the whole user sentence or dates. Results are ranked by relevance. Reuse nutrition only when both the product and eaten portion match; otherwise ask a short clarification.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                query: z
                    .string()
                    .min(1)
                    .max(200)
                    .describe(
                        "Identifying food or product words extracted from the user's request, e.g. 'булка мак' for 'съел ту булку с маком'. Do not include verbs, pronouns, dates, or meal times.",
                    ),
                limit: z.coerce.number().int().min(1).max(100).optional(),
            },
        },
        async ({ query, limit }) => {
            return withAnalytics(
                "search_meals",
                async () => {
                    if (!query.trim()) throw new Error("query required");
                    const candidateLimit = limit ?? 8;
                    // Group after a bounded broad fetch so repeats do not crowd
                    // distinct candidates out of the MCP response.
                    const meals = await searchMeals(userId, query.trim(), 100);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatMealSearchResults(
                                    meals,
                                    candidateLimit,
                                ),
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_nutrition_summary",
        {
            title: "Get Nutrition Summary",
            description: "Get daily nutrition totals for a date range",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_nutrition_summary",
                async () => {
                    validateDateRange(start_date, end_date);
                    const tz = await getUserTimezone(userId);
                    const [meals, water, goals] = await Promise.all([
                        getMealsInRange(userId, start_date, end_date, tz),
                        getWaterInRange(userId, start_date, end_date, tz),
                        getNutritionGoals(userId),
                    ]);
                    if (meals.length === 0 && water.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals or water logged between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }

                    // Group by date (local to user timezone)
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = dateInTz(meal.logged_at, tz);
                        const existing = byDate.get(date) ?? [];
                        existing.push(meal);
                        byDate.set(date, existing);
                    }
                    const waterByDate = new Map<string, number>();
                    for (const entry of water) {
                        const date = dateInTz(entry.logged_at, tz);
                        waterByDate.set(
                            date,
                            (waterByDate.get(date) ?? 0) + entry.amount_ml,
                        );
                        if (!byDate.has(date)) byDate.set(date, []);
                    }

                    const sections: string[] = [];
                    for (const [date, dateMeals] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const totals = sumMeals(dateMeals);
                        totals.water_ml = waterByDate.get(date) ?? 0;
                        const header = `## ${date} (${dateMeals.length} meal${dateMeals.length === 1 ? "" : "s"})`;
                        sections.push(
                            `${header}\n${formatProgress(totals, goals)}`,
                        );
                    }

                    const footer = goals
                        ? ""
                        : "\n\n(Tip: set daily targets with set_nutrition_goals to see progress percentages.)";

                    return {
                        content: [
                            {
                                type: "text",
                                text: sections.join("\n\n") + footer,
                            },
                        ],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    server.registerTool(
        "set_nutrition_goals",
        {
            title: "Set Nutrition Goals",
            description:
                "Set the user's daily calorie and macro targets, and optionally a target body weight. Pass only the fields you want to update — omitted fields keep their previous value. Pass null explicitly to clear a target.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                daily_calories: z
                    .number()
                    .min(0)
                    .nullable()
                    .optional()
                    .describe("Daily calorie target (kcal). Null to clear."),
                daily_protein_g: z
                    .number()
                    .min(0)
                    .nullable()
                    .optional()
                    .describe("Daily protein target (grams). Null to clear."),
                daily_carbs_g: z
                    .number()
                    .min(0)
                    .nullable()
                    .optional()
                    .describe("Daily carbs target (grams). Null to clear."),
                daily_fat_g: z
                    .number()
                    .min(0)
                    .nullable()
                    .optional()
                    .describe("Daily fat target (grams). Null to clear."),
                daily_water_ml: z
                    .number()
                    .min(0)
                    .nullable()
                    .optional()
                    .describe(
                        "Daily water target (milliliters). Null to clear.",
                    ),
                target_weight: z
                    .number()
                    .positive()
                    .nullable()
                    .optional()
                    .describe(
                        "Target body weight in `unit` (defaults to the user's preferred weight unit). Null to clear.",
                    ),
                unit: z
                    .enum(["kg", "lb"])
                    .optional()
                    .describe(
                        "Unit for target_weight. Defaults to the user's preferred weight unit.",
                    ),
            },
        },
        async (args) => {
            return withAnalytics(
                "set_nutrition_goals",
                async () => {
                    const preferredUnit = await getPreferredWeightUnit(userId);
                    const patch: NutritionGoalsInput = {};
                    for (const key of [
                        "daily_calories",
                        "daily_protein_g",
                        "daily_carbs_g",
                        "daily_fat_g",
                        "daily_water_ml",
                    ] as const) {
                        if (args[key] !== undefined) patch[key] = args[key];
                    }
                    // Only demand a unit when actually writing a numeric target.
                    if (args.target_weight === null) {
                        patch.target_weight_g = null;
                    } else {
                        if (args.target_weight !== undefined) {
                            const writeUnit = await resolveWriteWeightUnit(
                                userId,
                                args.unit,
                            );
                            patch.target_weight_g = toGrams(
                                args.target_weight,
                                writeUnit,
                            );
                            assertPlausibleWeight(
                                patch.target_weight_g,
                                writeUnit,
                            );
                        }
                    }
                    const displayUnit = args.unit ?? preferredUnit ?? "kg";
                    const goals = await patchNutritionGoals(userId, patch);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Goals updated.\n\n${formatGoals(goals, displayUnit)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_nutrition_goals",
        {
            title: "Get Nutrition Goals",
            description:
                "Get the user's current daily calorie and macro targets.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_nutrition_goals",
                async () => {
                    const [goals, unit] = await Promise.all([
                        getNutritionGoals(userId),
                        getPreferredWeightUnit(userId),
                    ]);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatGoals(goals, unit ?? "kg"),
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_calorie_bank",
        {
            title: "Get Daily and Weekly Calorie Balance",
            description:
                "Get both calorie levels in one call: the selected day's intake vs daily target and the containing Monday–Sunday calorie bank (daily target × 7) in the user's timezone. Call this when the user asks what remains today, asks about weekly flexibility, or a late/night snack puts a day over target. When the weekly bank remains non-negative, report the intake as covered by that remaining balance rather than as a violation. State facts only; do not prescribe compensation.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z
                    .string()
                    .optional()
                    .describe(
                        "Local date in YYYY-MM-DD; defaults to today. Omit rather than asking the user for today's date.",
                    ),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_calorie_bank",
                async () => {
                    const tz = await getUserTimezone(userId);
                    const targetDate = date ?? todayInTz(tz);
                    validateDate(targetDate);
                    const snapshot = await getCalorieBankSnapshot(
                        userId,
                        targetDate,
                        tz,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatCalorieBank(snapshot, tz),
                            },
                        ],
                    };
                },
                { userId },
                { date: date ?? "today" },
            );
        },
    );

    server.registerTool(
        "get_top_contributors",
        {
            title: "Get Period Top Contributors",
            description:
                "Return a ranked, pre-aggregated list of foods/meals contributing the most calories in a requested window, including calorie share, protein, carbs, fat, occurrence count, and last logged time. Call this once for questions such as 'what caused the overage this week?' instead of fetching or manually scanning individual days. With no dates it uses the current Monday–Sunday week in the user's timezone. State contributions without telling the user to remove or replace foods.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z
                    .string()
                    .optional()
                    .describe(
                        "Inclusive local start date (YYYY-MM-DD). Supply together with end_date only for an explicit window; omit for the current calendar week.",
                    ),
                end_date: z
                    .string()
                    .optional()
                    .describe(
                        "Inclusive local end date (YYYY-MM-DD). Supply together with start_date only for an explicit window; omit for the current calendar week.",
                    ),
                limit: z.coerce
                    .number()
                    .int()
                    .min(1)
                    .max(50)
                    .optional()
                    .describe("Maximum ranked contributors; defaults to 10."),
            },
        },
        async ({ start_date, end_date, limit }) => {
            return withAnalytics(
                "get_top_contributors",
                async () => {
                    if ((start_date == null) !== (end_date == null)) {
                        throw new Error(
                            "start_date and end_date must be supplied together",
                        );
                    }
                    const tz = await getUserTimezone(userId);
                    const currentWeek = calendarWeekBounds(todayInTz(tz));
                    const startDate = start_date ?? currentWeek.startDate;
                    const endDate = end_date ?? currentWeek.endDate;
                    validateDateRange(startDate, endDate);
                    const contributors = await getTopContributors(
                        userId,
                        startDate,
                        endDate,
                        tz,
                        limit ?? 10,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatTopContributors(
                                    contributors,
                                    startDate,
                                    endDate,
                                ),
                            },
                        ],
                    };
                },
                { userId },
                {
                    start_date: start_date ?? "current-week",
                    end_date: end_date ?? "current-week",
                },
            );
        },
    );

    server.registerTool(
        "get_weekly_summary",
        {
            title: "Get Calendar Week Nutrition Summary",
            description:
                "Build the complete material for a weekly nutrition digest in one call: Monday–Sunday daily calorie/macro totals in the user's timezone, calorie-bank state, and ranked top contributors. Call this for 'how is my week?' and scheduled Hermes weekly digests; do not make extra per-day or contributor calls. The returned text is a neutral mirror of recorded facts, not coaching, and does not tell the user to remove, replace, or compensate.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z
                    .string()
                    .optional()
                    .describe(
                        "Any local YYYY-MM-DD date inside the requested calendar week; defaults to today. Omit for 'this week' instead of asking the user for dates.",
                    ),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_weekly_summary",
                async () => ({
                    content: [
                        {
                            type: "text",
                            text: await weeklySummaryForUser(userId, date),
                        },
                    ],
                }),
                { userId },
                { date: date ?? "current-week" },
            );
        },
    );

    server.registerTool(
        "get_goal_progress",
        {
            title: "Get Goal Progress",
            description:
                "Get progress against daily nutrition goals for a specific date (defaults to today). Returns intake vs. target with remaining amounts for each macro.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z
                    .string()
                    .optional()
                    .describe("Date in YYYY-MM-DD format. Defaults to today."),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_goal_progress",
                async () => {
                    const tz = await getUserTimezone(userId);
                    const targetDate = date ?? todayInTz(tz);
                    validateDate(targetDate);
                    const [meals, water, goals, latestWeight, weightPref] =
                        await Promise.all([
                            getMealsByDate(userId, targetDate, tz),
                            getWaterByDate(userId, targetDate, tz),
                            getNutritionGoals(userId),
                            getLatestWeight(userId),
                            getPreferredWeightUnit(userId),
                        ]);
                    const unit = weightPref ?? "kg";
                    const totals = sumMeals(meals);
                    totals.water_ml = sumWater(water);
                    const header = `Progress for ${targetDate} (${meals.length} meal${meals.length === 1 ? "" : "s"}, ${water.length} water entr${water.length === 1 ? "y" : "ies"})`;
                    const body = formatProgress(totals, goals);

                    // Weight is a standing metric (latest overall), not per-date.
                    let weightLine = "";
                    if (latestWeight) {
                        const loggedOn = dateInTz(latestWeight.logged_at, tz);
                        if (goals?.target_weight_g != null) {
                            const delta =
                                latestWeight.weight_g - goals.target_weight_g;
                            const remaining = fromGrams(Math.abs(delta), unit);
                            const goalStr =
                                remaining === 0
                                    ? "at target"
                                    : `${remaining} ${unit} ${delta > 0 ? "to lose" : "to gain"}`;
                            weightLine = `\nWeight: ${formatWeight(latestWeight.weight_g, unit)} / ${formatWeight(goals.target_weight_g, unit)} target (${goalStr}, last logged ${loggedOn})`;
                        } else {
                            weightLine = `\nWeight: ${formatWeight(latestWeight.weight_g, unit)} (last logged ${loggedOn})`;
                        }
                    } else if (goals?.target_weight_g != null) {
                        weightLine = `\nWeight: no entries yet (target ${formatWeight(goals.target_weight_g, unit)}). Log one with log_weight.`;
                    }

                    const footer = goals
                        ? ""
                        : "\n\n(Tip: set daily targets with set_nutrition_goals to see progress percentages.)";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${header}\n${body}${weightLine}${footer}`,
                            },
                        ],
                    };
                },
                { userId },
                { date: date ?? "today" },
            );
        },
    );

    server.registerTool(
        "delete_meal",
        {
            title: "Delete Meal",
            description: "Delete a meal entry by ID",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the meal to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_meal",
                async () => {
                    const deleted = await deleteMeal(userId, id);
                    return {
                        content: [
                            {
                                type: "text",
                                text: deleted
                                    ? `Meal ${id} deleted.`
                                    : `No meal found with id ${id}.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "update_meal",
        {
            title: "Update Meal",
            description: "Update fields of an existing meal entry",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the meal to update"),
                description: z.string().optional(),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .optional(),
                calories: z.number().min(0).nullable().optional(),
                protein_g: z.number().min(0).nullable().optional(),
                carbs_g: z.number().min(0).nullable().optional(),
                fat_g: z.number().min(0).nullable().optional(),
                nutrition_source: z
                    .enum(["estimate", "barcode", "dish", "manual"])
                    .nullable()
                    .optional(),
                logged_at: z.string().optional(),
                notes: z.string().nullable().optional(),
            },
        },
        async ({ id, ...fields }) => {
            return withAnalytics(
                "update_meal",
                async () => {
                    if (fields.logged_at !== undefined)
                        validateLoggedAt(fields.logged_at, Date.now());
                    for (const key of [
                        "calories",
                        "protein_g",
                        "carbs_g",
                        "fat_g",
                    ] as const) {
                        if (fields[key] != null)
                            fields[key] = nonNegativeNumber(fields[key]);
                    }
                    const meal = await updateMeal(userId, id, fields);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal updated:\n${formatMeal(meal)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );
    server.registerTool(
        "log_water",
        {
            title: "Log Water",
            description:
                "Log a hydration entry in milliliters. If the user gives a volume in another unit (cups, oz, liters), convert it: 1 cup = 240 ml, 1 fl oz = 30 ml, 1 L = 1000 ml. If only 'a glass' is mentioned, ask for the size or assume 250 ml and confirm.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                amount_ml: z.coerce
                    .number()
                    .int()
                    .positive()
                    .describe("Amount in milliliters (integer, > 0)."),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). If you don't know the current date or time, ask the user before calling this tool.",
                    ),
                notes: z
                    .string()
                    .optional()
                    .describe("Optional notes (e.g. 'tea', 'post-workout')."),
                idempotency_key: z
                    .string()
                    .min(1)
                    .max(255)
                    .optional()
                    .describe(
                        "Stable client-supplied key for retry deduplication. Without one, retries may create another entry. Do NOT reuse a key for genuinely different sips.",
                    ),
            },
        },
        async (args) => {
            return withAnalytics(
                "log_water",
                async () => {
                    if (args.logged_at !== undefined)
                        validateLoggedAt(args.logged_at, Date.now());
                    const { entry, deduplicated } = await insertWater(
                        userId,
                        args,
                    );
                    const prefix = deduplicated
                        ? "Already logged (idempotent retry)"
                        : "Water logged";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${prefix}: ${entry.amount_ml} ml at ${entry.logged_at}${entry.notes ? ` (${entry.notes})` : ""}. ID: ${entry.id}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_water_today",
        {
            title: "Get Today's Water",
            description:
                "Get today's total water intake (ml) and the list of entries.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_water_today",
                async () => {
                    const tz = await getUserTimezone(userId);
                    const entries = await getWaterByDate(
                        userId,
                        todayInTz(tz),
                        tz,
                    );
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No water logged today.",
                                },
                            ],
                        };
                    }
                    const total = sumWater(entries);
                    const lines = entries.map(
                        (e) =>
                            `- ${e.amount_ml} ml at ${e.logged_at}${e.notes ? ` (${e.notes})` : ""} [id: ${e.id}]`,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Total: ${total} ml (${entries.length} entr${entries.length === 1 ? "y" : "ies"})\n\n${lines.join("\n")}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_water_by_date",
        {
            title: "Get Water by Date",
            description:
                "Get water intake total and entries for a specific date.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z.string().describe("Date in YYYY-MM-DD format"),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_water_by_date",
                async () => {
                    validateDate(date);
                    const tz = await getUserTimezone(userId);
                    const entries = await getWaterByDate(userId, date, tz);
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No water logged on ${date}.`,
                                },
                            ],
                        };
                    }
                    const total = sumWater(entries);
                    const lines = entries.map(
                        (e) =>
                            `- ${e.amount_ml} ml at ${e.logged_at}${e.notes ? ` (${e.notes})` : ""} [id: ${e.id}]`,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Total on ${date}: ${total} ml (${entries.length} entr${entries.length === 1 ? "y" : "ies"})\n\n${lines.join("\n")}`,
                            },
                        ],
                    };
                },
                { userId },
                { date },
            );
        },
    );

    server.registerTool(
        "delete_water",
        {
            title: "Delete Water Entry",
            description: "Delete a water log entry by ID.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the water entry to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_water",
                async () => {
                    const deleted = await deleteWater(userId, id);
                    return {
                        content: [
                            {
                                type: "text",
                                text: deleted
                                    ? `Water entry ${id} deleted.`
                                    : `No water entry found with id ${id}.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "log_weight",
        {
            title: "Log Weight",
            description:
                "Log a body-weight measurement. Provide the number in `weight` and its `unit` ('kg' or 'lb'); if you omit the unit, the user's saved preference is used, and if they have no preference set yet the call fails asking you to specify one. IMPORTANT: do NOT convert units yourself — pass the value in whatever unit the user stated and set `unit` accordingly. The server stores weight canonically and converts as needed. Multiple weigh-ins per day are allowed.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                weight: z.coerce
                    .number()
                    .positive()
                    .describe("Body weight value, in `unit` (> 0)."),
                unit: z
                    .enum(["kg", "lb"])
                    .optional()
                    .describe(
                        "Unit of the weight value. Defaults to the user's preferred weight unit.",
                    ),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). If you don't know the current date or time, ask the user before calling this tool.",
                    ),
                notes: z
                    .string()
                    .optional()
                    .describe(
                        "Optional notes (e.g. 'morning, fasted', 'after workout').",
                    ),
                idempotency_key: z
                    .string()
                    .min(1)
                    .max(255)
                    .optional()
                    .describe(
                        "Stable client-supplied key for retry deduplication. Without one, retries may create another entry.",
                    ),
            },
        },
        async (args) => {
            return withAnalytics(
                "log_weight",
                async () => {
                    if (args.logged_at !== undefined)
                        validateLoggedAt(args.logged_at, Date.now());
                    const unit = await resolveWriteWeightUnit(
                        userId,
                        args.unit,
                    );
                    const weight_g = toGrams(args.weight, unit);
                    assertPlausibleWeight(weight_g, unit);
                    const { entry, deduplicated } = await insertWeight(userId, {
                        weight_g,
                        logged_at: args.logged_at,
                        notes: args.notes,
                        idempotency_key: args.idempotency_key,
                    });
                    const prefix = deduplicated
                        ? "Already logged (idempotent retry)"
                        : "Weight logged";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${prefix}: ${formatWeight(entry.weight_g, unit)} at ${entry.logged_at}${entry.notes ? ` (${entry.notes})` : ""}. ID: ${entry.id}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_weight_today",
        {
            title: "Get Today's Weight",
            description:
                "Get today's weight entries, shown in the user's preferred unit.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_weight_today",
                async () => {
                    const [tz, weightPref] = await Promise.all([
                        getUserTimezone(userId),
                        getPreferredWeightUnit(userId),
                    ]);
                    const unit = weightPref ?? "kg";
                    const entries = await getWeightByDate(
                        userId,
                        todayInTz(tz),
                        tz,
                    );
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No weight logged today.",
                                },
                            ],
                        };
                    }
                    const lines = entries.map((e) =>
                        formatWeightEntry(e, unit),
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Today (${entries.length} entr${entries.length === 1 ? "y" : "ies"}):\n\n${lines.join("\n")}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_weight_by_date",
        {
            title: "Get Weight by Date",
            description:
                "Get weight entries for a specific date, in the user's preferred unit.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z.string().describe("Date in YYYY-MM-DD format"),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_weight_by_date",
                async () => {
                    validateDate(date);
                    const [tz, weightPref] = await Promise.all([
                        getUserTimezone(userId),
                        getPreferredWeightUnit(userId),
                    ]);
                    const unit = weightPref ?? "kg";
                    const entries = await getWeightByDate(userId, date, tz);
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No weight logged on ${date}.`,
                                },
                            ],
                        };
                    }
                    const lines = entries.map((e) =>
                        formatWeightEntry(e, unit),
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${date} (${entries.length} entr${entries.length === 1 ? "y" : "ies"}):\n\n${lines.join("\n")}`,
                            },
                        ],
                    };
                },
                { userId },
                { date },
            );
        },
    );

    server.registerTool(
        "get_weight_by_date_range",
        {
            title: "Get Weight by Date Range",
            description:
                "Get all weight entries between two dates (inclusive), grouped by day with each day's average. Use this instead of multiple get_weight_by_date calls.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_weight_by_date_range",
                async () => {
                    validateDateRange(start_date, end_date);
                    const [tz, weightPref] = await Promise.all([
                        getUserTimezone(userId),
                        getPreferredWeightUnit(userId),
                    ]);
                    const unit = weightPref ?? "kg";
                    const entries = await getWeightInRange(
                        userId,
                        start_date,
                        end_date,
                        tz,
                    );
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No weight found between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }

                    const byDate = new Map<string, WeightEntry[]>();
                    for (const e of entries) {
                        const date = dateInTz(e.logged_at, tz);
                        const existing = byDate.get(date) ?? [];
                        existing.push(e);
                        byDate.set(date, existing);
                    }

                    const sections: string[] = [];
                    for (const [date, dayEntries] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const avgG =
                            dayEntries.reduce((s, e) => s + e.weight_g, 0) /
                            dayEntries.length;
                        const header =
                            dayEntries.length === 1
                                ? `## ${date}`
                                : `## ${date} (avg ${formatWeight(avgG, unit)}, ${dayEntries.length} entries)`;
                        const formatted = dayEntries
                            .map((e) => formatWeightEntry(e, unit))
                            .join("\n");
                        sections.push(`${header}\n${formatted}`);
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: sections.join("\n\n"),
                            },
                        ],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    server.registerTool(
        "get_weight_trends",
        {
            title: "Get Weight Trends",
            description:
                "Weight trend over a window: latest reading, overall change, 7/14/30-day moving averages (to smooth day-to-day noise), min/max, and progress toward the target weight if one is set. Aggregates multiple weigh-ins per day by averaging. Defaults to the last 30 days ending today.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                days: z.coerce
                    .number()
                    .int()
                    .min(2)
                    .max(365)
                    .optional()
                    .describe("Window size in days (default 30, max 365)."),
                end_date: z
                    .string()
                    .optional()
                    .describe("Window end date YYYY-MM-DD (default today)."),
            },
        },
        async ({ days, end_date }) => {
            return withAnalytics(
                "get_weight_trends",
                async () => {
                    const [tz, weightPref] = await Promise.all([
                        getUserTimezone(userId),
                        getPreferredWeightUnit(userId),
                    ]);
                    const unit = weightPref ?? "kg";
                    const endDate = end_date ?? todayInTz(tz);
                    validateDate(endDate);
                    const windowDays = days ?? 30;
                    const startDate = shiftLocalDate(
                        endDate,
                        -(windowDays - 1),
                    );
                    const [entries, goals] = await Promise.all([
                        getWeightInRange(userId, startDate, endDate, tz),
                        getNutritionGoals(userId),
                    ]);
                    return {
                        content: [
                            {
                                type: "text",
                                text: computeWeightTrend(
                                    entries,
                                    startDate,
                                    endDate,
                                    tz,
                                    goals?.target_weight_g ?? null,
                                    unit,
                                ),
                            },
                        ],
                    };
                },
                { userId },
                { days: days ?? 30 },
            );
        },
    );

    server.registerTool(
        "update_weight",
        {
            title: "Update Weight Entry",
            description:
                "Update fields of an existing weight entry. Provide `unit` alongside `weight` (defaults to the user's preferred unit); do NOT convert units yourself.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the weight entry to update"),
                weight: z.coerce
                    .number()
                    .positive()
                    .optional()
                    .describe("New weight value, in `unit`."),
                unit: z
                    .enum(["kg", "lb"])
                    .optional()
                    .describe(
                        "Unit of the weight value. Defaults to the user's preferred weight unit.",
                    ),
                logged_at: z.string().optional().describe("ISO 8601 timestamp"),
                notes: z.string().nullable().optional(),
            },
        },
        async ({ id, weight, unit, logged_at, notes }) => {
            return withAnalytics(
                "update_weight",
                async () => {
                    if (logged_at !== undefined)
                        validateLoggedAt(logged_at, Date.now());
                    const patch: {
                        weight_g?: number;
                        logged_at?: string;
                        notes?: string | null;
                    } = {};
                    // Only require a unit when a new weight value is supplied;
                    // otherwise fall back to kg purely for formatting the result.
                    let displayUnit: WeightUnit;
                    if (weight !== undefined) {
                        displayUnit = await resolveWriteWeightUnit(
                            userId,
                            unit,
                        );
                        patch.weight_g = toGrams(weight, displayUnit);
                        assertPlausibleWeight(patch.weight_g, displayUnit);
                    } else {
                        displayUnit =
                            unit ??
                            (await getPreferredWeightUnit(userId)) ??
                            "kg";
                    }
                    if (logged_at !== undefined) patch.logged_at = logged_at;
                    if (notes !== undefined) patch.notes = notes;
                    const entry = await updateWeight(userId, id, patch);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Weight updated:\n${formatWeightEntry(entry, displayUnit)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "delete_weight",
        {
            title: "Delete Weight Entry",
            description: "Delete a weight log entry by ID.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the weight entry to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_weight",
                async () => {
                    const deleted = await deleteWeight(userId, id);
                    return {
                        content: [
                            {
                                type: "text",
                                text: deleted
                                    ? `Weight entry ${id} deleted.`
                                    : `No weight entry found with id ${id}.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "set_weight_unit",
        {
            title: "Set Weight Unit",
            description:
                "Set the user's preferred weight unit ('kg' or 'lb'), or pass null to clear it. This controls how weights are shown and how a bare number is interpreted when logging without an explicit unit. Stored weights are unaffected (they are canonical) — only display and default parsing change. While unset, logging requires an explicit unit and weights display in kg.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                unit: z
                    .enum(["kg", "lb"])
                    .nullable()
                    .describe(
                        "Preferred weight unit: 'kg' or 'lb'. Pass null to clear the preference.",
                    ),
            },
        },
        async ({ unit }) => {
            return withAnalytics(
                "set_weight_unit",
                async () => {
                    if (unit !== null && !isWeightUnit(unit)) {
                        throw new Error(
                            `Invalid weight unit: ${unit}. Use 'kg', 'lb', or null to clear.`,
                        );
                    }
                    const profile = await upsertProfile(userId, {
                        preferred_weight_unit: unit,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: profile.preferred_weight_unit
                                    ? `Preferred weight unit set to ${profile.preferred_weight_unit}.`
                                    : "Preferred weight unit cleared. Logging will require an explicit unit until you set one, and weights display in kg.",
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_weight_unit",
        {
            title: "Get Weight Unit",
            description:
                "Get the user's preferred weight unit. Reports if none is set.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_weight_unit",
                async () => {
                    const unit = await getPreferredWeightUnit(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: unit
                                    ? `Preferred weight unit: ${unit}.`
                                    : "No preferred weight unit set. Weights display in kg by default, and logging requires an explicit unit ('kg' or 'lb').",
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_trends",
        {
            title: "Get Trends",
            description:
                "Rolling 7/14/30-day averages, standard deviation, coefficient of variation, logging streaks, day-of-week breakdowns, and best/worst day for calories and each macro. Pre-aggregated so you can narrate findings to the user without doing arithmetic. Defaults to the last 30 days ending today.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                days: z.coerce
                    .number()
                    .int()
                    .min(2)
                    .max(365)
                    .optional()
                    .describe("Window size in days (default 30, max 365)."),
                end_date: z
                    .string()
                    .optional()
                    .describe("Window end date YYYY-MM-DD (default today)."),
            },
        },
        async ({ days, end_date }) => {
            return withAnalytics(
                "get_trends",
                async () => {
                    const tz = await getUserTimezone(userId);
                    const endDate = end_date ?? todayInTz(tz);
                    validateDate(endDate);
                    const windowDays = days ?? 30;
                    const startDate = shiftLocalDate(
                        endDate,
                        -(windowDays - 1),
                    );
                    const [meals, water, goals] = await Promise.all([
                        getMealsInRange(userId, startDate, endDate, tz),
                        getWaterInRange(userId, startDate, endDate, tz),
                        getNutritionGoals(userId),
                    ]);
                    const buckets = buildDailyBuckets(
                        meals,
                        water,
                        startDate,
                        endDate,
                        tz,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: computeTrends(buckets, goals),
                            },
                        ],
                    };
                },
                { userId },
                { days: days ?? 30 },
            );
        },
    );

    server.registerTool(
        "get_meal_patterns",
        {
            title: "Get Meal Patterns",
            description:
                "Pre-aggregated behavioural patterns across the logged window: meal-type presence rates, breakfast effect (days with vs without), high-calorie-lunch effect, late-dinner effect, weekday vs weekend, and outlier days. Narrate findings conversationally to the user. Defaults to the last 30 days.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                days: z.coerce
                    .number()
                    .int()
                    .min(7)
                    .max(365)
                    .optional()
                    .describe(
                        "Window size in days (default 30, min 7, max 365).",
                    ),
                end_date: z
                    .string()
                    .optional()
                    .describe("Window end date YYYY-MM-DD (default today)."),
            },
        },
        async ({ days, end_date }) => {
            return withAnalytics(
                "get_meal_patterns",
                async () => {
                    const tz = await getUserTimezone(userId);
                    const endDate = end_date ?? todayInTz(tz);
                    validateDate(endDate);
                    const windowDays = days ?? 30;
                    const startDate = shiftLocalDate(
                        endDate,
                        -(windowDays - 1),
                    );
                    const [meals, water] = await Promise.all([
                        getMealsInRange(userId, startDate, endDate, tz),
                        getWaterInRange(userId, startDate, endDate, tz),
                    ]);
                    const buckets = buildDailyBuckets(
                        meals,
                        water,
                        startDate,
                        endDate,
                        tz,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: computeMealPatterns(buckets, tz),
                            },
                        ],
                    };
                },
                { userId },
                { days: days ?? 30 },
            );
        },
    );

    server.registerTool(
        "export_meals",
        {
            title: "Export Meals",
            description:
                "Export all of the user's logged meals as a CSV file and return a private, time-limited download link (valid 60 minutes). Timestamps use the user's timezone if set, otherwise UTC. Share the link with the user so they can download their data.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "export_meals",
                async () => {
                    const { count, url } = await exportMeals(userId);
                    if (count === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No meals to export yet.",
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Exported ${count} meal${count === 1 ? "" : "s"} to CSV.\nDownload (link valid for 60 minutes): ${url}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerResource(
        "weekly-summary",
        "nutrition://weekly-summary",
        {
            title: "Weekly Nutrition Summary",
            description:
                "Current Monday–Sunday digest with daily calorie/macro totals, calorie-bank state, and top contributors in the user's timezone.",
            mimeType: "text/plain",
        },
        async (uri) => {
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "text/plain",
                        text: await weeklySummaryForUser(userId),
                    },
                ],
            };
        },
    );

    server.registerTool(
        "set_timezone",
        {
            title: "Set Timezone",
            description:
                "Set the user's IANA timezone (e.g. 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo'). This controls which calendar day meals and water are grouped into — e.g. a meal logged at 11pm in LA counts on that LA day, not the next UTC day. If the user hasn't set one yet and logs a meal or asks about 'today', offer to set it.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                timezone: z
                    .string()
                    .describe(
                        "IANA timezone identifier (e.g. 'America/New_York'). Must be a valid tzdata name.",
                    ),
            },
        },
        async ({ timezone }) => {
            return withAnalytics(
                "set_timezone",
                async () => {
                    if (!validateTz(timezone)) {
                        throw new Error(
                            `Invalid timezone: ${timezone}. Use an IANA identifier like 'America/Los_Angeles' or 'Europe/London'.`,
                        );
                    }
                    const profile = await upsertProfile(userId, { timezone });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Timezone set to ${profile.timezone}. Local today is ${todayInTz(profile.timezone)}.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_timezone",
        {
            title: "Get Timezone",
            description:
                "Get the user's configured IANA timezone. Returns UTC if no profile has been set.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_timezone",
                async () => {
                    const profile = await getProfile(userId);
                    if (!profile) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No timezone set yet (defaulting to UTC). Call set_timezone to configure one so 'today' matches the user's local calendar day.",
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Timezone: ${profile.timezone}. Local today is ${todayInTz(profile.timezone)}.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "delete_account",
        {
            title: "Delete Account",
            description:
                "Permanently delete the user's account and all associated data (meals, tokens, auth). This action is irreversible. Always confirm with the user before calling this tool.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                confirm: z
                    .boolean()
                    .describe(
                        "Must be true to confirm deletion. Always ask the user for explicit confirmation before setting this to true.",
                    ),
            },
        },
        async ({ confirm }) => {
            if (!confirm) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Account deletion cancelled. No data was removed.",
                        },
                    ],
                };
            }
            // Deliberately NOT wrapped in withAnalytics: it persists a
            // tool_analytics row keyed by user_id AFTER deletion (the table has
            // no FK), which would outlive a full account wipe. The MCP SDK still
            // turns a thrown error into an isError result.
            await deleteAllUserData(userId);
            return {
                content: [
                    {
                        type: "text",
                        text: "Your account and all associated data have been permanently deleted.",
                    },
                ],
            };
        },
    );
}

// Build a fresh McpServer with this user's tools registered.
function buildMcpServer(c: Context, userId: string): McpServer {
    const proto = c.req.header("x-forwarded-proto") || "http";
    const host =
        c.req.header("x-forwarded-host") || c.req.header("host") || "localhost";
    const baseUrl = `${proto}://${host}`;

    const server = new McpServer(
        {
            name: "nutrition-mcp",
            version: "1.14.2",
            icons: [
                {
                    src: `${baseUrl}/favicon.ico`,
                    mimeType: "image/x-icon",
                },
            ],
        },
        { capabilities: { tools: {}, resources: {} } },
    );

    registerTools(server, userId);
    return server;
}

// Stateless: /mcp holds no per-session state. Every request builds a brand-new
// transport + McpServer and tears it down when the response completes (the SDK
// forbids reusing a stateless transport). Because nothing is kept in-process, a
// restart/deploy can never strand a connected client — there is no session to
// lose, and therefore no reconnect step for a client to wedge on.
//
// Only POST (JSON-RPC request/response) is served. We reject GET and DELETE
// with 405 instead of delegating to the transport, because a GET would open a
// long-lived standalone SSE stream — and that stream is the one piece of state
// a deploy still severs. Since stateless mode never pushes server-initiated
// messages, that stream carries nothing; the only thing it does is die on every
// restart and leave some clients (observed: a Claude connector) wedged in a
// "connected but no tools" state. Refusing the stream (spec-allowed: a server
// MAY return 405 when it offers no SSE stream at this endpoint) means the client
// holds nothing that a deploy can break, so updates become truly invisible.
export const handleMcp = async (c: Context) => {
    if (c.req.method !== "POST") {
        return c.json(
            {
                jsonrpc: "2.0",
                id: null,
                error: {
                    code: -32000,
                    message:
                        "Method Not Allowed: this endpoint serves POST only and offers no SSE stream",
                },
            },
            405,
            { Allow: "POST" },
        );
    }

    const userId = c.get("userId") as string;

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });
    const server = buildMcpServer(c, userId);
    await server.connect(transport);

    return transport.handleRequest(c.req.raw);
};
