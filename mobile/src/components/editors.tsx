import { useEffect, useMemo, useRef, useState } from "react";
import {
    Alert,
    Animated,
    KeyboardAvoidingView,
    Modal,
    PanResponder,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
    addDish,
    addMeal,
    addWeight,
    getDishes,
    getStats,
    newIdempotencyKey,
    patchMeal,
    patchWeight,
    removeDish,
    removeMeal,
    removeWeight,
    saveGoals,
    type Dish,
    type FrequentMeal,
    type GoalsInput,
    type MealRow,
    type MealType,
} from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { tapBuzz } from "@/lib/haptics";

const MEAL_TYPES: { key: MealType; label: string }[] = [
    { key: "breakfast", label: "Завтрак" },
    { key: "lunch", label: "Обед" },
    { key: "dinner", label: "Ужин" },
    { key: "snack", label: "Перекус" },
];

const MEAL_LABEL: Record<string, string> = {
    breakfast: "Завтрак",
    lunch: "Обед",
    dinner: "Ужин",
    snack: "Перекус",
};

/** Sensible default for a new meal by the local clock. */
function mealTypeNow(): MealType {
    const h = new Date().getHours();
    if (h < 11) return "breakfast";
    if (h < 16) return "lunch";
    if (h < 22) return "dinner";
    return "snack";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Локальный ключ дня YYYY-MM-DD — для сравнения с «сегодня». */
function dayKeyLocal(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** «Ср · 16 июля» — дата записи в степпере. */
function whenDateLabel(d: Date): string {
    const wd = d.toLocaleDateString("ru-RU", { weekday: "short" });
    const dm = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
    return `${wd} · ${dm}`;
}

/** «вторник, 16 июля» — дата в read-only детали. */
function detailDate(iso: string): string {
    return new Date(iso).toLocaleDateString("ru-RU", {
        weekday: "long",
        day: "numeric",
        month: "long",
    });
}

function detailTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("ru-RU", {
        hour: "numeric",
        minute: "2-digit",
    });
}

/** Alert is a no-op on web — fall back to window.confirm there. */
function confirmDelete(title: string, onYes: () => void) {
    if (Platform.OS === "web") {
        if (window.confirm(title)) onYes();
        return;
    }
    Alert.alert(title, undefined, [
        { text: "Отмена", style: "cancel" },
        { text: "Удалить", style: "destructive", onPress: onYes },
    ]);
}

/** Подтверждение выхода из формы с несохранёнными правками. */
function confirmDiscard(onDiscard: () => void) {
    if (Platform.OS === "web") {
        if (window.confirm("Сбросить изменения?")) onDiscard();
        return;
    }
    Alert.alert("Сбросить изменения?", undefined, [
        { text: "Продолжить", style: "cancel" },
        { text: "Сбросить", style: "destructive", onPress: onDiscard },
    ]);
}

/** "" → null, "12,5" → 12.5, junk/≤0 → NaN (blocks save). */
function parseNum(s: string): number | null {
    const t = s.trim();
    if (!t) return null;
    const n = Number(t.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : NaN;
}

function numText(v: number | null | undefined): string {
    return v == null ? "" : String(v);
}

function clip(s: string, max = 22): string {
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function useTheme(): Theme {
    const scheme = useColorScheme();
    return Colors[scheme === "dark" ? "dark" : "light"];
}

// ----- shared bottom sheet -----

function Sheet({
    visible,
    title,
    onClose,
    children,
    theme,
}: {
    visible: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    theme: Theme;
}) {
    // Drag-to-dismiss: the handle zone (grabber + title) follows the finger,
    // a decisive pull closes, anything else springs back.
    const [drag] = useState(() => new Animated.Value(0));
    const pan = useMemo(
        () =>
            PanResponder.create({
                onMoveShouldSetPanResponder: (_e, g) =>
                    g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
                onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
                onPanResponderRelease: (_e, g) => {
                    if (g.dy > 90 || g.vy > 0.8) onClose();
                    else {
                        Animated.spring(drag, {
                            toValue: 0,
                            useNativeDriver: true,
                        }).start();
                    }
                },
            }),
        [drag, onClose],
    );
    useEffect(() => {
        if (visible) drag.setValue(0);
    }, [visible, drag]);
    const insets = useSafeAreaInsets();

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={onClose}
        >
            {/* edge-to-edge Android needs padding too (SDK 57) */}
            <KeyboardAvoidingView
                style={styles.backdropWrap}
                behavior="padding"
            >
                <Pressable style={styles.backdrop} onPress={onClose} />
                <Animated.View
                    style={[
                        styles.sheet,
                        {
                            backgroundColor: theme.surfaceElevated,
                            // Keep actions above the Android navigation bar.
                            paddingBottom: Spacing.xl + insets.bottom,
                            transform: [{ translateY: drag }],
                        },
                    ]}
                >
                    <View style={styles.handleZone} {...pan.panHandlers}>
                        <View
                            style={[
                                styles.grabber,
                                { backgroundColor: theme.hairline },
                            ]}
                        />
                        <Text style={[styles.sheetTitle, { color: theme.ink }]}>
                            {title}
                        </Text>
                    </View>
                    <ScrollView
                        style={styles.sheetBody}
                        contentContainerStyle={styles.sheetBodyContent}
                        keyboardShouldPersistTaps="handled"
                        showsVerticalScrollIndicator={false}
                    >
                        {children}
                    </ScrollView>
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

function Field({
    label,
    value,
    onChange,
    theme,
    keyboard = "default",
    placeholder,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    theme: Theme;
    keyboard?: "default" | "decimal-pad";
    placeholder?: string;
}) {
    const [focused, setFocused] = useState(false);
    return (
        <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.inkSecondary }]}>
                {label}
            </Text>
            <TextInput
                style={[
                    styles.input,
                    {
                        backgroundColor: theme.surface,
                        borderColor: focused ? theme.accent : theme.surface,
                        color: theme.ink,
                    },
                ]}
                value={value}
                onChangeText={onChange}
                keyboardType={keyboard}
                placeholder={placeholder}
                placeholderTextColor={theme.inkMuted}
                cursorColor={theme.accent}
                selectionColor={theme.accent}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
            />
        </View>
    );
}

function StepBtn({
    glyph,
    label,
    onPress,
    disabled,
    theme,
}: {
    glyph: string;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    theme: Theme;
}) {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={onPress}
            disabled={disabled}
            hitSlop={8}
            style={({ pressed }) => [
                styles.stepBtn,
                {
                    backgroundColor: theme.surface,
                    opacity: disabled ? 0.35 : 1,
                    transform: [{ scale: pressed && !disabled ? 0.92 : 1 }],
                },
            ]}
        >
            <Text style={[styles.stepBtnText, { color: theme.accent }]}>
                {glyph}
            </Text>
        </Pressable>
    );
}

/** Час/минута степпером (как напоминания в настройках). */
function TimeStepper({
    label,
    value,
    onDec,
    onInc,
    theme,
}: {
    label: string;
    value: string;
    onDec: () => void;
    onInc: () => void;
    theme: Theme;
}) {
    return (
        <View style={styles.timeStepper}>
            <StepBtn
                glyph="−"
                label={`${label}: меньше`}
                onPress={onDec}
                theme={theme}
            />
            <Text style={[styles.timeValue, TabularNums, { color: theme.ink }]}>
                {value}
            </Text>
            <StepBtn
                glyph="+"
                label={`${label}: больше`}
                onPress={onInc}
                theme={theme}
            />
        </View>
    );
}

/** Дата (±день, не в будущее) и время (час/минута) записи. */
function WhenEditor({
    value,
    onChange,
    today,
    theme,
}: {
    value: Date;
    onChange: (d: Date) => void;
    today: string;
    theme: Theme;
}) {
    const edit = (mut: (d: Date) => void) => {
        tapBuzz();
        const d = new Date(value);
        mut(d);
        onChange(d);
    };
    const bumpMinute = (delta: number) =>
        edit((d) => {
            const step = 5;
            const steps = 60 / step;
            const idx = Math.round(d.getMinutes() / step);
            d.setMinutes(((idx + delta + steps) % steps) * step);
        });
    const atTodayOrLater = dayKeyLocal(value) >= today;

    return (
        <View style={styles.whenBlock}>
            <Text style={[styles.fieldLabel, { color: theme.inkSecondary }]}>
                Когда
            </Text>
            <View style={styles.whenDateRow}>
                <StepBtn
                    glyph="‹"
                    label="На день раньше"
                    onPress={() => edit((d) => d.setDate(d.getDate() - 1))}
                    theme={theme}
                />
                <Text style={[styles.whenDate, { color: theme.ink }]}>
                    {whenDateLabel(value)}
                </Text>
                <StepBtn
                    glyph="›"
                    label="На день позже"
                    disabled={atTodayOrLater}
                    onPress={() => edit((d) => d.setDate(d.getDate() + 1))}
                    theme={theme}
                />
            </View>
            <View style={styles.whenTimeRow}>
                <TimeStepper
                    label="Часы"
                    value={pad2(value.getHours())}
                    onDec={() =>
                        edit((d) => d.setHours((d.getHours() + 23) % 24))
                    }
                    onInc={() =>
                        edit((d) => d.setHours((d.getHours() + 1) % 24))
                    }
                    theme={theme}
                />
                <Text style={[styles.stepperColon, { color: theme.inkMuted }]}>
                    :
                </Text>
                <TimeStepper
                    label="Минуты"
                    value={pad2(value.getMinutes())}
                    onDec={() => bumpMinute(-1)}
                    onInc={() => bumpMinute(1)}
                    theme={theme}
                />
            </View>
        </View>
    );
}

function SheetActions({
    onSave,
    onDelete,
    busy,
    canSave = true,
    theme,
}: {
    onSave: () => void;
    onDelete?: () => void;
    busy: boolean;
    canSave?: boolean;
    theme: Theme;
}) {
    const off = busy || !canSave;
    return (
        <View style={styles.actions}>
            <Pressable
                accessibilityRole="button"
                onPress={() => {
                    // success feedback comes from the caller after the save
                    // actually lands — here it's just a tap acknowledgement
                    tapBuzz();
                    onSave();
                }}
                disabled={off}
                style={({ pressed }) => [
                    styles.saveBtn,
                    {
                        backgroundColor: theme.accent,
                        opacity: off ? 0.5 : pressed ? 0.85 : 1,
                    },
                ]}
            >
                <Text style={[styles.saveText, { color: theme.onAccent }]}>
                    {busy ? "Сохраняю…" : "Сохранить"}
                </Text>
            </Pressable>
            {onDelete && (
                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        tapBuzz();
                        confirmDelete("Удалить запись?", onDelete);
                    }}
                    disabled={busy}
                    style={styles.deleteBtn}
                >
                    <Text style={[styles.deleteText, { color: theme.danger }]}>
                        Удалить
                    </Text>
                </Pressable>
            )}
        </View>
    );
}

// ----- meal editor -----

export function MealEditor({
    visible,
    meal,
    defaultLoggedAt,
    backdated,
    today,
    onRepeat,
    onDone,
    onClose,
}: {
    visible: boolean;
    /** null = create a new meal */
    meal: MealRow | null;
    /** ISO записи по умолчанию (день просмотра + текущее время суток). */
    defaultLoggedAt: string;
    /** Просматривают прошлый день — новую запись всегда датируем этим днём. */
    backdated: boolean;
    /** Локальное «сегодня» — потолок для степпера даты. */
    today: string;
    onRepeat: (meal: MealRow) => void;
    onDone: () => void;
    onClose: () => void;
}) {
    const theme = useTheme();
    // Существующий приём открывается на просмотр; новый — сразу в форме.
    // Родитель перемонтирует по key на каждое открытие — режим свеж.
    const [mode, setMode] = useState<"view" | "edit">(meal ? "view" : "edit");
    const dirtyRef = useRef(false);

    const requestClose = () => {
        if (mode === "edit" && dirtyRef.current) confirmDiscard(onClose);
        else onClose();
    };

    return (
        <Sheet
            visible={visible}
            title={
                mode === "view"
                    ? "Приём"
                    : meal
                      ? "Править еду"
                      : "Добавить еду"
            }
            onClose={requestClose}
            theme={theme}
        >
            {/* Remounts on every open, so state re-inits from props. */}
            {visible &&
                (meal && mode === "view" ? (
                    <MealDetail
                        meal={meal}
                        theme={theme}
                        onEdit={() => setMode("edit")}
                        onRepeat={() => {
                            onRepeat(meal);
                            onClose();
                        }}
                        onDone={onDone}
                    />
                ) : (
                    <MealForm
                        meal={meal}
                        defaultLoggedAt={defaultLoggedAt}
                        backdated={backdated}
                        today={today}
                        dirtyRef={dirtyRef}
                        onDone={onDone}
                        theme={theme}
                    />
                ))}
        </Sheet>
    );
}

function MealDetail({
    meal,
    theme,
    onEdit,
    onRepeat,
    onDone,
}: {
    meal: MealRow;
    theme: Theme;
    onEdit: () => void;
    onRepeat: () => void;
    onDone: () => void;
}) {
    const { onError } = useRequireAuth();
    const [busy, setBusy] = useState(false);
    const del = () =>
        confirmDelete("Удалить приём?", () => {
            setBusy(true);
            void removeMeal(meal.id)
                .then(onDone)
                .catch((err: unknown) => {
                    if (onError(err)) return;
                    setBusy(false);
                });
        });
    const macros = [
        meal.calories != null && `${meal.calories} ккал`,
        meal.protein_g != null && `Б ${Math.round(meal.protein_g)}`,
        meal.carbs_g != null && `У ${Math.round(meal.carbs_g)}`,
        meal.fat_g != null && `Ж ${Math.round(meal.fat_g)}`,
    ]
        .filter(Boolean)
        .join("   ·   ");

    return (
        <View style={styles.detail}>
            <Text style={[styles.detailEyebrow, { color: theme.accent }]}>
                {(MEAL_LABEL[meal.meal_type ?? ""] ?? "Приём").toUpperCase()}
            </Text>
            <Text style={[styles.detailValue, { color: theme.ink }]}>
                {meal.description}
            </Text>
            <Text style={[styles.detailMeta, { color: theme.inkMuted }]}>
                {detailDate(meal.logged_at)} · {detailTime(meal.logged_at)}
            </Text>
            {macros !== "" && (
                <Text
                    style={[
                        styles.detailMacros,
                        TabularNums,
                        { color: theme.inkSecondary },
                    ]}
                >
                    {macros}
                </Text>
            )}
            <Pressable
                accessibilityRole="button"
                onPress={() => {
                    tapBuzz();
                    onEdit();
                }}
                style={({ pressed }) => [
                    styles.saveBtn,
                    {
                        backgroundColor: theme.accent,
                        opacity: pressed ? 0.85 : 1,
                    },
                ]}
            >
                <Text style={[styles.saveText, { color: theme.onAccent }]}>
                    Править
                </Text>
            </Pressable>
            <View style={styles.detailSecondary}>
                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        tapBuzz();
                        onRepeat();
                    }}
                    hitSlop={8}
                >
                    <Text
                        style={[styles.detailAction, { color: theme.accent }]}
                    >
                        Повторить
                    </Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    onPress={del}
                    disabled={busy}
                    hitSlop={8}
                >
                    <Text
                        style={[styles.detailAction, { color: theme.danger }]}
                    >
                        Удалить
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

function MealForm({
    meal,
    defaultLoggedAt,
    backdated,
    today,
    dirtyRef,
    onDone,
    theme,
}: {
    meal: MealRow | null;
    defaultLoggedAt: string;
    backdated: boolean;
    today: string;
    dirtyRef: React.MutableRefObject<boolean>;
    onDone: () => void;
    theme: Theme;
}) {
    // Снимок исходных значений: базис dirty-сравнения. mealTypeNow/дата в
    // инициализаторе useState (не в рендере) — как в существующем коде.
    const [init] = useState(() => ({
        description: meal?.description ?? "",
        mealType: (meal?.meal_type as MealType) ?? mealTypeNow(),
        calories: numText(meal?.calories),
        protein: numText(meal?.protein_g),
        carbs: numText(meal?.carbs_g),
        fat: numText(meal?.fat_g),
        iso: new Date(meal?.logged_at ?? defaultLoggedAt).toISOString(),
    }));
    const [description, setDescription] = useState(init.description);
    const [mealType, setMealType] = useState<MealType>(init.mealType);
    const { onError } = useRequireAuth();
    const [calories, setCalories] = useState(init.calories);
    const [protein, setProtein] = useState(init.protein);
    const [carbs, setCarbs] = useState(init.carbs);
    const [fat, setFat] = useState(init.fat);
    const [loggedAt, setLoggedAt] = useState(() => new Date(init.iso));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [frequent, setFrequent] = useState<FrequentMeal[]>([]);
    const [dishes, setDishes] = useState<Dish[]>([]);
    const [remember, setRemember] = useState(false);
    // ref-замок: busy — async-стейт, быстрый двойной тап проскакивает до
    // ре-рендера и шлёт две записи.
    const lock = useRef(false);
    // Ключ на запись приёма — переживает ретрай в открытой форме (форма
    // ремоунтится на каждое открытие, так что ключ свежий на новый приём).
    const saveKey = useRef<{ sig: string; key: string } | null>(null);

    const dirty =
        description !== init.description ||
        mealType !== init.mealType ||
        calories !== init.calories ||
        protein !== init.protein ||
        carbs !== init.carbs ||
        fat !== init.fat ||
        loggedAt.toISOString() !== init.iso;
    useEffect(() => {
        dirtyRef.current = dirty;
    }, [dirty, dirtyRef]);

    // Форма ремоунтится на каждое открытие — частое тянем один раз, только
    // для нового приёма; сбой сети просто оставляет форму без чипов.
    useEffect(() => {
        if (meal) return;
        let alive = true;
        getStats(30)
            .then((s) => {
                if (alive) setFrequent(s.frequent);
            })
            .catch((err: unknown) => {
                // 401 уже стёр токен — оставлять юзера в форме бессмысленно.
                onError(err);
            });
        // Свой каталог: ошибку глотаем — редактор важнее чипов.
        getDishes()
            .then((d) => {
                if (alive) setDishes(d);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [meal, onError]);

    // Правка даты/времени: клампим не в будущее и не старше года.
    const changeLoggedAt = (d: Date) => {
        const now = new Date();
        const min = new Date(now);
        min.setFullYear(now.getFullYear() - 1);
        let t = d.getTime();
        if (t > now.getTime()) t = now.getTime();
        if (t < min.getTime()) t = min.getTime();
        setLoggedAt(new Date(t));
    };

    const fillFrom = (f: FrequentMeal) => {
        tapBuzz();
        setDescription(f.description);
        if (f.meal_type) setMealType(f.meal_type);
        setCalories(numText(f.calories));
        setProtein(numText(f.protein_g));
        setCarbs(numText(f.carbs_g));
        setFat(numText(f.fat_g));
    };

    const fillFromDish = (d: Dish) => {
        tapBuzz();
        setDescription(d.name);
        if (d.meal_type) setMealType(d.meal_type);
        setCalories(numText(d.calories));
        setProtein(numText(d.protein_g));
        setCarbs(numText(d.carbs_g));
        setFat(numText(d.fat_g));
    };

    // Long-press по чипу — убрать блюдо из каталога (оптимистично, с откатом).
    const forgetDish = (d: Dish) => {
        confirmDelete(`Убрать «${d.name}» из моих блюд?`, () => {
            setDishes((cur) => cur.filter((x) => x.id !== d.id));
            removeDish(d.id).catch((err) => {
                if (onError(err)) return;
                // Сервер отказал — возвращаем блюдо на место (порядок по имени).
                setDishes((cur) =>
                    cur.some((x) => x.id === d.id)
                        ? cur
                        : [...cur, d].sort((a, b) =>
                              a.name.localeCompare(b.name),
                          ),
                );
            });
        });
    };

    const save = async () => {
        const nums = {
            calories: parseNum(calories),
            protein_g: parseNum(protein),
            carbs_g: parseNum(carbs),
            fat_g: parseNum(fat),
        };
        if (
            !description.trim() ||
            Object.values(nums).some((v) => Number.isNaN(v))
        ) {
            setError("Проверь описание и числа, потом попробуй снова.");
            return;
        }
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            const fields = {
                description: description.trim(),
                meal_type: mealType,
                ...nums,
            };
            const iso = loggedAt.toISOString();
            // Прошлый день датируем всегда; для «сегодня» шлём время только
            // если его тронули (иначе сервер ставит «сейчас», без сдвига часов).
            const timeChanged = iso !== init.iso;
            if (meal) {
                await patchMeal(meal.id, fields, timeChanged ? iso : undefined);
            } else {
                const loggedAtToSend =
                    backdated || timeChanged ? iso : undefined;
                // Ключ привязан к payload (включая время): ретрай тех же данных
                // дедупится сервером, а смена времени/чисел — новый ключ.
                const sig = JSON.stringify({
                    ...fields,
                    loggedAt: loggedAtToSend ?? null,
                });
                if (saveKey.current?.sig !== sig)
                    saveKey.current = { sig, key: newIdempotencyKey() };
                await addMeal(fields, saveKey.current.key, loggedAtToSend);
            }
            // Приём записан — блюдо в каталог фоном; его сбой не рушит сохранение.
            if (remember) {
                void addDish({
                    name: fields.description,
                    meal_type: fields.meal_type,
                    ...nums,
                }).catch(() => {});
            }
            onDone();
        } catch (err) {
            if (onError(err)) return;
            setError("Не удалось сохранить — проверь сеть и попробуй ещё.");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };

    const del = async () => {
        if (!meal || lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            await removeMeal(meal.id);
            onDone();
        } catch (err) {
            if (onError(err)) return;
            // Отдельный текст: удаление не про «проверь числа».
            setError("Не удалось удалить — проверь сеть и попробуй ещё.");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };

    return (
        <>
            {!meal && dishes.length > 0 && (
                <View style={styles.frequentBlock}>
                    <Text
                        style={[
                            styles.frequentLabel,
                            { color: theme.inkSecondary },
                        ]}
                    >
                        МОИ БЛЮДА
                    </Text>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={styles.frequentRow}
                    >
                        {dishes.map((d) => (
                            <Pressable
                                key={d.id}
                                accessibilityRole="button"
                                accessibilityLabel={`Подставить «${d.name}»`}
                                onPress={() => fillFromDish(d)}
                                onLongPress={() => forgetDish(d)}
                                delayLongPress={350}
                                style={({ pressed }) => [
                                    styles.frequentChip,
                                    {
                                        backgroundColor: theme.accentSoft,
                                        transform: [
                                            { scale: pressed ? 0.96 : 1 },
                                        ],
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.frequentChipText,
                                        { color: theme.accent },
                                    ]}
                                >
                                    {clip(d.name)}
                                </Text>
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}
            {!meal && frequent.length > 0 && (
                <View style={styles.frequentBlock}>
                    <Text
                        style={[
                            styles.frequentLabel,
                            { color: theme.inkSecondary },
                        ]}
                    >
                        ЧАСТОЕ
                    </Text>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={styles.frequentRow}
                    >
                        {frequent.map((f, i) => (
                            <Pressable
                                key={`${f.description}-${i}`}
                                accessibilityRole="button"
                                accessibilityLabel={`Подставить «${f.description}»`}
                                onPress={() => fillFrom(f)}
                                style={({ pressed }) => [
                                    styles.frequentChip,
                                    {
                                        backgroundColor: theme.accentSoft,
                                        transform: [
                                            { scale: pressed ? 0.96 : 1 },
                                        ],
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.frequentChipText,
                                        { color: theme.accent },
                                    ]}
                                >
                                    {clip(f.description)}
                                </Text>
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}
            <Field
                label="Описание"
                value={description}
                onChange={setDescription}
                theme={theme}
                placeholder="Что было на тарелке?"
            />
            <View style={styles.typeRow}>
                {MEAL_TYPES.map((t) => {
                    const active = t.key === mealType;
                    return (
                        <Pressable
                            key={t.key}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            onPress={() => setMealType(t.key)}
                            style={[
                                styles.typeChip,
                                {
                                    backgroundColor: active
                                        ? theme.accent
                                        : theme.surface,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.typeChipText,
                                    {
                                        color: active
                                            ? theme.onAccent
                                            : theme.inkSecondary,
                                        fontFamily: active
                                            ? Fonts.sansSemiBold
                                            : Fonts.sansMedium,
                                    },
                                ]}
                            >
                                {t.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
            <WhenEditor
                value={loggedAt}
                onChange={changeLoggedAt}
                today={today}
                theme={theme}
            />
            <View style={styles.numRow}>
                <View style={styles.numCell}>
                    <Field
                        label="ккал"
                        value={calories}
                        onChange={setCalories}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
                <View style={styles.numCell}>
                    <Field
                        label="Белки, г"
                        value={protein}
                        onChange={setProtein}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
            </View>
            <View style={styles.numRow}>
                <View style={styles.numCell}>
                    <Field
                        label="Углеводы, г"
                        value={carbs}
                        onChange={setCarbs}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
                <View style={styles.numCell}>
                    <Field
                        label="Жиры, г"
                        value={fat}
                        onChange={setFat}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
            </View>
            <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: remember }}
                onPress={() => {
                    tapBuzz();
                    setRemember((v) => !v);
                }}
                style={[
                    styles.rememberChip,
                    {
                        backgroundColor: remember
                            ? theme.accentSoft
                            : theme.surface,
                    },
                ]}
            >
                <Text
                    style={[
                        styles.rememberText,
                        { color: remember ? theme.accent : theme.inkSecondary },
                    ]}
                >
                    {remember
                        ? "⭐ Запомнить как моё блюдо"
                        : "☆ Запомнить как моё блюдо"}
                </Text>
            </Pressable>
            {error && (
                <Text style={[styles.error, { color: theme.danger }]}>
                    {error}
                </Text>
            )}
            <SheetActions
                onSave={() => void save()}
                onDelete={meal ? () => void del() : undefined}
                busy={busy}
                canSave={dirty}
                theme={theme}
            />
        </>
    );
}

// ----- weight editor -----

export function WeightEditor({
    visible,
    entry,
    defaultLoggedAt,
    backdated,
    lastKg,
    onDone,
    onClose,
}: {
    visible: boolean;
    /** null = log a new weigh-in */
    entry: { id: string; weight_g: number; date?: string } | null;
    defaultLoggedAt: string;
    backdated: boolean;
    /** Последний известный вес (кг) — базис степпера при новой записи. */
    lastKg: number | null;
    onDone: () => void;
    onClose: () => void;
}) {
    const theme = useTheme();
    // Родитель перемонтирует по key на каждое открытие — режим свеж.
    const [mode, setMode] = useState<"view" | "edit">(entry ? "view" : "edit");
    const dirtyRef = useRef(false);

    const requestClose = () => {
        if (mode === "edit" && dirtyRef.current) confirmDiscard(onClose);
        else onClose();
    };

    return (
        <Sheet
            visible={visible}
            title={
                mode === "view"
                    ? "Взвешивание"
                    : entry
                      ? "Править взвешивание"
                      : "Записать вес"
            }
            onClose={requestClose}
            theme={theme}
        >
            {visible &&
                (entry && mode === "view" ? (
                    <WeightDetail
                        entry={entry}
                        theme={theme}
                        onEdit={() => setMode("edit")}
                        onDone={onDone}
                    />
                ) : (
                    <WeightForm
                        entry={entry}
                        defaultLoggedAt={defaultLoggedAt}
                        backdated={backdated}
                        lastKg={lastKg}
                        dirtyRef={dirtyRef}
                        onDone={onDone}
                        theme={theme}
                    />
                ))}
        </Sheet>
    );
}

function WeightDetail({
    entry,
    theme,
    onEdit,
    onDone,
}: {
    entry: { id: string; weight_g: number; date?: string };
    theme: Theme;
    onEdit: () => void;
    onDone: () => void;
}) {
    const { onError } = useRequireAuth();
    const [busy, setBusy] = useState(false);
    const del = () =>
        confirmDelete("Удалить взвешивание?", () => {
            setBusy(true);
            void removeWeight(entry.id)
                .then(onDone)
                .catch((err: unknown) => {
                    if (onError(err)) return;
                    setBusy(false);
                });
        });

    return (
        <View style={styles.detail}>
            <Text style={[styles.detailEyebrow, { color: theme.accent }]}>
                ВЕС
            </Text>
            <Text
                style={[styles.detailValue, TabularNums, { color: theme.ink }]}
            >
                {(entry.weight_g / 1000).toFixed(1)} кг
            </Text>
            {entry.date && (
                <Text style={[styles.detailMeta, { color: theme.inkMuted }]}>
                    {detailDate(`${entry.date}T12:00:00`)}
                </Text>
            )}
            <Pressable
                accessibilityRole="button"
                onPress={() => {
                    tapBuzz();
                    onEdit();
                }}
                style={({ pressed }) => [
                    styles.saveBtn,
                    {
                        backgroundColor: theme.accent,
                        opacity: pressed ? 0.85 : 1,
                    },
                ]}
            >
                <Text style={[styles.saveText, { color: theme.onAccent }]}>
                    Править
                </Text>
            </Pressable>
            <View style={styles.detailSecondary}>
                <Pressable
                    accessibilityRole="button"
                    onPress={del}
                    disabled={busy}
                    hitSlop={8}
                >
                    <Text
                        style={[styles.detailAction, { color: theme.danger }]}
                    >
                        Удалить
                    </Text>
                </Pressable>
            </View>
        </View>
    );
}

function WeightForm({
    entry,
    defaultLoggedAt,
    backdated,
    lastKg,
    dirtyRef,
    onDone,
    theme,
}: {
    entry: { id: string; weight_g: number; date?: string } | null;
    defaultLoggedAt: string;
    backdated: boolean;
    lastKg: number | null;
    dirtyRef: React.MutableRefObject<boolean>;
    onDone: () => void;
    theme: Theme;
}) {
    const { onError } = useRequireAuth();
    const [init] = useState(() => ({
        kg: entry ? (entry.weight_g / 1000).toFixed(1) : "",
    }));
    const [kg, setKg] = useState(init.kg);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lock = useRef(false);
    // Ключ на взвешивание — переживает ретрай в открытой форме.
    const saveKey = useRef<{ sig: string; key: string } | null>(null);

    const dirty = kg !== init.kg;
    useEffect(() => {
        dirtyRef.current = dirty;
    }, [dirty, dirtyRef]);

    // База степпера: текущее введённое значение, иначе последний вес.
    const bump = (delta: number) => {
        tapBuzz();
        const cur = parseNum(kg);
        const base = cur != null && !Number.isNaN(cur) ? cur : (lastKg ?? 70);
        const next = Math.max(0, Math.round((base + delta) * 10) / 10);
        setKg(next.toFixed(1));
    };

    const save = async () => {
        const v = parseNum(kg);
        if (v == null || Number.isNaN(v)) {
            setError("Введи вес вида 78.2.");
            return;
        }
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            if (entry) {
                await patchWeight(entry.id, v);
            } else {
                const loggedAt = backdated ? defaultLoggedAt : undefined;
                const sig = JSON.stringify({ v, loggedAt: loggedAt ?? null });
                if (saveKey.current?.sig !== sig)
                    saveKey.current = { sig, key: newIdempotencyKey() };
                await addWeight(v, saveKey.current.key, loggedAt);
            }
            onDone();
        } catch (err) {
            if (onError(err)) return;
            setError("Не удалось сохранить — проверь сеть и попробуй ещё.");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };

    const del = async () => {
        if (!entry || lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            await removeWeight(entry.id);
            onDone();
        } catch (err) {
            if (onError(err)) return;
            setError("Не удалось удалить — проверь сеть и попробуй ещё.");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    };

    return (
        <>
            <View style={styles.weightStepRow}>
                <StepBtn
                    glyph="−"
                    label="Минус 0,1 кг"
                    onPress={() => bump(-0.1)}
                    theme={theme}
                />
                <Text
                    style={[
                        styles.weightStepValue,
                        TabularNums,
                        { color: theme.ink },
                    ]}
                >
                    {kg || (lastKg != null ? lastKg.toFixed(1) : "—")}
                </Text>
                <StepBtn
                    glyph="+"
                    label="Плюс 0,1 кг"
                    onPress={() => bump(0.1)}
                    theme={theme}
                />
            </View>
            <Field
                label="Вес, кг"
                value={kg}
                onChange={setKg}
                theme={theme}
                keyboard="decimal-pad"
                placeholder={lastKg != null ? lastKg.toFixed(1) : "78.2"}
            />
            {error && (
                <Text style={[styles.error, { color: theme.danger }]}>
                    {error}
                </Text>
            )}
            <SheetActions
                onSave={() => void save()}
                onDelete={entry ? () => void del() : undefined}
                busy={busy}
                canSave={dirty}
                theme={theme}
            />
        </>
    );
}

// ----- goals editor -----

export function GoalsEditor({
    visible,
    initial,
    onDone,
    onClose,
}: {
    visible: boolean;
    initial: GoalsInput;
    onDone: () => void;
    onClose: () => void;
}) {
    const theme = useTheme();
    return (
        <Sheet
            visible={visible}
            title="Дневные цели"
            onClose={onClose}
            theme={theme}
        >
            {visible && (
                <GoalsForm initial={initial} onDone={onDone} theme={theme} />
            )}
        </Sheet>
    );
}

function GoalsForm({
    initial,
    onDone,
    theme,
}: {
    initial: GoalsInput;
    onDone: () => void;
    theme: Theme;
}) {
    const [calories, setCalories] = useState(numText(initial.daily_calories));
    const [protein, setProtein] = useState(numText(initial.daily_protein_g));
    const [carbs, setCarbs] = useState(numText(initial.daily_carbs_g));
    const [fat, setFat] = useState(numText(initial.daily_fat_g));
    const [water, setWater] = useState(numText(initial.daily_water_ml));
    const [target, setTarget] = useState(numText(initial.target_weight_kg));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const { onError } = useRequireAuth();

    const save = async () => {
        const goals: GoalsInput = {
            daily_calories: parseNum(calories),
            daily_protein_g: parseNum(protein),
            daily_carbs_g: parseNum(carbs),
            daily_fat_g: parseNum(fat),
            daily_water_ml: parseNum(water),
            target_weight_kg: parseNum(target),
        };
        if (Object.values(goals).some((v) => Number.isNaN(v))) {
            setError(true);
            return;
        }
        setBusy(true);
        try {
            await saveGoals(goals);
            onDone();
        } catch (err) {
            if (onError(err)) return;
            setError(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <View style={styles.numRow}>
                <View style={styles.numCell}>
                    <Field
                        label="Калории"
                        value={calories}
                        onChange={setCalories}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
                <View style={styles.numCell}>
                    <Field
                        label="Вода, мл"
                        value={water}
                        onChange={setWater}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
            </View>
            <View style={styles.numRow}>
                <View style={styles.numCell}>
                    <Field
                        label="Белки, г"
                        value={protein}
                        onChange={setProtein}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
                <View style={styles.numCell}>
                    <Field
                        label="Углеводы, г"
                        value={carbs}
                        onChange={setCarbs}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
            </View>
            <View style={styles.numRow}>
                <View style={styles.numCell}>
                    <Field
                        label="Жиры, г"
                        value={fat}
                        onChange={setFat}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
                <View style={styles.numCell}>
                    <Field
                        label="Целевой вес, кг"
                        value={target}
                        onChange={setTarget}
                        theme={theme}
                        keyboard="decimal-pad"
                    />
                </View>
            </View>
            <Text style={[styles.hint, { color: theme.inkMuted }]}>
                Оставь поле пустым, чтобы убрать эту цель.
            </Text>
            {error && (
                <Text style={[styles.error, { color: theme.danger }]}>
                    Только числа — проверь значения и попробуй снова.
                </Text>
            )}
            <SheetActions
                onSave={() => void save()}
                busy={busy}
                theme={theme}
            />
        </>
    );
}

const styles = StyleSheet.create({
    backdropWrap: { flex: 1, justifyContent: "flex-end" },
    backdrop: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(8, 9, 5, 0.6)",
    },
    sheet: {
        width: "100%",
        maxWidth: MaxContentWidth,
        maxHeight: "88%",
        alignSelf: "center",
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        padding: Spacing.lg,
        gap: Spacing.md,
    },
    sheetBody: { flexGrow: 0 },
    sheetBodyContent: { gap: Spacing.md },
    handleZone: { gap: Spacing.md },
    grabber: {
        alignSelf: "center",
        width: 40,
        height: 4,
        borderRadius: 2,
        marginTop: -Spacing.sm,
    },
    sheetTitle: { fontFamily: Fonts.display, fontSize: 19, lineHeight: 26 },
    field: { gap: 6, flex: 1 },
    fieldLabel: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    input: {
        fontFamily: Fonts.sans,
        fontSize: 16,
        borderWidth: 1,
        borderRadius: Radii.md,
        paddingHorizontal: Spacing.md,
        paddingVertical: 12,
    },
    frequentBlock: { gap: Spacing.sm },
    frequentLabel: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 2,
    },
    frequentRow: { gap: Spacing.sm },
    frequentChip: {
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 9,
    },
    frequentChipText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    rememberChip: {
        alignSelf: "flex-start",
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 9,
    },
    rememberText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    typeRow: { flexDirection: "row", gap: Spacing.sm, flexWrap: "wrap" },
    typeChip: {
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 9,
    },
    typeChipText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    numRow: { flexDirection: "row", gap: Spacing.md },
    numCell: { flex: 1 },
    hint: { fontFamily: Fonts.sans, fontSize: 12 },
    error: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    // Read-only деталь приёма/взвешивания
    detail: { gap: Spacing.sm },
    detailEyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 2,
    },
    detailValue: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 30 },
    detailMeta: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    detailMacros: { fontFamily: Fonts.sans, fontSize: 14, marginTop: 2 },
    detailSecondary: {
        flexDirection: "row",
        justifyContent: "center",
        gap: Spacing.xl,
        marginTop: Spacing.xs,
    },
    detailAction: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    // Степперы даты/времени записи
    whenBlock: { gap: Spacing.sm },
    whenDateRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: Spacing.md,
    },
    whenDate: {
        flex: 1,
        textAlign: "center",
        fontFamily: Fonts.sansSemiBold,
        fontSize: 16,
    },
    whenTimeRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: Spacing.sm,
    },
    timeStepper: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    timeValue: {
        fontFamily: Fonts.display,
        fontSize: 26,
        minWidth: 44,
        textAlign: "center",
    },
    stepperColon: {
        fontFamily: Fonts.display,
        fontSize: 22,
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
    // Быстрый вес: крупный степпер ±0,1
    weightStepRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: Spacing.lg,
    },
    weightStepValue: {
        fontFamily: Fonts.displayHero,
        fontSize: 40,
        minWidth: 120,
        textAlign: "center",
    },
    actions: {
        gap: Spacing.sm,
        marginTop: Spacing.sm,
    },
    deleteBtn: {
        alignSelf: "center",
        paddingVertical: Spacing.sm,
    },
    deleteText: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    saveBtn: {
        borderRadius: Radii.pill,
        paddingVertical: 16,
        alignItems: "center",
    },
    saveText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
});
