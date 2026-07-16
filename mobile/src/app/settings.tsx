import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
    Alert,
    KeyboardAvoidingView,
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

// Foreground notifications should still surface a banner.
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

/** Локальные напоминания: время фиксированное (пикер — позже, если понадобится).
 * Значение в AsyncStorage под key — id запланированного уведомления (есть id = включено). */
const REMINDERS = [
    {
        key: "reminder_dinner",
        label: "Записать ужин",
        hint: "Каждый день в 20:00",
        hour: 20,
        minute: 0,
        title: "Запиши ужин 🍽",
        body: "Отметь, что было на ужин.",
    },
    {
        key: "reminder_weight",
        label: "Взвеситься утром",
        hint: "Каждый день в 8:00",
        hour: 8,
        minute: 0,
        title: "Пора взвеситься ⚖️",
        body: "Утреннее взвешивание — лучший ориентир.",
    },
] as const;

type Reminder = (typeof REMINDERS)[number];

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
    const [reminders, setReminders] = useState<Record<string, boolean>>({});
    const [reminderNote, setReminderNote] = useState<string | null>(null);

    // On = уже есть сохранённый id запланированного уведомления.
    useEffect(() => {
        void Promise.all(
            REMINDERS.map((r) => AsyncStorage.getItem(r.key)),
        ).then((ids) => {
            setReminders(
                Object.fromEntries(
                    REMINDERS.map((r, i) => [r.key, ids[i] != null]),
                ),
            );
        });
    }, []);

    const toggleReminder = async (r: Reminder, on: boolean) => {
        setReminderNote(null);
        try {
            if (on) {
                const granted =
                    (await Notifications.getPermissionsAsync()).granted ||
                    (await Notifications.requestPermissionsAsync()).granted;
                if (!granted) {
                    setReminderNote(
                        "Разреши уведомления в настройках, чтобы включить напоминание.",
                    );
                    return; // остаётся выключенным
                }
                const id = await Notifications.scheduleNotificationAsync({
                    content: { title: r.title, body: r.body },
                    trigger: {
                        type: Notifications.SchedulableTriggerInputTypes.DAILY,
                        hour: r.hour,
                        minute: r.minute,
                    },
                });
                await AsyncStorage.setItem(r.key, id);
            } else {
                const id = await AsyncStorage.getItem(r.key);
                if (id)
                    await Notifications.cancelScheduledNotificationAsync(id);
                await AsyncStorage.removeItem(r.key);
            }
            setReminders((s) => ({ ...s, [r.key]: on }));
        } catch {
            setReminderNote(
                "Не получилось изменить напоминание — попробуй ещё раз.",
            );
        }
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
                            {REMINDERS.map((r) => (
                                <View key={r.key} style={styles.remRow}>
                                    <View style={styles.remText}>
                                        <Text
                                            style={[
                                                styles.remLabel,
                                                { color: theme.ink },
                                            ]}
                                        >
                                            {r.label}
                                        </Text>
                                        <Text
                                            style={[
                                                styles.remHint,
                                                { color: theme.inkMuted },
                                            ]}
                                        >
                                            {r.hint}
                                        </Text>
                                    </View>
                                    <Switch
                                        value={!!reminders[r.key]}
                                        onValueChange={(v) =>
                                            void toggleReminder(r, v)
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
