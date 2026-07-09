import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
    getSettings,
    sendChat,
    type ChatMessage,
    type ChatPart,
} from "@/lib/api";
import { tapBuzz, successBuzz } from "@/lib/haptics";

const SUGGESTIONS = [
    "Овсянка с ягодами на завтрак",
    "Запиши 300 мл воды",
    "Как у меня дела сегодня?",
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

/**
 * Photos live on disk as file:// URIs (light enough to persist and restore),
 * but the server needs data URLs. Inline the surviving photo right before
 * sending; a missing file degrades to the usual text stub.
 */
async function toPayload(messages: ChatMessage[]): Promise<ChatMessage[]> {
    return Promise.all(
        messages.map(async (m) => {
            const image = messageImage(m);
            if (!image || !image.startsWith("file://")) return m;
            try {
                const base64 = await FileSystem.readAsStringAsync(image, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                return {
                    role: m.role,
                    content: (m.content as ChatPart[]).map((p) =>
                        p.type === "image_url"
                            ? {
                                  type: "image_url" as const,
                                  image_url: {
                                      url: `data:image/jpeg;base64,${base64}`,
                                  },
                              }
                            : p,
                    ),
                };
            } catch {
                return {
                    role: m.role,
                    content: `[photo of food] ${messageText(m)}`.trim(),
                };
            }
        }),
    );
}

/**
 * Reap photo files no message references anymore (history is capped at 60
 * entries, and a picked-but-never-sent photo leaks its file). Only files
 * older than an hour are touched — the timestamp lives in the filename —
 * so anything written this session (including a camera shot recovered
 * after Android killed the activity) is never swept out from under us.
 */
async function sweepOrphanPhotos(referenced: ChatMessage[]): Promise<void> {
    const dir = FileSystem.documentDirectory;
    if (Platform.OS === "web" || !dir) return;
    const keep = new Set(
        referenced
            .map((m) => messageImage(m))
            .filter((u): u is string => !!u?.startsWith("file://"))
            .map((u) => u.slice(u.lastIndexOf("/") + 1)),
    );
    const hourAgo = Date.now() - 3_600_000;
    try {
        const names = await FileSystem.readDirectoryAsync(dir);
        await Promise.all(
            names
                .filter((n) => {
                    const stamp = /^chat-(\d+)\.jpg$/.exec(n)?.[1];
                    return stamp && !keep.has(n) && Number(stamp) < hourAgo;
                })
                .map((n) =>
                    FileSystem.deleteAsync(`${dir}${n}`, {
                        idempotent: true,
                    }),
                ),
        );
    } catch {
        // best-effort housekeeping; next mount retries
    }
}

/** Alert.alert is a no-op on react-native-web, so fall back to window.alert. */
function notify(title: string, message: string) {
    if (Platform.OS === "web") window.alert(`${title}\n${message}`);
    else Alert.alert(title, message);
}

const CHAT_KEY = "nutrition_chat";

/**
 * file:// photo refs are tiny and persist as-is (so old chats keep their
 * pictures); raw data URLs (web) are megabytes — those become text stubs.
 */
function storable(messages: ChatMessage[]): ChatMessage[] {
    return messages.slice(-60).map((m) => {
        if (typeof m.content === "string") return m;
        const image = messageImage(m);
        if (image?.startsWith("file://")) return m;
        const text = messageText(m);
        return {
            role: m.role,
            content: image ? `[photo of food] ${text}`.trim() : text,
        };
    });
}

/** What the typing bubble says while the assistant runs a tool. */
const TOOL_STATUS: Record<string, string> = {
    log_meal: "Записываю еду…",
    log_water: "Записываю воду…",
    log_weight: "Записываю вес…",
    get_dashboard: "Смотрю твой день…",
    get_day: "Заглядываю в прошлое…",
    update_meal: "Правлю запись…",
    delete_meal: "Убираю…",
    delete_water: "Убираю…",
    update_weight: "Правлю запись…",
    delete_weight: "Убираю…",
    set_goals: "Обновляю цели…",
    lookup_barcode: "Читаю штрихкод…",
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
    const [needsKey, setNeedsKey] = useState(false);
    const scrollRef = useRef<ScrollView>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Surface "assistant is off" before the first send, not after it fails.
    // On focus, not mount: the banner leads to settings and must clear on
    // the way back once a key is saved.
    useFocusEffect(
        useCallback(() => {
            getSettings()
                .then((s) => setNeedsKey(!s.chat_available && !s.has_llm_key))
                .catch(() => {});
        }, []),
    );

    // Restore the conversation, then mirror every change back to storage.
    useEffect(() => {
        AsyncStorage.getItem(CHAT_KEY)
            .then((raw) => {
                const restored = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
                if (restored.length) {
                    // The user may have typed before hydration finished —
                    // never clobber a live conversation with the stored one.
                    setMessages((cur) => (cur.length ? cur : restored));
                }
                void sweepOrphanPhotos(restored);
            })
            .catch(() => {})
            .finally(() => setHydrated(true));
    }, []);
    useEffect(() => {
        if (!hydrated) return;
        void AsyncStorage.setItem(CHAT_KEY, JSON.stringify(storable(messages)));
    }, [messages, hydrated]);

    const wipeChat = () => {
        abortRef.current?.abort();
        setMessages([]);
        // The pending photo's file is about to be swept with the rest.
        setPendingImage(null);
        void AsyncStorage.removeItem(CHAT_KEY);
        // Sweep the photos that belonged to the wiped history.
        if (Platform.OS !== "web" && FileSystem.documentDirectory) {
            const dir = FileSystem.documentDirectory;
            void FileSystem.readDirectoryAsync(dir)
                .then((names) =>
                    Promise.all(
                        names
                            .filter((n) => n.startsWith("chat-"))
                            .map((n) =>
                                FileSystem.deleteAsync(`${dir}${n}`, {
                                    idempotent: true,
                                }),
                            ),
                    ),
                )
                .catch(() => {});
        }
    };

    const clearChat = () => {
        if (Platform.OS === "web") {
            if (window.confirm("Стереть всю переписку?")) wipeChat();
            return;
        }
        Alert.alert("Стереть переписку?", "История и фото удалятся.", [
            { text: "Отмена", style: "cancel" },
            { text: "Стереть", style: "destructive", onPress: wipeChat },
        ]);
    };

    // Downscale + recompress every photo before it enters the pipeline:
    // the LLM doesn't need more than ~1280px, and disk/traffic shrink ~10x.
    const acceptImage = async (
        asset: { uri: string; width?: number } | undefined,
    ) => {
        if (!asset) return;
        let base64: string | undefined;
        try {
            const shrunk = await ImageManipulator.manipulateAsync(
                asset.uri,
                asset.width && asset.width > 1280
                    ? [{ resize: { width: 1280 } }]
                    : [],
                {
                    compress: 0.6,
                    format: ImageManipulator.SaveFormat.JPEG,
                    base64: true,
                },
            );
            base64 = shrunk.base64 ?? undefined;
        } catch {
            // manipulation can fail on exotic sources — send as-is below
        }
        if (!base64) return;
        if (base64.length + 30 > MAX_IMAGE_CHARS) {
            notify("Фото слишком большое", "Выбери поменьше или обрежь.");
            return;
        }
        if (Platform.OS === "web" || !FileSystem.documentDirectory) {
            setPendingImage(`data:image/jpeg;base64,${base64}`);
            return;
        }
        // To disk: the message then carries a tiny file:// ref that survives
        // restarts (photos used to vanish from restored chats).
        const uri = `${FileSystem.documentDirectory}chat-${Date.now()}.jpg`;
        try {
            await FileSystem.writeAsStringAsync(uri, base64, {
                encoding: FileSystem.EncodingType.Base64,
            });
            setPendingImage(uri);
        } catch {
            setPendingImage(`data:image/jpeg;base64,${base64}`);
        }
    };

    // Android may destroy the activity while the camera is open; recover
    // the shot on remount instead of silently losing it.
    useEffect(() => {
        if (Platform.OS !== "android") return;
        void ImagePicker.getPendingResultAsync().then((r) => {
            if (r && !("code" in r) && !r.canceled) {
                void acceptImage(r.assets?.[0]);
            }
        });
    }, []);

    const pickImage = async (fromCamera: boolean) => {
        const perm = fromCamera
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const result = fromCamera
            ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"] })
            : await ImagePicker.launchImageLibraryAsync({
                  mediaTypes: ["images"],
              });
        if (result.canceled) return;
        await acceptImage(result.assets?.[0]);
    };

    const attach = () => {
        if (Platform.OS === "web") {
            void pickImage(false);
            return;
        }
        Alert.alert("Добавить фото", undefined, [
            { text: "Камера", onPress: () => void pickImage(true) },
            { text: "Галерея", onPress: () => void pickImage(false) },
            { text: "Отмена", style: "cancel" },
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
                await toPayload(slimHistory(next)),
                (name) => setStatus(TOOL_STATUS[name] ?? "Думаю…"),
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
                                ? "Сессия истекла — войди заново."
                                : err instanceof Error &&
                                    err.message === "chat_not_configured"
                                  ? "Ассистенту нужен API-ключ — добавь свой в настройках."
                                  : "Не получилось — попробуй ещё раз.",
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
                            accessibilityLabel="Назад к дашборду"
                            onPress={() => router.back()}
                            hitSlop={12}
                        >
                            <Text
                                style={[styles.back, { color: theme.accent }]}
                            >
                                ← Сегодня
                            </Text>
                        </Pressable>
                        <Text
                            style={[styles.headerTitle, { color: theme.ink }]}
                        >
                            Ассистент
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Очистить переписку"
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
                                Очистить
                            </Text>
                        </Pressable>
                    </View>

                    {needsKey && (
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => router.push("/settings")}
                            style={[
                                styles.keyBanner,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: theme.danger,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.keyBannerText,
                                    { color: theme.ink },
                                ]}
                            >
                                Ассистент выключен — нужен API-ключ.{" "}
                                <Text style={{ color: theme.accent }}>
                                    Добавить в настройках →
                                </Text>
                            </Text>
                        </Pressable>
                    )}

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
                                    Расскажи,{"\n"}
                                    <Text
                                        style={[
                                            styles.emptyItalic,
                                            { color: theme.accent },
                                        ]}
                                    >
                                        что на тарелке.
                                    </Text>
                                </Text>
                                <Text
                                    style={[
                                        styles.emptyHint,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    {
                                        "Напиши текстом или сфоткай тарелку — я прикину и запишу."
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
                                accessibilityLabel="Убрать фото"
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
                            accessibilityLabel="Прикрепить фото"
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
                            placeholder="Тарелка, перекус, взвешивание…"
                            placeholderTextColor={theme.inkMuted}
                            cursorColor={theme.accent}
                            selectionColor={theme.accent}
                            value={input}
                            onChangeText={setInput}
                            onSubmitEditing={() => void send()}
                            multiline
                        />
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={
                                busy ? "Остановить" : "Отправить"
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
    keyBanner: {
        marginHorizontal: Spacing.lg,
        marginBottom: Spacing.sm,
        borderWidth: 1,
        borderRadius: Radii.md,
        padding: Spacing.md,
    },
    keyBannerText: {
        fontFamily: Fonts.sansMedium,
        fontSize: 13,
        lineHeight: 18,
    },
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
