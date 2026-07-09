import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";

/**
 * API client for the nutrition-mcp server (/api/login, /api/signup,
 * /api/dashboard, /api/chat, and the manual-edit CRUD). EXPO_PUBLIC_API_URL
 * unset = mock mode with fixture data so the app runs standalone.
 */
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const MOCK = API_URL === "";

const TOKEN_KEY = "nutrition_token";

// SecureStore is unavailable on web; fall back to localStorage there.
export async function getToken(): Promise<string | null> {
    if (Platform.OS === "web") return localStorage.getItem(TOKEN_KEY);
    return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string | null): Promise<void> {
    if (Platform.OS === "web") {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
        return;
    }
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export interface MacroProgress {
    eaten: number;
    goal: number | null;
}

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export interface MealRow {
    id: string;
    meal_type: MealType | null;
    description: string;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    logged_at: string;
}

export interface MealFields {
    description: string;
    meal_type: MealType;
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
}

export interface WaterRow {
    id: string;
    amount_ml: number;
    logged_at: string;
}

export interface WeightPoint {
    date: string;
    id: string;
    weight_g: number;
}

export interface GoalsInput {
    daily_calories: number | null;
    daily_protein_g: number | null;
    daily_carbs_g: number | null;
    daily_fat_g: number | null;
    daily_water_ml: number | null;
    target_weight_kg: number | null;
}

export interface DashboardData {
    date: string;
    calories: MacroProgress;
    macros: {
        protein: MacroProgress;
        carbs: MacroProgress;
        fat: MacroProgress;
    };
    water: {
        total_ml: number;
        goal_ml: number | null;
        by_hour: number[];
        entries: WaterRow[];
    };
    weight: {
        current_g: number | null;
        target_g: number | null;
        series: WeightPoint[];
    };
    meals: MealRow[];
}

export interface StatsDay {
    date: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    water_ml: number;
    logged: boolean;
}

export interface FrequentMeal {
    description: string;
    meal_type: MealType | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    count: number;
}

export interface StatsData {
    start: string;
    end: string;
    days: StatsDay[];
    streak: { current: number; best: number };
    frequent: FrequentMeal[];
    weight: {
        series: { date: string; weight_g: number }[];
        target_g: number | null;
    };
    goals: {
        daily_calories: number | null;
        daily_protein_g: number | null;
        daily_carbs_g: number | null;
        daily_fat_g: number | null;
        daily_water_ml: number | null;
    };
}

export type ChatPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
    role: "user" | "assistant";
    content: string | ChatPart[];
}

export interface ChatReply {
    message: string;
    /** Карточки «записать?» — ассистент предложил, кнопки решают. */
    proposals: MealFields[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getToken();
    const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init?.headers,
        },
    });
    if (res.status === 401) {
        await setToken(null);
        throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<void> {
    if (MOCK) {
        await setToken("mock-token");
        return;
    }
    const { token } = await request<{ token: string }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
    });
    await setToken(token);
}

export async function signup(
    email: string,
    password: string,
    code?: string,
): Promise<void> {
    if (MOCK) {
        await setToken("mock-token");
        return;
    }
    const { token } = await request<{ token: string }>("/api/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, code }),
    });
    await setToken(token);
}

export async function logout(): Promise<void> {
    await setToken(null);
}

/** No date = today; past days are read-mostly (new logs always land "now"). */
export async function getDashboard(date?: string): Promise<DashboardData> {
    if (MOCK) {
        const d = structuredClone(MOCK_DASHBOARD);
        if (date) d.date = date;
        return d;
    }
    return request<DashboardData>(
        date ? `/api/dashboard?date=${date}` : "/api/dashboard",
    );
}

/** Trailing-window aggregates for the stats screen (7–90 days). */
export async function getStats(days = 30): Promise<StatsData> {
    if (MOCK) return structuredClone(MOCK_STATS);
    // /api/stats занят публичной статистикой лендинга
    return request<StatsData>(`/api/summary?days=${days}`);
}

/**
 * Chat turn over SSE: `onTool` fires as the assistant runs each tool, so the
 * UI can narrate progress. `expo/fetch` is WinterCG-compliant and streams on
 * native; on web it's the regular fetch.
 */
export async function sendChat(
    messages: ChatMessage[],
    onTool?: (name: string) => void,
    signal?: AbortSignal,
): Promise<ChatReply> {
    if (MOCK) {
        onTool?.("propose_meal");
        await new Promise((r) => setTimeout(r, 900));
        return {
            message: "Прикинул на глаз — проверь карточку.",
            proposals: [
                {
                    description: "Овсянка с бананом",
                    meal_type: "breakfast",
                    calories: 320,
                    protein_g: 9,
                    carbs_g: 55,
                    fat_g: 7,
                },
            ],
        };
    }
    const token = await getToken();
    const res = await expoFetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ messages }),
        signal,
    });
    if (res.status === 401) {
        await setToken(null);
        throw new Error("unauthorized");
    }
    if (res.status === 503) throw new Error("chat_not_configured");
    if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line
        for (;;) {
            const cut = buffer.indexOf("\n\n");
            if (cut < 0) break;
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("");
            if (!data) continue;
            const event = JSON.parse(data) as
                | { type: "tool"; name: string }
                | { type: "done"; message: string; proposals?: MealFields[] }
                | { type: "error"; error: string };
            if (event.type === "tool") onTool?.(event.name);
            else if (event.type === "done") {
                return {
                    message: event.message,
                    proposals: event.proposals ?? [],
                };
            } else throw new Error(event.error);
        }
    }
    throw new Error("stream ended without a message");
}

// ----- settings -----

export interface Settings {
    has_llm_key: boolean;
    chat_available: boolean;
}

let mockHasKey = false;

export async function getSettings(): Promise<Settings> {
    if (MOCK) return { has_llm_key: mockHasKey, chat_available: true };
    return request<Settings>("/api/settings");
}

/** Pass null to remove the stored key. */
export async function saveLlmKey(key: string | null): Promise<Settings> {
    if (MOCK) {
        mockHasKey = !!key;
        return { has_llm_key: mockHasKey, chat_available: true };
    }
    return request<Settings>("/api/settings/llm", {
        method: "PUT",
        body: JSON.stringify({ api_key: key }),
    });
}

// ----- manual editing -----

export async function addMeal(fields: MealFields): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.meals.push({
            id: `mock-${Date.now()}`,
            meal_type: fields.meal_type,
            description: fields.description,
            calories: fields.calories ?? null,
            protein_g: fields.protein_g ?? null,
            carbs_g: fields.carbs_g ?? null,
            fat_g: fields.fat_g ?? null,
            logged_at: new Date().toISOString(),
        });
        return;
    }
    await request("/api/meals", {
        method: "POST",
        body: JSON.stringify(fields),
    });
}

export async function patchMeal(
    id: string,
    fields: Partial<MealFields>,
): Promise<void> {
    if (MOCK) {
        const m = MOCK_DASHBOARD.meals.find((x) => x.id === id);
        if (m) Object.assign(m, fields);
        return;
    }
    await request(`/api/meals/${id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
    });
}

export async function removeMeal(id: string): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.meals = MOCK_DASHBOARD.meals.filter((m) => m.id !== id);
        return;
    }
    await request(`/api/meals/${id}`, { method: "DELETE" });
}

export async function addWater(amountMl: number): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.water.total_ml += amountMl;
        MOCK_DASHBOARD.water.entries.push({
            id: `mock-${Date.now()}`,
            amount_ml: amountMl,
            logged_at: new Date().toISOString(),
        });
        return;
    }
    await request("/api/water", {
        method: "POST",
        body: JSON.stringify({ amount_ml: amountMl }),
    });
}

export async function removeWater(id: string): Promise<void> {
    if (MOCK) {
        const e = MOCK_DASHBOARD.water.entries.find((x) => x.id === id);
        if (e) MOCK_DASHBOARD.water.total_ml -= e.amount_ml;
        MOCK_DASHBOARD.water.entries = MOCK_DASHBOARD.water.entries.filter(
            (x) => x.id !== id,
        );
        return;
    }
    await request(`/api/water/${id}`, { method: "DELETE" });
}

export async function addWeight(kg: number): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.weight.current_g = Math.round(kg * 1000);
        return;
    }
    await request("/api/weight", {
        method: "POST",
        body: JSON.stringify({ weight_kg: kg }),
    });
}

export async function patchWeight(id: string, kg: number): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.weight.current_g = Math.round(kg * 1000);
        return;
    }
    await request(`/api/weight/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ weight_kg: kg }),
    });
}

export async function removeWeight(id: string): Promise<void> {
    if (MOCK) return;
    await request(`/api/weight/${id}`, { method: "DELETE" });
}

export async function saveGoals(goals: GoalsInput): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.calories.goal = goals.daily_calories;
        MOCK_DASHBOARD.macros.protein.goal = goals.daily_protein_g;
        MOCK_DASHBOARD.macros.carbs.goal = goals.daily_carbs_g;
        MOCK_DASHBOARD.macros.fat.goal = goals.daily_fat_g;
        MOCK_DASHBOARD.water.goal_ml = goals.daily_water_ml;
        MOCK_DASHBOARD.weight.target_g =
            goals.target_weight_kg == null
                ? null
                : Math.round(goals.target_weight_kg * 1000);
        return;
    }
    await request("/api/goals", {
        method: "PUT",
        body: JSON.stringify(goals),
    });
}

// ---------- Fixtures (mock mode) ----------

const MOCK_STATS: StatsData = (() => {
    const end = new Date().toISOString().slice(0, 10);
    const shift = (days: number) => {
        const d = new Date(`${end}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
    };
    // Правдоподобные 30 дней: будни ровнее, выходные выше, пара пропусков.
    const days: StatsDay[] = Array.from({ length: 30 }, (_, i) => {
        const date = shift(i - 29);
        const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
        const skipped = i === 6 || i === 19;
        const base = dow === 0 || dow === 6 ? 2350 : 1950;
        const calories = skipped ? 0 : base + ((i * 137) % 400) - 200;
        return {
            date,
            calories,
            protein_g: skipped ? 0 : 90 + ((i * 31) % 40),
            carbs_g: skipped ? 0 : 180 + ((i * 53) % 60),
            fat_g: skipped ? 0 : 55 + ((i * 17) % 25),
            water_ml: skipped ? 0 : 1500 + ((i * 211) % 1200),
            logged: !skipped,
        };
    });
    return {
        start: shift(-29),
        end,
        days,
        streak: { current: 10, best: 13 },
        frequent: [
            {
                description: "Овсянка с черникой",
                meal_type: "breakfast",
                calories: 420,
                protein_g: 14,
                carbs_g: 58,
                fat_g: 16,
                count: 9,
            },
            {
                description: "Куриный боул с рисом",
                meal_type: "lunch",
                calories: 640,
                protein_g: 46,
                carbs_g: 62,
                fat_g: 22,
                count: 7,
            },
            {
                description: "Греческий йогурт с мёдом",
                meal_type: "snack",
                calories: 230,
                protein_g: 15,
                carbs_g: 20,
                fat_g: 9,
                count: 5,
            },
            {
                description: "Лосось с овощами",
                meal_type: "dinner",
                calories: 480,
                protein_g: 38,
                carbs_g: 18,
                fat_g: 26,
                count: 4,
            },
        ],
        weight: {
            series: Array.from({ length: 11 }, (_, i) => ({
                date: shift(i * 3 - 30),
                weight_g: 80100 - i * 190,
            })),
            target_g: 74000,
        },
        goals: {
            daily_calories: 2200,
            daily_protein_g: 140,
            daily_carbs_g: 220,
            daily_fat_g: 70,
            daily_water_ml: 2500,
        },
    };
})();

const MOCK_DASHBOARD: DashboardData = {
    date: new Date().toISOString().slice(0, 10),
    calories: { eaten: 1486, goal: 2200 },
    macros: {
        protein: { eaten: 96, goal: 140 },
        carbs: { eaten: 152, goal: 220 },
        fat: { eaten: 48, goal: 70 },
    },
    water: {
        total_ml: 1450,
        goal_ml: 2500,
        // ponytail: 8 three-hour buckets, 00–24
        by_hour: [0, 0, 350, 250, 400, 200, 250, 0],
        entries: [
            { id: "w1", amount_ml: 350, logged_at: "2026-07-07T07:10:00Z" },
            { id: "w2", amount_ml: 250, logged_at: "2026-07-07T09:40:00Z" },
            { id: "w3", amount_ml: 400, logged_at: "2026-07-07T13:00:00Z" },
            { id: "w4", amount_ml: 200, logged_at: "2026-07-07T16:20:00Z" },
            { id: "w5", amount_ml: 250, logged_at: "2026-07-07T19:05:00Z" },
        ],
    },
    weight: {
        current_g: 78200,
        target_g: 74000,
        series: [
            { date: "2026-06-08", id: "g1", weight_g: 80100 },
            { date: "2026-06-11", id: "g2", weight_g: 79800 },
            { date: "2026-06-14", id: "g3", weight_g: 79900 },
            { date: "2026-06-17", id: "g4", weight_g: 79400 },
            { date: "2026-06-20", id: "g5", weight_g: 79100 },
            { date: "2026-06-23", id: "g6", weight_g: 78900 },
            { date: "2026-06-26", id: "g7", weight_g: 79000 },
            { date: "2026-06-29", id: "g8", weight_g: 78600 },
            { date: "2026-07-02", id: "g9", weight_g: 78400 },
            { date: "2026-07-05", id: "g10", weight_g: 78300 },
            { date: "2026-07-07", id: "g11", weight_g: 78200 },
        ],
    },
    meals: [
        {
            id: "1",
            meal_type: "breakfast",
            description: "Oatmeal with blueberries & almond butter",
            calories: 420,
            protein_g: 14,
            carbs_g: 58,
            fat_g: 16,
            logged_at: "2026-07-07T07:40:00Z",
        },
        {
            id: "2",
            meal_type: "lunch",
            description: "Grilled chicken bowl, brown rice, avocado",
            calories: 640,
            protein_g: 46,
            carbs_g: 62,
            fat_g: 22,
            logged_at: "2026-07-07T12:15:00Z",
        },
        {
            id: "3",
            meal_type: "snack",
            description: "Greek yogurt, honey, walnuts",
            calories: 230,
            protein_g: 15,
            carbs_g: 20,
            fat_g: 9,
            logged_at: "2026-07-07T16:05:00Z",
        },
        {
            id: "4",
            meal_type: "dinner",
            description: "Salmon, roasted vegetables",
            calories: 196,
            protein_g: 21,
            carbs_g: 12,
            fat_g: 8,
            logged_at: "2026-07-07T19:30:00Z",
        },
    ],
};
