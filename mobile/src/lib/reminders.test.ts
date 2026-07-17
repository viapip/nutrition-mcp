/// <reference types="bun" />
import { expect, test } from "bun:test";

import {
    diffReminders,
    reconcileReminders,
    type Reminder,
    type ScheduleState,
} from "./reminders";

const rem = (over: Partial<Reminder> = {}): Reminder => ({
    id: "a",
    hour: 8,
    minute: 0,
    enabled: true,
    ...over,
});

test("новое включённое напоминание — только планируем", () => {
    const d = diffReminders([rem()], {});
    expect(d.toCancel).toEqual([]);
    expect(d.toSchedule.map((r) => r.id)).toEqual(["a"]);
});

test("свежая бронь — ничего не делаем", () => {
    const schedule: ScheduleState = {
        a: { notificationId: "n1", hour: 8, minute: 0 },
    };
    const d = diffReminders([rem()], schedule);
    expect(d.toCancel).toEqual([]);
    expect(d.toSchedule).toEqual([]);
});

test("смена времени — гасим старую бронь и планируем заново", () => {
    const schedule: ScheduleState = {
        a: { notificationId: "n1", hour: 8, minute: 0 },
    };
    const d = diffReminders([rem({ hour: 9 })], schedule);
    expect(d.toCancel).toEqual(["n1"]);
    expect(d.toSchedule.map((r) => r.id)).toEqual(["a"]);
});

test("смена подписи — перепланируем (меняется контент)", () => {
    const schedule: ScheduleState = {
        a: { notificationId: "n1", hour: 8, minute: 0, label: "Старое" },
    };
    const d = diffReminders([rem({ label: "Новое" })], schedule);
    expect(d.toCancel).toEqual(["n1"]);
    expect(d.toSchedule.map((r) => r.id)).toEqual(["a"]);
});

test("выключенное напоминание — отменяем бронь, не планируем", () => {
    const schedule: ScheduleState = {
        a: { notificationId: "n1", hour: 8, minute: 0 },
    };
    const d = diffReminders([rem({ enabled: false })], schedule);
    expect(d.toCancel).toEqual(["n1"]);
    expect(d.toSchedule).toEqual([]);
});

test("удалённое напоминание — отменяем осиротевшую бронь", () => {
    const schedule: ScheduleState = {
        a: { notificationId: "n1", hour: 8, minute: 0 },
        b: { notificationId: "n2", hour: 9, minute: 0 },
    };
    const d = diffReminders([rem({ id: "a" })], schedule);
    expect(d.toCancel).toEqual(["n2"]);
    expect(d.toSchedule).toEqual([]);
});

test("reconcile: планирует включённое и возвращает карту броней", async () => {
    let seq = 0;
    const scheduled: string[] = [];
    const cancelled: string[] = [];
    const next = await reconcileReminders(
        [rem({ id: "a", hour: 7, minute: 30 })],
        {},
        async (r) => {
            scheduled.push(r.id);
            seq += 1;
            return `n${seq}`;
        },
        async (id) => {
            cancelled.push(id);
        },
    );
    expect(scheduled).toEqual(["a"]);
    expect(cancelled).toEqual([]);
    expect(next.a.notificationId).toBe("n1");
    expect(next.a.hour).toBe(7);
    expect(next.a.minute).toBe(30);
});

test("reconcile: смена времени отменяет старое и пишет новую бронь", async () => {
    const cancelled: string[] = [];
    const next = await reconcileReminders(
        [rem({ id: "a", hour: 9, minute: 0 })],
        { a: { notificationId: "old", hour: 8, minute: 0 } },
        async () => "new",
        async (id) => {
            cancelled.push(id);
        },
    );
    expect(cancelled).toEqual(["old"]);
    expect(next.a.notificationId).toBe("new");
});

test("reconcile: выключение убирает бронь из карты", async () => {
    const cancelled: string[] = [];
    const next = await reconcileReminders(
        [rem({ id: "a", enabled: false })],
        { a: { notificationId: "old", hour: 8, minute: 0 } },
        async () => "new",
        async (id) => {
            cancelled.push(id);
        },
    );
    expect(cancelled).toEqual(["old"]);
    expect(next).toEqual({});
});
