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
                    backgroundColor: theme.surfaceElevated,
                    borderColor: hasKey ? theme.accent : theme.hairline,
                },
            ]}
        >
            <View
                style={[
                    styles.statusDot,
                    {
                        backgroundColor: hasKey ? theme.accent : theme.inkMuted,
                    },
                ]}
            />
            <View style={styles.statusText}>
                <Text style={[styles.statusTitle, { color: theme.ink }]}>
                    {hasKey ? "Your own key" : "Shared key"}
                </Text>
                <Text style={[styles.statusHint, { color: theme.inkMuted }]}>
                    {hasKey
                        ? "Assistant requests are billed to your provider account."
                        : "You're on the server's key — fine to use, shared limits apply."}
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

    useEffect(() => {
        getSettings()
            .then((s) => {
                setHasKey(s.has_llm_key);
                setChatAvailable(s.chat_available);
            })
            .catch(() => setHasKey(false));
    }, []);

    const save = async (value: string | null) => {
        if (busy) return;
        setBusy(true);
        setNote(null);
        try {
            await saveLlmKey(value);
            setHasKey(!!value);
            if (value) setChatAvailable(true);
            setKey("");
            setNote(value ? "Key saved." : "Key removed.");
            successBuzz();
        } catch {
            setNote("Couldn't save — check the key and try again.");
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
                                accessibilityLabel="Back to dashboard"
                                onPress={() => router.back()}
                                hitSlop={12}
                            >
                                <Text
                                    style={[
                                        styles.back,
                                        { color: theme.accent },
                                    ]}
                                >
                                    ← Today
                                </Text>
                            </Pressable>
                        </View>

                        {/* Hero */}
                        <Text style={[styles.hero, { color: theme.ink }]}>
                            Your kitchen,{"\n"}
                            <Text
                                style={[
                                    styles.heroItalic,
                                    { color: theme.accent },
                                ]}
                            >
                                your key.
                            </Text>
                        </Text>
                        <Text
                            style={[styles.heroHint, { color: theme.inkMuted }]}
                        >
                            The assistant talks to an LLM provider on every
                            message. Bring your own API key to pay for exactly
                            what you use.
                        </Text>

                        {hasKey != null && (
                            <KeyStatus
                                hasKey={hasKey && chatAvailable}
                                theme={theme}
                            />
                        )}
                        {!chatAvailable && !hasKey && (
                            <Text
                                style={[
                                    styles.heroHint,
                                    { color: theme.danger },
                                ]}
                            >
                                No server key is configured — the assistant is
                                off until you add a key.
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
                                {hasKey ? "Replace key" : "API key"}
                            </Text>
                            <TextInput
                                style={[
                                    styles.input,
                                    {
                                        backgroundColor: theme.surfaceElevated,
                                        borderColor: theme.hairline,
                                        color: theme.ink,
                                    },
                                ]}
                                placeholder="sk-…"
                                placeholderTextColor={theme.inkMuted}
                                value={key}
                                onChangeText={(v) => {
                                    setKey(v);
                                    setNote(null);
                                }}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                            />
                            <Text
                                style={[
                                    styles.fieldHint,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                Stored on your server, never shown again.
                                Moonshot keys work out of the box; any
                                OpenAI-compatible provider the server points at
                                will too.
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => void save(key.trim())}
                                disabled={busy || !key.trim()}
                                style={({ pressed }) => [
                                    styles.saveBtn,
                                    {
                                        backgroundColor: theme.accent,
                                        opacity:
                                            pressed || busy || !key.trim()
                                                ? 0.5
                                                : 1,
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.saveText,
                                        { color: theme.onAccent },
                                    ]}
                                >
                                    {busy ? "Saving…" : "Save key"}
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
                                        Remove my key
                                    </Text>
                                </Pressable>
                            )}
                            {note && (
                                <Text
                                    style={[
                                        styles.note,
                                        {
                                            color: note.startsWith("Couldn't")
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
                            onPress={async () => {
                                await logout();
                                router.replace("/login");
                            }}
                            hitSlop={8}
                        >
                            <Text
                                style={[
                                    styles.logout,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                Log out
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
    hero: {
        fontFamily: Fonts.display,
        fontSize: 36,
        lineHeight: 42,
        marginTop: Spacing.lg,
    },
    heroItalic: { fontFamily: Fonts.displayLight },
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
    statusDot: { width: 10, height: 10, borderRadius: 5 },
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
        borderRadius: Radii.lg,
        paddingVertical: 14,
        alignItems: "center",
        marginTop: Spacing.sm,
    },
    saveText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    removeBtn: { alignSelf: "center", paddingVertical: Spacing.sm },
    removeText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    note: { fontFamily: Fonts.sansMedium, fontSize: 14, textAlign: "center" },
    divider: { height: 1, marginVertical: Spacing.xl },
    logout: { fontFamily: Fonts.sansMedium, fontSize: 15 },
});
