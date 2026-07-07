import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/**
 * API client for the nutrition-mcp server (POST /api/login, GET
 * /api/dashboard). EXPO_PUBLIC_API_URL unset = mock mode with fixture data so
 * the app runs standalone.
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

export interface MealRow {
    id: string;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack" | null;
    description: string;
    calories: number | null;
    logged_at: string;
}

export interface WeightPoint {
    date: string;
    weight_g: number;
}

export interface DashboardData {
    date: string;
    calories: MacroProgress;
    macros: {
        protein: MacroProgress;
        carbs: MacroProgress;
        fat: MacroProgress;
    };
    water: { total_ml: number; goal_ml: number | null; by_hour: number[] };
    weight: {
        current_g: number | null;
        target_g: number | null;
        series: WeightPoint[];
    };
    meals: MealRow[];
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

export async function logout(): Promise<void> {
    await setToken(null);
}

export async function getDashboard(): Promise<DashboardData> {
    if (MOCK) return MOCK_DASHBOARD;
    return request<DashboardData>("/api/dashboard");
}

// ---------- Fixtures (mock mode) ----------

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
    },
    weight: {
        current_g: 78200,
        target_g: 74000,
        series: [
            { date: "2026-06-08", weight_g: 80100 },
            { date: "2026-06-11", weight_g: 79800 },
            { date: "2026-06-14", weight_g: 79900 },
            { date: "2026-06-17", weight_g: 79400 },
            { date: "2026-06-20", weight_g: 79100 },
            { date: "2026-06-23", weight_g: 78900 },
            { date: "2026-06-26", weight_g: 79000 },
            { date: "2026-06-29", weight_g: 78600 },
            { date: "2026-07-02", weight_g: 78400 },
            { date: "2026-07-05", weight_g: 78300 },
            { date: "2026-07-07", weight_g: 78200 },
        ],
    },
    meals: [
        {
            id: "1",
            meal_type: "breakfast",
            description: "Oatmeal with blueberries & almond butter",
            calories: 420,
            logged_at: "2026-07-07T07:40:00Z",
        },
        {
            id: "2",
            meal_type: "lunch",
            description: "Grilled chicken bowl, brown rice, avocado",
            calories: 640,
            logged_at: "2026-07-07T12:15:00Z",
        },
        {
            id: "3",
            meal_type: "snack",
            description: "Greek yogurt, honey, walnuts",
            calories: 230,
            logged_at: "2026-07-07T16:05:00Z",
        },
        {
            id: "4",
            meal_type: "dinner",
            description: "Salmon, roasted vegetables",
            calories: 196,
            logged_at: "2026-07-07T19:30:00Z",
        },
    ],
};
