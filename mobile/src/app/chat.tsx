import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Alert,
    Animated,
    Image,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
    type NativeSyntheticEvent,
    type TextInputKeyPressEventData,
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
    addMeal,
    getSettings,
    isUnauthorized,
    newIdempotencyKey,
    sendChat,
    type ChatMessage,
    type ChatPart,
    type MealFields,
} from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { tapBuzz, successBuzz } from "@/lib/haptics";

/** Карточка «записать?» из propose_meal; resolved и idem живут только на
 * девайсе — idem даёт серверу дедупнуть повторный тап «Записать». */
type Proposal = MealFields & {
    resolved?: "saved" | "declined";
    idem?: string;
};

// В запрос уходят голые {role, content}; at/failed/proposals/turnKey — локальные.
// turnKey переживает перезапуск → retry дедупится сервером и после ремоунта.
type Msg = ChatMessage & {
    at?: number;
    failed?: boolean;
    proposals?: Proposal[];
    turnKey?: string;
};

/** Подсказки под час: утром — про завтрак, вечером — про итоги.
 * `send` уходит сразу, `prefill` лишь заполняет поле — блюдо надо дописать. */
type Suggestion = {
    label: string;
    send?: string;
    prefill?: string;
    camera?: boolean;
    barcode?: boolean;
};
function suggestions(): Suggestion[] {
    const h = new Date().getHours();
    const meal =
        h < 11
            ? { label: "Записать завтрак…", prefill: "На завтрак " }
            : h < 16
              ? { label: "Записать обед…", prefill: "На обед " }
              : { label: "Записать ужин…", prefill: "На ужин " }; // и ночью
    return [
        { label: "Сфоткать тарелку", camera: true },
        { label: "Сканировать штрихкод", barcode: true },
        meal,
        { label: "+300 мл воды", send: "Запиши 300 мл воды" },
        h >= 18
            ? { label: "Итог дня", send: "Как прошёл мой день?" }
            : { label: "Как дела?", send: "Как у меня дела сегодня?" },
    ];
}

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

/** Судьбу карточек модель узнаёт из текста: сами proposals в запрос не уходят. */
function proposalNote(m: Msg): string {
    if (!m.proposals?.length) return "";
    return m.proposals
        .map(
            (p) =>
                `\n[card "${p.description}": ${
                    p.resolved === "saved"
                        ? "user confirmed — saved"
                        : p.resolved === "declined"
                          ? "user declined — not saved"
                          : "no answer — not saved"
                }]`,
        )
        .join("");
}

/** В payload остаётся только новейшее фото (старые → текстовая заглушка),
 * история режется под капы сервера; at/failed не покидают устройство. */
function slimHistory(messages: Msg[]): ChatMessage[] {
    const live = messages.filter((m) => !m.failed);
    const lastWithImage = live.findLastIndex((m) => messageImage(m) != null);
    let out = live.map((m, i): ChatMessage => {
        if (typeof m.content === "string") {
            return { role: m.role, content: m.content + proposalNote(m) };
        }
        if (i === lastWithImage) {
            return { role: m.role, content: m.content };
        }
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

/** На диске file://, серверу нужен data URL — инлайним перед отправкой;
 * пропавший файл → заглушка. */
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

/** Чистка фото без ссылок из истории. Только старше часа (метка в имени) —
 * свежий кадр, в т.ч. восстановленный после kill активности, не выметаем. */
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

/** file:// реф лёгкий — храним как есть; data URL (web) весит мегабайты → заглушка. */
function storable(messages: Msg[]): Msg[] {
    return messages.slice(-60).map((m) => {
        if (typeof m.content === "string") return m;
        const image = messageImage(m);
        if (image?.startsWith("file://")) return m;
        const text = messageText(m);
        return {
            ...m,
            content: image ? `[photo of food] ${text}`.trim() : text,
        };
    });
}

const DRAFT_KEY = "nutrition_chat_draft";

/** Сообщение с локальным таймстемпом (вне компонента — правило purity). */
function stamped(
    role: Msg["role"],
    content: Msg["content"],
    failed?: boolean,
): Msg {
    return failed
        ? { role, content, at: Date.now(), failed }
        : { role, content, at: Date.now() };
}

/** «Сегодня», «Вчера», иначе «5 июля» — для разделителей в ленте. */
function dayLabel(at: number): string {
    const d = new Date(at);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return "Сегодня";
    if (d.toDateString() === yesterday.toDateString()) return "Вчера";
    return d.toLocaleDateString("ru-RU", { month: "long", day: "numeric" });
}

/** What the typing bubble says while the assistant runs a tool. */
const TOOL_STATUS: Record<string, string> = {
    propose_meal: "Готовлю карточку…",
    log_meal: "Записываю еду…",
    list_dishes: "Смотрю твои блюда…",
    save_dish: "Запоминаю блюдо…",
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

const MEAL_TYPE_RU: Record<string, string> = {
    breakfast: "Завтрак",
    lunch: "Обед",
    dinner: "Ужин",
    snack: "Перекус",
};

function macroLine(p: MealFields): string {
    const parts: string[] = [];
    if (p.protein_g != null) parts.push(`Б ${p.protein_g}`);
    if (p.fat_g != null) parts.push(`Ж ${p.fat_g}`);
    if (p.carbs_g != null) parts.push(`У ${p.carbs_g}`);
    return parts.join("  ·  ");
}

/** Карточка подтверждения: «Записать» пишет напрямую через REST (без второго
 * прогона LLM); кнопки только на последнем сообщении — старые карточки не пишутся. */
function ProposalCard({
    p,
    theme,
    active,
    saving,
    onResolve,
}: {
    p: Proposal;
    theme: Theme;
    active: boolean;
    saving: boolean;
    onResolve: (save: boolean) => void;
}) {
    const macros = macroLine(p);
    return (
        <View style={[styles.card, { backgroundColor: theme.surfaceElevated }]}>
            <View style={styles.cardHead}>
                <Text style={[styles.cardType, { color: theme.inkMuted }]}>
                    {(MEAL_TYPE_RU[p.meal_type] ?? p.meal_type).toUpperCase()}
                </Text>
                {p.calories != null && (
                    <Text style={[styles.cardKcal, { color: theme.accent }]}>
                        ≈ {p.calories} ккал
                    </Text>
                )}
            </View>
            <Text style={[styles.cardDesc, { color: theme.ink }]}>
                {p.description}
            </Text>
            {!!macros && (
                <Text
                    style={[styles.cardMacros, { color: theme.inkSecondary }]}
                >
                    {macros}
                </Text>
            )}
            {p.resolved === "saved" ? (
                <Text style={[styles.cardStatus, { color: theme.accent }]}>
                    ✓ В дневнике
                </Text>
            ) : p.resolved === "declined" ? (
                <Text style={[styles.cardStatus, { color: theme.inkMuted }]}>
                    Отменено
                </Text>
            ) : active ? (
                <View style={styles.cardButtons}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Записать: ${p.description}`}
                        disabled={saving}
                        onPress={() => onResolve(true)}
                        style={({ pressed }) => [
                            styles.cardYes,
                            {
                                backgroundColor: theme.accent,
                                opacity: pressed || saving ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                styles.cardYesText,
                                { color: theme.onAccent },
                            ]}
                        >
                            {saving ? "Записываю…" : "Записать"}
                        </Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Не записывать"
                        disabled={saving}
                        onPress={() => onResolve(false)}
                        style={({ pressed }) => [
                            styles.cardNo,
                            {
                                borderColor: theme.hairline,
                                opacity: pressed ? 0.6 : 1,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                styles.cardNoText,
                                { color: theme.inkSecondary },
                            ]}
                        >
                            Не надо
                        </Text>
                    </Pressable>
                </View>
            ) : (
                <Text style={[styles.cardStatus, { color: theme.inkMuted }]}>
                    Не записано
                </Text>
            )}
        </View>
    );
}

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
    const { guard, onError } = useRequireAuth();
    // Deep-link из виджета/quick actions: "camera" — сразу открыть съёмку,
    // "text" — сфокусировать поле ввода.
    const { compose } = useLocalSearchParams<{ compose?: string }>();

    const [messages, setMessages] = useState<Msg[]>([]);
    const [hydrated, setHydrated] = useState(false);
    const [input, setInput] = useState("");
    const [pendingImage, setPendingImage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    // Текст финального ответа, растущий по токенам, пока ход идёт.
    const [streamText, setStreamText] = useState("");
    const [needsKey, setNeedsKey] = useState(false);
    // Purely visual: paints the input border accent while focused.
    const [inputFocused, setInputFocused] = useState(false);
    // Кнопка «вниз» — когда юзер листает историю и лента уехала.
    const [showJump, setShowJump] = useState(false);
    // «Скопировано» — мимолётная плашка после долгого тапа по пузырю.
    const [copied, setCopied] = useState(false);
    const [viewerUri, setViewerUri] = useState<string | null>(null);
    const [scanning, setScanning] = useState(false);
    // «Нужен доступ к камере» — когда сканер штрихкода не получил разрешение.
    const [scanNote, setScanNote] = useState<string | null>(null);
    const [permission, requestPermission] = useCameraPermissions();
    const atBottom = useRef(true);
    const pendingClaimed = useRef(false);
    const inputRef = useRef<TextInput>(null);
    const scrollRef = useRef<ScrollView>(null);
    const abortRef = useRef<AbortController | null>(null);
    const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // onBarcodeScanned сыплет колбэками по кадрам — ref гасит все после первого.
    const scannedRef = useRef(false);
    const scanNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // «Ассистент выключен» — до первой отправки; на focus, чтобы баннер гас
    // после сохранения ключа в настройках
    useFocusEffect(
        useCallback(() => {
            // Виджет может открыть чат до логина — гейтим по токену, как дашборд.
            guard(() => {
                getSettings()
                    .then((s) =>
                        setNeedsKey(!s.chat_available && !s.has_llm_key),
                    )
                    .catch(() => {});
            });
        }, [guard]),
    );

    // Restore the conversation, then mirror every change back to storage.
    useEffect(() => {
        AsyncStorage.getItem(CHAT_KEY)
            .then((raw) => {
                let restored: Msg[] = [];
                if (raw) {
                    try {
                        restored = JSON.parse(raw) as Msg[];
                    } catch {
                        // Битый JSON не восстановить — стираем и включаем
                        // зеркало заново, иначе новые сообщения не сохранятся.
                        void AsyncStorage.removeItem(CHAT_KEY);
                    }
                }
                if (restored.length) {
                    // The user may have typed before hydration finished —
                    // never clobber a live conversation with the stored one.
                    setMessages((cur) => (cur.length ? cur : restored));
                }
                void sweepOrphanPhotos(restored);
                // Зеркало — только после успешного чтения: иначе сбой самого
                // AsyncStorage затёр бы сохранённую историю пустым массивом
                setHydrated(true);
            })
            .catch(() => {});
        // Недописанное сообщение переживает перезапуск приложения.
        AsyncStorage.getItem(DRAFT_KEY)
            .then((d) => {
                if (d) setInput((cur) => cur || d);
            })
            .catch(() => {});
    }, []);
    useEffect(() => {
        if (!hydrated) return;
        void AsyncStorage.setItem(CHAT_KEY, JSON.stringify(storable(messages)));
    }, [messages, hydrated]);
    // Черновик пишется с паузой, чтобы не дёргать сторадж на каждый символ.
    useEffect(() => {
        const t = setTimeout(() => {
            void (input
                ? AsyncStorage.setItem(DRAFT_KEY, input)
                : AsyncStorage.removeItem(DRAFT_KEY));
        }, 400);
        return () => clearTimeout(t);
    }, [input]);

    const wipeChat = () => {
        abortRef.current?.abort();
        setMessages([]);
        setShowJump(false);
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
            // manipulation can fail on exotic sources — сообщаем ниже
        }
        if (!base64) {
            // Фото не обработалось — не роняем молча, говорим пользователю.
            notify("Не вышло обработать фото", "Попробуй другой снимок.");
            return;
        }
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

    // Android may destroy the activity while the camera is open; recover the
    // shot on remount. Оба пути (remount-восстановление и compose=camera)
    // претендуют на pending — claim'им его максимум один раз.
    const claimPendingShot = async () => {
        if (Platform.OS !== "android" || pendingClaimed.current) return null;
        pendingClaimed.current = true;
        const r = await ImagePicker.getPendingResultAsync();
        return r && !("code" in r) && !r.canceled ? r : null;
    };

    useEffect(() => {
        if (compose === "camera") return;
        void claimPendingShot().then((r) => {
            if (r) void acceptImage(r.assets?.[0]);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- один раз на маунт
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

    // compose=camera на маунте: если Activity убили с открытой камерой, кадр
    // ждёт в pending — забираем его вместо повторного запуска съёмки.
    const openCameraOrRecover = async () => {
        const pending = await claimPendingShot();
        if (pending) {
            await acceptImage(pending.assets?.[0]);
            return;
        }
        await pickImage(Platform.OS !== "web");
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

    // Штрихкод — отдельный поток на expo-camera, не трогает фото-пайплайн.
    const openScanner = async () => {
        if (scanNoteTimer.current) clearTimeout(scanNoteTimer.current);
        setScanNote(null);
        let granted = permission?.granted ?? false;
        if (!granted) granted = (await requestPermission()).granted;
        if (!granted) {
            setScanNote("Нужен доступ к камере, чтобы сканировать штрихкод.");
            scanNoteTimer.current = setTimeout(() => setScanNote(null), 5000);
            return;
        }
        scannedRef.current = false;
        setScanning(true);
    };

    const onBarcodeScanned = ({ data }: { data: string }) => {
        if (scannedRef.current) return;
        scannedRef.current = true;
        tapBuzz();
        setScanning(false);
        void send(`штрихкод ${data}`);
    };

    // Deep-link отрабатывает по ЗНАЧЕНИЮ compose и вычищает параметр, чтобы
    // повторный тап той же кнопки виджета при открытом чате снова сработал.
    const composeHandled = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!compose) {
            composeHandled.current = undefined;
            return;
        }
        if (compose === composeHandled.current) return;
        composeHandled.current = compose;
        // Съесть параметр — иначе повтор того же значения не перезапустит эффект.
        router.setParams({ compose: "" });
        if (compose === "camera") {
            void openCameraOrRecover();
        } else if (compose === "text") {
            // Клавиатуре нужен тик после монтирования, чтобы поднять поле.
            setTimeout(() => inputRef.current?.focus(), 250);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- openCamera/pickImage не мемоизированы; сброс по значению даёт один запуск на значение
    }, [compose]);

    // Один ход ассистента поверх готовой истории; и send, и retry идут сюда.
    // ref-замок: два быстрых тапа читают одно и то же устаревшее busy.
    const runLock = useRef(false);
    const run = async (next: Msg[]) => {
        runLock.current = true;
        setBusy(true);
        setStatus("Думаю…");
        setStreamText("");
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        // Ключ хода берём с последнего сообщения пользователя: send ставит
        // свежий, retry идёт по той же истории → тот же ключ → сервер дедупит.
        const turnKey = [...next]
            .reverse()
            .find((m) => m.role === "user")?.turnKey;
        try {
            const reply = await sendChat(
                await toPayload(slimHistory(next)),
                (name) => setStatus(TOOL_STATUS[name] ?? "Думаю…"),
                ctrl.signal,
                turnKey,
                (t) => setStreamText((s) => s + t),
                () => setStreamText(""),
            );
            successBuzz();
            const assistant = stamped("assistant", reply.message);
            // Каждой карточке — свой idem-ключ для дедупа повторного «Записать».
            const proposals: Proposal[] = reply.proposals.map((p) => ({
                ...p,
                idem: newIdempotencyKey(),
            }));
            // Функциональный аппенд, не захваченный next: пока ход шёл,
            // карточка могла резолвнуться — её флаг нельзя затереть.
            setMessages((cur) => [
                ...cur,
                proposals.length ? { ...assistant, proposals } : assistant,
            ]);
        } catch (err) {
            // Cancelled by the user — keep their message, add nothing.
            if (!ctrl.signal.aborted) {
                setMessages((cur) => [
                    ...cur,
                    stamped(
                        "assistant",
                        isUnauthorized(err)
                            ? "Сессия истекла — войди заново."
                            : err instanceof Error &&
                                err.message === "chat_not_configured"
                              ? "Ассистенту нужен API-ключ — добавь свой в настройках."
                              : "Не получилось. Проверь сеть — сообщение никуда не делось.",
                        true,
                    ),
                ]);
            }
        } finally {
            runLock.current = false;
            abortRef.current = null;
            setBusy(false);
            setStatus(null);
            // Batches with the append above in one tick — no flash between
            // the live preview and the authoritative reply.
            setStreamText("");
        }
    };

    const send = async (textOverride?: string) => {
        const text = (textOverride ?? input).trim();
        if ((!text && !pendingImage) || busy || runLock.current) return;

        const content: ChatMessage["content"] = pendingImage
            ? ([
                  { type: "image_url", image_url: { url: pendingImage } },
                  ...(text ? [{ type: "text", text } as ChatPart] : []),
              ] as ChatPart[])
            : text;
        // Хвост из сбойных заметок вычищается — новая попытка идёт с чистой
        // историей, а не поверх «не получилось».
        const base = messages.filter((m) => !m.failed);
        // Новый ход — новый ключ, живёт на сообщении (переживает перезапуск).
        const userMsg: Msg = {
            ...stamped("user", content),
            turnKey: newIdempotencyKey(),
        };
        const next = [...base, userMsg];
        tapBuzz();
        setMessages(next);
        setInput("");
        void AsyncStorage.removeItem(DRAFT_KEY);
        setPendingImage(null);
        await run(next);
    };

    // «Повторить» на сбойном пузыре: та же история → run() возьмёт тот же
    // turnKey с последнего сообщения пользователя → сервер дедупит запись.
    const retry = async () => {
        if (busy || runLock.current) return;
        tapBuzz();
        const base = messages.filter((m) => !m.failed);
        if (base.length === 0) return;
        setMessages(base);
        await run(base);
    };

    // Карточка: «Записать» — прямой REST без LLM, «Не надо» — локальная пометка.
    const [savingCard, setSavingCard] = useState<string | null>(null);
    const markProposal = (
        mi: number,
        pi: number,
        resolved: "saved" | "declined",
    ) =>
        setMessages((cur) =>
            cur.map((m, i) =>
                i === mi
                    ? {
                          ...m,
                          proposals: m.proposals?.map((p, j) =>
                              j === pi ? { ...p, resolved } : p,
                          ),
                      }
                    : m,
            ),
        );
    const resolveProposal = async (mi: number, pi: number, save: boolean) => {
        const p = messages[mi]?.proposals?.[pi];
        if (!p || p.resolved || savingCard) return;
        if (!save) {
            tapBuzz();
            markProposal(mi, pi, "declined");
            return;
        }
        setSavingCard(`${mi}:${pi}`);
        try {
            // p.idem дедупит повторный тап после потерянного ответа: если
            // строка уже вставлена, сервер вернёт её же, а не второй дубль.
            await addMeal(
                {
                    description: p.description,
                    meal_type: p.meal_type,
                    calories: p.calories ?? null,
                    protein_g: p.protein_g ?? null,
                    carbs_g: p.carbs_g ?? null,
                    fat_g: p.fat_g ?? null,
                },
                p.idem,
            );
            successBuzz();
            markProposal(mi, pi, "saved");
        } catch (err) {
            if (onError(err)) return;
            notify("Не записалось", "Проверь сеть и попробуй ещё раз.");
        } finally {
            setSavingCard(null);
        }
    };

    const copyMessage = async (text: string) => {
        if (!text) return;
        try {
            await Clipboard.setStringAsync(text);
        } catch {
            return; // буфер недоступен — молча, тост был бы враньём
        }
        tapBuzz();
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    };

    const onSuggestion = (s: Suggestion) => {
        if (s.camera) {
            // На вебе камеры нет — открываем выбор файла.
            void pickImage(Platform.OS !== "web");
            return;
        }
        if (s.barcode) {
            void openScanner();
            return;
        }
        if (s.send) {
            void send(s.send);
            return;
        }
        if (s.prefill) {
            tapBuzz();
            // Уже набранный текст не затираем — только фокусируем поле.
            setInput((cur) => (cur.trim() ? cur : s.prefill!));
            inputRef.current?.focus();
        }
    };

    useEffect(
        () => () => {
            if (copiedTimer.current) clearTimeout(copiedTimer.current);
            if (scanNoteTimer.current) clearTimeout(scanNoteTimer.current);
        },
        [],
    );

    // Разделитель дня: локальный день сообщения отличается от дня ближайшего
    // предыдущего сообщения с таймстемпом (у легаси-историй его нет).
    const showDaySep = (i: number): boolean => {
        const at = messages[i]?.at;
        if (at == null) return false;
        const day = new Date(at).toDateString();
        for (let j = i - 1; j >= 0; j--) {
            const prev = messages[j]?.at;
            if (prev != null) return new Date(prev).toDateString() !== day;
        }
        return true;
    };

    // Enter отправляет на вебе; перенос строки — Shift+Enter, как в мессенджерах.
    const onKeyPress = (
        e: NativeSyntheticEvent<TextInputKeyPressEventData>,
    ) => {
        if (Platform.OS !== "web") return;
        const native = e.nativeEvent as TextInputKeyPressEventData & {
            shiftKey?: boolean;
        };
        if (native.key === "Enter" && !native.shiftKey) {
            e.preventDefault();
            void send();
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
                                style={[
                                    styles.back,
                                    { color: theme.inkSecondary },
                                ]}
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
                                { backgroundColor: theme.surfaceElevated },
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

                    <View style={styles.flex}>
                        <ScrollView
                            ref={scrollRef}
                            style={styles.flex}
                            contentContainerStyle={styles.messages}
                            keyboardShouldPersistTaps="handled"
                            scrollEventThrottle={48}
                            onScroll={(e) => {
                                const {
                                    contentOffset,
                                    layoutMeasurement,
                                    contentSize,
                                } = e.nativeEvent;
                                const nearBottom =
                                    contentOffset.y +
                                        layoutMeasurement.height >=
                                    contentSize.height - 48;
                                atBottom.current = nearBottom;
                                // Кнопка «вниз» живёт всегда, когда лента
                                // уехала, — не только при новых сообщениях.
                                setShowJump(!nearBottom && messages.length > 0);
                            }}
                            onContentSizeChange={() => {
                                // Автоскролл только когда юзер и так внизу; если он
                                // читает историю — не дёргаем, а показываем «вниз».
                                if (atBottom.current) {
                                    scrollRef.current?.scrollToEnd({
                                        animated: true,
                                    });
                                } else {
                                    setShowJump(true);
                                }
                            }}
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
                                        {suggestions().map((s) => (
                                            <Pressable
                                                key={s.label}
                                                accessibilityRole="button"
                                                onPress={() => onSuggestion(s)}
                                                style={({ pressed }) => [
                                                    styles.chip,
                                                    {
                                                        backgroundColor:
                                                            theme.accentSoft,
                                                    },
                                                    pressed && { opacity: 0.7 },
                                                ]}
                                            >
                                                <Text
                                                    style={[
                                                        styles.chipText,
                                                        { color: theme.accent },
                                                    ]}
                                                >
                                                    {s.label}
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
                                const showDay = showDaySep(i);
                                return (
                                    <View key={i} style={styles.messageBlock}>
                                        {showDay && m.at != null && (
                                            <Text
                                                style={[
                                                    styles.daySep,
                                                    { color: theme.inkMuted },
                                                ]}
                                            >
                                                {dayLabel(m.at).toUpperCase()}
                                            </Text>
                                        )}
                                        <Pressable
                                            accessibilityLabel={
                                                text
                                                    ? "Сообщение, долгое нажатие копирует"
                                                    : undefined
                                            }
                                            onLongPress={() =>
                                                void copyMessage(text)
                                            }
                                            delayLongPress={350}
                                            style={[
                                                styles.bubble,
                                                mine
                                                    ? [
                                                          styles.bubbleMine,
                                                          {
                                                              backgroundColor:
                                                                  theme.accentSoft,
                                                          },
                                                      ]
                                                    : [
                                                          styles.bubbleTheirs,
                                                          {
                                                              backgroundColor:
                                                                  theme.surfaceElevated,
                                                          },
                                                      ],
                                            ]}
                                        >
                                            {image && (
                                                <Pressable
                                                    accessibilityRole="imagebutton"
                                                    accessibilityLabel="Открыть фото"
                                                    onPress={() =>
                                                        setViewerUri(image)
                                                    }
                                                >
                                                    <Image
                                                        source={{ uri: image }}
                                                        style={
                                                            styles.bubbleImage
                                                        }
                                                    />
                                                </Pressable>
                                            )}
                                            {!!text && (
                                                <Text
                                                    style={[
                                                        styles.bubbleText,
                                                        {
                                                            color: m.failed
                                                                ? theme.inkSecondary
                                                                : theme.ink,
                                                        },
                                                    ]}
                                                >
                                                    {text}
                                                </Text>
                                            )}
                                        </Pressable>
                                        {m.proposals?.map((p, pi) => (
                                            <ProposalCard
                                                key={pi}
                                                p={p}
                                                theme={theme}
                                                active={
                                                    i === messages.length - 1 &&
                                                    !busy
                                                }
                                                saving={
                                                    savingCard === `${i}:${pi}`
                                                }
                                                onResolve={(save) =>
                                                    void resolveProposal(
                                                        i,
                                                        pi,
                                                        save,
                                                    )
                                                }
                                            />
                                        ))}
                                        {m.failed && (
                                            <Pressable
                                                accessibilityRole="button"
                                                onPress={() => void retry()}
                                                style={({ pressed }) => [
                                                    styles.retryChip,
                                                    {
                                                        backgroundColor:
                                                            theme.accentSoft,
                                                        opacity: pressed
                                                            ? 0.7
                                                            : 1,
                                                    },
                                                ]}
                                            >
                                                <Text
                                                    style={[
                                                        styles.chipText,
                                                        {
                                                            color: theme.accent,
                                                        },
                                                    ]}
                                                >
                                                    ↻ Повторить
                                                </Text>
                                            </Pressable>
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
                                            backgroundColor:
                                                theme.surfaceElevated,
                                        },
                                    ]}
                                >
                                    {streamText ? (
                                        // Финальный ответ «печатается» по токенам —
                                        // тем же стилем, что и готовое сообщение.
                                        <Text
                                            style={[
                                                styles.bubbleText,
                                                { color: theme.ink },
                                            ]}
                                        >
                                            {streamText}
                                        </Text>
                                    ) : (
                                        <View style={styles.statusRow}>
                                            <TypingDots theme={theme} />
                                            {status && (
                                                <Text
                                                    style={[
                                                        styles.statusText,
                                                        {
                                                            color: theme.inkMuted,
                                                        },
                                                    ]}
                                                >
                                                    {status}
                                                </Text>
                                            )}
                                        </View>
                                    )}
                                </View>
                            )}
                        </ScrollView>

                        {showJump && (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="К последним сообщениям"
                                onPress={() => {
                                    scrollRef.current?.scrollToEnd({
                                        animated: true,
                                    });
                                    setShowJump(false);
                                }}
                                style={[
                                    styles.jump,
                                    { backgroundColor: theme.surfaceElevated },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.jumpIcon,
                                        { color: theme.accent },
                                    ]}
                                >
                                    ↓
                                </Text>
                            </Pressable>
                        )}
                        {copied && (
                            <View
                                style={[
                                    styles.copied,
                                    { backgroundColor: theme.surfaceElevated },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.copiedText,
                                        { color: theme.inkSecondary },
                                    ]}
                                >
                                    Скопировано
                                </Text>
                            </View>
                        )}
                    </View>

                    {/* Pending photo preview */}
                    {pendingImage && (
                        <View style={styles.preview}>
                            <Image
                                source={{ uri: pendingImage }}
                                style={styles.previewImage}
                            />
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="Убрать фото"
                                onPress={() => setPendingImage(null)}
                                style={[
                                    styles.previewRemove,
                                    { backgroundColor: theme.surfaceElevated },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.previewRemoveText,
                                        { color: theme.ink },
                                    ]}
                                >
                                    ×
                                </Text>
                            </Pressable>
                        </View>
                    )}

                    {/* Подсказки живут и в непустом чате — пока поле свободно */}
                    {messages.length > 0 &&
                        !busy &&
                        !input &&
                        !pendingImage && (
                            <ScrollView
                                horizontal
                                showsHorizontalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                                style={styles.suggestStrip}
                                contentContainerStyle={styles.suggestRow}
                            >
                                {suggestions().map((s) => (
                                    <Pressable
                                        key={s.label}
                                        accessibilityRole="button"
                                        onPress={() => onSuggestion(s)}
                                        style={({ pressed }) => [
                                            styles.suggestChip,
                                            {
                                                backgroundColor:
                                                    theme.accentSoft,
                                                opacity: pressed ? 0.7 : 1,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.suggestText,
                                                { color: theme.accent },
                                            ]}
                                        >
                                            {s.label}
                                        </Text>
                                    </Pressable>
                                ))}
                            </ScrollView>
                        )}

                    {scanNote && (
                        <Text
                            accessibilityLiveRegion="polite"
                            style={[styles.scanNote, { color: theme.inkMuted }]}
                        >
                            {scanNote}
                        </Text>
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
                            style={({ pressed }) => [
                                styles.attach,
                                { borderColor: theme.hairline },
                                pressed && { transform: [{ scale: 0.92 }] },
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
                            ref={inputRef}
                            style={[
                                styles.input,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: inputFocused
                                        ? theme.accent
                                        : theme.surfaceElevated,
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
                            onKeyPress={onKeyPress}
                            onFocus={() => setInputFocused(true)}
                            onBlur={() => setInputFocused(false)}
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
                                    transform: [{ scale: pressed ? 0.92 : 1 }],
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

            {/* Полноэкранный просмотр фото из переписки */}
            <Modal
                visible={viewerUri != null}
                transparent
                animationType="fade"
                onRequestClose={() => setViewerUri(null)}
            >
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Закрыть фото"
                    style={styles.viewerBackdrop}
                    onPress={() => setViewerUri(null)}
                >
                    {viewerUri && (
                        <Image
                            source={{ uri: viewerUri }}
                            style={styles.viewerImage}
                            resizeMode="contain"
                        />
                    )}
                </Pressable>
            </Modal>

            {/* Сканер штрихкода — отдельный поток на expo-camera */}
            <Modal
                visible={scanning}
                animationType="slide"
                onRequestClose={() => setScanning(false)}
            >
                <View style={styles.scanner}>
                    <CameraView
                        style={StyleSheet.absoluteFill}
                        facing="back"
                        barcodeScannerSettings={{
                            barcodeTypes: [
                                "ean13",
                                "ean8",
                                "upc_a",
                                "upc_e",
                                "code128",
                            ],
                        }}
                        onBarcodeScanned={onBarcodeScanned}
                    />
                    <SafeAreaView style={styles.scannerOverlay}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Закрыть сканер штрихкода"
                            onPress={() => setScanning(false)}
                            hitSlop={12}
                            style={styles.scannerClose}
                        >
                            <Text style={styles.scannerCloseText}>×</Text>
                        </Pressable>
                        <Text style={styles.scannerHint}>
                            Наведите камеру на штрихкод
                        </Text>
                    </SafeAreaView>
                </View>
            </Modal>
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
        borderRadius: Radii.lg,
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
        gap: Spacing.md,
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
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 10,
        alignSelf: "flex-start",
    },
    chipText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    messageBlock: { gap: Spacing.sm },
    daySep: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 10,
        letterSpacing: 2,
        textAlign: "center",
        paddingVertical: Spacing.xs,
    },
    retryChip: {
        alignSelf: "flex-start",
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 8,
    },
    jump: {
        position: "absolute",
        right: Spacing.lg,
        bottom: Spacing.md,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        elevation: 4,
        shadowOpacity: 0.2,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
    },
    jumpIcon: { fontFamily: Fonts.sansSemiBold, fontSize: 18 },
    copied: {
        position: "absolute",
        top: Spacing.sm,
        alignSelf: "center",
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 7,
        elevation: 4,
        shadowOpacity: 0.2,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
    },
    copiedText: { fontFamily: Fonts.sansMedium, fontSize: 12 },
    suggestStrip: { flexGrow: 0 },
    suggestRow: {
        gap: Spacing.sm,
        paddingHorizontal: Spacing.lg,
        paddingBottom: Spacing.sm,
    },
    suggestChip: {
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 8,
    },
    suggestText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    viewerBackdrop: {
        flex: 1,
        backgroundColor: "rgba(18,13,7,0.92)",
        alignItems: "center",
        justifyContent: "center",
        padding: Spacing.lg,
    },
    viewerImage: { width: "100%", height: "80%" },
    scanner: { flex: 1, backgroundColor: "#000" },
    scannerOverlay: { flex: 1, justifyContent: "space-between" },
    scannerClose: {
        alignSelf: "flex-end",
        margin: Spacing.lg,
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.45)",
    },
    scannerCloseText: { color: "#fff", fontSize: 26, lineHeight: 28 },
    scannerHint: {
        color: "#fff",
        fontFamily: Fonts.sansMedium,
        fontSize: 15,
        textAlign: "center",
        marginBottom: Spacing.xxl,
        paddingHorizontal: Spacing.lg,
    },
    scanNote: {
        fontFamily: Fonts.sans,
        fontSize: 13,
        lineHeight: 18,
        paddingHorizontal: Spacing.lg,
        paddingBottom: Spacing.sm,
    },
    bubble: {
        maxWidth: "85%",
        borderRadius: Radii.lg,
        padding: Spacing.md,
        gap: Spacing.sm,
    },
    bubbleMine: { alignSelf: "flex-end", borderBottomRightRadius: Radii.sm },
    bubbleTheirs: {
        alignSelf: "flex-start",
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
    card: {
        alignSelf: "flex-start",
        width: "85%",
        borderRadius: Radii.lg,
        padding: Spacing.md,
        gap: 6,
    },
    cardHead: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },
    cardType: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 10,
        letterSpacing: 2,
    },
    cardKcal: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    cardDesc: { fontFamily: Fonts.sansMedium, fontSize: 15, lineHeight: 21 },
    cardMacros: { fontFamily: Fonts.sans, fontSize: 13 },
    cardStatus: { fontFamily: Fonts.sansMedium, fontSize: 13, marginTop: 2 },
    cardButtons: { flexDirection: "row", gap: Spacing.sm, marginTop: 4 },
    cardYes: {
        flex: 1,
        borderRadius: Radii.pill,
        paddingVertical: 14,
        alignItems: "center",
    },
    cardYesText: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    cardNo: {
        flex: 1,
        borderWidth: 1,
        borderRadius: Radii.pill,
        paddingVertical: 14,
        alignItems: "center",
    },
    cardNoText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    preview: {
        paddingHorizontal: Spacing.lg,
        paddingBottom: Spacing.sm,
        alignSelf: "flex-start",
    },
    previewImage: {
        width: 72,
        height: 72,
        borderRadius: Radii.md,
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
        elevation: 3,
        shadowOpacity: 0.2,
        shadowRadius: 4,
        shadowOffset: { width: 0, height: 2 },
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
        borderRadius: Radii.xl,
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
