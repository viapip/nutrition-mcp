const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(tz: string): Intl.DateTimeFormat {
    let formatter = dateFormatters.get(tz);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
        dateFormatters.set(tz, formatter);
    }
    return formatter;
}

function dateTimeFormatter(tz: string): Intl.DateTimeFormat {
    let formatter = dateTimeFormatters.get(tz);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour12: false,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
        dateTimeFormatters.set(tz, formatter);
    }
    return formatter;
}

function hourFormatter(tz: string): Intl.DateTimeFormat {
    let formatter = hourFormatters.get(tz);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour12: false,
            hour: "2-digit",
        });
        hourFormatters.set(tz, formatter);
    }
    return formatter;
}

export function validateTz(tz: string): boolean {
    try {
        dateFormatter(tz);
        return true;
    } catch {
        return false;
    }
}

/** Current local date (YYYY-MM-DD) in the given IANA timezone. */
export function todayInTz(tz: string): string {
    return dateFormatter(tz).format(new Date());
}

/** Local date (YYYY-MM-DD) of an absolute instant in the given IANA timezone. */
export function dateInTz(instant: Date | string, tz: string): string {
    const d = instant instanceof Date ? instant : new Date(instant);
    return dateFormatter(tz).format(d);
}

/** Monday–Sunday calendar week containing a local YYYY-MM-DD date. */
export function calendarWeekBounds(date: string): {
    startDate: string;
    endDate: string;
} {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    const startDate = shiftLocalDate(date, day === 0 ? -6 : 1 - day);
    return { startDate, endDate: shiftLocalDate(startDate, 6) };
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
    const parts = dateTimeFormatter(tz).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

/** Local hour (0-23) of an absolute instant in the given IANA timezone. */
export function hourInTz(instant: Date | string, tz: string): number {
    const d = instant instanceof Date ? instant : new Date(instant);
    const parts = hourFormatter(tz).formatToParts(d);
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
    const parts = dateTimeFormatter(tz).formatToParts(new Date(utcGuess));
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
