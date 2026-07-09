import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
    type Theme,
} from "@/constants/theme";
import {
    addMeal,
    addWeight,
    getStats,
    patchMeal,
    patchWeight,
    removeMeal,
    removeWeight,
    saveGoals,
    type FrequentMeal,
    type GoalsInput,
    type MealRow,
    type MealType,
} from "@/lib/api";
import { tapBuzz } from "@/lib/haptics";

const MEAL_TYPES: { key: MealType; label: string }[] = [
    { key: "breakfast", label: "Завтрак" },
    { key: "lunch", label: "Обед" },
    { key: "dinner", label: "Ужин" },
    { key: "snack", label: "Перекус" },
];

/** Sensible default for a new meal by the local clock. */
function mealTypeNow(): MealType {
    const h = new Date().getHours();
    if (h < 11) return "breakfast";
    if (h < 16) return "lunch";
    if (h < 22) return "dinner";
    return "snack";
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
                            borderColor: theme.hairline,
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
                        borderColor: theme.hairline,
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
            />
        </View>
    );
}

function SheetActions({
    onSave,
    onDelete,
    busy,
    theme,
}: {
    onSave: () => void;
    onDelete?: () => void;
    busy: boolean;
    theme: Theme;
}) {
    return (
        <View style={styles.actions}>
            {onDelete && (
                <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                        tapBuzz();
                        confirmDelete("Удалить запись?", onDelete);
                    }}
                    disabled={busy}
                    style={[styles.deleteBtn, { borderColor: theme.danger }]}
                >
                    <Text style={[styles.deleteText, { color: theme.danger }]}>
                        Удалить
                    </Text>
                </Pressable>
            )}
            <Pressable
                accessibilityRole="button"
                onPress={() => {
                    // success feedback comes from the caller after the save
                    // actually lands — here it's just a tap acknowledgement
                    tapBuzz();
                    onSave();
                }}
                disabled={busy}
                style={({ pressed }) => [
                    styles.saveBtn,
                    {
                        backgroundColor: theme.accent,
                        opacity: pressed || busy ? 0.85 : 1,
                    },
                ]}
            >
                <Text style={[styles.saveText, { color: theme.onAccent }]}>
                    {busy ? "Сохраняю…" : "Сохранить"}
                </Text>
            </Pressable>
        </View>
    );
}

// ----- meal editor -----

export function MealEditor({
    visible,
    meal,
    onDone,
    onClose,
}: {
    visible: boolean;
    /** null = create a new meal */
    meal: MealRow | null;
    onDone: () => void;
    onClose: () => void;
}) {
    const theme = useTheme();
    return (
        <Sheet
            visible={visible}
            title={meal ? "Править еду" : "Добавить еду"}
            onClose={onClose}
            theme={theme}
        >
            {/* Remounts on every open, so state re-inits from props. */}
            {visible && <MealForm meal={meal} onDone={onDone} theme={theme} />}
        </Sheet>
    );
}

function MealForm({
    meal,
    onDone,
    theme,
}: {
    meal: MealRow | null;
    onDone: () => void;
    theme: Theme;
}) {
    const [description, setDescription] = useState(meal?.description ?? "");
    const [mealType, setMealType] = useState<MealType>(
        (meal?.meal_type as MealType) ?? mealTypeNow(),
    );
    const [calories, setCalories] = useState(numText(meal?.calories));
    const [protein, setProtein] = useState(numText(meal?.protein_g));
    const [carbs, setCarbs] = useState(numText(meal?.carbs_g));
    const [fat, setFat] = useState(numText(meal?.fat_g));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const [frequent, setFrequent] = useState<FrequentMeal[]>([]);

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
                if (err instanceof Error && err.message === "unauthorized") {
                    router.replace("/login");
                }
            });
        return () => {
            alive = false;
        };
    }, [meal]);

    const fillFrom = (f: FrequentMeal) => {
        tapBuzz();
        setDescription(f.description);
        if (f.meal_type) setMealType(f.meal_type);
        setCalories(numText(f.calories));
        setProtein(numText(f.protein_g));
        setCarbs(numText(f.carbs_g));
        setFat(numText(f.fat_g));
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
            setError(true);
            return;
        }
        setBusy(true);
        try {
            const fields = {
                description: description.trim(),
                meal_type: mealType,
                ...nums,
            };
            if (meal) await patchMeal(meal.id, fields);
            else await addMeal(fields);
            onDone();
        } catch {
            setError(true);
        } finally {
            setBusy(false);
        }
    };

    const del = async () => {
        if (!meal) return;
        setBusy(true);
        try {
            await removeMeal(meal.id);
            onDone();
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
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
                                        ? theme.accentSoft
                                        : theme.surface,
                                    borderColor: active
                                        ? theme.accent
                                        : theme.hairline,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.typeChipText,
                                    {
                                        color: active
                                            ? theme.accent
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
            {error && (
                <Text style={[styles.error, { color: theme.danger }]}>
                    Проверь описание и числа, потом попробуй снова.
                </Text>
            )}
            <SheetActions
                onSave={() => void save()}
                onDelete={meal ? () => void del() : undefined}
                busy={busy}
                theme={theme}
            />
        </>
    );
}

// ----- weight editor -----

export function WeightEditor({
    visible,
    entry,
    onDone,
    onClose,
}: {
    visible: boolean;
    /** null = log a new weigh-in */
    entry: { id: string; weight_g: number } | null;
    onDone: () => void;
    onClose: () => void;
}) {
    const theme = useTheme();
    return (
        <Sheet
            visible={visible}
            title={entry ? "Править взвешивание" : "Записать вес"}
            onClose={onClose}
            theme={theme}
        >
            {visible && (
                <WeightForm entry={entry} onDone={onDone} theme={theme} />
            )}
        </Sheet>
    );
}

function WeightForm({
    entry,
    onDone,
    theme,
}: {
    entry: { id: string; weight_g: number } | null;
    onDone: () => void;
    theme: Theme;
}) {
    const [kg, setKg] = useState(
        entry ? (entry.weight_g / 1000).toFixed(1) : "",
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);

    const save = async () => {
        const v = parseNum(kg);
        if (v == null || Number.isNaN(v)) {
            setError(true);
            return;
        }
        setBusy(true);
        try {
            if (entry) await patchWeight(entry.id, v);
            else await addWeight(v);
            onDone();
        } catch {
            setError(true);
        } finally {
            setBusy(false);
        }
    };

    const del = async () => {
        if (!entry) return;
        setBusy(true);
        try {
            await removeWeight(entry.id);
            onDone();
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Field
                label="Вес, кг"
                value={kg}
                onChange={setKg}
                theme={theme}
                keyboard="decimal-pad"
                placeholder="78.2"
            />
            {error && (
                <Text style={[styles.error, { color: theme.danger }]}>
                    Введи вес вида 78.2.
                </Text>
            )}
            <SheetActions
                onSave={() => void save()}
                onDelete={entry ? () => void del() : undefined}
                busy={busy}
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
        } catch {
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
        backgroundColor: "rgba(18, 13, 7, 0.55)",
    },
    sheet: {
        width: "100%",
        maxWidth: MaxContentWidth,
        maxHeight: "88%",
        alignSelf: "center",
        borderTopLeftRadius: Radii.lg,
        borderTopRightRadius: Radii.lg,
        borderWidth: 1,
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
        borderRadius: Radii.xl,
        paddingHorizontal: Spacing.md,
        paddingVertical: 9,
    },
    frequentChipText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    typeRow: { flexDirection: "row", gap: Spacing.sm, flexWrap: "wrap" },
    typeChip: {
        borderWidth: 1,
        borderRadius: Radii.lg,
        paddingHorizontal: Spacing.md,
        paddingVertical: 8,
    },
    typeChipText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    numRow: { flexDirection: "row", gap: Spacing.md },
    numCell: { flex: 1 },
    hint: { fontFamily: Fonts.sans, fontSize: 12 },
    error: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    actions: {
        flexDirection: "row",
        gap: Spacing.md,
        marginTop: Spacing.sm,
    },
    deleteBtn: {
        borderWidth: 1,
        borderRadius: Radii.xl,
        paddingVertical: 14,
        paddingHorizontal: Spacing.lg,
        alignItems: "center",
    },
    deleteText: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    saveBtn: {
        flex: 1,
        borderRadius: Radii.xl,
        paddingVertical: 14,
        alignItems: "center",
    },
    saveText: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
});
