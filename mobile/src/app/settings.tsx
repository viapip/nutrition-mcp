import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
    KeyboardAvoidingView,
    Pressable,
    ScrollView,
    StyleSheet,
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
import { getSettings, logout, saveLlmKey } from "@/lib/api";
import { successBuzz, tapBuzz } from "@/lib/haptics";

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
                    borderColor: hasKey ? theme.accent : theme.hairline,
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

    const [hasKey, setHasKey] = useState<boolean | null>(null);
    const [chatAvailable, setChatAvailable] = useState(true);
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        getSettings()
            .then((s) => {
                setHasKey(s.has_llm_key);
                setChatAvailable(s.chat_available);
            })
            .catch((err) => {
                if (err instanceof Error && err.message === "unauthorized") {
                    router.replace("/login");
                } else {
                    setHasKey(false);
                }
            });
    }, []);

    const save = async (value: string | null) => {
        if (busy) return;
        setBusy(true);
        setNote(null);
        try {
            const s = await saveLlmKey(value);
            setHasKey(s.has_llm_key);
            setChatAvailable(s.chat_available);
            setKey("");
            setNote(value ? "Ключ сохранён." : "Ключ удалён.");
            successBuzz();
        } catch (err) {
            if (err instanceof Error && err.message === "unauthorized") {
                router.replace("/login");
                return;
            }
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
                        <View style={styles.form}>
                            <Text
                                style={[
                                    styles.label,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                {hasKey ? "Заменить ключ" : "API-ключ"}
                            </Text>
                            <TextInput
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.surfaceElevated,
                                        borderColor: focused
                                            ? theme.accent
                                            : theme.hairline,
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

                        {/* Account */}
                        <View
                            style={[
                                styles.divider,
                                { backgroundColor: theme.hairline },
                            ]}
                        />
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
    form: { marginTop: Spacing.lg, gap: Spacing.sm },
    label: { fontFamily: Fonts.sansMedium, fontSize: 13 },
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
        borderRadius: Radii.xl,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: Spacing.sm,
    },
    saveText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    removeBtn: { alignSelf: "center", paddingVertical: Spacing.sm },
    removeText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    note: { fontFamily: Fonts.sansMedium, fontSize: 14, textAlign: "center" },
    divider: { height: 1, marginVertical: Spacing.xl },
    logoutRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },
    logout: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    logoutArrow: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
});
