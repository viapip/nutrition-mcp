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
    upsertNutritionGoals,
    type MealInput,
} from "./db.js";
import { buildDashboard, mealFields } from "./api.js";
import { normalizeBarcode, lookupBarcode } from "./foods.js";
import { isPlausibleWeightGrams } from "./units.js";
import { authenticateBearer, rateLimit } from "./middleware.js";
import { todayInTz, shiftLocalDate } from "./tz.js";

/**
 * Chat endpoint for the mobile app: an OpenAI-compatible chat-completions
 * provider (Kimi by default) with tool-use over the same data layer the MCP
 * tools wrap. The provider is just three env vars — swap LLM_BASE_URL /
 * LLM_MODEL / LLM_API_KEY and any compatible provider (Moonshot, DeepSeek,
 * OpenRouter, OpenAI) works unchanged.
 */

const LLM_BASE_URL = () =>
    process.env.LLM_BASE_URL ?? "https://api.moonshot.ai/v1";
const LLM_MODEL = () => process.env.LLM_MODEL ?? "kimi-k2.6";

const MAX_TOOL_ROUNDS = 6;
const MAX_MESSAGES = 40;
const MAX_TOTAL_CHARS = 16_000;
const REQUEST_TIMEOUT_MS = 60_000;

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

/** The dashboard aggregation for a given local date (defaults to today). */
async function daySnapshot(userId: string, date?: string) {
    const tz = await getUserTimezone(userId);
    const day = date ?? todayInTz(tz);
    const [meals, water, weights, latest, goals] = await Promise.all([
        getMealsByDate(userId, day, tz),
        getWaterByDate(userId, day, tz),
        getWeightInRange(userId, shiftLocalDate(day, -30), day, tz),
        getLatestWeight(userId),
        getNutritionGoals(userId),
    ]);
    return buildDashboard(day, tz, meals, water, weights, latest, goals);
}

/** Executes one tool call; errors come back as a JSON payload the model can react to. */
export async function executeTool(
    userId: string,
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    try {
        switch (name) {
            case "log_meal": {
                const input: MealInput = {
                    description: String(args.description ?? ""),
                    meal_type: args.meal_type as MealInput["meal_type"],
                    calories:
                        args.calories == null
                            ? undefined
                            : positive(args.calories),
                    protein_g:
                        args.protein_g == null
                            ? undefined
                            : positive(args.protein_g),
                    carbs_g:
                        args.carbs_g == null
                            ? undefined
                            : positive(args.carbs_g),
                    fat_g:
                        args.fat_g == null ? undefined : positive(args.fat_g),
                };
                if (!input.description) throw new Error("description required");
                const { meal } = await insertMeal(userId, input);
                return JSON.stringify({ logged: true, meal });
            }
            case "log_water": {
                const { entry } = await insertWater(userId, {
                    amount_ml: positive(args.amount_ml),
                });
                return JSON.stringify({ logged: true, entry });
            }
            case "log_weight": {
                const { entry } = await insertWeight(userId, {
                    weight_g: weightGramsFromKg(args.weight_kg),
                });
                return JSON.stringify({ logged: true, entry });
            }
            case "get_dashboard":
                return JSON.stringify(await daySnapshot(userId));
            case "get_day": {
                const date = String(args.date ?? "");
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                    throw new Error("date must be YYYY-MM-DD");
                }
                return JSON.stringify(await daySnapshot(userId, date));
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
                const current = await getNutritionGoals(userId);
                // Merge semantics: only keys present in args change; null clears.
                const num = (k: string, cur: number | null) =>
                    k in args
                        ? args[k] == null
                            ? null
                            : positive(args[k])
                        : cur;
                const goals = await upsertNutritionGoals(userId, {
                    daily_calories: num(
                        "daily_calories",
                        current?.daily_calories ?? null,
                    ),
                    daily_protein_g: num(
                        "daily_protein_g",
                        current?.daily_protein_g ?? null,
                    ),
                    daily_carbs_g: num(
                        "daily_carbs_g",
                        current?.daily_carbs_g ?? null,
                    ),
                    daily_fat_g: num(
                        "daily_fat_g",
                        current?.daily_fat_g ?? null,
                    ),
                    daily_water_ml: num(
                        "daily_water_ml",
                        current?.daily_water_ml ?? null,
                    ),
                    target_weight_g:
                        "target_weight_kg" in args
                            ? args.target_weight_kg == null
                                ? null
                                : weightGramsFromKg(args.target_weight_kg)
                            : (current?.target_weight_g ?? null),
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

async function callLlm(
    messages: unknown[],
    apiKey: string,
    signal?: AbortSignal,
): Promise<LlmMessage> {
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
            // No temperature: kimi-for-coding rejects anything but 1;
            // provider defaults are fine for the rest.
        }),
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    const data = (await res.json()) as {
        choices?: { message?: LlmMessage }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("LLM returned no message");
    return msg;
}

/** One chat turn: system prompt + history → tool loop → final assistant text.
 * `onTool` fires before each tool executes so a streaming caller can narrate. */
export async function runChatTurn(
    userId: string,
    history: ChatMessage[],
    apiKey: string,
    onTool?: (name: string) => void,
    signal?: AbortSignal,
): Promise<string> {
    const tz = await getUserTimezone(userId);
    const messages: unknown[] = [
        {
            role: "system",
            content:
                "You are the assistant inside a personal nutrition-tracking app. " +
                "Log meals, water and weight with the tools when the user reports them; " +
                "consult get_dashboard before answering questions about today or progress, and get_day for past dates. " +
                "To correct or remove an entry, find its id via get_dashboard/get_day first, then use the update/delete tools. " +
                "Estimate calories/macros yourself when the user doesn't give numbers, and say you estimated. " +
                "For packaged products with a barcode (typed, or readable on a photo of the package), call lookup_barcode first and scale to the amount eaten. " +
                "When the user sends a food photo, identify the dish and portion size, estimate calories and macros, and log the meal. " +
                `Today is ${todayInTz(tz)} (${tz}). ` +
                "Reply in the user's language, in one or two short sentences.",
        },
        ...history,
    ];

    let logged = false;
    try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const msg = await callLlm(messages, apiKey, signal);
            if (!msg.tool_calls?.length) return msg.content ?? "";
            messages.push(msg);
            for (const call of msg.tool_calls) {
                // Client hit Stop — don't run tools it no longer wants.
                if (signal?.aborted) throw new Error("aborted");
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(call.function.arguments || "{}");
                } catch {
                    // leave args empty; executeTool reports the validation error
                }
                onTool?.(call.function.name);
                const result = await executeTool(
                    userId,
                    call.function.name,
                    args,
                );
                if (/^\{"(logged|updated|deleted|saved)":true/.test(result)) {
                    logged = true;
                }
                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: result,
                });
            }
        }
        throw new Error("tool loop did not converge");
    } catch (err) {
        // A retry after a partial success would double-log (idempotency keys
        // include a fresh logged_at), so degrade to a canned confirmation.
        if (logged) {
            return "Done — but I couldn't finish a reply. Check the dashboard.";
        }
        throw err;
    }
}

export function createChatRouter() {
    const chat = new Hono();

    chat.post("/api/chat", authenticateBearer, rateLimit, async (c) => {
        let history: ChatMessage[];
        try {
            const body = await c.req.json();
            history = body.messages;
        } catch {
            return c.json({ error: "invalid_request" }, 400);
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
            return c.json({ error: "invalid_request" }, 400);
        }
        const userId = c.get("userId") as string;

        // The user's own key wins; the server key is the shared fallback.
        const profile = await getProfile(userId);
        const apiKey = profile?.llm_api_key ?? process.env.LLM_API_KEY;
        if (!apiKey) {
            return c.json({ error: "chat_not_configured" }, 503);
        }

        // SSE: narrate tool calls while the turn runs, so the app can show
        // live status instead of a minute of typing dots.
        if (c.req.header("accept")?.includes("text/event-stream")) {
            return streamSSE(c, async (stream) => {
                try {
                    const message = await runChatTurn(
                        userId,
                        history,
                        apiKey,
                        (name) =>
                            void stream.writeSSE({
                                data: JSON.stringify({ type: "tool", name }),
                            }),
                        // Client Stop aborts the request; stop burning tokens
                        // and running tools for an answer nobody will see.
                        c.req.raw.signal,
                    );
                    await stream.writeSSE({
                        data: JSON.stringify({ type: "done", message }),
                    });
                } catch (err) {
                    console.error("Chat turn failed:", err);
                    await stream.writeSSE({
                        data: JSON.stringify({
                            type: "error",
                            error: "chat_failed",
                        }),
                    });
                }
            });
        }

        try {
            const message = await runChatTurn(
                userId,
                history,
                apiKey,
                undefined,
                c.req.raw.signal,
            );
            return c.json({ message });
        } catch (err) {
            console.error("Chat turn failed:", err);
            return c.json({ error: "chat_failed" }, 502);
        }
    });

    return chat;
}
