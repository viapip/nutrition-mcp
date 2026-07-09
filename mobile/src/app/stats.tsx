import { router } from "expo-router";
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

import { CalorieColumns, WeightSparkline } from "@/components/charts";
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
    getStats,
    getToken,
    type FrequentMeal,
    type StatsData,
} from "@/lib/api";
import { successBuzz, tapBuzz } from "@/lib/haptics";

type ThemeColors = (typeof Colors)["light"] | (typeof Colors)["dark"];

/** день / дня / дней */
function pluralDays(n: number): string {
    const d10 = n % 10;
    const d100 = n % 100;
    if (d10 === 1 && d100 !== 11) return "день";
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "дня";
    return "дней";
}

function kgText(g: number): string {
    return (g / 1000).toLocaleString("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
}

function litreText(ml: number): string {
    return (ml / 1000).toLocaleString("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
}

function avgOf(xs: number[]): number {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Staggered entrance: fade + lift, once per mount (локальная копия из index). */
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

function StatsSkeleton({ theme }: { theme: ThemeColors }) {
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
                <Animated.View style={block(styles.skelHero)} />
                {[0, 1, 2].map((i) => (
                    <Animated.View key={i} style={block(styles.skelCard)} />
                ))}
            </View>
        </SafeAreaView>
    );
}

/** Тонкая горизонтальная полоса прогресса «среднее против цели». */
function MacroBar({
    label,
    value,
    goal,
    color,
    theme,
}: {
    label: string;
    value: number;
    goal: number | null;
    color: string;
    theme: ThemeColors;
}) {
    const pct = goal ? Math.min(value / goal, 1) : 0;
    return (
        <View
            style={macroStyles.row}
            accessible
            accessibilityLabel={`${label}: в среднем ${Math.round(value)}${
                goal != null ? ` из ${goal}` : ""
            } г в день`}
        >
            <View style={macroStyles.header}>
                <Text
                    style={[macroStyles.label, { color: theme.inkSecondary }]}
                >
                    {label}
                </Text>
                <Text
                    style={[
                        macroStyles.value,
                        TabularNums,
                        { color: theme.ink },
                    ]}
                >
                    {Math.round(value).toLocaleString("ru-RU")}
                    {goal != null && ` / ${goal.toLocaleString("ru-RU")}`} г
                </Text>
            </View>
            {goal != null && (
                <View
                    style={[
                        macroStyles.track,
                        { backgroundColor: theme.hairline },
                    ]}
                >
                    <View
                        style={[
                            macroStyles.fill,
                            {
                                backgroundColor: color,
                                width: `${Math.max(pct * 100, 1)}%`,
                            },
                        ]}
                    />
                </View>
            )}
        </View>
    );
}

const macroStyles = StyleSheet.create({
    row: { gap: 6 },
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
    },
    label: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    value: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    track: { height: 6, borderRadius: 3, overflow: "hidden" },
    fill: { height: 6, borderRadius: 3 },
});

export default function StatsScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];
    const { width } = useWindowDimensions();
    const contentW =
        Math.min(width, MaxContentWidth) - Spacing.lg * 2 - Spacing.md * 2;

    const [stats, setStats] = useState<StatsData | null>(null);
    const [failed, setFailed] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [added, setAdded] = useState<Record<number, boolean>>({});
    const [repeatNote, setRepeatNote] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const s = await getStats(30);
            setStats(s);
            // Список частого мог перестроиться — пометки по индексам неверны.
            setAdded({});
            setFailed(false);
        } catch (err) {
            if (err instanceof Error && err.message === "unauthorized") {
                router.replace("/login");
            } else {
                setFailed(true);
            }
        }
    }, []);

    useEffect(() => {
        getToken().then((t) => {
            if (!t) router.replace("/login");
            else void load();
        });
    }, [load]);

    const refresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    // ref-замок по индексу: быстрый двойной тап иначе добавит два приёма.
    const inflight = useRef<Set<number>>(new Set());
    const repeatMeal = useCallback(async (item: FrequentMeal, i: number) => {
        if (inflight.current.has(i)) return;
        inflight.current.add(i);
        tapBuzz();
        setRepeatNote(null);
        try {
            await addMeal({
                description: item.description,
                meal_type: item.meal_type ?? "snack",
                calories: item.calories,
                protein_g: item.protein_g,
                carbs_g: item.carbs_g,
                fat_g: item.fat_g,
            });
            successBuzz();
            setAdded((prev) => ({ ...prev, [i]: true }));
        } catch (err) {
            if (err instanceof Error && err.message === "unauthorized") {
                router.replace("/login");
                return;
            }
            setRepeatNote("Не добавилось — проверь сеть и попробуй ещё.");
        } finally {
            inflight.current.delete(i);
        }
    }, []);

    if (!stats) {
        if (!failed) return <StatsSkeleton theme={theme} />;
        return (
            <SafeAreaView
                style={[
                    styles.safe,
                    styles.retryWrap,
                    { backgroundColor: theme.surface },
                ]}
            >
                <Text style={[styles.retryTitle, { color: theme.ink }]}>
                    Цифры{"\n"}
                    <Text style={{ color: theme.accent }}>не пришли</Text>
                </Text>
                <Text style={[styles.retryHint, { color: theme.inkMuted }]}>
                    Проверь соединение — статистика никуда не делась.
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

    const windowLen = stats.days.length;
    const logged30 = stats.days.filter((d) => d.logged);
    const last7 = stats.days.slice(-7);
    const logged7 = last7.filter((d) => d.logged);

    const avg30 = Math.round(avgOf(logged30.map((d) => d.calories)));
    const avg7 = Math.round(avgOf(logged7.map((d) => d.calories)));

    const goals = stats.goals;
    const avgProtein7 = avgOf(logged7.map((d) => d.protein_g));
    const avgCarbs7 = avgOf(logged7.map((d) => d.carbs_g));
    const avgFat7 = avgOf(logged7.map((d) => d.fat_g));

    const avgWater7 = avgOf(logged7.map((d) => d.water_ml));
    const waterGoal = goals.daily_water_ml;
    const waterDaysHit =
        waterGoal != null
            ? stats.days.filter((d) => d.water_ml >= waterGoal).length
            : null;
    const waterPct = waterGoal ? Math.min(avgWater7 / waterGoal, 1) : 0;

    const weightSeries = stats.weight.series;
    const firstW = weightSeries[0] ?? null;
    const lastW = weightSeries.at(-1) ?? null;
    const weightDeltaG =
        firstW && lastW && weightSeries.length >= 2
            ? lastW.weight_g - firstW.weight_g
            : null;
    const toGoalG =
        lastW != null && stats.weight.target_g != null
            ? lastW.weight_g - stats.weight.target_g
            : null;

    // Стрик упирается в окно выборки — за его краем правды нет.
    const streakCapped = stats.streak.current >= windowLen;
    const streakLit = stats.streak.current > 0;
    const streakText = streakCapped
        ? `${windowLen}+`
        : String(stats.streak.current);

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
                                    ПОСЛЕДНИЕ 30 ДНЕЙ
                                </Text>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel="Закрыть итоги"
                                    onPress={() => router.back()}
                                    hitSlop={8}
                                >
                                    <Text
                                        style={[
                                            styles.headerAction,
                                            { color: theme.accent },
                                        ]}
                                    >
                                        Закрыть
                                    </Text>
                                </Pressable>
                            </View>
                            <Text style={[styles.h1, { color: theme.ink }]}>
                                Итоги
                            </Text>
                        </View>
                    </FadeIn>

                    {/* Streak hero */}
                    <FadeIn delay={60}>
                        <View
                            style={[
                                styles.card,
                                styles.streakCard,
                                {
                                    backgroundColor: theme.surfaceElevated,
                                    borderColor: theme.hairline,
                                },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.streakValue,
                                    TabularNums,
                                    streakLit
                                        ? {
                                              color: theme.accent,
                                              textShadowColor: theme.accent,
                                              textShadowOffset: {
                                                  width: 0,
                                                  height: 0,
                                              },
                                              textShadowRadius: 18,
                                          }
                                        : { color: theme.inkMuted },
                                ]}
                            >
                                {streakText}
                            </Text>
                            <Text
                                style={[
                                    styles.streakCaption,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                {streakCapped
                                    ? "дней подряд"
                                    : `${pluralDays(stats.streak.current)} подряд`}
                            </Text>
                            {!streakLit && (
                                <Text
                                    style={[
                                        styles.streakHint,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    Огонёк погас — запиши что-нибудь сегодня.
                                </Text>
                            )}
                            {stats.streak.best > 0 && (
                                <Text
                                    style={[
                                        styles.footnote,
                                        TabularNums,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    рекорд {stats.streak.best}
                                </Text>
                            )}
                        </View>
                    </FadeIn>

                    {/* Calories */}
                    <FadeIn delay={120}>
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
                                КАЛОРИИ
                            </Text>
                            <CalorieColumns
                                values={stats.days.map((d) => d.calories)}
                                goal={goals.daily_calories}
                                theme={theme}
                                width={contentW}
                            />
                            <Text
                                style={[
                                    styles.footnote,
                                    TabularNums,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                В среднем {avg30.toLocaleString("ru-RU")} ккал ·
                                за неделю {avg7.toLocaleString("ru-RU")}
                            </Text>
                        </View>
                    </FadeIn>

                    {/* Macros */}
                    <FadeIn delay={180}>
                        <View
                            style={[
                                styles.card,
                                styles.macrosCard,
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
                                БЕЛКИ · УГЛЕВОДЫ · ЖИРЫ — НЕДЕЛЯ
                            </Text>
                            <MacroBar
                                label="Белки"
                                value={avgProtein7}
                                goal={goals.daily_protein_g}
                                color={theme.protein}
                                theme={theme}
                            />
                            <MacroBar
                                label="Углеводы"
                                value={avgCarbs7}
                                goal={goals.daily_carbs_g}
                                color={theme.carbs}
                                theme={theme}
                            />
                            <MacroBar
                                label="Жиры"
                                value={avgFat7}
                                goal={goals.daily_fat_g}
                                color={theme.fat}
                                theme={theme}
                            />
                        </View>
                    </FadeIn>

                    {/* Water */}
                    <FadeIn delay={240}>
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
                                    ВОДА — НЕДЕЛЯ
                                </Text>
                                <Text
                                    style={[
                                        styles.cardValue,
                                        TabularNums,
                                        { color: theme.water },
                                    ]}
                                >
                                    {litreText(avgWater7)}
                                    {waterGoal != null &&
                                        ` / ${litreText(waterGoal)}`}{" "}
                                    л в день
                                </Text>
                            </View>
                            {waterGoal != null && (
                                <View
                                    style={[
                                        macroStyles.track,
                                        { backgroundColor: theme.hairline },
                                    ]}
                                >
                                    <View
                                        style={[
                                            macroStyles.fill,
                                            {
                                                backgroundColor: theme.water,
                                                width: `${Math.max(waterPct * 100, 1)}%`,
                                            },
                                        ]}
                                    />
                                </View>
                            )}
                            {waterDaysHit != null && (
                                <Text
                                    style={[
                                        styles.footnote,
                                        TabularNums,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    Цель закрыта {waterDaysHit} из {windowLen}{" "}
                                    {pluralDays(windowLen)}
                                </Text>
                            )}
                        </View>
                    </FadeIn>

                    {/* Weight */}
                    <FadeIn delay={300}>
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
                                    ВЕС
                                </Text>
                                {lastW != null && (
                                    <Text
                                        style={[
                                            styles.cardValue,
                                            TabularNums,
                                            { color: theme.ink },
                                        ]}
                                    >
                                        {kgText(lastW.weight_g)} кг
                                    </Text>
                                )}
                            </View>
                            {weightSeries.length >= 2 ? (
                                <WeightSparkline
                                    series={weightSeries}
                                    targetG={stats.weight.target_g}
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

                    {/* Frequent meals */}
                    {stats.frequent.length > 0 && (
                        <FadeIn delay={360}>
                            <Text style={[styles.h2, { color: theme.ink }]}>
                                Часто ешь
                            </Text>
                            <View
                                style={[
                                    styles.card,
                                    styles.frequentCard,
                                    {
                                        backgroundColor: theme.surfaceElevated,
                                        borderColor: theme.hairline,
                                    },
                                ]}
                            >
                                {stats.frequent.map((item, i) => (
                                    <View
                                        key={`${item.description}-${i}`}
                                        style={[
                                            styles.freqRow,
                                            i > 0 && {
                                                borderTopWidth: 1,
                                                borderTopColor: theme.hairline,
                                            },
                                        ]}
                                    >
                                        <View style={styles.freqText}>
                                            <Text
                                                style={[
                                                    styles.freqDesc,
                                                    { color: theme.ink },
                                                ]}
                                                numberOfLines={1}
                                            >
                                                {item.description}
                                            </Text>
                                            <Text
                                                style={[
                                                    styles.freqMeta,
                                                    TabularNums,
                                                    { color: theme.inkMuted },
                                                ]}
                                            >
                                                ×{item.count}
                                                {item.calories != null &&
                                                    ` · ${item.calories.toLocaleString("ru-RU")} ккал`}
                                            </Text>
                                        </View>
                                        {added[i] ? (
                                            <Text
                                                style={[
                                                    styles.freqAdded,
                                                    { color: theme.accent },
                                                ]}
                                            >
                                                Добавлено
                                            </Text>
                                        ) : (
                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={`Добавить «${item.description}» сегодня`}
                                                onPress={() =>
                                                    void repeatMeal(item, i)
                                                }
                                                hitSlop={10}
                                                style={styles.repeatBtn}
                                            >
                                                <Text
                                                    style={[
                                                        styles.repeatIcon,
                                                        {
                                                            color: theme.inkMuted,
                                                        },
                                                    ]}
                                                >
                                                    ↻
                                                </Text>
                                            </Pressable>
                                        )}
                                    </View>
                                ))}
                                {repeatNote && (
                                    <Text
                                        style={[
                                            styles.footnote,
                                            styles.freqNote,
                                            { color: theme.danger },
                                        ]}
                                    >
                                        {repeatNote}
                                    </Text>
                                )}
                            </View>
                        </FadeIn>
                    )}
                </View>
            </ScrollView>
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
        fontSize: 30,
        lineHeight: 40,
        textAlign: "center",
    },
    retryHint: {
        fontFamily: Fonts.sans,
        fontSize: 14,
        textAlign: "center",
    },
    retryBtn: {
        borderRadius: Radii.xl,
        paddingHorizontal: Spacing.xl,
        paddingVertical: 14,
        marginTop: Spacing.sm,
    },
    retryText: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    skeletonWrap: {
        flex: 1,
        padding: Spacing.lg,
        gap: Spacing.md,
    },
    skelLine: { width: 160, height: 14, borderRadius: 7 },
    skelTitle: { width: 180, height: 34, borderRadius: 8 },
    skelHero: { height: 160, borderRadius: Radii.lg },
    skelCard: { height: 140, borderRadius: Radii.lg },
    scroll: { paddingBottom: Spacing.xxl },
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
    headerAction: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    h1: {
        fontFamily: Fonts.display,
        fontSize: 32,
        lineHeight: 42,
    },
    h2: {
        fontFamily: Fonts.display,
        fontSize: 20,
        lineHeight: 28,
        marginTop: Spacing.sm,
        marginBottom: Spacing.sm,
    },
    card: {
        borderWidth: 1,
        borderRadius: Radii.lg,
        padding: Spacing.md,
        gap: Spacing.sm,
    },
    streakCard: {
        alignItems: "center",
        paddingVertical: Spacing.lg,
        gap: Spacing.xs,
    },
    streakValue: {
        fontFamily: Fonts.displayBold,
        fontSize: 42,
        lineHeight: 52,
    },
    streakCaption: { fontFamily: Fonts.sansMedium, fontSize: 14 },
    streakHint: {
        fontFamily: Fonts.sans,
        fontSize: 13,
        textAlign: "center",
        marginTop: Spacing.xs,
    },
    macrosCard: { gap: Spacing.md },
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
    cardValue: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    footnote: { fontFamily: Fonts.sans, fontSize: 12 },
    frequentCard: { gap: 0 },
    freqRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        paddingVertical: Spacing.md,
    },
    freqText: { flex: 1, gap: 3 },
    freqDesc: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 20 },
    freqMeta: { fontFamily: Fonts.sans, fontSize: 12 },
    freqAdded: { fontFamily: Fonts.sansSemiBold, fontSize: 13 },
    freqNote: { paddingVertical: Spacing.sm },
    repeatBtn: { paddingLeft: 2 },
    repeatIcon: { fontSize: 17, lineHeight: 20 },
});
