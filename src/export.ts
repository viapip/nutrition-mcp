import {
    getAllMeals,
    getUserTimezone,
    createMealExport,
    sweepExpiredMealExports,
    type Meal,
} from "./db.js";
import { formatLocalDateTime } from "./tz.js";

// Download-link lifetime. The cleanup sweep ages rows out on the same horizon.
const EXPORT_TTL_SECONDS = 60 * 60; // 60 minutes
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

const CSV_COLUMNS = [
    "id",
    "logged_at",
    "timezone",
    "meal_type",
    "description",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "notes",
] as const;

/** Quote a CSV field only when it contains a delimiter, quote, or newline. */
function csvEscape(value: string | number | null | undefined): string {
    if (value == null) return "";
    let str = String(value);
    // CSV-injection guard: a leading =, +, -, @ or control char makes a
    // spreadsheet evaluate the cell as a formula. Prefix ' to force it to text.
    if (/^[=+\-@\t\r]/.test(str)) {
        str = `'${str}`;
    }
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Build a CSV from meals. `logged_at` is rendered in `tz` (the user's timezone,
 * or "UTC" when none is set), and the `timezone` column records which zone the
 * timestamp is expressed in so the file is self-describing.
 */
export function buildMealsCsv(meals: Meal[], tz: string): string {
    const rows = [CSV_COLUMNS.join(",")];
    for (const m of meals) {
        rows.push(
            [
                csvEscape(m.id),
                csvEscape(formatLocalDateTime(m.logged_at, tz)),
                csvEscape(tz),
                csvEscape(m.meal_type),
                csvEscape(m.description),
                csvEscape(m.calories),
                csvEscape(m.protein_g),
                csvEscape(m.carbs_g),
                csvEscape(m.fat_g),
                csvEscape(m.notes),
            ].join(","),
        );
    }
    return rows.join("\n");
}

// Public origin for building the absolute download link (the export tool has
// no request context to derive it from). Falls back to localhost for dev.
function publicBaseUrl(): string {
    const configured = process.env.BASE_URL;
    if (configured) {
        if (!/^https?:\/\//.test(configured)) {
            throw new Error(
                `BASE_URL must start with http:// or https:// (got "${configured}")`,
            );
        }
        return configured.replace(/\/+$/, "");
    }
    return `http://localhost:${process.env.PORT || "8080"}`;
}

export interface MealsExportResult {
    count: number;
    url?: string;
}

/**
 * Generate a CSV of all the user's meals, store it in the `meal_exports` table
 * under a fresh random token (replacing the user's previous export), and
 * return a download link valid for EXPORT_TTL_SECONDS.
 */
export async function exportMeals(userId: string): Promise<MealsExportResult> {
    // Resolve first so a misconfigured BASE_URL fails before any DB work.
    const baseUrl = publicBaseUrl();

    const meals = await getAllMeals(userId);
    if (meals.length === 0) return { count: 0 };

    const tz = await getUserTimezone(userId);
    const csv = buildMealsCsv(meals, tz);
    const token = crypto.randomUUID();

    await createMealExport(token, userId, csv, EXPORT_TTL_SECONDS);

    return {
        count: meals.length,
        url: `${baseUrl}/exports/${token}/meals.csv`,
    };
}

/**
 * Delete export rows past their expiry. Runs as a background sweep so no
 * export outlives its link by more than one sweep interval, even across
 * server restarts and for users who never export again.
 */
export async function sweepStaleExports(): Promise<void> {
    try {
        const removed = await sweepExpiredMealExports();
        if (removed > 0) {
            console.log(`Export sweep: removed ${removed} stale export(s).`);
        }
    } catch (err) {
        console.warn(
            "Export sweep failed:",
            err instanceof Error ? err.message : err,
        );
    }
}

let sweepRunning = false;

/** Start the periodic export-cleanup sweep. Call once at server startup. */
export function startExportCleanup(): void {
    setInterval(() => {
        if (sweepRunning) return;
        sweepRunning = true;
        sweepStaleExports().finally(() => {
            sweepRunning = false;
        });
    }, SWEEP_INTERVAL_MS);
}
