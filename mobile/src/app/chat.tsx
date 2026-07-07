import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
    Alert,
    Animated,
    Image,
    KeyboardAvoidingView,
    Platform,
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
import { sendChat, type ChatMessage, type ChatPart } from "@/lib/api";
import { tapBuzz, successBuzz } from "@/lib/haptics";

const SUGGESTIONS = [
    "I had a bowl of oatmeal with berries",
    "Log 300 ml of water",
    "How am I doing today?",
];

function messageText(m: ChatMessage): string {
    if (typeof m.content === "string") return m.content;
    return m.content
        .filter(
            (p): p is Extract<ChatPart, { type: "text" }> => p.type === "text",
        )
        .map((p) => p.text)
        .join(" ");
}

function messageImage(m: ChatMessage): string | null {
    if (typeof m.content === "string") return null;
    const img = m.content.find(
        (p): p is Extract<ChatPart, { type: "image_url" }> =>
            p.type === "image_url",
    );
    return img?.image_url.url ?? null;
}

// Client-side caps with margin under the server's 40 messages / 16k chars,
// so a long conversation keeps working instead of tripping a 400.
const TRIM_MESSAGES = 30;
const TRIM_CHARS = 12_000;
// Server's per-image cap (data-URL length)
const MAX_IMAGE_CHARS = 1_500_000;

/**
 * Keep only the newest photo in the request payload: older images are
 * replaced with a text stub so history stays under the server's size caps
 * while the model still knows a photo was there. Oldest messages are
 * dropped once the history outgrows the client caps.
 */
function slimHistory(messages: ChatMessage[]): ChatMessage[] {
    const lastWithImage = messages.findLastIndex(
        (m) => messageImage(m) != null,
    );
    let out = messages.map((m, i) => {
        if (i === lastWithImage || typeof m.content === "string") return m;
        const text = messageText(m);
        return {
            role: m.role,
            content: messageImage(m) ? `[photo of food] ${text}`.trim() : text,
        };
    });
    const chars = (ms: ChatMessage[]) =>
        ms.reduce((n, m) => n + messageText(m).length, 0);
    while (
        out.length > 1 &&
        (out.length > TRIM_MESSAGES || chars(out) > TRIM_CHARS)
    ) {
        out = out.slice(1);
    }
    return out;
}

/** Alert.alert is a no-op on react-native-web, so fall back to window.alert. */
function notify(title: string, message: string) {
    if (Platform.OS === "web") window.alert(`${title}\n${message}`);
    else Alert.alert(title, message);
}

const CHAT_KEY = "nutrition_chat";

/** Photos are megabytes of base64 — persist text stubs, cap the length. */
function storable(messages: ChatMessage[]): ChatMessage[] {
    return messages.slice(-60).map((m) => {
        if (typeof m.content === "string") return m;
        const text = messageText(m);
        return {
            role: m.role,
            content: messageImage(m) ? `[photo of food] ${text}`.trim() : text,
        };
    });
}

/** What the typing bubble says while the assistant runs a tool. */
const TOOL_STATUS: Record<string, string> = {
    log_meal: "Logging the meal…",
    log_water: "Logging water…",
    log_weight: "Logging weight…",
    get_dashboard: "Checking your day…",
    get_day: "Looking back…",
    update_meal: "Fixing the entry…",
    delete_meal: "Removing it…",
    delete_water: "Removing it…",
    update_weight: "Fixing the entry…",
    delete_weight: "Removing it…",
    set_goals: "Updating goals…",
    lookup_barcode: "Reading the barcode…",
};

function TypingDots({ theme }: { theme: Theme }) {
    // useState, not useRef: reading a ref during render trips react-hooks/refs
    const [pulse] = useState(() => new Animated.Value(0));
    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(pulse, {
                    toValue: 1,
                    duration: 500,
                    useNativeDriver: true,
                }),
                Animated.timing(pulse, {
                    toValue: 0,
                    duration: 500,
                    useNativeDriver: true,
                }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [pulse]);

    return (
        <View style={styles.dotsRow}>
            {[0, 1, 2].map((i) => (
                <Animated.View
                    key={i}
                    style={[
                        styles.dot,
                        {
                            backgroundColor: theme.inkMuted,
                            opacity: pulse.interpolate({
                                inputRange: [0, 1],
                                outputRange: i === 1 ? [0.9, 0.3] : [0.3, 0.9],
                            }),
                        },
                    ]}
                />
            ))}
        </View>
    );
}

export default function ChatScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [hydrated, setHydrated] = useState(false);
    const [input, setInput] = useState("");
    const [pendingImage, setPendingImage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const scrollRef = useRef<ScrollView>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Restore the conversation, then mirror every change back to storage.
    useEffect(() => {
        AsyncStorage.getItem(CHAT_KEY)
            .then((raw) => {
                if (raw) setMessages(JSON.parse(raw) as ChatMessage[]);
            })
            .catch(() => {})
            .finally(() => setHydrated(true));
    }, []);
    useEffect(() => {
        if (!hydrated) return;
        void AsyncStorage.setItem(CHAT_KEY, JSON.stringify(storable(messages)));
    }, [messages, hydrated]);

    const clearChat = () => {
        abortRef.current?.abort();
        setMessages([]);
        void AsyncStorage.removeItem(CHAT_KEY);
    };

    const acceptImage = (base64: string | null | undefined) => {
        if (!base64) return;
        const dataUrl = `data:image/jpeg;base64,${base64}`;
        if (dataUrl.length > MAX_IMAGE_CHARS) {
            notify("Photo too large", "Pick a smaller photo or crop it.");
            return;
        }
        setPendingImage(dataUrl);
    };

    // Android may destroy the activity while the camera is open; recover
    // the shot on remount instead of silently losing it.
    useEffect(() => {
        if (Platform.OS !== "android") return;
        void ImagePicker.getPendingResultAsync().then((r) => {
            if (r && !("code" in r) && !r.canceled) {
                acceptImage(r.assets?.[0]?.base64);
            }
        });
    }, []);

    const pickImage = async (fromCamera: boolean) => {
        const perm = fromCamera
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const result = fromCamera
            ? await ImagePicker.launchCameraAsync({
                  mediaTypes: ["images"],
                  quality: 0.4,
                  base64: true,
              })
            : await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ["images"],
                  quality: 0.4,
                  base64: true,
              });
        if (result.canceled) return;
        acceptImage(result.assets?.[0]?.base64);
    };

    const attach = () => {
        if (Platform.OS === "web") {
            void pickImage(false);
            return;
        }
        Alert.alert("Add a photo", undefined, [
            { text: "Camera", onPress: () => void pickImage(true) },
            { text: "Photo library", onPress: () => void pickImage(false) },
            { text: "Cancel", style: "cancel" },
        ]);
    };

    const send = async (textOverride?: string) => {
        const text = (textOverride ?? input).trim();
        if ((!text && !pendingImage) || busy) return;

        const content: ChatMessage["content"] = pendingImage
            ? ([
                  { type: "image_url", image_url: { url: pendingImage } },
                  ...(text ? [{ type: "text", text } as ChatPart] : []),
              ] as ChatPart[])
            : text;
        const next = [...messages, { role: "user" as const, content }];
        tapBuzz();
        setMessages(next);
        setInput("");
        setPendingImage(null);
        setBusy(true);
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
            const reply = await sendChat(
                slimHistory(next),
                (name) => setStatus(TOOL_STATUS[name] ?? "Working…"),
                ctrl.signal,
            );
            successBuzz();
            setMessages([...next, { role: "assistant", content: reply }]);
        } catch (err) {
            // Cancelled by the user — keep their message, add nothing.
            if (!ctrl.signal.aborted) {
                setMessages([
                    ...next,
                    {
                        role: "assistant",
                        content:
                            err instanceof Error &&
                            err.message === "unauthorized"
                                ? "Session expired — log in again."
                                : err instanceof Error &&
                                    err.message === "chat_not_configured"
                                  ? "The assistant needs an API key — add yours in Settings."
                                  : "That didn't go through — try again.",
                    },
                ]);
            }
        } finally {
            abortRef.current = null;
            setBusy(false);
            setStatus(null);
        }
    };

    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            {/* edge-to-edge Android (SDK 57) no longer resizes on its own,
                so padding is needed on both platforms */}
            <KeyboardAvoidingView style={styles.flex} behavior="padding">
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
                                style={[styles.back, { color: theme.accent }]}
                            >
                                ← Today
                            </Text>
                        </Pressable>
                        <Text
                            style={[styles.headerTitle, { color: theme.ink }]}
                        >
                            Assistant
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Clear conversation"
                            onPress={clearChat}
                            hitSlop={12}
                            disabled={messages.length === 0}
                            style={styles.headerSpacer}
                        >
                            <Text
                                style={[
                                    styles.clear,
                                    {
                                        color:
                                            messages.length === 0
                                                ? "transparent"
                                                : theme.inkMuted,
                                    },
                                ]}
                            >
                                Clear
                            </Text>
                        </Pressable>
                    </View>

                    <ScrollView
                        ref={scrollRef}
                        style={styles.flex}
                        contentContainerStyle={styles.messages}
                        onContentSizeChange={() =>
                            scrollRef.current?.scrollToEnd({ animated: true })
                        }
                    >
                        {messages.length === 0 && (
                            <View style={styles.empty}>
                                <Text
                                    style={[
                                        styles.emptyTitle,
                                        { color: theme.ink },
                                    ]}
                                >
                                    Tell me{"\n"}
                                    <Text
                                        style={[
                                            styles.emptyItalic,
                                            { color: theme.accent },
                                        ]}
                                    >
                                        what you ate.
                                    </Text>
                                </Text>
                                <Text
                                    style={[
                                        styles.emptyHint,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    {
                                        "Type it, or snap a photo of the plate — I'll estimate and log it."
                                    }
                                </Text>
                                <View style={styles.chips}>
                                    {SUGGESTIONS.map((s) => (
                                        <Pressable
                                            key={s}
                                            accessibilityRole="button"
                                            onPress={() => void send(s)}
                                            style={[
                                                styles.chip,
                                                {
                                                    backgroundColor:
                                                        theme.surfaceElevated,
                                                    borderColor: theme.hairline,
                                                },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.chipText,
                                                    {
                                                        color: theme.inkSecondary,
                                                    },
                                                ]}
                                            >
                                                {s}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </View>
                            </View>
                        )}

                        {messages.map((m, i) => {
                            const mine = m.role === "user";
                            const image = messageImage(m);
                            const text = messageText(m);
                            return (
                                <View
                                    key={i}
                                    style={[
                                        styles.bubble,
                                        mine
                                            ? [
                                                  styles.bubbleMine,
                                                  {
                                                      backgroundColor:
                                                          theme.accent,
                                                  },
                                              ]
                                            : [
                                                  styles.bubbleTheirs,
                                                  {
                                                      backgroundColor:
                                                          theme.surfaceElevated,
                                                      borderColor:
                                                          theme.hairline,
                                                  },
                                              ],
                                    ]}
                                >
                                    {image && (
                                        <Image
                                            source={{ uri: image }}
                                            style={styles.bubbleImage}
                                        />
                                    )}
                                    {!!text && (
                                        <Text
                                            style={[
                                                styles.bubbleText,
                                                {
                                                    color: mine
                                                        ? theme.onAccent
                                                        : theme.ink,
                                                },
                                            ]}
                                        >
                                            {text}
                                        </Text>
                                    )}
                                </View>
                            );
                        })}

                        {busy && (
                            <View
                                style={[
                                    styles.bubble,
                                    styles.bubbleTheirs,
                                    {
                                        backgroundColor: theme.surfaceElevated,
                                        borderColor: theme.hairline,
                                    },
                                ]}
                            >
                                <View style={styles.statusRow}>
                                    <TypingDots theme={theme} />
                                    {status && (
                                        <Text
                                            style={[
                                                styles.statusText,
                                                { color: theme.inkSecondary },
                                            ]}
                                        >
                                            {status}
                                        </Text>
                                    )}
                                </View>
                            </View>
                        )}
                    </ScrollView>

                    {/* Pending photo preview */}
                    {pendingImage && (
                        <View style={styles.preview}>
                            <Image
                                source={{ uri: pendingImage }}
                                style={[
                                    styles.previewImage,
                                    { borderColor: theme.hairline },
                                ]}
                            />
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Remove photo"
                                onPress={() => setPendingImage(null)}
                                style={[
                                    styles.previewRemove,
                                    { backgroundColor: theme.ink },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.previewRemoveText,
                                        { color: theme.surface },
                                    ]}
                                >
                                    ×
                                </Text>
                            </Pressable>
                        </View>
                    )}

                    {/* Input bar */}
                    <View
                        style={[
                            styles.inputBar,
                            { borderTopColor: theme.hairline },
                        ]}
                    >
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Attach a photo"
                            onPress={attach}
                            style={[
                                styles.attach,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: theme.hairline,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.attachIcon,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                ✚
                            </Text>
                        </Pressable>
                        <TextInput
                            style={[
                                styles.input,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: theme.hairline,
                                    color: theme.ink,
                                },
                            ]}
                            placeholder="A plate, a snack, a weigh-in…"
                            placeholderTextColor={theme.inkMuted}
                            value={input}
                            onChangeText={setInput}
                            onSubmitEditing={() => void send()}
                            multiline
                        />
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={
                                busy ? "Stop generating" : "Send"
                            }
                            onPress={() =>
                                busy ? abortRef.current?.abort() : void send()
                            }
                            disabled={!busy && !input.trim() && !pendingImage}
                            style={({ pressed }) => [
                                styles.send,
                                {
                                    backgroundColor: busy
                                        ? theme.ink
                                        : theme.accent,
                                    opacity:
                                        pressed ||
                                        (!busy &&
                                            !input.trim() &&
                                            !pendingImage)
                                            ? 0.5
                                            : 1,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.sendIcon,
                                    {
                                        color: busy
                                            ? theme.surface
                                            : theme.onAccent,
                                    },
                                ]}
                            >
                                {busy ? "◼" : "↑"}
                            </Text>
                        </Pressable>
                    </View>
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
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: Spacing.lg,
        paddingVertical: Spacing.sm,
    },
    back: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    headerTitle: { fontFamily: Fonts.display, fontSize: 20 },
    headerSpacer: { width: 56, alignItems: "flex-end" },
    clear: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
    statusText: { fontFamily: Fonts.sans, fontSize: 13 },
    messages: {
        paddingHorizontal: Spacing.lg,
        paddingVertical: Spacing.md,
        gap: Spacing.sm,
    },
    empty: { paddingTop: Spacing.xxl, gap: Spacing.md },
    emptyTitle: {
        fontFamily: Fonts.display,
        fontSize: 36,
        lineHeight: 42,
    },
    emptyItalic: { fontFamily: Fonts.displayLight },
    emptyHint: { fontFamily: Fonts.sans, fontSize: 14, lineHeight: 20 },
    chips: { gap: Spacing.sm, marginTop: Spacing.sm },
    chip: {
        borderWidth: 1,
        borderRadius: Radii.lg,
        paddingHorizontal: Spacing.md,
        paddingVertical: 10,
        alignSelf: "flex-start",
    },
    chipText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    bubble: {
        maxWidth: "85%",
        borderRadius: Radii.lg,
        padding: Spacing.md,
        gap: Spacing.sm,
    },
    bubbleMine: { alignSelf: "flex-end", borderBottomRightRadius: Radii.sm },
    bubbleTheirs: {
        alignSelf: "flex-start",
        borderWidth: 1,
        borderBottomLeftRadius: Radii.sm,
    },
    bubbleText: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 21 },
    bubbleImage: {
        width: 200,
        height: 200,
        borderRadius: Radii.md,
    },
    dotsRow: { flexDirection: "row", gap: 5, paddingVertical: 4 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    preview: {
        paddingHorizontal: Spacing.lg,
        paddingBottom: Spacing.sm,
        alignSelf: "flex-start",
    },
    previewImage: {
        width: 72,
        height: 72,
        borderRadius: Radii.md,
        borderWidth: 1,
    },
    previewRemove: {
        position: "absolute",
        top: -6,
        right: Spacing.lg - 6,
        width: 22,
        height: 22,
        borderRadius: 11,
        alignItems: "center",
        justifyContent: "center",
    },
    previewRemoveText: { fontSize: 14, lineHeight: 16 },
    inputBar: {
        flexDirection: "row",
        alignItems: "flex-end",
        gap: Spacing.sm,
        borderTopWidth: 1,
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.sm,
        paddingBottom: Spacing.sm,
    },
    attach: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderWidth: 1,
        alignItems: "center",
        justifyContent: "center",
    },
    attachIcon: { fontSize: 18 },
    input: {
        flex: 1,
        fontFamily: Fonts.sans,
        fontSize: 15,
        borderWidth: 1,
        borderRadius: Radii.lg,
        paddingHorizontal: Spacing.md,
        paddingVertical: 11,
        maxHeight: 120,
    },
    send: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
    },
    sendIcon: { fontFamily: Fonts.sansSemiBold, fontSize: 20 },
});
