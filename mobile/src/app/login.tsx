import { router } from "expo-router";
import { useState } from "react";
import {
    KeyboardAvoidingView,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { login, signup } from "@/lib/api";
import {
    Colors,
    Fonts,
    MaxContentWidth,
    Radii,
    Spacing,
} from "@/constants/theme";

/** Четырёхлучевая янтарная искра — графический акцент бренда. */
function Spark({ size, color }: { size: number; color: string }) {
    const c = size / 2;
    // Контрольные точки у центра делают лучи вогнутыми
    const w = size * 0.14;
    const d = `M ${c} 0 C ${c} ${c - w}, ${c + w} ${c}, ${size} ${c} C ${c + w} ${c}, ${c} ${c + w}, ${c} ${size} C ${c} ${c + w}, ${c - w} ${c}, 0 ${c} C ${c - w} ${c}, ${c} ${c - w}, ${c} 0 Z`;
    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Path d={d} fill={color} />
        </Svg>
    );
}

export default function LoginScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];

    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [focused, setFocused] = useState<string | null>(null);

    const switchMode = (next: "signin" | "signup") => {
        if (next === mode) return;
        setMode(next);
        setError(null);
    };

    const submit = async () => {
        if (!email || !password || busy) return;
        setBusy(true);
        setError(null);
        try {
            if (mode === "signin") {
                await login(email.trim(), password);
            } else {
                await signup(email.trim(), password, code.trim() || undefined);
            }
            router.replace("/");
        } catch {
            setError(
                mode === "signin"
                    ? "Неверная почта или пароль. Попробуй ещё раз."
                    : "Не получилось создать аккаунт — проверь поля (и инвайт-код, если он нужен).",
            );
        } finally {
            setBusy(false);
        }
    };

    const inputStyle = (field: string) => [
        styles.input,
        {
            backgroundColor: theme.surfaceElevated,
            borderColor: focused === field ? theme.accent : theme.hairline,
            color: theme.ink,
        },
    ];

    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <KeyboardAvoidingView style={styles.flex} behavior="padding">
                <View style={styles.wrap}>
                    <Spark size={30} color={theme.accent} />
                    <Text style={[styles.eyebrow, { color: theme.inkMuted }]}>
                        ЕДА · ВОДА · ВЕС
                    </Text>
                    <Text style={[styles.title, { color: theme.ink }]}>
                        ЕШЬ.{"\n"}ПЕЙ.{"\n"}
                        <Text style={{ color: theme.accent }}>ВЗВЕСЬСЯ.</Text>
                    </Text>

                    <View style={styles.form}>
                        <View
                            style={[
                                styles.segment,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: theme.hairline,
                                },
                            ]}
                        >
                            {(
                                [
                                    ["signin", "Войти"],
                                    ["signup", "Создать аккаунт"],
                                ] as const
                            ).map(([value, label]) => {
                                const active = mode === value;
                                return (
                                    <Pressable
                                        key={value}
                                        accessibilityRole="button"
                                        accessibilityState={{
                                            selected: active,
                                        }}
                                        onPress={() => switchMode(value)}
                                        style={[
                                            styles.segItem,
                                            active && {
                                                backgroundColor:
                                                    theme.accentSoft,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.segText,
                                                {
                                                    color: active
                                                        ? theme.accent
                                                        : theme.inkMuted,
                                                },
                                            ]}
                                        >
                                            {label}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>

                        <TextInput
                            style={inputStyle("email")}
                            placeholder="Почта"
                            placeholderTextColor={theme.inkMuted}
                            cursorColor={theme.accent}
                            selectionColor={theme.accent}
                            autoCapitalize="none"
                            autoComplete="email"
                            keyboardType="email-address"
                            value={email}
                            onChangeText={setEmail}
                            onFocus={() => setFocused("email")}
                            onBlur={() => setFocused(null)}
                        />
                        <TextInput
                            style={inputStyle("password")}
                            placeholder="Пароль"
                            placeholderTextColor={theme.inkMuted}
                            cursorColor={theme.accent}
                            selectionColor={theme.accent}
                            secureTextEntry
                            autoComplete="password"
                            value={password}
                            onChangeText={setPassword}
                            onSubmitEditing={submit}
                            onFocus={() => setFocused("password")}
                            onBlur={() => setFocused(null)}
                        />
                        {mode === "signup" && (
                            <TextInput
                                style={inputStyle("code")}
                                placeholder="Инвайт-код (если он у тебя есть)"
                                placeholderTextColor={theme.inkMuted}
                                cursorColor={theme.accent}
                                selectionColor={theme.accent}
                                autoCapitalize="none"
                                value={code}
                                onChangeText={setCode}
                                onSubmitEditing={submit}
                                onFocus={() => setFocused("code")}
                                onBlur={() => setFocused(null)}
                            />
                        )}
                        {error && (
                            <Text
                                style={[styles.error, { color: theme.danger }]}
                            >
                                {error}
                            </Text>
                        )}
                        <Pressable
                            accessibilityRole="button"
                            onPress={submit}
                            disabled={busy}
                            style={({ pressed }) => [
                                styles.button,
                                {
                                    backgroundColor: theme.accent,
                                    opacity: busy ? 0.85 : 1,
                                    transform: [
                                        { scale: pressed && !busy ? 0.97 : 1 },
                                    ],
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.buttonText,
                                    { color: theme.onAccent },
                                ]}
                            >
                                {busy
                                    ? "Секунду…"
                                    : mode === "signin"
                                      ? "Войти"
                                      : "Создать аккаунт"}
                            </Text>
                        </Pressable>
                    </View>

                    <Text style={[styles.footnote, { color: theme.inkMuted }]}>
                        Сфоткай тарелку, расскажи ассистенту — стол ведёт счёт.
                    </Text>
                </View>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1 },
    flex: { flex: 1 },
    wrap: {
        flex: 1,
        width: "100%",
        maxWidth: MaxContentWidth,
        alignSelf: "center",
        paddingHorizontal: Spacing.lg,
        justifyContent: "center",
        gap: Spacing.sm,
    },
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 3,
        marginTop: Spacing.md,
    },
    title: {
        fontFamily: Fonts.display,
        fontSize: 34,
        lineHeight: 43,
        marginTop: Spacing.xs,
        marginBottom: Spacing.lg,
    },
    form: { gap: Spacing.sm },
    segment: {
        flexDirection: "row",
        borderWidth: 1,
        borderRadius: Radii.xl,
        padding: Spacing.xs,
        marginBottom: Spacing.xs,
    },
    segItem: {
        flex: 1,
        alignItems: "center",
        paddingVertical: 10,
        borderRadius: Radii.xl,
    },
    segText: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    input: {
        fontFamily: Fonts.sans,
        fontSize: 16,
        borderWidth: 1,
        borderRadius: Radii.md,
        paddingHorizontal: Spacing.md,
        paddingVertical: 14,
    },
    error: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    button: {
        borderRadius: Radii.xl,
        paddingVertical: 16,
        alignItems: "center",
        marginTop: Spacing.sm,
    },
    buttonText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    footnote: {
        fontFamily: Fonts.sans,
        fontSize: 13,
        textAlign: "center",
        marginTop: Spacing.xl,
    },
});
