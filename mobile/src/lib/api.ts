import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { fetch as expoFetch } from "expo/fetch";

/** Клиент API сервера. EXPO_PUBLIC_API_URL не задан = mock-режим с фикстурами. */
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

/** Блюдо из личного каталога: КБЖУ — на одну порцию, meal_type — подсказка. */
export interface Dish {
    id: string;
    name: string;
    meal_type: MealType | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
}

/** Поля для сохранения блюда — id/created_at ставит сервер. */
export interface DishInput {
    name: string;
    meal_type?: MealType | null;
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

/** Сброс токена по 401 — только если он всё ещё тот, что отправляли:
 * поздний 401 старого запроса не должен стереть свежий логин. */
async function clearIfStale(sentToken: string | null): Promise<void> {
    if (sentToken && (await getToken()) === sentToken) await setToken(null);
}

/** True для 401-часового, который бросают request()/sendChat(). */
export function isUnauthorized(err: unknown): boolean {
    return err instanceof Error && err.message === "unauthorized";
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
        await clearIfStale(token);
        throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json() as Promise<T>;
}

/** IANA-зона устройства. "UTC" (реальный или Hermes без ICU) → undefined,
 * чтобы не затирать нормальную сохранённую зону фолбэком. */
function deviceTimezone(): string | undefined {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return tz && tz !== "UTC" ? tz : undefined;
    } catch {
        return undefined;
    }
}

/** Distinguishes wrong-credentials from rate-limit/offline so the login screen
 * can stop telling a user with the right password that it's wrong. */
export class LoginError extends Error {
    constructor(public reason: "invalid" | "rate_limited" | "network") {
        super(reason);
    }
}

export async function login(email: string, password: string): Promise<void> {
    if (MOCK) {
        await setToken("mock-token");
        return;
    }
    let res: Response;
    try {
        res = await fetch(`${API_URL}/api/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email,
                password,
                timezone: deviceTimezone(),
            }),
        });
    } catch {
        throw new LoginError("network");
    }
    if (res.status === 429) throw new LoginError("rate_limited");
    if (!res.ok) throw new LoginError("invalid");
    const { token } = (await res.json()) as { token: string };
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
    // Как login: 429/offline различаем от отказа, а не отдаём общий
    // «проверь инвайт-код» на любой сбой.
    let res: Response;
    try {
        res = await fetch(`${API_URL}/api/signup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email,
                password,
                code,
                timezone: deviceTimezone(),
            }),
        });
    } catch {
        throw new LoginError("network");
    }
    if (res.status === 429) throw new LoginError("rate_limited");
    if (!res.ok) throw new LoginError("invalid");
    const { token } = (await res.json()) as { token: string };
    await setToken(token);
}

export async function logout(): Promise<void> {
    if (!MOCK) {
        // Best-effort server revoke — logout must never fail the user.
        try {
            await request("/api/logout", { method: "POST" });
        } catch {}
    }
    await setToken(null);
}

export async function deleteAccount(): Promise<void> {
    if (MOCK) return;
    await request("/api/account", {
        method: "DELETE",
        body: JSON.stringify({ confirm: true }),
    });
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

/** Ход чата по SSE: onTool — прогресс инструментов, onDelta — токены финального
 * ответа по мере генерации, onReset — сбросить показанный черновик (nudge).
 * expo/fetch стримит на нативе. */
export async function sendChat(
    messages: ChatMessage[],
    onTool?: (name: string) => void,
    signal?: AbortSignal,
    turnKey?: string,
    onDelta?: (text: string) => void,
    onReset?: () => void,
): Promise<ChatReply> {
    if (MOCK) {
        onTool?.("propose_meal");
        await new Promise((r) => setTimeout(r, 500));
        const msg = "Прикинул на глаз — проверь карточку.";
        const words = msg.split(" ");
        for (let i = 0; i < words.length; i++) {
            onDelta?.((i ? " " : "") + words[i]);
            await new Promise((r) => setTimeout(r, 55));
        }
        return {
            message: msg,
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
        body: JSON.stringify({
            messages,
            turn_key: turnKey,
            stream_tokens: true,
        }),
        signal,
    });
    if (res.status === 401) {
        await clearIfStale(token);
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
                | { type: "delta"; text: string }
                | { type: "reset" }
                | { type: "done"; message: string; proposals?: MealFields[] }
                | { type: "error"; error: string };
            if (event.type === "tool") onTool?.(event.name);
            else if (event.type === "delta") onDelta?.(event.text);
            else if (event.type === "reset") onReset?.();
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

/** Стабильный ключ ретрая — сервер дедупит повторную запись. Только из
 * хендлеров/эффектов (Date.now), не в рендере. */
export function newIdempotencyKey(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function addMeal(
    fields: MealFields,
    idempotencyKey?: string,
    loggedAt?: string,
): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.meals.push({
            id: `mock-${Date.now()}`,
            meal_type: fields.meal_type,
            description: fields.description,
            calories: fields.calories ?? null,
            protein_g: fields.protein_g ?? null,
            carbs_g: fields.carbs_g ?? null,
            fat_g: fields.fat_g ?? null,
            logged_at: loggedAt ?? new Date().toISOString(),
        });
        return;
    }
    await request("/api/meals", {
        method: "POST",
        body: JSON.stringify({
            ...fields,
            idempotency_key: idempotencyKey,
            ...(loggedAt ? { logged_at: loggedAt } : {}),
        }),
    });
}

/** Совпадение по подстроке в описании — для «повторить недавнее». */
export async function searchMeals(query: string): Promise<MealRow[]> {
    if (MOCK) {
        const q = query.toLowerCase();
        return structuredClone(MOCK_DASHBOARD.meals).filter((m) =>
            m.description.toLowerCase().includes(q),
        );
    }
    const { meals } = await request<{ meals: MealRow[] }>(
        `/api/meals/search?q=${encodeURIComponent(query)}`,
    );
    return meals;
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

export async function addWater(
    amountMl: number,
    idempotencyKey?: string,
    loggedAt?: string,
): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.water.total_ml += amountMl;
        MOCK_DASHBOARD.water.entries.push({
            id: `mock-${Date.now()}`,
            amount_ml: amountMl,
            logged_at: loggedAt ?? new Date().toISOString(),
        });
        return;
    }
    await request("/api/water", {
        method: "POST",
        body: JSON.stringify({
            amount_ml: amountMl,
            idempotency_key: idempotencyKey,
            ...(loggedAt ? { logged_at: loggedAt } : {}),
        }),
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

export async function addWeight(
    kg: number,
    idempotencyKey?: string,
): Promise<void> {
    if (MOCK) {
        MOCK_DASHBOARD.weight.current_g = Math.round(kg * 1000);
        return;
    }
    await request("/api/weight", {
        method: "POST",
        body: JSON.stringify({
            weight_kg: kg,
            idempotency_key: idempotencyKey,
        }),
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

// ----- dishes -----

/** Личный каталог, отсортирован по имени (как отдаёт сервер). */
export async function getDishes(): Promise<Dish[]> {
    if (MOCK) {
        return structuredClone(MOCK_DISHES).sort((a, b) =>
            a.name.localeCompare(b.name),
        );
    }
    const { dishes } = await request<{ dishes: Dish[] }>("/api/dishes");
    return dishes;
}

/** Дубликат по имени сервер обновляет на месте — «запомнить» повторно не плодит копии. */
export async function addDish(dish: DishInput): Promise<Dish> {
    if (MOCK) {
        const name = dish.name.trim();
        const existing = MOCK_DISHES.find(
            (d) => d.name.toLowerCase() === name.toLowerCase(),
        );
        const row: Dish = {
            id: existing?.id ?? `mock-${Date.now()}`,
            name,
            meal_type: dish.meal_type ?? null,
            calories: dish.calories ?? null,
            protein_g: dish.protein_g ?? null,
            carbs_g: dish.carbs_g ?? null,
            fat_g: dish.fat_g ?? null,
        };
        if (existing) Object.assign(existing, row);
        else MOCK_DISHES.push(row);
        return structuredClone(row);
    }
    const { dish: saved } = await request<{ dish: Dish }>("/api/dishes", {
        method: "POST",
        body: JSON.stringify(dish),
    });
    return saved;
}

export async function removeDish(id: string): Promise<void> {
    if (MOCK) {
        MOCK_DISHES = MOCK_DISHES.filter((d) => d.id !== id);
        return;
    }
    await request(`/api/dishes/${id}`, { method: "DELETE" });
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

let MOCK_DISHES: Dish[] = [
    {
        id: "d1",
        name: "Протеиновый коктейль",
        meal_type: "snack",
        calories: 180,
        protein_g: 30,
        carbs_g: 8,
        fat_g: 3,
    },
    {
        id: "d2",
        name: "Булочка с корицей",
        meal_type: "snack",
        calories: 340,
        protein_g: 6,
        carbs_g: 52,
        fat_g: 12,
    },
    {
        id: "d3",
        name: "Овсянка с черникой",
        meal_type: "breakfast",
        calories: 420,
        protein_g: 14,
        carbs_g: 58,
        fat_g: 16,
    },
];
