import { expect, test } from "bun:test";
import {
    nonNegativeNumber,
    validateDate,
    validateDateRange,
    validateLoggedAt,
} from "./validate.js";

test("strict dates reject rollover and reversed or oversized ranges", () => {
    expect(() => validateDate("2026-02-31")).toThrow("Invalid date");
    expect(() => validateDate("2026-99-99")).toThrow("Invalid date");
    expect(() => validateDateRange("2026-02-02", "2026-02-01")).toThrow(
        "start_date",
    );
    expect(() => validateDateRange("2025-01-01", "2026-01-01")).toThrow(
        "365 days",
    );
    expect(validateDateRange("2026-01-01", "2026-12-31")).toBe(365);
});

test("nutrients accept zero but reject negatives and coercion junk", () => {
    expect(nonNegativeNumber(0)).toBe(0);
    expect(nonNegativeNumber("1.5")).toBe(1.5);
    expect(() => nonNegativeNumber(-1)).toThrow("non-negative");
    expect(() => nonNegativeNumber("")).toThrow("non-negative");
    expect(() => nonNegativeNumber(false)).toThrow("non-negative");
});

test("logged_at accepts backfill and one-day skew, rejects rollover and future", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(() =>
        validateLoggedAt("1999-01-01T00:00:00.000Z", now),
    ).not.toThrow();
    expect(() =>
        validateLoggedAt("2026-07-16T12:00:00.000Z", now),
    ).not.toThrow();
    expect(() =>
        validateLoggedAt("2026-07-14T19:30:00+03:00", now),
    ).not.toThrow();
    expect(() => validateLoggedAt("2026-02-31T19:30:00.000Z", now)).toThrow(
        "Invalid logged_at",
    );
    expect(() => validateLoggedAt("2026-99-99T19:30:00.000Z", now)).toThrow(
        "Invalid logged_at",
    );
    expect(() => validateLoggedAt("not-a-date", now)).toThrow(
        "Invalid logged_at",
    );
    expect(() => validateLoggedAt("2026-07-16T12:00:00.0001Z", now)).toThrow(
        "Invalid logged_at",
    );
    expect(() => validateLoggedAt("2026-07-16T12:00:00.001Z", now)).toThrow(
        "future",
    );
});
