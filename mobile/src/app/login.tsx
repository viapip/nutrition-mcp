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

import { login, signup } from "@/lib/api";
import {
    Colors,
    Fonts,
    MaxContentWidth,
    Radii,
    Spacing,
} from "@/constants/theme";

export default function LoginScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];

    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

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

    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <KeyboardAvoidingView style={styles.flex} behavior="padding">
                <View style={styles.wrap}>
                    <Text style={[styles.eyebrow, { color: theme.inkMuted }]}>
                        NUTRITION MCP
                    </Text>
                    <Text style={[styles.title, { color: theme.ink }]}>
                        Твой стол,{"\n"}
                        <Text
                            style={[
                                styles.titleItalic,
                                { color: theme.accent },
                            ]}
                        >
                            по-честному.
                        </Text>
                    </Text>

                    <View style={styles.form}>
                        <TextInput
                            style={[
                                styles.input,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: theme.hairline,
                                    color: theme.ink,
                                },
                            ]}
                            placeholder="Почта"
                            placeholderTextColor={theme.inkMuted}
                            cursorColor={theme.accent}
                            selectionColor={theme.accent}
                            autoCapitalize="none"
                            autoComplete="email"
                            keyboardType="email-address"
                            value={email}
                            onChangeText={setEmail}
                        />
                        <TextInput
                            style={[
                                styles.input,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: theme.hairline,
                                    color: theme.ink,
                                },
                            ]}
                            placeholder="Пароль"
                            placeholderTextColor={theme.inkMuted}
                            cursorColor={theme.accent}
                            selectionColor={theme.accent}
                            secureTextEntry
                            autoComplete="password"
                            value={password}
                            onChangeText={setPassword}
                            onSubmitEditing={submit}
                        />
                        {mode === "signup" && (
                            <TextInput
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.surfaceElevated,
                                        borderColor: theme.hairline,
                                        color: theme.ink,
                                    },
                                ]}
                                placeholder="Инвайт-код (если он у тебя есть)"
                                placeholderTextColor={theme.inkMuted}
                                cursorColor={theme.accent}
                                selectionColor={theme.accent}
                                autoCapitalize="none"
                                value={code}
                                onChangeText={setCode}
                                onSubmitEditing={submit}
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
                                    opacity: pressed || busy ? 0.85 : 1,
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
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => {
                                setMode(
                                    mode === "signin" ? "signup" : "signin",
                                );
                                setError(null);
                            }}
                        >
                            <Text
                                style={[
                                    styles.switchMode,
                                    { color: theme.accent },
                                ]}
                            >
                                {mode === "signin"
                                    ? "Впервые тут? Создать аккаунт"
                                    : "Уже есть аккаунт? Войти"}
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
        gap: Spacing.md,
    },
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 12,
        letterSpacing: 2.5,
    },
    title: {
        fontFamily: Fonts.display,
        fontSize: 44,
        lineHeight: 50,
        marginBottom: Spacing.lg,
    },
    titleItalic: { fontFamily: Fonts.displayLight },
    form: { gap: Spacing.sm },
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
        borderRadius: Radii.md,
        paddingVertical: 15,
        alignItems: "center",
        marginTop: Spacing.sm,
    },
    buttonText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    switchMode: {
        fontFamily: Fonts.sansMedium,
        fontSize: 14,
        textAlign: "center",
        paddingVertical: Spacing.sm,
    },
    footnote: {
        fontFamily: Fonts.sans,
        fontSize: 13,
        textAlign: "center",
        marginTop: Spacing.xl,
    },
});
