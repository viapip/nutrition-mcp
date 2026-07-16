const DAY_MS = 24 * 60 * 60 * 1000;
const NUTRITION_SOURCES = ["estimate", "barcode", "dish", "manual"];
const ISO_TIMESTAMP =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Strict calendar date: shape plus a UTC round-trip rejects 2026-02-31. */
export function validateDate(date: string): void {
    const parsed = new Date(`${date}T12:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
    ) {
        throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD.`);
    }
}

/** Inclusive range length, with ordering and a bounded query window. */
export function validateDateRange(
    startDate: string,
    endDate: string,
    maxDays: number = 365,
): number {
    validateDate(startDate);
    validateDate(endDate);
    if (startDate > endDate) {
        throw new Error("start_date must be on or before end_date");
    }
    const days =
        Math.round(
            (Date.parse(`${endDate}T00:00:00Z`) -
                Date.parse(`${startDate}T00:00:00Z`)) /
                DAY_MS,
        ) + 1;
    if (days > maxDays) {
        throw new Error(
            `date range must not exceed ${maxDays} days; use export_meals for larger exports`,
        );
    }
    return days;
}

/** Valid ISO instant, no calendar/time rollover, at most one day ahead. */
export function validateLoggedAt(
    value: string,
    nowMs: number,
    toleranceMs: number = DAY_MS,
): void {
    const match = ISO_TIMESTAMP.exec(value);
    const time = Date.parse(value);
    try {
        if (!match) throw new Error();
        validateDate(match[1]!);
        if (
            Number(match[2]) > 23 ||
            Number(match[3]) > 59 ||
            Number(match[4]) > 59 ||
            Number.isNaN(time)
        ) {
            throw new Error();
        }
    } catch {
        throw new Error(
            `Invalid logged_at timestamp: ${value}. Use an ISO 8601 string.`,
        );
    }
    if (time > nowMs + toleranceMs) {
        throw new Error(`logged_at is in the future (${value}).`);
    }
}

/** Non-negative finite nutrient value; zero is valid. */
export function nonNegativeNumber(value: unknown): number {
    if (
        typeof value !== "number" &&
        (typeof value !== "string" || value.trim() === "")
    ) {
        throw new Error(`invalid non-negative number: ${String(value)}`);
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new Error(`invalid non-negative number: ${String(value)}`);
    }
    return number;
}

export function isNutritionSource(value: unknown): boolean {
    return typeof value === "string" && NUTRITION_SOURCES.includes(value);
}
