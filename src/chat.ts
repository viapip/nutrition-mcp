import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
    insertMeal,
    updateMeal,
    deleteMeal,
    insertWater,
    deleteWater,
    insertWeight,
    updateWeight,
    deleteWeight,
    getProfile,
    getUserTimezone,
    getMealsByDate,
    getWaterByDate,
    getWeightInRange,
    getLatestWeight,
    getNutritionGoals,
    patchNutritionGoals,
    listDishes,
    insertDish,
    type MealInput,
    type DishInput,
} from "./db.js";
import { buildDashboard, mealFields } from "./api.js";
import { normalizeBarcode, lookupBarcode } from "./foods.js";
import { isPlausibleWeightGrams } from "./units.js";
import { authenticateBearer, rateLimit } from "./middleware.js";
import { todayInTz, shiftLocalDate } from "./tz.js";
import {
    isNutritionSource,
    nonNegativeNumber,
    validateDate,
    validateDateRange,
} from "./validate.js";

/** Чат мобильного приложения: OpenAI-совместимый провайдер (Kimi по умолчанию)
 * с tool-use над тем же слоем данных, что и MCP. Провайдер = три env-переменных
 * (LLM_BASE_URL / LLM_MODEL / LLM_API_KEY). */

const LLM_BASE_URL = () =>
    process.env.LLM_BASE_URL ?? "https://api.moonshot.ai/v1";
const LLM_MODEL = () => process.env.LLM_MODEL ?? "kimi-k2.6";

const MAX_TOOL_ROUNDS = 6;
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 16_000;
const TURN_TIMEOUT_MS = 90_000;

/** OpenAI-vision content part: plain text or an inline data-URL image. */
export type ChatPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
    role: "user" | "assistant";
    content: string | ChatPart[];
}

const MAX_IMAGES = 4;
const MAX_IMAGE_DATA_URL_CHARS = 1_500_000; // ~1MB decoded

/** A meal card awaiting the user's Confirm/Cancel tap; nothing is saved yet. */
export interface MealProposal {
    description: string;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    nutrition_source?: "estimate" | "barcode" | "dish" | "manual";
}

function textLength(content: ChatMessage["content"]): number {
    if (typeof content === "string") return content.length;
    return content.reduce(
        (n, p) => n + (p.type === "text" ? p.text.length : 0),
        0,
    );
}

function validPart(p: ChatPart): boolean {
    if (p?.type === "text") return typeof p.text === "string";
    if (p?.type === "image_url") {
        const url = p.image_url?.url;
        return (
            typeof url === "string" &&
            url.startsWith("data:image/") &&
            url.length <= MAX_IMAGE_DATA_URL_CHARS
        );
    }
    return false;
}

function imageCount(history: ChatMessage[]): number {
    return history.reduce(
        (n, m) =>
            typeof m.content === "string"
                ? n
                : n + m.content.filter((p) => p.type === "image_url").length,
        0,
    );
}

const TOOLS = [
    {
        type: "function",
        function: {
            name: "log_meal",
            description:
                "Log a meal the user ate. Estimate calories and macros from the description when the user does not provide them.",
            parameters: {
                type: "object",
                properties: {
                    description: { type: "string" },
                    meal_type: {
                        type: "string",
                        enum: ["breakfast", "lunch", "dinner", "snack"],
                    },
                    calories: { type: "number" },
                    protein_g: { type: "number" },
                    carbs_g: { type: "number" },
                    fat_g: { type: "number" },
                    nutrition_source: {
                        type: "string",
                        enum: ["estimate", "barcode", "dish", "manual"],
                        description:
                            "Origin of the nutrition values: estimate, barcode lookup, saved dish, or manual user values.",
                    },
                },
                required: ["description", "meal_type"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "propose_meal",
            description:
                "Show the user a meal card with Confirm/Cancel buttons instead of saving. " +
                "The app logs the entry itself when the user taps Confirm — never follow up with log_meal. " +
                "Always include your calorie and macro estimates.",
            parameters: {
                type: "object",
                properties: {
                    description: { type: "string" },
                    meal_type: {
                        type: "string",
                        enum: ["breakfast", "lunch", "dinner", "snack"],
                    },
                    calories: { type: "number" },
                    protein_g: { type: "number" },
                    carbs_g: { type: "number" },
                    fat_g: { type: "number" },
                    nutrition_source: {
                        type: "string",
                        enum: ["estimate", "barcode", "dish", "manual"],
                        description:
                            "Origin of the nutrition values: estimate, barcode lookup, saved dish, or manual user values.",
                    },
                },
                required: ["description", "meal_type"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "log_water",
            description: "Log drinking water, in milliliters.",
            parameters: {
                type: "object",
                properties: { amount_ml: { type: "number" } },
                required: ["amount_ml"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "log_weight",
            description: "Log the user's body weight, in kilograms.",
            parameters: {
                type: "object",
                properties: { weight_kg: { type: "number" } },
                required: ["weight_kg"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_dashboard",
            description:
                "Today's snapshot: meals, calories and macros vs goals, water, and the 30-day weight series. Entry ids in the response can be passed to the update/delete tools.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "get_day",
            description:
                "Same snapshot as get_dashboard but for a past date (YYYY-MM-DD).",
            parameters: {
                type: "object",
                properties: { date: { type: "string" } },
                required: ["date"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_meal",
            description:
                "Correct an existing meal. Pass the meal id from get_dashboard and only the fields to change; null clears a macro value.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    description: { type: "string" },
                    meal_type: {
                        type: "string",
                        enum: ["breakfast", "lunch", "dinner", "snack"],
                    },
                    calories: { type: ["number", "null"] },
                    protein_g: { type: ["number", "null"] },
                    carbs_g: { type: ["number", "null"] },
                    fat_g: { type: ["number", "null"] },
                    nutrition_source: {
                        type: ["string", "null"],
                        enum: ["estimate", "barcode", "dish", "manual", null],
                    },
                },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_meal",
            description: "Delete a meal by id (from get_dashboard).",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_water",
            description: "Delete a water entry by id (from get_dashboard).",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_weight",
            description:
                "Correct a weight entry by id (from get_dashboard's weight series).",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    weight_kg: { type: "number" },
                },
                required: ["id", "weight_kg"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_weight",
            description: "Delete a weight entry by id.",
            parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "set_goals",
            description:
                "Update the user's daily targets. Pass only the fields to change — omitted ones keep their value, null clears a target.",
            parameters: {
                type: "object",
                properties: {
                    daily_calories: { type: ["number", "null"] },
                    daily_protein_g: { type: ["number", "null"] },
                    daily_carbs_g: { type: ["number", "null"] },
                    daily_fat_g: { type: ["number", "null"] },
                    daily_water_ml: { type: ["number", "null"] },
                    target_weight_kg: { type: ["number", "null"] },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "lookup_barcode",
            description:
                "Look up a packaged product's verified nutrition by barcode (EAN/UPC digits — typed by the user or read from a photo of the package). Use before log_meal for branded products, scaling to the amount eaten.",
            parameters: {
                type: "object",
                properties: { barcode: { type: "string" } },
                required: ["barcode"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_dishes",
            description:
                "The user's saved catalog of recurring dishes with per-portion macros. Consult it before estimating a named or recurring item.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "save_dish",
            description:
                "Save (or update) a dish in the user's catalog for reuse. Macros are per portion; saving an existing name overwrites it. This does NOT log a meal.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    meal_type: {
                        type: "string",
                        enum: ["breakfast", "lunch", "dinner", "snack"],
                    },
                    calories: { type: "number" },
                    protein_g: { type: "number" },
                    carbs_g: { type: "number" },
                    fat_g: { type: "number" },
                },
                required: ["name"],
            },
        },
    },
];

function positive(n: unknown): number {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`invalid number: ${n}`);
    return v;
}

function weightGramsFromKg(v: unknown): number {
    const g = Math.round(positive(v) * 1000);
    if (!isPlausibleWeightGrams(g)) {
        throw new Error("weight outside plausible range (20–500 kg)");
    }
    return g;
}

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;

/** propose_meal: validate into a card for the client; no DB write happens here. */
function collectProposal(
    args: Record<string, unknown>,
    out: MealProposal[],
): string {
    try {
        const description = String(args.description ?? "").trim();
        if (!description) throw new Error("description required");
        const meal_type = args.meal_type as MealProposal["meal_type"];
        if (!MEAL_TYPES.includes(meal_type)) {
            throw new Error("meal_type must be breakfast|lunch|dinner|snack");
        }
        const p: MealProposal = { description, meal_type };
        for (const k of [
            "calories",
            "protein_g",
            "carbs_g",
            "fat_g",
        ] as const) {
            if (args[k] != null) p[k] = nonNegativeNumber(args[k]);
        }
        if (
            args.nutrition_source !== undefined &&
            !isNutritionSource(args.nutrition_source)
        ) {
            throw new Error("invalid nutrition_source");
        }
        p.nutrition_source =
            (args.nutrition_source as MealProposal["nutrition_source"]) ??
            "estimate";
        out.push(p);
        return JSON.stringify({
            proposed: true,
            note: "Card shown to the user with Confirm/Cancel buttons; the app saves it on Confirm. Do not call log_meal for this entry — nothing is saved yet.",
        });
    } catch (err) {
        return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** The dashboard aggregation for a given local date (defaults to today). */
async function daySnapshot(userId: string, tz: string, date?: string) {
    const today = todayInTz(tz);
    const day = date ?? today;
    validateDate(day);
    validateDateRange(shiftLocalDate(day, -30), day);
    const [meals, water, weights, latest, goals] = await Promise.all([
        getMealsByDate(userId, day, tz),
        getWaterByDate(userId, day, tz),
        getWeightInRange(userId, shiftLocalDate(day, -30), day, tz),
        getLatestWeight(userId),
        getNutritionGoals(userId),
    ]);
    // Прошлый день: «текущий вес» — последнее известное к этому дню, а не
    // сегодняшнее, иначе карточка расходится с графиком (как /api/dashboard).
    const asOf = day === today ? latest : (weights.at(-1) ?? null);
    return buildDashboard(day, tz, meals, water, weights, asOf, goals);
}

/** Один tool call; ошибки уходят модели JSON-пейлоадом. idem делает
 * пишущие инструменты retry-safe (повторный ход = тот же ключ). */
export async function executeTool(
    userId: string,
    name: string,
    args: Record<string, unknown>,
    idem?: string,
    timezone: string = "UTC",
): Promise<string> {
    try {
        switch (name) {
            case "log_meal": {
                if (
                    args.nutrition_source !== undefined &&
                    !isNutritionSource(args.nutrition_source)
                ) {
                    throw new Error("invalid nutrition_source");
                }
                const input: MealInput = {
                    description: String(args.description ?? ""),
                    meal_type: args.meal_type as MealInput["meal_type"],
                    calories:
                        args.calories == null
                            ? undefined
                            : nonNegativeNumber(args.calories),
                    protein_g:
                        args.protein_g == null
                            ? undefined
                            : nonNegativeNumber(args.protein_g),
                    carbs_g:
                        args.carbs_g == null
                            ? undefined
                            : nonNegativeNumber(args.carbs_g),
                    fat_g:
                        args.fat_g == null
                            ? undefined
                            : nonNegativeNumber(args.fat_g),
                    nutrition_source:
                        (args.nutrition_source as MealInput["nutrition_source"]) ??
                        "estimate",
                    idempotency_key: idem,
                };
                if (!input.description) throw new Error("description required");
                const { meal } = await insertMeal(userId, input);
                return JSON.stringify({ logged: true, meal });
            }
            case "log_water": {
                const { entry } = await insertWater(userId, {
                    amount_ml: positive(args.amount_ml),
                    idempotency_key: idem,
                });
                return JSON.stringify({ logged: true, entry });
            }
            case "log_weight": {
                const { entry } = await insertWeight(userId, {
                    weight_g: weightGramsFromKg(args.weight_kg),
                    idempotency_key: idem,
                });
                return JSON.stringify({ logged: true, entry });
            }
            case "get_dashboard":
                return JSON.stringify(await daySnapshot(userId, timezone));
            case "get_day": {
                const date = String(args.date ?? "");
                validateDate(date);
                return JSON.stringify(
                    await daySnapshot(userId, timezone, date),
                );
            }
            case "update_meal": {
                const id = String(args.id ?? "");
                if (!id) throw new Error("id required");
                const meal = await updateMeal(
                    userId,
                    id,
                    mealFields(args, true),
                );
                return JSON.stringify({ updated: true, meal });
            }
            case "delete_meal": {
                if (!(await deleteMeal(userId, String(args.id ?? "")))) {
                    throw new Error("meal not found");
                }
                return JSON.stringify({ deleted: true });
            }
            case "delete_water": {
                if (!(await deleteWater(userId, String(args.id ?? "")))) {
                    throw new Error("water entry not found");
                }
                return JSON.stringify({ deleted: true });
            }
            case "update_weight": {
                const entry = await updateWeight(
                    userId,
                    String(args.id ?? ""),
                    { weight_g: weightGramsFromKg(args.weight_kg) },
                );
                return JSON.stringify({ updated: true, entry });
            }
            case "delete_weight": {
                const deleted = await deleteWeight(
                    userId,
                    String(args.id ?? ""),
                );
                if (!deleted) throw new Error("weight entry not found");
                return JSON.stringify({ deleted: true });
            }
            case "set_goals": {
                // Merge semantics: only keys present in args change; null clears.
                const num = (k: string) =>
                    k in args
                        ? args[k] == null
                            ? null
                            : nonNegativeNumber(args[k])
                        : undefined;
                const goals = await patchNutritionGoals(userId, {
                    daily_calories: num("daily_calories"),
                    daily_protein_g: num("daily_protein_g"),
                    daily_carbs_g: num("daily_carbs_g"),
                    daily_fat_g: num("daily_fat_g"),
                    daily_water_ml: num("daily_water_ml"),
                    target_weight_g:
                        "target_weight_kg" in args
                            ? args.target_weight_kg == null
                                ? null
                                : weightGramsFromKg(args.target_weight_kg)
                            : undefined,
                });
                return JSON.stringify({ saved: true, goals });
            }
            case "lookup_barcode": {
                const normalized = normalizeBarcode(String(args.barcode ?? ""));
                if (!normalized) throw new Error("invalid barcode");
                const food = await lookupBarcode(normalized);
                return JSON.stringify(
                    food ? { found: true, food } : { found: false },
                );
            }
            case "list_dishes":
                return JSON.stringify({ dishes: await listDishes(userId) });
            case "save_dish": {
                const name = String(args.name ?? "").trim();
                if (!name) throw new Error("name required");
                const num = (k: string) =>
                    args[k] == null ? undefined : nonNegativeNumber(args[k]);
                const dish = await insertDish(userId, {
                    name,
                    meal_type:
                        args.meal_type == null
                            ? undefined
                            : (args.meal_type as DishInput["meal_type"]),
                    calories: num("calories"),
                    protein_g: num("protein_g"),
                    carbs_g: num("carbs_g"),
                    fat_g: num("fat_g"),
                });
                return JSON.stringify({ saved: true, dish });
            }
            default:
                throw new Error(`unknown tool: ${name}`);
        }
    } catch (err) {
        return JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

interface LlmMessage {
    role: string;
    content: string | null;
    tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
    }[];
}

interface LlmUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

interface LlmResult {
    message: LlmMessage;
    usage?: LlmUsage;
}

async function callLlm(
    messages: unknown[],
    apiKey: string,
    signal: AbortSignal,
    onDelta?: (text: string) => unknown,
): Promise<LlmResult> {
    const res = await fetch(`${LLM_BASE_URL()}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: LLM_MODEL(),
            messages,
            tools: TOOLS,
            stream: true,
            stream_options: { include_usage: true },
            // No temperature: kimi-for-coding rejects anything but 1;
            // provider defaults are fine for the rest.
        }),
        signal,
    });
    if (!res.ok) {
        // Server-log only (client gets a generic chat_failed); still redact
        // key-shaped strings in case the provider echoes credentials back.
        const body = (await res.text().catch(() => "")).replace(
            /sk-[\w-]{10,}|Bearer\s+\S+/g,
            "[redacted]",
        );
        throw new Error(
            `LLM request failed: ${res.status} ${body.slice(0, 200)}`,
        );
    }
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        const data = (await res.json()) as {
            choices?: { message?: LlmMessage }[];
            usage?: LlmUsage;
        };
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error("LLM returned no message");
        if (message.content) await onDelta?.(message.content);
        return { message, usage: data.usage };
    }
    if (!res.body) throw new Error("LLM returned no stream");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<
        number,
        { id: string; function: { name: string; arguments: string } }
    >();
    let content = "";
    let usage: LlmUsage | undefined;
    let buffer = "";

    const consumeLine = async (line: string) => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        const event = JSON.parse(payload) as {
            choices?: {
                delta?: {
                    content?: string;
                    tool_calls?: {
                        index: number;
                        id?: string;
                        function?: { name?: string; arguments?: string };
                    }[];
                };
            }[];
            usage?: LlmUsage;
        };
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta;
        if (delta?.content) {
            content += delta.content;
            await onDelta?.(delta.content);
        }
        for (const chunk of delta?.tool_calls ?? []) {
            const call = toolCalls.get(chunk.index) ?? {
                id: "",
                function: { name: "", arguments: "" },
            };
            if (chunk.id) call.id += chunk.id;
            if (chunk.function?.name) call.function.name += chunk.function.name;
            if (chunk.function?.arguments)
                call.function.arguments += chunk.function.arguments;
            toolCalls.set(chunk.index, call);
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) await consumeLine(line);
        if (done) break;
    }
    if (buffer) await consumeLine(buffer);

    const assembled = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call);
    if (!content && assembled.length === 0) {
        throw new Error("LLM returned no message");
    }
    return {
        message: {
            role: "assistant",
            content: content || null,
            tool_calls: assembled.length ? assembled : undefined,
        },
        usage,
    };
}

// Текст, УТВЕРЖДАЮЩИЙ существование карточки («Предложила: …», «Подтвердите»).
// Прошедшее время намеренно: «могу предложить…» — невинное предложение, не клейм.
// Ложное срабатывание стоит один лишний раунд LLM с nudge.
const CLAIMS_PROPOSAL =
    /предложил|предложен|подтверд|карточк|proposed|confirm/i;

/** One chat turn: system prompt + history → tool loop → final assistant text.
 * `onTool` fires before each tool executes so a streaming caller can narrate. */
export async function runChatTurn(
    userId: string,
    history: ChatMessage[],
    apiKey: string,
    onTool?: (name: string) => unknown,
    signal?: AbortSignal,
    turnKey?: string,
    onDelta?: (text: string) => unknown,
    onReset?: () => unknown,
    timezone?: string,
): Promise<{ message: string; proposals: MealProposal[] }> {
    const startedAt = performance.now();
    const roundLatenciesMs: number[] = [];
    const roundUsage: (LlmUsage | null)[] = [];
    let rounds = 0;
    let outcome = "error";
    const turnSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TURN_TIMEOUT_MS)])
        : AbortSignal.timeout(TURN_TIMEOUT_MS);
    const tz = timezone ?? (await getUserTimezone(userId));
    const messages: unknown[] = [
        {
            role: "system",
            content:
                "You are the assistant inside a personal nutrition-tracking app. " +
                "MEALS NEED CONFIRMATION: EVERY mention of food the user ate gets a propose_meal call with your estimates in the SAME turn — one call per dish. " +
                "This includes follow-ups and additions: 'ещё одна порция', 'the same again', 'плюс кофе' are each a new propose_meal, re-estimated from context. " +
                "NEVER reply about eaten food in prose alone — a reply without a propose_meal (or log_meal) call silently loses the meal. " +
                "The app shows a card with Confirm/Cancel buttons and saves it itself on Confirm. " +
                "After propose_meal, reply with one short sentence (note what you estimated); the buttons handle the confirmation — don't ask in words. " +
                "Call log_meal directly only when the user's message is an explicit command to log ('запиши', 'добавь', 'внеси') or they just typed their agreement to your proposal. " +
                "Water and weight are unambiguous — log them immediately without asking. " +
                "CRITICAL: data is saved ONLY by tool calls. Never say an entry was logged, " +
                "updated or deleted unless the corresponding tool returned success in this turn; a proposal awaiting confirmation is not saved. " +
                "Consult get_dashboard before answering questions about today or progress, and get_day for past dates. " +
                "ENTRY IDS: you cannot see ids from earlier turns of the conversation — never guess, invent or reuse one. " +
                "To correct or remove an entry, always call get_dashboard (or get_day) first in the SAME turn, match the entry by its description, and take the id from that fresh response. " +
                "If several entries match, list them and ask which one; confirm deletions before calling delete tools. " +
                "Estimate calories/macros yourself when the user doesn't give numbers, and say you estimated. " +
                "For packaged products with a barcode (typed, or readable on a photo of the package), call lookup_barcode first and scale to the amount eaten. " +
                "Set nutrition_source on every meal/proposal: barcode after lookup_barcode, dish for saved dishes, manual for user-supplied macros, otherwise estimate. " +
                "When the user sends a food photo, identify the dish and portion size, estimate calories and macros, and call propose_meal. " +
                "SAVED DISHES: the user keeps a personal catalog of recurring dishes. When the user " +
                "reports eating something that sounds like a named/recurring item (a product or a " +
                "dish they might have saved), call list_dishes BEFORE estimating. If exactly one " +
                "saved dish matches, use its macros verbatim in propose_meal and mention the match. " +
                "If several could match, ask which one. If none match, estimate as usual. When the " +
                "user asks to remember a dish (or confirms a new recurring item), call save_dish. " +
                `Today is ${todayInTz(tz)} (${tz}). ` +
                "Reply in the user's language, in one or two short sentences.",
        },
        ...history,
    ];

    let logged = false;
    let toolSeq = 0;
    let nudged = false;
    const proposals: MealProposal[] = [];
    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const roundStartedAt = performance.now();
            rounds += 1;
            let result: LlmResult;
            try {
                result = await callLlm(messages, apiKey, turnSignal, onDelta);
                roundUsage.push(result.usage ?? null);
            } catch (err) {
                roundUsage.push(null);
                throw err;
            } finally {
                roundLatenciesMs.push(
                    Math.round(performance.now() - roundStartedAt),
                );
            }
            const msg = result.message;
            if (!msg.tool_calls?.length) {
                const text = msg.content ?? "";
                // Анти-мимикрия: ответ клеймит карточку, а ход не дал ни
                // карточки, ни записи — возвращаем модели один раз
                if (
                    !nudged &&
                    !proposals.length &&
                    !logged &&
                    CLAIMS_PROPOSAL.test(text)
                ) {
                    nudged = true;
                    console.log("[chat] proposal claimed without tool — nudge");
                    await onReset?.();
                    messages.push(msg);
                    messages.push({
                        role: "system",
                        content:
                            "CHECK FAILED: your reply claims a proposal or asks to confirm, but no propose_meal tool call happened this turn — the user sees NO card and NOTHING is saved. If (and only if) the user reported food they actually ATE, call propose_meal now (one call per dish), then reply in one short sentence. If they did not (you were suggesting ideas, answering a question), do NOT call any tool — just repeat your answer.",
                    });
                    continue;
                }
                outcome = "ok";
                return { message: text, proposals };
            }
            messages.push(msg);
            for (const call of msg.tool_calls) {
                // Client hit Stop — don't run tools it no longer wants.
                if (turnSignal.aborted) throw new Error("aborted");
                let args: Record<string, unknown> = {};
                let argsError: string | undefined;
                try {
                    const parsed = JSON.parse(
                        call.function.arguments || "{}",
                    ) as unknown;
                    if (
                        !parsed ||
                        typeof parsed !== "object" ||
                        Array.isArray(parsed)
                    ) {
                        throw new Error("tool arguments must be an object");
                    }
                    args = parsed as Record<string, unknown>;
                } catch {
                    argsError = "tool arguments must be a JSON object";
                }
                await onTool?.(call.function.name);
                // Ключ = (turn, позиция, канонизированные args) → log_* дедупятся
                // на ретрае. ponytail: перестановка одинаковых вызовов между
                // ретраями может задвоить — принимаем, редкость
                const seq = toolSeq++;
                const canonicalArgs = JSON.stringify(
                    args,
                    Object.keys(args).sort(),
                );
                const idem = turnKey
                    ? `chat:${turnKey}:${seq}:${new Bun.CryptoHasher("sha256")
                          .update(`${call.function.name}\n${canonicalArgs}`)
                          .digest("hex")
                          .slice(0, 16)}`
                    : undefined;
                const toolResult = argsError
                    ? JSON.stringify({ error: argsError })
                    : call.function.name === "propose_meal"
                      ? collectProposal(args, proposals)
                      : await executeTool(
                            userId,
                            call.function.name,
                            args,
                            idem,
                            tz,
                        );
                // Observability: tool-call outcomes are otherwise invisible in
                // the runtime logs (analytics only covers MCP tools).
                const failed = toolResult.startsWith('{"error"');
                console.log(
                    `[chat] tool ${call.function.name} ${failed ? `err: ${JSON.parse(toolResult).error}` : "ok"}`,
                );
                if (
                    /^\{"(logged|updated|deleted|saved)":true/.test(toolResult)
                ) {
                    logged = true;
                }
                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: toolResult,
                });
            }
        }
        throw new Error("tool loop did not converge");
    } catch (err) {
        // Without a client-stable turn key, retrying after a partial success
        // could double-log, so degrade to a canned confirmation.
        if (logged || proposals.length) {
            const russian = /[А-Яа-яЁё]/.test(
                JSON.stringify(history.at(-1)?.content ?? ""),
            );
            outcome = "partial";
            return {
                message: proposals.length
                    ? russian
                        ? "Карточка готова — ответ не дописался, но её можно проверить ниже."
                        : "The card is ready — the reply was interrupted, but you can review it below."
                    : russian
                      ? "Записал — но ответ не дописался. Загляни в дашборд."
                      : "Saved — the reply was interrupted. Check the dashboard.",
                proposals,
            };
        }
        throw err;
    } finally {
        console.log(
            JSON.stringify({
                event: "chat_turn_complete",
                user_id: userId,
                outcome,
                rounds,
                round_llm_ms: roundLatenciesMs,
                total_ms: Math.round(performance.now() - startedAt),
                round_usage: roundUsage,
            }),
        );
    }
}

const activeChatUsers = new Set<string>();

export function createChatRouter() {
    const chat = new Hono<{ Variables: { userId: string } }>();

    chat.post("/api/chat", authenticateBearer, rateLimit, async (c) => {
        const wantsSse = c.req.header("accept")?.includes("text/event-stream");
        const fail = (
            error: string,
            status: 400 | 409 | 503,
        ): Response | Promise<Response> => {
            if (!wantsSse) return c.json({ error }, status);
            c.status(status);
            return streamSSE(c, (stream) =>
                stream.writeSSE({
                    data: JSON.stringify({ type: "error", error }),
                }),
            );
        };
        let history: ChatMessage[];
        let turnKey: string | undefined;
        try {
            const body = await c.req.json();
            history = body.messages;
            // Client-stable per user message; a retried turn reuses it so the
            // log_* tools dedupe instead of double-writing.
            if (
                typeof body.turn_key === "string" &&
                body.turn_key.length > 0 &&
                body.turn_key.length <= 100
            ) {
                turnKey = body.turn_key;
            }
        } catch {
            return fail("invalid_request", 400);
        }
        if (
            !Array.isArray(history) ||
            history.length === 0 ||
            history.length > MAX_MESSAGES ||
            !history.every(
                (m) =>
                    (m?.role === "user" || m?.role === "assistant") &&
                    (typeof m?.content === "string" ||
                        (Array.isArray(m?.content) &&
                            m.content.length > 0 &&
                            m.content.every(validPart))),
            ) ||
            history.reduce((n, m) => n + textLength(m.content), 0) >
                MAX_TOTAL_CHARS ||
            imageCount(history) > MAX_IMAGES
        ) {
            return fail("invalid_request", 400);
        }
        const userId = c.get("userId");
        if (activeChatUsers.has(userId)) {
            return fail("chat_in_progress", 409);
        }
        activeChatUsers.add(userId);

        // The user's own key wins; the server key is the shared fallback.
        let profile;
        try {
            profile = await getProfile(userId);
        } catch (err) {
            activeChatUsers.delete(userId);
            console.error("Chat profile lookup failed:", err);
            return fail("service_unavailable", 503);
        }
        const apiKey = profile?.llm_api_key ?? process.env.LLM_API_KEY;
        if (!apiKey) {
            activeChatUsers.delete(userId);
            return fail("chat_not_configured", 503);
        }

        // SSE: narrate tool calls while the turn runs, so the app can show
        // live status instead of a minute of typing dots.
        if (wantsSse) {
            return streamSSE(c, async (stream) => {
                try {
                    const { message, proposals } = await runChatTurn(
                        userId,
                        history,
                        apiKey,
                        (name) =>
                            stream.writeSSE({
                                data: JSON.stringify({ type: "tool", name }),
                            }),
                        // Client Stop aborts the request; stop burning tokens
                        // and running tools for an answer nobody will see.
                        c.req.raw.signal,
                        turnKey,
                        (text) =>
                            stream.writeSSE({
                                data: JSON.stringify({ type: "delta", text }),
                            }),
                        () =>
                            stream.writeSSE({
                                data: JSON.stringify({ type: "reset" }),
                            }),
                        profile?.timezone ?? "UTC",
                    );
                    await stream.writeSSE({
                        data: JSON.stringify({
                            type: "done",
                            message,
                            proposals,
                        }),
                    });
                } catch (err) {
                    console.error("Chat turn failed:", err);
                    await stream.writeSSE({
                        data: JSON.stringify({
                            type: "error",
                            error: "chat_failed",
                        }),
                    });
                } finally {
                    activeChatUsers.delete(userId);
                }
            });
        }

        try {
            const { message, proposals } = await runChatTurn(
                userId,
                history,
                apiKey,
                undefined,
                c.req.raw.signal,
                turnKey,
                undefined,
                undefined,
                profile?.timezone ?? "UTC",
            );
            return c.json({ message, proposals });
        } catch (err) {
            console.error("Chat turn failed:", err);
            return c.json({ error: "chat_failed" }, 502);
        } finally {
            activeChatUsers.delete(userId);
        }
    });

    return chat;
}
