import { router } from "expo-router";
import { useState } from "react";
import {
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { login } from "@/lib/api";
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

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (!email || !password || busy) return;
        setBusy(true);
        setError(null);
        try {
            await login(email.trim(), password);
            router.replace("/");
        } catch {
            setError("Wrong email or password. Try again.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <KeyboardAvoidingView
                style={styles.flex}
                behavior={Platform.OS === "ios" ? "padding" : undefined}
            >
                <View style={styles.wrap}>
                    <Text style={[styles.eyebrow, { color: theme.inkMuted }]}>
                        NUTRITION MCP
                    </Text>
                    <Text style={[styles.title, { color: theme.ink }]}>
                        Your table,{"\n"}
                        <Text
                            style={[
                                styles.titleItalic,
                                { color: theme.accent },
                            ]}
                        >
                            kept honest.
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
                            placeholder="Email"
                            placeholderTextColor={theme.inkMuted}
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
                            placeholder="Password"
                            placeholderTextColor={theme.inkMuted}
                            secureTextEntry
                            autoComplete="password"
                            value={password}
                            onChangeText={setPassword}
                            onSubmitEditing={submit}
                        />
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
                                {busy ? "Signing in…" : "Sign in"}
                            </Text>
                        </Pressable>
                    </View>

                    <Text style={[styles.footnote, { color: theme.inkMuted }]}>
                        Log meals by talking to Claude — this app is your
                        mirror.
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
    footnote: {
        fontFamily: Fonts.sans,
        fontSize: 13,
        textAlign: "center",
        marginTop: Spacing.xl,
    },
});
