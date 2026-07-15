import { router, useFocusEffect, type Href } from "expo-router";
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

import {
    WaterBars,
    WeekStrip,
    WeightSparkline,
    type WeekDay,
} from "@/components/charts";
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
    getStats,
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

// Экран статистики создаётся параллельно; typed routes подхватят маршрут
// после генерации .expo/types — до тех пор нужен каст.
const STATS_ROUTE = "/stats" as Href;

// Кэш стрика по «сегодня» сервера (end); любая запись дня сбрасывает
let streakCache: { day: string; current: number } | null = null;

// Глобаль переживает logout — login.tsx сбрасывает, иначе виден чужой стрик
export function resetStreakCache() {
    streakCache = null;
}

/** 1 день, 2 дня, 5 дней. */
function dayWord(n: number): string {
    const d10 = n % 10;
    const d100 = n % 100;
    if (d100 >= 11 && d100 <= 14) return "дней";
    if (d10 === 1) return "день";
    if (d10 >= 2 && d10 <= 4) return "дня";
    return "дней";
}

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

function greeting(): string {
    const h = new Date().getHours();
    if (h < 5) return "Доброй ночи";
    if (h < 12) return "Доброе утро";
    if (h < 18) return "Добрый день";
    return "Добрый вечер";
}

function kgText(g: number): string {
    return (g / 1000).toLocaleString("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
}

/** Staggered entrance: fade + lift, once per mount. */
function FadeIn({
    delay,
    children,
}: {
    delay: number;
    children: React.ReactNode;
}) {
    const [anim] = useState(() => new Animated.Value(0));
    useEffect(() => {
        Animated.timing(anim, {
            toValue: 1,
            duration: 420,
            delay,
            useNativeDriver: true,
        }).start();
    }, [anim, delay]);
    return (
        <Animated.View
            style={{
                opacity: anim,
                transform: [
                    {
                        translateY: anim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [14, 0],
                        }),
                    },
                ],
            }}
        >
            {children}
        </Animated.View>
    );
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
                <Animated.View style={block(styles.skelStrip)} />
                <Animated.View style={block(styles.skelHero)} />
                <Animated.View style={block(styles.skelBlock)} />
                <Animated.View style={block(styles.skelBlock)} />
                {[0, 1].map((i) => (
                    <Animated.View key={i} style={block(styles.skelRow)} />
                ))}
            </View>
        </SafeAreaView>
    );
}

/** Строка макроса: подпись слева, тонкий бар по центру, «96 / 140 г» справа. */
function MacroRow({
    label,
    eaten,
    goal,
    color,
    theme,
}: {
    label: string;
    eaten: number;
    goal: number | null;
    color: string;
    theme: (typeof Colors)["light"] | (typeof Colors)["dark"];
}) {
    const pct = goal ? Math.min(eaten / goal, 1) : 0;
    const over = goal != null && eaten > goal;
    return (
        <View
            style={macroStyles.row}
            accessible
            accessibilityLabel={`${label}: ${Math.round(eaten)}${
                goal != null ? ` из ${Math.round(goal)}` : ""
            } г`}
        >
            <Text style={[macroStyles.label, { color: theme.inkSecondary }]}>
                {label}
            </Text>
            <View
                style={[macroStyles.track, { backgroundColor: theme.hairline }]}
            >
                <View
                    style={[
                        macroStyles.fill,
                        {
                            backgroundColor: color,
                            width: `${Math.max(pct * 100, 2)}%`,
                        },
                    ]}
                />
            </View>
            <Text
                style={[
                    macroStyles.value,
                    TabularNums,
                    { color: over ? theme.danger : theme.ink },
                ]}
            >
                {Math.round(eaten)}
                {goal != null && ` / ${Math.round(goal)}`} г
            </Text>
        </View>
    );
}

const macroStyles = StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
    label: { width: 64, fontFamily: Fonts.sansMedium, fontSize: 13 },
    track: { flex: 1, height: 6, borderRadius: 3, overflow: "hidden" },
    fill: { height: 6, borderRadius: 3 },
    value: { fontFamily: Fonts.sansSemiBold, fontSize: 13 },
});

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
    // Дата «сегодня» по серверу — опора для навигации
    const [todayDate, setTodayDate] = useState<string | null>(null);
    // Прошлые 6 дней недели: date → {pct, over}; сегодня считается из data
    const [pastWeek, setPastWeek] = useState<Record<string, WeekDay>>({});
    const [waterNote, setWaterNote] = useState<string | null>(null);
    const [waterBusy, setWaterBusy] = useState(false);
    const waterLock = useRef(false);
    const repeatLock = useRef(false);
    const [mealEditor, setMealEditor] = useState<{
        visible: boolean;
        meal: MealRow | null;
    }>({ visible: false, meal: null });
    const [weightEditor, setWeightEditor] = useState<{
        visible: boolean;
        entry: { id: string; weight_g: number } | null;
    }>({ visible: false, entry: null });
    const [goalsVisible, setGoalsVisible] = useState(false);
    const [streak, setStreak] = useState<number | null>(null);

    // Отсекает устаревший ответ, когда editorDone перезапросил стрик раньше.
    const streakSeq = useRef(0);
    const loadStreak = useCallback(async (serverToday?: string | null) => {
        if (
            streakCache &&
            streakCache.day === (serverToday ?? streakCache.day)
        ) {
            setStreak(streakCache.current);
            return;
        }
        const seq = ++streakSeq.current;
        try {
            const s = await getStats(30);
            if (seq !== streakSeq.current) return;
            streakCache = { day: s.end, current: s.streak.current };
            setStreak(s.streak.current);
        } catch {
            // без статистики бейдж просто не показывается
        }
    }, []);

    // 6 прошлых дней — отдельными запросами, weekSeq отсекает устаревший залп;
    // прошлое меняют только редакторы, на фокус не перезагружаем
    const weekLoadedFor = useRef<string | null>(null);
    const weekSeq = useRef(0);
    const loadWeek = useCallback(async (today: string) => {
        const seq = ++weekSeq.current;
        const dates = Array.from({ length: 6 }, (_, i) =>
            shiftDate(today, i - 6),
        );
        const results = await Promise.allSettled(
            dates.map((d) => getDashboard(d)),
        );
        if (seq !== weekSeq.current) return;
        const next: Record<string, WeekDay> = {};
        results.forEach((r, i) => {
            const date = dates[i]!;
            if (r.status !== "fulfilled") {
                // Пусть следующий фокус экрана попробует добрать день ещё раз.
                weekLoadedFor.current = null;
                next[date] = { date, pct: null, over: false };
                return;
            }
            const { eaten, goal } = r.value.calories;
            next[date] = {
                date,
                pct: goal ? eaten / goal : null,
                over: goal != null && eaten > goal,
            };
        });
        setPastWeek(next);
    }, []);

    // Отсекает устаревший ответ, когда день перещёлкнули до прихода первого.
    const loadSeq = useRef(0);
    const load = useCallback(async () => {
        const seq = ++loadSeq.current;
        try {
            const d = await getDashboard(viewDate ?? undefined);
            if (seq !== loadSeq.current) return;
            setData(d);
            if (viewDate == null) {
                setTodayDate(d.date);
                if (weekLoadedFor.current !== d.date) {
                    weekLoadedFor.current = d.date;
                    void loadWeek(d.date);
                }
                // Сервер перешагнул на новый день — вчерашний стрик неактуален.
                if (streakCache && streakCache.day !== d.date) {
                    streakCache = null;
                    void loadStreak();
                }
            }
            setFailed(false);
        } catch (err) {
            // Only a rejected token means logout; a transient server/network
            // error keeps whatever is on screen and lets the user retry.
            if (err instanceof Error && err.message === "unauthorized") {
                router.replace("/login");
            } else if (seq === loadSeq.current) {
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
    }, [viewDate, todayDate, loadWeek, loadStreak]);

    // Reload whenever the screen regains focus (e.g. returning from chat,
    // where the assistant may have logged something).
    useFocusEffect(
        useCallback(() => {
            getToken().then((t) => {
                if (!t) {
                    router.replace("/login");
                    return;
                }
                load();
                // Возврат из чата мог изменить сегодняшнюю серию — не доверяем
                // дневному кэшу, перезапрашиваем стрик.
                streakCache = null;
                void loadStreak(todayDate);
            });
        }, [load, loadStreak, todayDate]),
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
        // Правка могла коснуться прошлого дня — обновляем и полосу недели.
        if (todayDate) void loadWeek(todayDate);
        streakCache = null;
        void loadStreak();
    }, [closeEditors, load, loadWeek, loadStreak, todayDate]);

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
                // Первый стакан за день двигает стрик — сбрасываем кэш бейджа.
                streakCache = null;
                await load();
                void loadStreak(todayDate);
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
        [bumpWater, load, loadStreak, todayDate],
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
            // ref-замок: быстрый двойной тап иначе пишет два одинаковых приёма.
            if (repeatLock.current) return;
            repeatLock.current = true;
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
                streakCache = null;
                void loadStreak(todayDate);
                if (viewDate == null) void load();
                else setViewDate(null);
            } catch {
                // тихий сбой здесь хуже молчания — но повтор не критичен
            } finally {
                repeatLock.current = false;
            }
        },
        [load, viewDate, loadStreak, todayDate],
    );

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
                    <Text style={{ color: theme.accent }}>молчит</Text>
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
                            backgroundColor: theme.accent,
                            transform: [{ scale: pressed ? 0.97 : 1 }],
                        },
                    ]}
                >
                    <Text style={[styles.retryText, { color: theme.onAccent }]}>
                        Повторить
                    </Text>
                </Pressable>
            </SafeAreaView>
        );
    }

    const kcalGoal = data.calories.goal;
    const kcalEaten = data.calories.eaten;
    const kcalOver = kcalGoal != null && kcalEaten > kcalGoal;
    const kcalLeft = kcalGoal != null ? kcalGoal - kcalEaten : null;
    const kcalPct = kcalGoal ? Math.min(kcalEaten / kcalGoal, 1) : 0;
    // Герой: остаток / перебор / просто съедено (когда цели нет)
    const heroEyebrow = kcalOver
        ? "ПЕРЕБОР"
        : kcalGoal == null
          ? "СЪЕДЕНО"
          : isToday
            ? "ОСТАЛОСЬ СЕГОДНЯ"
            : "ОСТАЛОСЬ";
    const heroValue = kcalGoal == null ? kcalEaten : Math.abs(kcalLeft ?? 0);
    const heroSub =
        kcalGoal != null
            ? `${kcalEaten.toLocaleString("ru-RU")} из ${kcalGoal.toLocaleString("ru-RU")} ккал`
            : "ккал за сегодня";
    const waterPct = data.water.goal_ml
        ? Math.min(data.water.total_ml / data.water.goal_ml, 1)
        : 0;
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
    const showStreak = streak != null && streak > 0;
    const streakLabel =
        streak != null && streak >= 30
            ? "30+ дней"
            : `${streak ?? 0} ${dayWord(streak ?? 0)}`;

    // Неделя: 6 прошлых дней из pastWeek + сегодняшний слот из живых данных.
    const weekDays: WeekDay[] = Array.from({ length: 6 }, (_, i) => {
        const date = shiftDate(today, i - 6);
        return pastWeek[date] ?? { date, pct: null, over: false };
    });
    weekDays.push(
        data.date === today
            ? {
                  date: today,
                  pct: kcalGoal ? kcalEaten / kcalGoal : null,
                  over: kcalOver,
              }
            : (pastWeek[today] ?? { date: today, pct: null, over: false }),
    );

    const selectDay = (date: string) => {
        tapBuzz();
        setViewDate(date === today ? null : date);
    };

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
                    {/* Header */}
                    <FadeIn delay={0}>
                        <View style={styles.titleBlock}>
                            <View style={styles.eyebrowRow}>
                                <Text
                                    style={[
                                        styles.eyebrow,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    {(isToday
                                        ? greeting()
                                        : formatDate(data.date)
                                    ).toUpperCase()}
                                </Text>
                                <View style={styles.headerActions}>
                                    {!showStreak && (
                                        <Pressable
                                            accessibilityRole="button"
                                            onPress={() =>
                                                router.push(STATS_ROUTE)
                                            }
                                            hitSlop={8}
                                        >
                                            <Text
                                                style={[
                                                    styles.headerAction,
                                                    { color: theme.inkMuted },
                                                ]}
                                            >
                                                Итоги
                                            </Text>
                                        </Pressable>
                                    )}
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
                            <View style={styles.h1Row}>
                                <Text style={[styles.h1, { color: theme.ink }]}>
                                    {dayTitle(data.date, today)}
                                </Text>
                                {showStreak && (
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Стрик ${streakLabel}, открыть итоги`}
                                        onPress={() => {
                                            tapBuzz();
                                            router.push(STATS_ROUTE);
                                        }}
                                        hitSlop={8}
                                        style={({ pressed }) => [
                                            styles.streakBadge,
                                            {
                                                backgroundColor:
                                                    theme.accentSoft,
                                                transform: [
                                                    {
                                                        scale: pressed
                                                            ? 0.96
                                                            : 1,
                                                    },
                                                ],
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.streakText,
                                                TabularNums,
                                                { color: theme.accent },
                                            ]}
                                        >
                                            ✦ {streakLabel}
                                        </Text>
                                    </Pressable>
                                )}
                            </View>
                        </View>
                    </FadeIn>

                    {/* Week navigation: arrows reach past the strip */}
                    <FadeIn delay={60}>
                        <View style={styles.weekRow}>
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
                                        styles.weekArrow,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    ‹
                                </Text>
                            </Pressable>
                            <View style={styles.weekStripWrap}>
                                <WeekStrip
                                    days={weekDays}
                                    selected={data.date}
                                    today={today}
                                    theme={theme}
                                    // Ширина строки минус стрелки с зазорами
                                    width={
                                        Math.min(width, MaxContentWidth) -
                                        Spacing.lg * 2 -
                                        56
                                    }
                                    onSelect={selectDay}
                                />
                            </View>
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
                                        styles.weekArrow,
                                        {
                                            color: isToday
                                                ? "transparent"
                                                : theme.inkMuted,
                                        },
                                    ]}
                                >
                                    ›
                                </Text>
                            </Pressable>
                        </View>
                        {!isToday && (
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => setViewDate(null)}
                                hitSlop={8}
                                style={[
                                    styles.backToday,
                                    { backgroundColor: theme.accentSoft },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.backTodayText,
                                        { color: theme.accent },
                                    ]}
                                >
                                    ↩ К сегодняшнему дню
                                </Text>
                            </Pressable>
                        )}
                    </FadeIn>

                    {/* Hero: остаток калорий гигантской цифрой прямо на surface */}
                    <FadeIn delay={120}>
                        <View
                            style={styles.hero}
                            accessible
                            accessibilityLabel={`Калории: съедено ${kcalEaten}${
                                kcalGoal != null ? ` из ${kcalGoal}` : ""
                            } ккал`}
                        >
                            <Text
                                style={[
                                    styles.heroEyebrow,
                                    {
                                        color: kcalOver
                                            ? theme.danger
                                            : theme.inkMuted,
                                    },
                                ]}
                            >
                                {heroEyebrow}
                            </Text>
                            <Text
                                style={[
                                    styles.heroNumber,
                                    TabularNums,
                                    {
                                        color: kcalOver
                                            ? theme.danger
                                            : theme.accent,
                                    },
                                ]}
                            >
                                {heroValue.toLocaleString("ru-RU")}
                            </Text>
                            <Text
                                style={[
                                    styles.heroSub,
                                    TabularNums,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                {heroSub}
                            </Text>
                            {kcalGoal != null && (
                                <View
                                    style={[
                                        styles.heroTrack,
                                        {
                                            backgroundColor:
                                                theme.surfaceElevated,
                                        },
                                    ]}
                                >
                                    <View
                                        style={[
                                            styles.heroFill,
                                            {
                                                backgroundColor: kcalOver
                                                    ? theme.danger
                                                    : theme.accent,
                                                width: `${Math.max(kcalPct * 100, 2)}%`,
                                            },
                                        ]}
                                    />
                                </View>
                            )}
                        </View>
                    </FadeIn>

                    {/* Макросы: три строки-бара на приподнятом блоке */}
                    <FadeIn delay={180}>
                        <View
                            style={[
                                styles.block,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <MacroRow
                                label="Белки"
                                eaten={data.macros.protein.eaten}
                                goal={data.macros.protein.goal}
                                color={theme.protein}
                                theme={theme}
                            />
                            <MacroRow
                                label="Углеводы"
                                eaten={data.macros.carbs.eaten}
                                goal={data.macros.carbs.goal}
                                color={theme.carbs}
                                theme={theme}
                            />
                            <MacroRow
                                label="Жиры"
                                eaten={data.macros.fat.eaten}
                                goal={data.macros.fat.goal}
                                color={theme.fat}
                                theme={theme}
                            />
                        </View>
                    </FadeIn>

                    {/* Water */}
                    <FadeIn delay={240}>
                        <View
                            style={[
                                styles.block,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <View style={styles.cardHeader}>
                                <Text
                                    style={[
                                        styles.cardLabel,
                                        { color: theme.inkSecondary },
                                    ]}
                                >
                                    ВОДА
                                </Text>
                                <Text
                                    style={[
                                        styles.cardValue,
                                        TabularNums,
                                        { color: theme.ink },
                                    ]}
                                >
                                    {(
                                        data.water.total_ml / 1000
                                    ).toLocaleString("ru-RU", {
                                        minimumFractionDigits: 1,
                                        maximumFractionDigits: 1,
                                    })}
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
                                            style={({ pressed }) => [
                                                styles.chip,
                                                {
                                                    backgroundColor:
                                                        theme.accentSoft,
                                                    opacity: waterBusy
                                                        ? 0.5
                                                        : 1,
                                                    transform: [
                                                        {
                                                            scale: pressed
                                                                ? 0.96
                                                                : 1,
                                                        },
                                                    ],
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
                                            onPress={() =>
                                                void deleteWater(e.id)
                                            }
                                            hitSlop={{ top: 8, bottom: 8 }}
                                            style={[
                                                styles.chipGhost,
                                                {
                                                    borderColor: theme.hairline,
                                                },
                                            ]}
                                        >
                                            <Text
                                                style={[
                                                    styles.chipText,
                                                    TabularNums,
                                                    {
                                                        color: theme.inkSecondary,
                                                    },
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
                                        {Math.round(waterPct * 100)}% дневной
                                        цели — тапни запись, чтобы удалить
                                    </Text>
                                )}
                        </View>
                    </FadeIn>

                    {/* Weight */}
                    <FadeIn delay={300}>
                        <View
                            style={[
                                styles.block,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <View style={styles.cardHeader}>
                                <Text
                                    style={[
                                        styles.cardLabel,
                                        { color: theme.inkSecondary },
                                    ]}
                                >
                                    ВЕС · 30 ДНЕЙ
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
                                            {
                                                backgroundColor:
                                                    theme.accentSoft,
                                            },
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
                                                styles.chipGhost,
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
                    </FadeIn>

                    {/* Meals */}
                    <FadeIn delay={360}>
                        <View style={styles.titleRow}>
                            <Text style={[styles.h2, { color: theme.ink }]}>
                                Еда
                            </Text>
                            {isToday && (
                                <Pressable
                                    accessibilityRole="button"
                                    onPress={() =>
                                        setMealEditor({
                                            visible: true,
                                            meal: null,
                                        })
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
                                styles.block,
                                styles.mealsCard,
                                { backgroundColor: theme.surfaceElevated },
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
                                            Тарелка пуста — расскажи ассистенту
                                            или добавь вручную.
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
                                                        backgroundColor:
                                                            theme.accentSoft,
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
                                                    Добавить вручную
                                                </Text>
                                            </Pressable>
                                            <Pressable
                                                accessibilityRole="button"
                                                onPress={() =>
                                                    router.push("/chat")
                                                }
                                                style={[
                                                    styles.chipGhost,
                                                    {
                                                        borderColor:
                                                            theme.hairline,
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
                                                { color: theme.accent },
                                            ]}
                                        >
                                            {(
                                                MEAL_LABEL[
                                                    meal.meal_type ?? ""
                                                ] ?? "Приём"
                                            ).toUpperCase()}
                                            <Text
                                                style={{
                                                    color: theme.inkMuted,
                                                }}
                                            >
                                                {"  "}
                                                {formatTime(meal.logged_at)}
                                            </Text>
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
                                                { color: theme.ink },
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
                    </FadeIn>
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
                        shadowColor: theme.accent,
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
        fontFamily: Fonts.displayHero,
        fontSize: 44,
        lineHeight: 48,
        textAlign: "center",
    },
    retryHint: {
        fontFamily: Fonts.sans,
        fontSize: 14,
        textAlign: "center",
    },
    retryBtn: {
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.xl,
        paddingVertical: 16,
        marginTop: Spacing.sm,
    },
    retryText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    skeletonWrap: {
        flex: 1,
        padding: Spacing.lg,
        gap: Spacing.md,
    },
    skelLine: { width: 140, height: 14, borderRadius: 7 },
    skelTitle: { width: 220, height: 34, borderRadius: 8 },
    skelStrip: { height: 52, borderRadius: Radii.xl },
    skelHero: { width: 240, height: 72, borderRadius: 12 },
    skelBlock: { height: 120, borderRadius: Radii.xl },
    skelRow: { height: 64, borderRadius: Radii.xl },
    scroll: { paddingBottom: Spacing.xxl * 2 },
    wrap: {
        width: "100%",
        maxWidth: MaxContentWidth,
        alignSelf: "center",
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.md,
        gap: Spacing.md,
    },
    titleBlock: { gap: Spacing.xs },
    eyebrowRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 3,
    },
    h1: {
        fontFamily: Fonts.display,
        fontSize: 32,
        lineHeight: 42,
    },
    h1Row: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    streakBadge: {
        borderRadius: Radii.pill,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    streakText: { fontFamily: Fonts.sansSemiBold, fontSize: 13 },
    weekRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.sm,
    },
    weekStripWrap: { flex: 1 },
    weekArrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 24,
        lineHeight: 26,
        paddingHorizontal: 2,
        marginTop: -14,
    },
    backToday: {
        alignSelf: "flex-start",
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 8,
        marginTop: Spacing.sm,
    },
    backTodayText: { fontFamily: Fonts.sansSemiBold, fontSize: 13 },
    titleRow: {
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
    },
    headerActions: { flexDirection: "row", gap: Spacing.md },
    headerAction: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    h2: {
        fontFamily: Fonts.display,
        fontSize: 20,
        lineHeight: 28,
        marginTop: Spacing.sm,
    },
    block: {
        borderRadius: Radii.xl,
        padding: Spacing.lg,
        gap: Spacing.md,
    },
    hero: {
        paddingTop: Spacing.sm,
        paddingBottom: Spacing.xs,
        gap: Spacing.xs,
    },
    heroEyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 3,
    },
    heroNumber: {
        fontFamily: Fonts.displayHero,
        fontSize: 68,
        lineHeight: 74,
    },
    heroSub: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    heroTrack: {
        height: 7,
        borderRadius: Radii.pill,
        overflow: "hidden",
        marginTop: Spacing.sm,
    },
    heroFill: { height: 7, borderRadius: Radii.pill },
    cardHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        alignSelf: "stretch",
    },
    cardLabel: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 2,
    },
    cardValue: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
    chipRow: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: Spacing.sm,
    },
    chip: {
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.md,
        paddingVertical: 10,
    },
    chipGhost: {
        borderWidth: 1,
        borderRadius: Radii.pill,
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
    mealText: { flex: 1, gap: 3 },
    mealMeta: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 10,
        letterSpacing: 1.5,
    },
    mealDesc: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 20 },
    mealMacros: { fontFamily: Fonts.sans, fontSize: 12 },
    mealKcal: { fontFamily: Fonts.displayBold, fontSize: 17 },
    repeatBtn: { paddingLeft: 2 },
    repeatIcon: { fontSize: 17, lineHeight: 20 },
    fab: {
        position: "absolute",
        bottom: Spacing.lg,
        alignSelf: "center",
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.xl,
        paddingVertical: 16,
        shadowOpacity: 0.5,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 8 },
        elevation: 10,
    },
    fabText: { fontFamily: Fonts.sansSemiBold, fontSize: 16 },
});
