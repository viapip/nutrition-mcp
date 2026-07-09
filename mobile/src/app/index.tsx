import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Animated,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    useColorScheme,
    useWindowDimensions,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { MacroRing, WaterBars, WeightSparkline } from "@/components/charts";
import { GoalsEditor, MealEditor, WeightEditor } from "@/components/editors";
import {
    Colors,
    Fonts,
    MaxContentWidth,
    Radii,
    Spacing,
    TabularNums,
} from "@/constants/theme";
import {
    addMeal,
    addWater,
    getDashboard,
    getToken,
    removeWater,
    type DashboardData,
    type MealRow,
} from "@/lib/api";
import { tapBuzz, successBuzz } from "@/lib/haptics";

const MEAL_LABEL: Record<string, string> = {
    breakfast: "Завтрак",
    lunch: "Обед",
    dinner: "Ужин",
    snack: "Перекус",
};

const WATER_PRESETS = [150, 250, 500];

function formatDate(iso: string): string {
    return new Date(`${iso}T12:00:00`).toLocaleDateString("ru-RU", {
        weekday: "long",
        month: "long",
        day: "numeric",
    });
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("ru-RU", {
        hour: "numeric",
        minute: "2-digit",
    });
}

function shiftDate(iso: string, days: number): string {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** «Сегодня», «Вчера», иначе «5 июля». */
function dayTitle(iso: string, today: string): string {
    if (iso === today) return "Сегодня";
    if (iso === shiftDate(today, -1)) return "Вчера";
    return new Date(`${iso}T12:00:00`).toLocaleDateString("ru-RU", {
        month: "long",
        day: "numeric",
    });
}

function kgText(g: number): string {
    return (g / 1000).toLocaleString("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
}

/** Pulsing placeholder shown while the first dashboard load is in flight. */
function DashboardSkeleton({
    theme,
}: {
    theme: (typeof Colors)["light"] | (typeof Colors)["dark"];
}) {
    const [pulse] = useState(() => new Animated.Value(0.35));
    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(pulse, {
                    toValue: 0.75,
                    duration: 700,
                    useNativeDriver: true,
                }),
                Animated.timing(pulse, {
                    toValue: 0.35,
                    duration: 700,
                    useNativeDriver: true,
                }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [pulse]);

    const block = (extra: object) => [
        { backgroundColor: theme.surfaceElevated, opacity: pulse },
        extra,
    ];
    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <View style={[styles.wrap, styles.skeletonWrap]}>
                <Animated.View style={block(styles.skelLine)} />
                <Animated.View style={block(styles.skelTitle)} />
                <View style={styles.skelRings}>
                    {[0, 1, 2].map((i) => (
                        <Animated.View key={i} style={block(styles.skelRing)} />
                    ))}
                </View>
                <Animated.View style={block(styles.skelCard)} />
                {[0, 1, 2].map((i) => (
                    <Animated.View key={i} style={block(styles.skelRow)} />
                ))}
            </View>
        </SafeAreaView>
    );
}

export default function DashboardScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];
    const { width } = useWindowDimensions();
    const contentW =
        Math.min(width, MaxContentWidth) - Spacing.lg * 2 - Spacing.md * 2;

    const [data, setData] = useState<DashboardData | null>(null);
    const [failed, setFailed] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    // null = сегодня; строка YYYY-MM-DD = просмотр прошлого дня
    const [viewDate, setViewDate] = useState<string | null>(null);
    // Дата «сегодня» по серверу — опора для стрелок навигации
    const [todayDate, setTodayDate] = useState<string | null>(null);
    const [waterNote, setWaterNote] = useState<string | null>(null);
    const [waterBusy, setWaterBusy] = useState(false);
    const waterLock = useRef(false);
    const [mealEditor, setMealEditor] = useState<{
        visible: boolean;
        meal: MealRow | null;
    }>({ visible: false, meal: null });
    const [weightEditor, setWeightEditor] = useState<{
        visible: boolean;
        entry: { id: string; weight_g: number } | null;
    }>({ visible: false, entry: null });
    const [goalsVisible, setGoalsVisible] = useState(false);

    const load = useCallback(async () => {
        try {
            const d = await getDashboard(viewDate ?? undefined);
            setData(d);
            if (viewDate == null) setTodayDate(d.date);
            setFailed(false);
        } catch (err) {
            // Only a rejected token means logout; a transient server/network
            // error keeps whatever is on screen and lets the user retry.
            if (err instanceof Error && err.message === "unauthorized") {
                router.replace("/login");
            } else {
                setFailed(true);
                // Day switch failed — snap viewDate back to the day still on
                // screen so actions/labels match the visible data.
                setData((cur) => {
                    if (cur) {
                        setViewDate(
                            todayDate == null || cur.date === todayDate
                                ? null
                                : cur.date,
                        );
                    }
                    return cur;
                });
            }
        }
    }, [viewDate, todayDate]);

    // Reload whenever the screen regains focus (e.g. returning from chat,
    // where the assistant may have logged something).
    useFocusEffect(
        useCallback(() => {
            getToken().then((t) => {
                if (!t) router.replace("/login");
                else load();
            });
        }, [load]),
    );

    const refresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const closeEditors = useCallback(() => {
        setMealEditor({ visible: false, meal: null });
        setWeightEditor({ visible: false, entry: null });
        setGoalsVisible(false);
    }, []);

    const editorDone = useCallback(() => {
        successBuzz();
        closeEditors();
        void load();
    }, [closeEditors, load]);

    const isToday = viewDate == null;

    const bumpWater = useCallback((ml: number) => {
        setData((cur) =>
            cur
                ? {
                      ...cur,
                      water: {
                          ...cur.water,
                          total_ml: cur.water.total_ml + ml,
                      },
                  }
                : cur,
        );
    }, []);

    const drinkWater = useCallback(
        async (ml: number) => {
            // ref lock: state updates are async, a fast double-tap slips past
            if (waterLock.current) return;
            waterLock.current = true;
            tapBuzz();
            setWaterBusy(true);
            setWaterNote(null);
            // Optimistic total — the bars catch up after the reload.
            bumpWater(ml);
            try {
                await addWater(ml);
                await load();
            } catch (err) {
                if (err instanceof Error && err.message === "unauthorized") {
                    router.replace("/login");
                    return;
                }
                // Roll the bump back first: if the reload below also dies
                // offline, the screen must not keep phantom millilitres.
                bumpWater(-ml);
                setWaterNote("Не записалось — проверь сеть и попробуй ещё.");
                void load();
            } finally {
                waterLock.current = false;
                setWaterBusy(false);
            }
        },
        [bumpWater, load],
    );

    const deleteWater = useCallback(
        async (id: string) => {
            tapBuzz();
            setWaterNote(null);
            try {
                await removeWater(id);
                await load();
            } catch (err) {
                if (err instanceof Error && err.message === "unauthorized") {
                    router.replace("/login");
                    return;
                }
                setWaterNote("Не удалилось — проверь сеть и попробуй ещё.");
            }
        },
        [load],
    );

    // «Повторить приём»: копия записи логируется сейчас, поэтому прыгаем на сегодня.
    const repeatMeal = useCallback(
        async (meal: MealRow) => {
            tapBuzz();
            try {
                await addMeal({
                    description: meal.description,
                    meal_type: meal.meal_type ?? "snack",
                    calories: meal.calories,
                    protein_g: meal.protein_g,
                    carbs_g: meal.carbs_g,
                    fat_g: meal.fat_g,
                });
                successBuzz();
                if (viewDate == null) void load();
                else setViewDate(null);
            } catch {
                // тихий сбой здесь хуже молчания — но повтор не критичен
            }
        },
        [load, viewDate],
    );

    // Hooks stay above the early returns
    const kcalGoal = data?.calories.goal ?? null;
    const kcalEaten = data?.calories.eaten ?? 0;
    const kcalPct = kcalGoal ? Math.min(kcalEaten / kcalGoal, 1) : 0;
    const [meterAnim] = useState(() => new Animated.Value(0));
    useEffect(() => {
        Animated.timing(meterAnim, {
            toValue: kcalPct,
            duration: 600,
            useNativeDriver: false, // width % can't ride the native driver
        }).start();
    }, [kcalPct, meterAnim]);

    if (!data) {
        if (!failed) return <DashboardSkeleton theme={theme} />;
        return (
            <SafeAreaView
                style={[
                    styles.safe,
                    styles.retryWrap,
                    { backgroundColor: theme.surface },
                ]}
            >
                <Text style={[styles.retryTitle, { color: theme.ink }]}>
                    Кухня{"\n"}
                    <Text style={{ color: theme.accent }}>не отвечает.</Text>
                </Text>
                <Text style={[styles.retryHint, { color: theme.inkMuted }]}>
                    Проверь соединение — данные целы на сервере.
                </Text>
                <Pressable
                    accessibilityRole="button"
                    onPress={() => void load()}
                    style={({ pressed }) => [
                        styles.retryBtn,
                        {
                            borderColor: theme.hairline,
                            backgroundColor: theme.surfaceElevated,
                            opacity: pressed ? 0.7 : 1,
                        },
                    ]}
                >
                    <Text style={[styles.retryText, { color: theme.ink }]}>
                        Повторить
                    </Text>
                </Pressable>
            </SafeAreaView>
        );
    }

    const waterPct = data.water.goal_ml
        ? Math.min(data.water.total_ml / data.water.goal_ml, 1)
        : 0;
    const kcalOver = kcalGoal != null && kcalEaten > kcalGoal;
    const lastWeightPoint = data.weight.series.at(-1) ?? null;
    const firstWeightPoint = data.weight.series[0] ?? null;
    const weightDeltaG =
        lastWeightPoint && firstWeightPoint && data.weight.series.length >= 2
            ? lastWeightPoint.weight_g - firstWeightPoint.weight_g
            : null;
    const toGoalG =
        data.weight.current_g != null && data.weight.target_g != null
            ? data.weight.current_g - data.weight.target_g
            : null;
    const today = todayDate ?? data.date;

    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <ScrollView
                contentContainerStyle={styles.scroll}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={refresh}
                    />
                }
            >
                <View style={styles.wrap}>
                    {/* Header: date with prev/next day arrows */}
                    <View style={styles.dateRow}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Предыдущий день"
                            onPress={() => {
                                tapBuzz();
                                setViewDate(shiftDate(data.date, -1));
                            }}
                            hitSlop={10}
                        >
                            <Text
                                style={[
                                    styles.dateArrow,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                ‹
                            </Text>
                        </Pressable>
                        <Text
                            style={[styles.eyebrow, { color: theme.inkMuted }]}
                        >
                            {formatDate(data.date).toUpperCase()}
                        </Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Следующий день"
                            disabled={isToday}
                            onPress={() => {
                                tapBuzz();
                                const next = shiftDate(data.date, 1);
                                setViewDate(next >= today ? null : next);
                            }}
                            hitSlop={10}
                        >
                            <Text
                                style={[
                                    styles.dateArrow,
                                    {
                                        color: isToday
                                            ? "transparent"
                                            : theme.inkSecondary,
                                    },
                                ]}
                            >
                                ›
                            </Text>
                        </Pressable>
                    </View>
                    <View style={styles.titleRow}>
                        <Text style={[styles.h1, { color: theme.ink }]}>
                            {dayTitle(data.date, today)}
                        </Text>
                        <View style={styles.headerActions}>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => router.push("/settings")}
                                hitSlop={8}
                            >
                                <Text
                                    style={[
                                        styles.headerAction,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    Настройки
                                </Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => setGoalsVisible(true)}
                                hitSlop={8}
                            >
                                <Text
                                    style={[
                                        styles.headerAction,
                                        { color: theme.accent },
                                    ]}
                                >
                                    Цели
                                </Text>
                            </Pressable>
                        </View>
                    </View>
                    {!isToday && (
                        <Pressable
                            accessibilityRole="button"
                            onPress={() => setViewDate(null)}
                            hitSlop={8}
                        >
                            <Text
                                style={[
                                    styles.backToday,
                                    { color: theme.accent },
                                ]}
                            >
                                ↩ Вернуться к сегодня
                            </Text>
                        </Pressable>
                    )}

                    {/* Hero: calories + macro rings in one block */}
                    <View
                        style={[
                            styles.card,
                            {
                                backgroundColor: theme.surfaceElevated,
                                borderColor: theme.hairline,
                            },
                        ]}
                    >
                        <Text
                            style={[
                                styles.cardLabel,
                                { color: theme.inkSecondary },
                            ]}
                        >
                            Калории
                        </Text>
                        <View style={styles.heroRow}>
                            <Text
                                style={[styles.heroValue, { color: theme.ink }]}
                            >
                                {data.calories.eaten.toLocaleString("ru-RU")}
                            </Text>
                            {kcalGoal != null && (
                                <Text
                                    style={[
                                        styles.heroGoal,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    из {kcalGoal.toLocaleString("ru-RU")} ккал
                                </Text>
                            )}
                        </View>
                        {kcalGoal != null && (
                            <View
                                style={[
                                    styles.meterTrack,
                                    { backgroundColor: theme.hairline },
                                ]}
                            >
                                <Animated.View
                                    style={[
                                        styles.meterFill,
                                        {
                                            backgroundColor: kcalOver
                                                ? theme.danger
                                                : theme.accent,
                                            width: meterAnim.interpolate({
                                                inputRange: [0, 1],
                                                outputRange: ["0%", "100%"],
                                            }),
                                        },
                                    ]}
                                />
                            </View>
                        )}
                        {kcalOver && (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.danger },
                                ]}
                            >
                                Перебор на{" "}
                                {(kcalEaten - kcalGoal!).toLocaleString(
                                    "ru-RU",
                                )}{" "}
                                ккал
                            </Text>
                        )}
                        <View style={styles.ringsRow}>
                            <MacroRing
                                label="Белки"
                                eaten={data.macros.protein.eaten}
                                goal={data.macros.protein.goal}
                                unit="г"
                                color={theme.protein}
                                theme={theme}
                            />
                            <MacroRing
                                label="Углеводы"
                                eaten={data.macros.carbs.eaten}
                                goal={data.macros.carbs.goal}
                                unit="г"
                                color={theme.carbs}
                                theme={theme}
                            />
                            <MacroRing
                                label="Жиры"
                                eaten={data.macros.fat.eaten}
                                goal={data.macros.fat.goal}
                                unit="г"
                                color={theme.fat}
                                theme={theme}
                            />
                        </View>
                    </View>

                    {/* Water */}
                    <View
                        style={[
                            styles.card,
                            {
                                backgroundColor: theme.surfaceElevated,
                                borderColor: theme.hairline,
                            },
                        ]}
                    >
                        <View style={styles.cardHeader}>
                            <Text
                                style={[
                                    styles.cardLabel,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                Вода
                            </Text>
                            <Text
                                style={[
                                    styles.cardValue,
                                    TabularNums,
                                    { color: theme.ink },
                                ]}
                            >
                                {(data.water.total_ml / 1000).toLocaleString(
                                    "ru-RU",
                                    {
                                        minimumFractionDigits: 1,
                                        maximumFractionDigits: 1,
                                    },
                                )}
                                {data.water.goal_ml != null &&
                                    ` / ${(
                                        data.water.goal_ml / 1000
                                    ).toLocaleString("ru-RU", {
                                        minimumFractionDigits: 1,
                                        maximumFractionDigits: 1,
                                    })}`}{" "}
                                л
                            </Text>
                        </View>
                        <WaterBars
                            byHour={data.water.by_hour}
                            color={theme.water}
                            theme={theme}
                            width={contentW}
                        />
                        {isToday && (
                            <View style={styles.chipRow}>
                                {WATER_PRESETS.map((ml) => (
                                    <Pressable
                                        key={ml}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Добавить ${ml} мл воды`}
                                        disabled={waterBusy}
                                        onPress={() => void drinkWater(ml)}
                                        hitSlop={{ top: 8, bottom: 8 }}
                                        style={[
                                            styles.chip,
                                            {
                                                borderColor: theme.hairline,
                                                opacity: waterBusy ? 0.5 : 1,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.chipText,
                                                { color: theme.water },
                                            ]}
                                        >
                                            +{ml} мл
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                        )}
                        {data.water.entries.length > 0 && (
                            <View style={styles.chipRow}>
                                {data.water.entries.map((e) => (
                                    <Pressable
                                        key={e.id}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Удалить ${e.amount_ml} мл (${formatTime(e.logged_at)})`}
                                        onPress={() => void deleteWater(e.id)}
                                        hitSlop={{ top: 8, bottom: 8 }}
                                        style={[
                                            styles.chip,
                                            {
                                                borderColor: theme.hairline,
                                                backgroundColor: theme.surface,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.chipText,
                                                TabularNums,
                                                { color: theme.inkSecondary },
                                            ]}
                                        >
                                            {e.amount_ml} мл ·{" "}
                                            {formatTime(e.logged_at)}
                                            {"  "}
                                            <Text
                                                style={{
                                                    color: theme.inkMuted,
                                                }}
                                            >
                                                ×
                                            </Text>
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                        )}
                        {waterNote && (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.danger },
                                ]}
                            >
                                {waterNote}
                            </Text>
                        )}
                        {data.water.entries.length === 0 && isToday && (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                Ни капли за день — начни со стакана.
                            </Text>
                        )}
                        {data.water.goal_ml != null &&
                            data.water.entries.length > 0 && (
                                <Text
                                    style={[
                                        styles.footnote,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    {Math.round(waterPct * 100)}% дневной цели —
                                    тапни запись, чтобы удалить
                                </Text>
                            )}
                    </View>

                    {/* Weight */}
                    <View
                        style={[
                            styles.card,
                            {
                                backgroundColor: theme.surfaceElevated,
                                borderColor: theme.hairline,
                            },
                        ]}
                    >
                        <View style={styles.cardHeader}>
                            <Text
                                style={[
                                    styles.cardLabel,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                Вес · 30 дней
                            </Text>
                            {data.weight.current_g != null && (
                                <Text
                                    style={[
                                        styles.cardValue,
                                        TabularNums,
                                        { color: theme.ink },
                                    ]}
                                >
                                    {kgText(data.weight.current_g)} кг
                                </Text>
                            )}
                        </View>
                        {data.weight.series.length >= 2 ? (
                            <WeightSparkline
                                series={data.weight.series}
                                targetG={data.weight.target_g}
                                color={theme.accent}
                                theme={theme}
                                width={contentW}
                            />
                        ) : (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                Запиши вес дважды — появится тренд.
                            </Text>
                        )}
                        {isToday && (
                            <View style={styles.chipRow}>
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() =>
                                        setWeightEditor({
                                            visible: true,
                                            entry: null,
                                        })
                                    }
                                    hitSlop={{ top: 8, bottom: 8 }}
                                    style={[
                                        styles.chip,
                                        { borderColor: theme.hairline },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.chipText,
                                            { color: theme.accent },
                                        ]}
                                    >
                                        Записать вес
                                    </Text>
                                </Pressable>
                                {lastWeightPoint && (
                                    <Pressable
                                        accessibilityRole="button"
                                        onPress={() =>
                                            setWeightEditor({
                                                visible: true,
                                                entry: lastWeightPoint,
                                            })
                                        }
                                        hitSlop={{ top: 8, bottom: 8 }}
                                        style={[
                                            styles.chip,
                                            { borderColor: theme.hairline },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.chipText,
                                                { color: theme.inkSecondary },
                                            ]}
                                        >
                                            Править последнее
                                        </Text>
                                    </Pressable>
                                )}
                            </View>
                        )}
                        {(weightDeltaG != null || toGoalG != null) && (
                            <Text
                                style={[
                                    styles.footnote,
                                    TabularNums,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                {weightDeltaG != null &&
                                    `${weightDeltaG > 0 ? "+" : "−"}${kgText(
                                        Math.abs(weightDeltaG),
                                    )} кг за 30 дней`}
                                {weightDeltaG != null &&
                                    toGoalG != null &&
                                    " · "}
                                {toGoalG != null &&
                                    (Math.abs(toGoalG) < 100
                                        ? "цель достигнута"
                                        : `до цели ${kgText(Math.abs(toGoalG))} кг`)}
                            </Text>
                        )}
                    </View>

                    {/* Meals */}
                    <View style={styles.titleRow}>
                        <Text style={[styles.h2, { color: theme.ink }]}>
                            Еда
                        </Text>
                        {isToday && (
                            <Pressable
                                accessibilityRole="button"
                                onPress={() =>
                                    setMealEditor({ visible: true, meal: null })
                                }
                                hitSlop={8}
                            >
                                <Text
                                    style={[
                                        styles.headerAction,
                                        { color: theme.accent },
                                    ]}
                                >
                                    + Добавить
                                </Text>
                            </Pressable>
                        )}
                    </View>
                    <View
                        style={[
                            styles.card,
                            styles.mealsCard,
                            {
                                backgroundColor: theme.surfaceElevated,
                                borderColor: theme.hairline,
                            },
                        ]}
                    >
                        {data.meals.length === 0 &&
                            (isToday ? (
                                <View style={styles.emptyMeals}>
                                    <Text
                                        style={[
                                            styles.emptyMealsText,
                                            { color: theme.inkSecondary },
                                        ]}
                                    >
                                        Тарелка пуста — расскажи ассистенту или
                                        добавь вручную.
                                    </Text>
                                    <View style={styles.chipRow}>
                                        <Pressable
                                            accessibilityRole="button"
                                            onPress={() =>
                                                setMealEditor({
                                                    visible: true,
                                                    meal: null,
                                                })
                                            }
                                            style={[
                                                styles.chip,
                                                {
                                                    borderColor: theme.hairline,
                                                },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.chipText,
                                                    { color: theme.accent },
                                                ]}
                                            >
                                                Добавить вручную
                                            </Text>
                                        </Pressable>
                                        <Pressable
                                            accessibilityRole="button"
                                            onPress={() => router.push("/chat")}
                                            style={[
                                                styles.chip,
                                                {
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
                                                Спросить ассистента
                                            </Text>
                                        </Pressable>
                                    </View>
                                </View>
                            ) : (
                                <Text
                                    style={[
                                        styles.footnote,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    В этот день записей нет.
                                </Text>
                            ))}
                        {data.meals.map((meal, i) => (
                            <Pressable
                                key={meal.id}
                                accessibilityRole="button"
                                onPress={() =>
                                    setMealEditor({ visible: true, meal })
                                }
                                style={[
                                    styles.mealRow,
                                    i > 0 && {
                                        borderTopWidth: 1,
                                        borderTopColor: theme.hairline,
                                    },
                                ]}
                            >
                                <View style={styles.mealText}>
                                    <Text
                                        style={[
                                            styles.mealMeta,
                                            { color: theme.inkMuted },
                                        ]}
                                    >
                                        {(
                                            MEAL_LABEL[meal.meal_type ?? ""] ??
                                            "Приём"
                                        ).toUpperCase()}
                                        {" · "}
                                        {formatTime(meal.logged_at)}
                                    </Text>
                                    <Text
                                        style={[
                                            styles.mealDesc,
                                            { color: theme.ink },
                                        ]}
                                        numberOfLines={2}
                                    >
                                        {meal.description}
                                    </Text>
                                    {(meal.protein_g != null ||
                                        meal.carbs_g != null ||
                                        meal.fat_g != null) && (
                                        <Text
                                            style={[
                                                styles.mealMacros,
                                                TabularNums,
                                                { color: theme.inkMuted },
                                            ]}
                                        >
                                            {[
                                                meal.protein_g != null &&
                                                    `Б ${Math.round(meal.protein_g)}`,
                                                meal.carbs_g != null &&
                                                    `У ${Math.round(meal.carbs_g)}`,
                                                meal.fat_g != null &&
                                                    `Ж ${Math.round(meal.fat_g)}`,
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </Text>
                                    )}
                                </View>
                                {meal.calories != null && (
                                    <Text
                                        style={[
                                            styles.mealKcal,
                                            TabularNums,
                                            { color: theme.inkSecondary },
                                        ]}
                                    >
                                        {meal.calories}
                                    </Text>
                                )}
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel="Повторить приём сегодня"
                                    onPress={() => void repeatMeal(meal)}
                                    hitSlop={10}
                                    style={styles.repeatBtn}
                                >
                                    <Text
                                        style={[
                                            styles.repeatIcon,
                                            { color: theme.inkMuted },
                                        ]}
                                    >
                                        ↻
                                    </Text>
                                </Pressable>
                            </Pressable>
                        ))}
                    </View>
                </View>
            </ScrollView>

            {/* Assistant FAB */}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Открыть чат с ассистентом"
                onPress={() => router.push("/chat")}
                style={({ pressed }) => [
                    styles.fab,
                    {
                        backgroundColor: theme.accent,
                        transform: [{ scale: pressed ? 0.95 : 1 }],
                    },
                ]}
            >
                <Text style={[styles.fabText, { color: theme.onAccent }]}>
                    ✳ Ассистент
                </Text>
            </Pressable>

            <MealEditor
                visible={mealEditor.visible}
                meal={mealEditor.meal}
                onDone={editorDone}
                onClose={closeEditors}
            />
            <WeightEditor
                visible={weightEditor.visible}
                entry={weightEditor.entry}
                onDone={editorDone}
                onClose={closeEditors}
            />
            <GoalsEditor
                visible={goalsVisible}
                initial={{
                    daily_calories: data.calories.goal,
                    daily_protein_g: data.macros.protein.goal,
                    daily_carbs_g: data.macros.carbs.goal,
                    daily_fat_g: data.macros.fat.goal,
                    daily_water_ml: data.water.goal_ml,
                    target_weight_kg:
                        data.weight.target_g == null
                            ? null
                            : data.weight.target_g / 1000,
                }}
                onDone={editorDone}
                onClose={closeEditors}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1 },
    retryWrap: {
        alignItems: "center",
        justifyContent: "center",
        gap: Spacing.md,
        padding: Spacing.lg,
    },
    retryTitle: {
        fontFamily: Fonts.display,
        fontSize: 32,
        lineHeight: 38,
        textAlign: "center",
    },
    retryHint: {
        fontFamily: Fonts.sans,
        fontSize: 14,
        textAlign: "center",
    },
    retryBtn: {
        borderWidth: 1,
        borderRadius: Radii.lg,
        paddingHorizontal: Spacing.lg,
        paddingVertical: 12,
        marginTop: Spacing.sm,
    },
    retryText: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    skeletonWrap: {
        flex: 1,
        padding: Spacing.lg,
        gap: Spacing.md,
    },
    skelLine: { width: 140, height: 14, borderRadius: 7 },
    skelTitle: { width: 220, height: 34, borderRadius: 8 },
    skelRings: {
        flexDirection: "row",
        justifyContent: "space-between",
        marginVertical: Spacing.md,
    },
    skelRing: { width: 92, height: 92, borderRadius: 46 },
    skelCard: { height: 140, borderRadius: Radii.lg },
    skelRow: { height: 64, borderRadius: Radii.md },
    scroll: { paddingBottom: Spacing.xxl * 2 },
    wrap: {
        width: "100%",
        maxWidth: MaxContentWidth,
        alignSelf: "center",
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.md,
        gap: Spacing.md,
    },
    dateRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        alignSelf: "flex-start",
    },
    dateArrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 22,
        lineHeight: 24,
        paddingHorizontal: 2,
    },
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 12,
        letterSpacing: 2.5,
    },
    backToday: {
        fontFamily: Fonts.sansMedium,
        fontSize: 14,
    },
    titleRow: {
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
    },
    headerActions: { flexDirection: "row", gap: Spacing.md },
    headerAction: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    h1: {
        fontFamily: Fonts.display,
        fontSize: 40,
        lineHeight: 46,
        marginTop: -Spacing.sm,
    },
    h2: {
        fontFamily: Fonts.display,
        fontSize: 24,
        lineHeight: 30,
        marginTop: Spacing.sm,
    },
    card: {
        borderWidth: 1,
        borderRadius: Radii.lg,
        padding: Spacing.md,
        gap: Spacing.sm,
    },
    cardHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
    },
    cardLabel: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    cardValue: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    heroRow: { flexDirection: "row", alignItems: "baseline", gap: Spacing.sm },
    heroValue: { fontFamily: Fonts.display, fontSize: 54, lineHeight: 62 },
    heroGoal: { fontFamily: Fonts.sans, fontSize: 15 },
    meterTrack: { height: 8, borderRadius: 4, overflow: "hidden" },
    meterFill: { height: 8, borderRadius: 4 },
    ringsRow: {
        flexDirection: "row",
        justifyContent: "space-around",
        paddingTop: Spacing.md,
    },
    chipRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: Spacing.sm,
    },
    chip: {
        borderWidth: 1,
        borderRadius: Radii.lg,
        paddingHorizontal: Spacing.md,
        paddingVertical: 9,
    },
    chipText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    footnote: { fontFamily: Fonts.sans, fontSize: 12 },
    mealsCard: { gap: 0 },
    emptyMeals: { gap: Spacing.md, paddingVertical: Spacing.sm },
    emptyMealsText: { fontFamily: Fonts.sans, fontSize: 14, lineHeight: 20 },
    mealRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        paddingVertical: Spacing.md,
    },
    mealText: { flex: 1, gap: 2 },
    mealMeta: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 10,
        letterSpacing: 1.5,
    },
    mealDesc: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 20 },
    mealMacros: { fontFamily: Fonts.sans, fontSize: 12 },
    mealKcal: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    repeatBtn: { paddingLeft: 2 },
    repeatIcon: { fontSize: 17, lineHeight: 20 },
    fab: {
        position: "absolute",
        bottom: Spacing.lg,
        alignSelf: "center",
        borderRadius: 28,
        paddingHorizontal: Spacing.lg,
        paddingVertical: 14,
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
    },
    fabText: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
});
