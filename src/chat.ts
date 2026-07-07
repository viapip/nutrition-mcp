import { Hono } from "hono";
import {
    insertMeal,
    insertWater,
    insertWeight,
    getUserTimezone,
    getMealsByDate,
    getWaterByDate,
    getWeightInRange,
    getLatestWeight,
    getNutritionGoals,
    type MealInput,
} from "./db.js";
import { buildDashboard } from "./api.js";
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
                "Today's snapshot: meals, calories and macros vs goals, water, and the 30-day weight series.",
            parameters: { type: "object", properties: {} },
        },
    },
];

function positive(n: unknown): number {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`invalid number: ${n}`);
    return v;
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
                    weight_g: Math.round(positive(args.weight_kg) * 1000),
                });
                return JSON.stringify({ logged: true, entry });
            }
            case "get_dashboard": {
                const tz = await getUserTimezone(userId);
                const today = todayInTz(tz);
                const [meals, water, weights, latest, goals] =
                    await Promise.all([
                        getMealsByDate(userId, today, tz),
                        getWaterByDate(userId, today, tz),
                        getWeightInRange(
                            userId,
                            shiftLocalDate(today, -30),
                            today,
                            tz,
                        ),
                        getLatestWeight(userId),
                        getNutritionGoals(userId),
                    ]);
                return JSON.stringify(
                    buildDashboard(
                        today,
                        tz,
                        meals,
                        water,
                        weights,
                        latest,
                        goals,
                    ),
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

async function callLlm(messages: unknown[]): Promise<LlmMessage> {
    const res = await fetch(`${LLM_BASE_URL()}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        },
        body: JSON.stringify({
            model: LLM_MODEL(),
            messages,
            tools: TOOLS,
            temperature: 0.3,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`LLM request failed: ${res.status}`);
    }
    const data = (await res.json()) as {
        choices?: { message?: LlmMessage }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("LLM returned no message");
    return msg;
}

/** One chat turn: system prompt + history → tool loop → final assistant text. */
export async function runChatTurn(
    userId: string,
    history: ChatMessage[],
): Promise<string> {
    const tz = await getUserTimezone(userId);
    const messages: unknown[] = [
        {
            role: "system",
            content:
                "You are the assistant inside a personal nutrition-tracking app. " +
                "Log meals, water and weight with the tools when the user reports them; " +
                "consult get_dashboard before answering questions about today or progress. " +
                "Estimate calories/macros yourself when the user doesn't give numbers, and say you estimated. " +
                "When the user sends a food photo, identify the dish and portion size, estimate calories and macros, and log the meal. " +
                `Today is ${todayInTz(tz)} (${tz}). ` +
                "Reply in the user's language, in one or two short sentences.",
        },
        ...history,
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const msg = await callLlm(messages);
        if (!msg.tool_calls?.length) return msg.content ?? "";
        messages.push(msg);
        for (const call of msg.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(call.function.arguments || "{}");
            } catch {
                // leave args empty; executeTool reports the validation error
            }
            messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: await executeTool(userId, call.function.name, args),
            });
        }
    }
    throw new Error("tool loop did not converge");
}

export function createChatRouter() {
    const chat = new Hono();

    chat.post("/api/chat", authenticateBearer, rateLimit, async (c) => {
        if (!process.env.LLM_API_KEY) {
            return c.json({ error: "chat_not_configured" }, 503);
        }
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
        try {
            const message = await runChatTurn(
                c.get("userId") as string,
                history,
            );
            return c.json({ message });
        } catch (err) {
            console.error("Chat turn failed:", err);
            return c.json({ error: "chat_failed" }, 502);
        }
    });

    return chat;
}
