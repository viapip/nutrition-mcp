import { test, expect } from "bun:test";
import {
    validateTz,
    dateInTz,
    formatLocalDateTime,
    hourInTz,
    zonedDayStartUtc,
    zonedNextDayStartUtc,
    shiftLocalDate,
    calendarWeekBounds,
} from "./tz.js";

test("dateInTz maps an instant to the local calendar day", () => {
    // 07:00Z = 23:00 the previous day in LA, same day in UTC/Tokyo.
    const inst = "2024-03-01T07:00:00Z";
    expect(dateInTz(inst, "America/Los_Angeles")).toBe("2024-02-29");
    expect(dateInTz(inst, "UTC")).toBe("2024-03-01");
    expect(dateInTz(inst, "Asia/Tokyo")).toBe("2024-03-01");
});

test("formatLocalDateTime renders wall-clock time, normalizing hour 24 to 00", () => {
    expect(
        formatLocalDateTime("2024-03-01T07:00:00Z", "America/Los_Angeles"),
    ).toBe("2024-02-29 23:00:00");
    // Exactly midnight LA (PST UTC-8).
    expect(
        formatLocalDateTime("2024-03-01T08:00:00Z", "America/Los_Angeles"),
    ).toBe("2024-03-01 00:00:00");
});

test("hourInTz reflects local time", () => {
    expect(hourInTz("2024-03-01T07:00:00Z", "America/Los_Angeles")).toBe(23);
    expect(hourInTz("2024-03-01T08:00:00Z", "America/Los_Angeles")).toBe(0);
});

test("zonedDayStartUtc handles DST transitions and fractional offsets", () => {
    expect(
        zonedDayStartUtc("2024-03-01", "America/Los_Angeles").toISOString(),
    ).toBe("2024-03-01T08:00:00.000Z");
    // 2024-03-10 is the spring-forward day; midnight is still PST (UTC-8).
    expect(
        zonedDayStartUtc("2024-03-10", "America/Los_Angeles").toISOString(),
    ).toBe("2024-03-10T08:00:00.000Z");
    // The next day is PDT (UTC-7).
    expect(
        zonedDayStartUtc("2024-03-11", "America/Los_Angeles").toISOString(),
    ).toBe("2024-03-11T07:00:00.000Z");
    expect(zonedDayStartUtc("2024-03-01", "Asia/Kolkata").toISOString()).toBe(
        "2024-02-29T18:30:00.000Z",
    );
    expect(zonedDayStartUtc("2024-03-01", "Asia/Kathmandu").toISOString()).toBe(
        "2024-02-29T18:15:00.000Z",
    );
});

test("zonedNextDayStartUtc is the exclusive upper bound", () => {
    expect(
        zonedNextDayStartUtc("2024-03-01", "America/Los_Angeles").toISOString(),
    ).toBe("2024-03-02T08:00:00.000Z");
});

test("shiftLocalDate does calendar arithmetic across month boundaries", () => {
    expect(shiftLocalDate("2024-02-28", 1)).toBe("2024-02-29"); // leap year
    expect(shiftLocalDate("2024-03-01", -1)).toBe("2024-02-29");
});

test("calendarWeekBounds is Monday–Sunday, including Sunday input", () => {
    expect(calendarWeekBounds("2026-07-20")).toEqual({
        startDate: "2026-07-20",
        endDate: "2026-07-26",
    });
    expect(calendarWeekBounds("2026-07-26")).toEqual({
        startDate: "2026-07-20",
        endDate: "2026-07-26",
    });
});

test("validateTz accepts IANA names and rejects junk", () => {
    expect(validateTz("America/Los_Angeles")).toBe(true);
    expect(validateTz("UTC")).toBe(true);
    expect(validateTz("Etc/GMT+5")).toBe(true);
    expect(validateTz("Mars/Phobos")).toBe(false);
    expect(validateTz("")).toBe(false);
});
