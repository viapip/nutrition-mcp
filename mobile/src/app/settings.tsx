import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Alert,
    KeyboardAvoidingView,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    useColorScheme,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
    Colors,
    Fonts,
    MaxContentWidth,
    Radii,
    Spacing,
    TabularNums,
    type Theme,
} from "@/constants/theme";
import {
    deleteAccount,
    getSettings,
    logout,
    saveLlmKey,
    setToken,
} from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { successBuzz, tapBuzz } from "@/lib/haptics";
import {
    diffReminders,
    formatTime,
    genReminderId,
    legacySeedReminders,
    parseReminders,
    parseSchedule,
    reconcileReminders,
    reminderContent,
    serializeReminders,
    type Reminder,
    type ScheduleState,
} from "@/lib/reminders";

// Foreground notifications should still surface a banner.
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

const REMINDERS_KEY = "reminders_v2";
const SCHEDULE_KEY = "reminder_sched_v2";
const LEGACY_KEYS = ["reminder_dinner", "reminder_weight"];
// Шаг минут в селекторе времени.
const MIN_STEP = 5;

const pad2 = (n: number) => String(n).padStart(2, "0");

async function scheduleReminder(r: Reminder): Promise<string> {
    const { title, body } = reminderContent(r);
    return Notifications.scheduleNotificationAsync({
        content: { title, body },
        trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour: r.hour,
            minute: r.minute,
        },
    });
}

async function cancelReminder(id: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(id);
}

async function ensureNotifyPermission(): Promise<boolean> {
    if ((await Notifications.getPermissionsAsync()).granted) return true;
    return (await Notifications.requestPermissionsAsync()).granted;
}

async function persistReminders(
    reminders: Reminder[],
    schedule: ScheduleState,
): Promise<void> {
    await AsyncStorage.multiSet([
        [REMINDERS_KEY, serializeReminders(reminders)],
        [SCHEDULE_KEY, JSON.stringify(schedule)],
    ]);
}

function StepBtn({
    glyph,
    label,
    onPress,
    theme,
}: {
    glyph: string;
    label: string;
    onPress: () => void;
    theme: Theme;
}) {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={onPress}
            hitSlop={8}
            style={({ pressed }) => [
                styles.stepBtn,
                {
                    backgroundColor: theme.surface,
                    transform: [{ scale: pressed ? 0.92 : 1 }],
                },
            ]}
        >
            <Text style={[styles.stepBtnText, { color: theme.accent }]}>
                {glyph}
            </Text>
        </Pressable>
    );
}

function Stepper({
    label,
    value,
    onDec,
    onInc,
    theme,
}: {
    label: string;
    value: number;
    onDec: () => void;
    onInc: () => void;
    theme: Theme;
}) {
    return (
        <View style={styles.stepper}>
            <Text style={[styles.stepperLabel, { color: theme.inkMuted }]}>
                {label}
            </Text>
            <View style={styles.stepperControls}>
                <StepBtn
                    glyph="−"
                    label={`${label}: меньше`}
                    onPress={onDec}
                    theme={theme}
                />
                <Text
                    style={[
                        styles.stepperValue,
                        TabularNums,
                        { color: theme.ink },
                    ]}
                >
                    {pad2(value)}
                </Text>
                <StepBtn
                    glyph="+"
                    label={`${label}: больше`}
                    onPress={onInc}
                    theme={theme}
                />
            </View>
        </View>
    );
}

/** Status card: where the assistant's requests are billed right now. */
function KeyStatus({ hasKey, theme }: { hasKey: boolean; theme: Theme }) {
    return (
        <View
            style={[
                styles.status,
                {
                    backgroundColor: hasKey
                        ? theme.accentSoft
                        : theme.surfaceElevated,
                },
            ]}
        >
            <View
                style={[
                    styles.statusHalo,
                    hasKey && { backgroundColor: theme.accentSoft },
                ]}
            >
                <View
                    style={[
                        styles.statusDot,
                        {
                            backgroundColor: hasKey
                                ? theme.accent
                                : theme.inkMuted,
                        },
                        hasKey && {
                            shadowColor: theme.accent,
                            shadowOpacity: 0.9,
                            shadowRadius: 6,
                            shadowOffset: { width: 0, height: 0 },
                            elevation: 6,
                        },
                    ]}
                />
            </View>
            <View style={styles.statusText}>
                <Text style={[styles.statusTitle, { color: theme.ink }]}>
                    {hasKey ? "Свой ключ" : "Общий ключ"}
                </Text>
                <Text style={[styles.statusHint, { color: theme.inkMuted }]}>
                    {hasKey
                        ? "Запросы ассистента оплачиваются с твоего аккаунта провайдера."
                        : "Ты на серверном ключе — пользуйся, лимиты общие."}
                </Text>
            </View>
        </View>
    );
}

export default function SettingsScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];

    const { onError } = useRequireAuth();
    const [hasKey, setHasKey] = useState<boolean | null>(null);
    const [chatAvailable, setChatAvailable] = useState(true);
    // Настройки не загрузились (offline) — не выдаём hasKey=false за «общий ключ».
    const [loadError, setLoadError] = useState(false);
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [focused, setFocused] = useState(false);
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [remindersReady, setRemindersReady] = useState(false);
    const [reminderNote, setReminderNote] = useState<string | null>(null);
    // null = редактор закрыт; иначе — черновик создаваемого/правимого напоминания.
    const [draft, setDraft] = useState<Reminder | null>(null);
    // Карта броней (reminderId → системное уведомление): живёт вне рендера.
    const schedule = useRef<ScheduleState>({});

    // Приводит систему к списку: спрашивает разрешение при первом планировании,
    // (пере)планирует enabled, гасит лишнее, персистит список и карту броней.
    const commit = useCallback(async (next: Reminder[]) => {
        setReminderNote(null);
        try {
            let list = next;
            const plan = diffReminders(list, schedule.current);
            if (plan.toSchedule.length > 0) {
                const granted = await ensureNotifyPermission();
                if (!granted) {
                    // Оставляем выключенными те, что требовали планирования.
                    const blocked = new Set(plan.toSchedule.map((r) => r.id));
                    list = list.map((r) =>
                        blocked.has(r.id) ? { ...r, enabled: false } : r,
                    );
                    setReminderNote(
                        "Разреши уведомления в настройках, чтобы включить напоминание.",
                    );
                }
            }
            const nextSchedule = await reconcileReminders(
                list,
                schedule.current,
                scheduleReminder,
                cancelReminder,
            );
            schedule.current = nextSchedule;
            setReminders(list);
            await persistReminders(list, nextSchedule);
        } catch {
            setReminderNote(
                "Не получилось обновить напоминания — попробуй ещё раз.",
            );
        }
    }, []);

    useEffect(() => {
        let alive = true;
        void (async () => {
            const rawList = await AsyncStorage.getItem(REMINDERS_KEY);
            if (rawList != null) {
                schedule.current = parseSchedule(
                    await AsyncStorage.getItem(SCHEDULE_KEY),
                );
                if (alive) {
                    setReminders(parseReminders(rawList));
                    setRemindersReady(true);
                }
                return;
            }
            // Первый запуск v2: миграция со старых ключей либо чистый старт.
            const legacyIds = await Promise.all(
                LEGACY_KEYS.map((k) => AsyncStorage.getItem(k)),
            );
            for (const id of legacyIds) {
                if (id) {
                    try {
                        await Notifications.cancelScheduledNotificationAsync(
                            id,
                        );
                    } catch {
                        // Старая бронь могла уже истечь.
                    }
                }
            }
            await AsyncStorage.multiRemove(LEGACY_KEYS);
            const seed = legacyIds.some((id) => id != null)
                ? legacySeedReminders(genReminderId)
                : [];
            if (seed.length > 0) await commit(seed);
            else await persistReminders([], {});
            if (alive) setRemindersReady(true);
        })().catch(() => {
            if (alive) setRemindersReady(true);
        });
        return () => {
            alive = false;
        };
    }, [commit]);

    const isEditing = draft != null && reminders.some((r) => r.id === draft.id);

    const openNew = () => {
        tapBuzz();
        setReminderNote(null);
        const now = new Date();
        setDraft({
            id: genReminderId(),
            hour: now.getHours(),
            minute: 0,
            label: "",
            enabled: true,
        });
    };

    const openEdit = (r: Reminder) => {
        tapBuzz();
        setReminderNote(null);
        setDraft({ ...r, label: r.label ?? "" });
    };

    const toggleReminder = (r: Reminder, on: boolean) => {
        tapBuzz();
        void commit(
            reminders.map((x) => (x.id === r.id ? { ...x, enabled: on } : x)),
        );
    };

    const bumpDraft = (field: "hour" | "minute", delta: number) => {
        tapBuzz();
        setDraft((d) => {
            if (!d) return d;
            if (field === "hour")
                return { ...d, hour: (d.hour + delta + 24) % 24 };
            const steps = 60 / MIN_STEP;
            const idx = Math.round(d.minute / MIN_STEP);
            return { ...d, minute: ((idx + delta + steps) % steps) * MIN_STEP };
        });
    };

    const saveDraft = async () => {
        if (!draft) return;
        const label = draft.label?.trim();
        const clean: Reminder = { ...draft, label: label || undefined };
        const exists = reminders.some((r) => r.id === clean.id);
        const next = exists
            ? reminders.map((r) => (r.id === clean.id ? clean : r))
            : [...reminders, clean];
        setDraft(null);
        await commit(next);
        successBuzz();
    };

    const deleteDraft = async () => {
        if (!draft) return;
        const next = reminders.filter((r) => r.id !== draft.id);
        setDraft(null);
        await commit(next);
    };

    const confirmDeleteAccount = () => {
        tapBuzz();
        Alert.alert(
            "Удалить аккаунт?",
            "Все данные будут стёрты безвозвратно. Это действие необратимо.",
            [
                { text: "Отмена", style: "cancel" },
                {
                    text: "Удалить",
                    style: "destructive",
                    onPress: () => void removeAccount(),
                },
            ],
        );
    };

    const removeAccount = async () => {
        try {
            await deleteAccount();
            await setToken(null);
            router.replace("/login");
        } catch (err) {
            if (onError(err)) return;
            Alert.alert(
                "Не вышло",
                "Не получилось удалить аккаунт. Попробуй позже.",
            );
        }
    };

    useEffect(() => {
        getSettings()
            .then((s) => {
                setHasKey(s.has_llm_key);
                setChatAvailable(s.chat_available);
            })
            .catch((err) => {
                if (onError(err)) return;
                // hasKey остаётся null (неизвестно), а не false.
                setLoadError(true);
            });
    }, [onError]);

    const save = async (value: string | null) => {
        if (busy) return;
        setBusy(true);
        setNote(null);
        try {
            const s = await saveLlmKey(value);
            setHasKey(s.has_llm_key);
            setChatAvailable(s.chat_available);
            setLoadError(false);
            setKey("");
            setNote(value ? "Ключ сохранён." : "Ключ удалён.");
            successBuzz();
        } catch (err) {
            if (onError(err)) return;
            setNote(
                "Не получилось сохранить — проверь ключ и попробуй ещё раз.",
            );
        } finally {
            setBusy(false);
        }
    };

    const ordered = [...reminders].sort(
        (a, b) => a.hour - b.hour || a.minute - b.minute,
    );

    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <KeyboardAvoidingView style={styles.flex} behavior="padding">
                <ScrollView
                    style={styles.flex}
                    contentContainerStyle={styles.scroll}
                >
                    <View style={styles.wrap}>
                        {/* Header */}
                        <View style={styles.header}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Назад к дашборду"
                                onPress={() => router.back()}
                                hitSlop={12}
                            >
                                <Text
                                    style={[
                                        styles.back,
                                        { color: theme.accent },
                                    ]}
                                >
                                    ← Сегодня
                                </Text>
                            </Pressable>
                        </View>

                        {/* Hero */}
                        <Text
                            style={[styles.eyebrow, { color: theme.inkMuted }]}
                        >
                            КУХНЯ · ДОСТУП
                        </Text>
                        <Text style={[styles.hero, { color: theme.ink }]}>
                            ТВОЙ{"\n"}
                            <Text style={{ color: theme.accent }}>КЛЮЧ.</Text>
                        </Text>
                        <Text
                            style={[styles.heroHint, { color: theme.inkMuted }]}
                        >
                            Ассистент ходит к LLM-провайдеру на каждое
                            сообщение. Добавь свой API-ключ, чтобы платить ровно
                            за то, что используешь.
                        </Text>

                        {/* No key anywhere → the danger note below explains */}
                        {hasKey != null && (hasKey || chatAvailable) && (
                            <KeyStatus hasKey={hasKey} theme={theme} />
                        )}
                        {loadError && (
                            <Text
                                style={[
                                    styles.heroHint,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                Не удалось загрузить настройки — проверь сеть.
                            </Text>
                        )}
                        {!chatAvailable && !hasKey && (
                            <Text
                                style={[
                                    styles.heroHint,
                                    { color: theme.danger },
                                ]}
                            >
                                Серверный ключ не настроен — ассистент выключен,
                                пока не добавишь свой.
                            </Text>
                        )}

                        {/* Key input */}
                        <View
                            style={[
                                styles.form,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.eyebrow,
                                    styles.sectionEyebrow,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                {hasKey ? "ЗАМЕНИТЬ КЛЮЧ" : "API-КЛЮЧ"}
                            </Text>
                            <TextInput
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.surface,
                                        borderColor: focused
                                            ? theme.accent
                                            : theme.surface,
                                        color: theme.ink,
                                    },
                                ]}
                                placeholder="sk-…"
                                placeholderTextColor={theme.inkMuted}
                                cursorColor={theme.accent}
                                selectionColor={theme.accent}
                                value={key}
                                onChangeText={(v) => {
                                    setKey(v);
                                    setNote(null);
                                }}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                                onFocus={() => setFocused(true)}
                                onBlur={() => setFocused(false)}
                            />
                            <Text
                                style={[
                                    styles.fieldHint,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                Хранится на твоём сервере и больше не
                                показывается. Ключи Kimi/Moonshot работают из
                                коробки; подойдёт любой OpenAI-совместимый
                                провайдер, на который смотрит сервер.
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => void save(key.trim())}
                                disabled={busy || !key.trim()}
                                style={({ pressed }) => {
                                    const off = busy || !key.trim();
                                    return [
                                        styles.saveBtn,
                                        {
                                            backgroundColor: theme.accent,
                                            opacity: off ? 0.5 : 1,
                                            transform: [
                                                {
                                                    scale:
                                                        pressed && !off
                                                            ? 0.97
                                                            : 1,
                                                },
                                            ],
                                        },
                                    ];
                                }}
                            >
                                <Text
                                    style={[
                                        styles.saveText,
                                        { color: theme.onAccent },
                                    ]}
                                >
                                    {busy ? "Сохраняю…" : "Сохранить ключ"}
                                </Text>
                            </Pressable>
                            {hasKey && (
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() => {
                                        tapBuzz();
                                        void save(null);
                                    }}
                                    disabled={busy}
                                    style={styles.removeBtn}
                                >
                                    <Text
                                        style={[
                                            styles.removeText,
                                            { color: theme.danger },
                                        ]}
                                    >
                                        Удалить мой ключ
                                    </Text>
                                </Pressable>
                            )}
                            {note && (
                                <Text
                                    style={[
                                        styles.note,
                                        {
                                            color: note.startsWith(
                                                "Не получилось",
                                            )
                                                ? theme.danger
                                                : theme.accent,
                                        },
                                    ]}
                                >
                                    {note}
                                </Text>
                            )}
                        </View>

                        {/* Reminders */}
                        <View
                            style={[
                                styles.form,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.eyebrow,
                                    styles.sectionEyebrow,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                НАПОМИНАНИЯ
                            </Text>
                            {remindersReady && ordered.length === 0 && (
                                <Text
                                    style={[
                                        styles.fieldHint,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    Пока пусто. Добавь напоминание на любое
                                    время — например, записать обед или
                                    взвеситься утром.
                                </Text>
                            )}
                            {ordered.map((r) => (
                                <View key={r.id} style={styles.remRow}>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Изменить напоминание ${formatTime(
                                            r.hour,
                                            r.minute,
                                        )}`}
                                        onPress={() => openEdit(r)}
                                        style={styles.remText}
                                    >
                                        <Text
                                            style={[
                                                styles.remLabel,
                                                { color: theme.ink },
                                            ]}
                                        >
                                            {r.label?.trim() || "Напоминание"}
                                        </Text>
                                        <Text
                                            style={[
                                                styles.remHint,
                                                { color: theme.inkMuted },
                                            ]}
                                        >
                                            Каждый день в{" "}
                                            {formatTime(r.hour, r.minute)}
                                        </Text>
                                    </Pressable>
                                    <Switch
                                        value={r.enabled}
                                        onValueChange={(v) =>
                                            toggleReminder(r, v)
                                        }
                                        trackColor={{
                                            false: theme.hairline,
                                            true: theme.accent,
                                        }}
                                        thumbColor={theme.surfaceElevated}
                                        ios_backgroundColor={theme.hairline}
                                    />
                                </View>
                            ))}
                            {remindersReady && (
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={openNew}
                                    style={({ pressed }) => [
                                        styles.addRem,
                                        {
                                            borderColor: theme.hairline,
                                            opacity: pressed ? 0.6 : 1,
                                        },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.addRemText,
                                            { color: theme.accent },
                                        ]}
                                    >
                                        ＋ Добавить напоминание
                                    </Text>
                                </Pressable>
                            )}
                            {reminderNote && (
                                <Text
                                    style={[
                                        styles.fieldHint,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    {reminderNote}
                                </Text>
                            )}
                        </View>

                        {/* Account */}
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Выйти из аккаунта"
                            onPress={async () => {
                                await logout();
                                router.replace("/login");
                            }}
                            hitSlop={8}
                            style={({ pressed }) => [
                                styles.logoutRow,
                                { opacity: pressed ? 0.6 : 1 },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.logout,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                Выйти
                            </Text>
                            <Text
                                style={[
                                    styles.logoutArrow,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                →
                            </Text>
                        </Pressable>

                        {/* Danger zone */}
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Удалить аккаунт"
                            onPress={confirmDeleteAccount}
                            style={({ pressed }) => [
                                styles.dangerBtn,
                                {
                                    borderTopColor: theme.hairline,
                                    opacity: pressed ? 0.6 : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.dangerText,
                                    { color: theme.danger },
                                ]}
                            >
                                Удалить аккаунт
                            </Text>
                        </Pressable>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>

            <Modal
                visible={draft != null}
                transparent
                animationType="fade"
                statusBarTranslucent
                navigationBarTranslucent
                onRequestClose={() => setDraft(null)}
            >
                <Pressable
                    style={styles.remBackdrop}
                    onPress={() => setDraft(null)}
                >
                    {/* Тап по карточке не должен закрывать модалку. */}
                    <Pressable
                        style={[
                            styles.remCard,
                            { backgroundColor: theme.surfaceElevated },
                        ]}
                    >
                        {draft && (
                            <>
                                <Text
                                    style={[
                                        styles.remCardTitle,
                                        { color: theme.ink },
                                    ]}
                                >
                                    {isEditing
                                        ? "Изменить напоминание"
                                        : "Новое напоминание"}
                                </Text>
                                <View style={styles.stepperRow}>
                                    <Stepper
                                        label="Часы"
                                        value={draft.hour}
                                        onDec={() => bumpDraft("hour", -1)}
                                        onInc={() => bumpDraft("hour", 1)}
                                        theme={theme}
                                    />
                                    <Text
                                        style={[
                                            styles.stepperColon,
                                            { color: theme.inkMuted },
                                        ]}
                                    >
                                        :
                                    </Text>
                                    <Stepper
                                        label="Минуты"
                                        value={draft.minute}
                                        onDec={() => bumpDraft("minute", -1)}
                                        onInc={() => bumpDraft("minute", 1)}
                                        theme={theme}
                                    />
                                </View>
                                <TextInput
                                    style={[
                                        styles.input,
                                        {
                                            backgroundColor: theme.surface,
                                            borderColor: theme.surface,
                                            color: theme.ink,
                                        },
                                    ]}
                                    placeholder="Подпись (необязательно)"
                                    placeholderTextColor={theme.inkMuted}
                                    cursorColor={theme.accent}
                                    selectionColor={theme.accent}
                                    value={draft.label ?? ""}
                                    onChangeText={(v) =>
                                        setDraft((d) =>
                                            d ? { ...d, label: v } : d,
                                        )
                                    }
                                    maxLength={40}
                                />
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() => void saveDraft()}
                                    style={({ pressed }) => [
                                        styles.saveBtn,
                                        {
                                            backgroundColor: theme.accent,
                                            transform: [
                                                { scale: pressed ? 0.97 : 1 },
                                            ],
                                        },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.saveText,
                                            { color: theme.onAccent },
                                        ]}
                                    >
                                        Сохранить
                                    </Text>
                                </Pressable>
                                <View style={styles.remCardFooter}>
                                    <Pressable
                                        accessibilityRole="button"
                                        onPress={() => setDraft(null)}
                                        hitSlop={8}
                                    >
                                        <Text
                                            style={[
                                                styles.remCardAction,
                                                { color: theme.inkSecondary },
                                            ]}
                                        >
                                            Отмена
                                        </Text>
                                    </Pressable>
                                    {isEditing && (
                                        <Pressable
                                            accessibilityRole="button"
                                            onPress={() => void deleteDraft()}
                                            hitSlop={8}
                                        >
                                            <Text
                                                style={[
                                                    styles.remCardAction,
                                                    { color: theme.danger },
                                                ]}
                                            >
                                                Удалить
                                            </Text>
                                        </Pressable>
                                    )}
                                </View>
                            </>
                        )}
                    </Pressable>
                </Pressable>
            </Modal>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1 },
    flex: { flex: 1 },
    scroll: { flexGrow: 1 },
    wrap: {
        flex: 1,
        width: "100%",
        maxWidth: MaxContentWidth,
        alignSelf: "center",
        paddingHorizontal: Spacing.lg,
        paddingBottom: Spacing.xl,
    },
    header: { paddingVertical: Spacing.sm },
    back: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 3,
        marginTop: Spacing.lg,
    },
    hero: {
        fontFamily: Fonts.display,
        fontSize: 34,
        lineHeight: 43,
        marginTop: Spacing.xs,
    },
    heroHint: {
        fontFamily: Fonts.sans,
        fontSize: 14,
        lineHeight: 20,
        marginTop: Spacing.md,
    },
    status: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        borderWidth: 1,
        borderRadius: Radii.lg,
        padding: Spacing.md,
        marginTop: Spacing.lg,
    },
    statusHalo: {
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: "center",
        justifyContent: "center",
    },
    statusDot: { width: 12, height: 12, borderRadius: 6 },
    statusText: { flex: 1, gap: 2 },
    statusTitle: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    statusHint: { fontFamily: Fonts.sans, fontSize: 13, lineHeight: 18 },
    form: {
        marginTop: Spacing.lg,
        gap: Spacing.sm,
        borderRadius: Radii.lg,
        padding: Spacing.lg,
    },
    sectionEyebrow: { marginTop: 0, marginBottom: Spacing.xs },
    input: {
        fontFamily: Fonts.sans,
        fontSize: 16,
        borderWidth: 1,
        borderRadius: Radii.md,
        paddingHorizontal: Spacing.md,
        paddingVertical: 12,
    },
    fieldHint: { fontFamily: Fonts.sans, fontSize: 12, lineHeight: 17 },
    saveBtn: {
        borderRadius: Radii.pill,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: Spacing.sm,
    },
    saveText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    removeBtn: { alignSelf: "center", paddingVertical: Spacing.sm },
    removeText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    note: { fontFamily: Fonts.sansMedium, fontSize: 14, textAlign: "center" },
    remRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: Spacing.md,
        paddingVertical: Spacing.xs,
    },
    remText: { flex: 1, gap: 2 },
    remLabel: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    remHint: { fontFamily: Fonts.sans, fontSize: 12, lineHeight: 17 },
    addRem: {
        borderWidth: 1,
        borderStyle: "dashed",
        borderRadius: Radii.md,
        paddingVertical: 12,
        alignItems: "center",
        marginTop: Spacing.xs,
    },
    addRemText: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    remBackdrop: {
        flex: 1,
        backgroundColor: "rgba(8, 9, 5, 0.6)",
        alignItems: "center",
        justifyContent: "center",
        padding: Spacing.lg,
    },
    remCard: {
        width: "100%",
        maxWidth: 360,
        borderRadius: Radii.lg,
        padding: Spacing.lg,
        gap: Spacing.md,
    },
    remCardTitle: { fontFamily: Fonts.display, fontSize: 19, lineHeight: 26 },
    stepperRow: {
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "center",
        gap: Spacing.md,
    },
    stepper: { alignItems: "center", gap: Spacing.sm },
    stepperLabel: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 2,
    },
    stepperControls: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    stepBtn: {
        width: 40,
        height: 40,
        borderRadius: Radii.pill,
        alignItems: "center",
        justifyContent: "center",
    },
    stepBtnText: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 22,
        lineHeight: 24,
    },
    stepperValue: {
        fontFamily: Fonts.display,
        fontSize: 30,
        minWidth: 56,
        textAlign: "center",
    },
    stepperColon: {
        fontFamily: Fonts.display,
        fontSize: 24,
        marginBottom: 8,
    },
    remCardFooter: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: Spacing.xs,
    },
    remCardAction: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    logoutRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: Spacing.xl,
    },
    logout: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    logoutArrow: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    dangerBtn: {
        marginTop: Spacing.lg,
        paddingTop: Spacing.lg,
        alignItems: "center",
        borderTopWidth: 1,
    },
    dangerText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
});
