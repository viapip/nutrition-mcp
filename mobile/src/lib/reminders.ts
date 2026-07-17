/** Пользовательское ежедневное напоминание. hour 0–23, minute 0–59. */
export type Reminder = {
    id: string;
    hour: number;
    minute: number;
    label?: string;
    enabled: boolean;
};

/** Что мы считаем запланированным в системе: reminderId → бронь уведомления. */
export type ScheduledEntry = {
    notificationId: string;
    hour: number;
    minute: number;
    label?: string;
};

export type ScheduleState = Record<string, ScheduledEntry>;

export type ReminderDiff = {
    /** id системных уведомлений на отмену */
    toCancel: string[];
    /** напоминания на (пере)планирование */
    toSchedule: Reminder[];
};

let idCounter = 0;

/** Стабильный id нового напоминания. Не звать из рендера (Date.now). */
export function genReminderId(): string {
    idCounter += 1;
    return `rem_${Date.now().toString(36)}_${idCounter}`;
}

export function formatTime(hour: number, minute: number): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(hour)}:${pad(minute)}`;
}

/** Заголовок и тело системного уведомления для напоминания. */
export function reminderContent(r: Reminder): { title: string; body: string } {
    const label = r.label?.trim();
    return {
        title: label || "Напоминание",
        body: "Загляни в Sage и отметь.",
    };
}

/** Два старых хардкод-напоминания — засев при миграции. */
export function legacySeedReminders(genId: () => string): Reminder[] {
    return [
        {
            id: genId(),
            hour: 20,
            minute: 0,
            label: "Записать ужин",
            enabled: true,
        },
        {
            id: genId(),
            hour: 8,
            minute: 0,
            label: "Взвеситься утром",
            enabled: true,
        },
    ];
}

function clampInt(n: unknown, min: number, max: number): number | null {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    const v = Math.round(n);
    return v >= min && v <= max ? v : null;
}

function normalizeReminder(x: unknown): Reminder | null {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    const hour = clampInt(o.hour, 0, 23);
    const minute = clampInt(o.minute, 0, 59);
    if (hour == null || minute == null) return null;
    return {
        id: typeof o.id === "string" && o.id ? o.id : genReminderId(),
        hour,
        minute,
        label: typeof o.label === "string" ? o.label : undefined,
        enabled: o.enabled === true,
    };
}

export function parseReminders(raw: string | null): Reminder[] {
    if (!raw) return [];
    try {
        const data: unknown = JSON.parse(raw);
        if (!Array.isArray(data)) return [];
        return data
            .map(normalizeReminder)
            .filter((r): r is Reminder => r !== null);
    } catch {
        return [];
    }
}

export function serializeReminders(reminders: Reminder[]): string {
    return JSON.stringify(reminders);
}

export function parseSchedule(raw: string | null): ScheduleState {
    if (!raw) return {};
    try {
        const data: unknown = JSON.parse(raw);
        if (!data || typeof data !== "object" || Array.isArray(data)) return {};
        return data as ScheduleState;
    } catch {
        return {};
    }
}

// Подпись входит в проверку: её смена меняет контент уведомления → перепланируем.
function isFresh(entry: ScheduledEntry, r: Reminder): boolean {
    return (
        entry.hour === r.hour &&
        entry.minute === r.minute &&
        (entry.label ?? "") === (r.label ?? "")
    );
}

/** Чистый diff: что отменить и что (пере)запланировать под текущий список. */
export function diffReminders(
    reminders: Reminder[],
    schedule: ScheduleState,
): ReminderDiff {
    const toCancel: string[] = [];
    const toSchedule: Reminder[] = [];
    const byId = new Map(reminders.map((r) => [r.id, r]));

    // Брони удалённых или выключенных напоминаний — на отмену.
    for (const [rid, entry] of Object.entries(schedule)) {
        const r = byId.get(rid);
        if (!r || !r.enabled) toCancel.push(entry.notificationId);
    }

    for (const r of reminders) {
        if (!r.enabled) continue;
        const entry = schedule[r.id];
        if (entry && isFresh(entry, r)) continue;
        // Время/подпись изменились — старую бронь тоже гасим.
        if (entry) toCancel.push(entry.notificationId);
        toSchedule.push(r);
    }

    return { toCancel, toSchedule };
}

/** Приводит систему к списку и возвращает новую карту броней для персиста. */
export async function reconcileReminders(
    reminders: Reminder[],
    schedule: ScheduleState,
    scheduleOne: (r: Reminder) => Promise<string>,
    cancelOne: (notificationId: string) => Promise<void>,
): Promise<ScheduleState> {
    const { toCancel, toSchedule } = diffReminders(reminders, schedule);

    for (const id of toCancel) {
        try {
            await cancelOne(id);
        } catch {
            // Уже отменено/истекло — не мешаем остальному.
        }
    }

    const rescheduled = new Set(toSchedule.map((r) => r.id));
    const byId = new Map(reminders.map((r) => [r.id, r]));
    const next: ScheduleState = {};

    // Оставляем ещё валидные брони (включённые, не тронутые diff-ом).
    for (const [rid, entry] of Object.entries(schedule)) {
        const r = byId.get(rid);
        if (r && r.enabled && !rescheduled.has(rid)) next[rid] = entry;
    }

    for (const r of toSchedule) {
        const notificationId = await scheduleOne(r);
        next[r.id] = {
            notificationId,
            hour: r.hour,
            minute: r.minute,
            label: r.label,
        };
    }

    return next;
}
