export function validateTz(tz: string): boolean {
    try {
        // The TZ constructor throws RangeError on unknown identifiers.
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** Current local date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTz(tz: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

/** Local date (YYYY-MM-DD) of an absolute instant in the given IANA timezone. */
export function dateInTz(instant: Date | string, tz: string): string {
    const d = instant instanceof Date ? instant : new Date(instant);
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}

/**
 * Local wall-clock timestamp ("YYYY-MM-DD HH:mm:ss") of an absolute instant in
 * the given IANA timezone. With tz="UTC" this yields the raw UTC time.
 */
export function formatLocalDateTime(
    instant: Date | string,
    tz: string,
): string {
    const d = instant instanceof Date ? instant : new Date(instant);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

/** Local hour (0-23) of an absolute instant in the given IANA timezone. */
export function hourInTz(instant: Date | string, tz: string): number {
    const d = instant instanceof Date ? instant : new Date(instant);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        hour: "2-digit",
    }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")!.value);
    return h === 24 ? 0 : h;
}

/**
 * UTC instant corresponding to 00:00:00 local on `date` in `tz`.
 * Works correctly across DST transitions.
 */
export function zonedDayStartUtc(date: string, tz: string): Date {
    const [y, m, d] = date.split("-").map(Number);
    if (y == null || m == null || d == null) {
        throw new Error(`Invalid date string: ${date}`);
    }
    const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(utcGuess));
    const getPart = (t: string) =>
        Number(parts.find((p) => p.type === t)!.value);
    let lh = getPart("hour");
    if (lh === 24) lh = 0;
    const asUtc = Date.UTC(
        getPart("year"),
        getPart("month") - 1,
        getPart("day"),
        lh,
        getPart("minute"),
        getPart("second"),
    );
    const offsetMs = asUtc - utcGuess;
    return new Date(utcGuess - offsetMs);
}

/** Exclusive upper bound: midnight of the day AFTER `date` in `tz`, as UTC. */
export function zonedNextDayStartUtc(date: string, tz: string): Date {
    const [y, m, d] = date.split("-").map(Number);
    if (y == null || m == null || d == null) {
        throw new Error(`Invalid date string: ${date}`);
    }
    const next = new Date(Date.UTC(y, m - 1, d));
    next.setUTCDate(next.getUTCDate() + 1);
    const nextStr = next.toISOString().slice(0, 10);
    return zonedDayStartUtc(nextStr, tz);
}

/**
 * Validate a client-supplied `logged_at` ISO string: it must parse, and must
 * not be in the future beyond a small clock-skew tolerance. Prevents a
 * mis-dated entry from silently becoming the user's "latest" reading. `nowMs`
 * is injected for testability.
 */
export function validateLoggedAt(
    iso: string,
    nowMs: number,
    toleranceMs: number = 5 * 60 * 1000,
): void {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) {
        throw new Error(
            `Invalid logged_at timestamp: ${iso}. Use an ISO 8601 string.`,
        );
    }
    if (t > nowMs + toleranceMs) {
        throw new Error(
            `logged_at is in the future (${iso}). Log the time the measurement was actually taken.`,
        );
    }
}

/** Shift a local YYYY-MM-DD date by N days, returning YYYY-MM-DD. No TZ needed. */
export function shiftLocalDate(date: string, days: number): string {
    const [y, m, d] = date.split("-").map(Number);
    if (y == null || m == null || d == null) {
        throw new Error(`Invalid date string: ${date}`);
    }
    const next = new Date(Date.UTC(y, m - 1, d));
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString().slice(0, 10);
}
