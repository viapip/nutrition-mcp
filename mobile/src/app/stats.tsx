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
import { FadeIn, usePulse } from "@/components/motion";
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
    newIdempotencyKey,
    type FrequentMeal,
    type StatsData,
    type StatsDay,
} from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { kgText } from "@/lib/format";
import { successBuzz, tapBuzz } from "@/lib/haptics";

type ThemeColors = (typeof Colors)["light"] | (typeof Colors)["dark"];

const PERIODS = [7, 30, 90] as const;
type Period = (typeof PERIODS)[number];

/** день / дня / дней */
function pluralDays(n: number): string {
    const d10 = n % 10;
    const d100 = n % 100;
    if (d10 === 1 && d100 !== 11) return "день";
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "дня";
    return "дней";
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

/** 2–4 честные строки итога из уже загруженных данных — без LLM и доп. запроса. */
function buildInsights(d: {
    windowLen: number;
    loggedWindow: StatsDay[];
    goals: StatsData["goals"];
    weightSeries: StatsData["weight"]["series"];
    weightDeltaG: number | null;
}): string[] {
    const { windowLen, loggedWindow, goals, weightSeries, weightDeltaG } = d;
    const loggedCount = loggedWindow.length;
    if (loggedCount === 0) return ["Пока нет записей за этот период."];

    const lines: string[] = [];
    lines.push(
        loggedCount === windowLen
            ? `Ни одного пропуска за ${windowLen} ${pluralDays(windowLen)}.`
            : `Записано ${loggedCount} из ${windowLen} ${pluralDays(windowLen)}.`,
    );

    const avgCal = Math.round(avgOf(loggedWindow.map((x) => x.calories)));
    const cGoal = goals.daily_calories;
    if (cGoal != null) {
        const diff = avgCal - cGoal;
        lines.push(
            Math.abs(diff) < 50
                ? `Калории в среднем ${avgCal.toLocaleString("ru-RU")} ккал — у самой цели.`
                : `Калории в среднем ${avgCal.toLocaleString("ru-RU")} ккал — на ${Math.abs(diff).toLocaleString("ru-RU")} ${diff > 0 ? "выше" : "ниже"} цели.`,
        );
    } else {
        lines.push(
            `Калории в среднем ${avgCal.toLocaleString("ru-RU")} ккал в день.`,
        );
    }

    const pGoal = goals.daily_protein_g;
    if (pGoal != null) {
        const below = loggedWindow.filter((x) => x.protein_g < pGoal).length;
        lines.push(
            below === 0
                ? "Белок ни разу не просел ниже цели."
                : `Белок ниже цели ${below} ${pluralDays(below)} из ${loggedCount}.`,
        );
    }

    if (weightSeries.length >= 2 && weightDeltaG != null) {
        const absKg = kgText(Math.abs(weightDeltaG));
        lines.push(
            Math.abs(weightDeltaG) < 100
                ? `Вес держится ровно за ${windowLen} ${pluralDays(windowLen)}.`
                : `Вес ${weightDeltaG > 0 ? "вырос" : "снизился"} на ${absKg} кг за ${windowLen} ${pluralDays(windowLen)}.`,
        );
    }

    return lines.slice(0, 4);
}

/** «ИТОГИ» + «Закрыть» — видна во всех состояниях экрана (загрузка/ошибка/данные). */
function StatsTopBar({ theme }: { theme: ThemeColors }) {
    return (
        <View style={styles.topBar}>
            <Text style={[styles.eyebrow, { color: theme.inkMuted }]}>
                ИТОГИ
            </Text>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Закрыть итоги"
                onPress={() => router.back()}
                hitSlop={8}
                style={({ pressed }) => ({
                    transform: [{ scale: pressed ? 0.96 : 1 }],
                })}
            >
                <Text
                    style={[styles.closeAction, { color: theme.inkSecondary }]}
                >
                    Закрыть
                </Text>
            </Pressable>
        </View>
    );
}

function StatsSkeleton({ theme }: { theme: ThemeColors }) {
    const pulse = usePulse();

    const block = (extra: object) => [
        { backgroundColor: theme.surfaceElevated, opacity: pulse },
        extra,
    ];
    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <View style={[styles.wrap, styles.skeletonWrap]}>
                <StatsTopBar theme={theme} />
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

    const { guard, onError } = useRequireAuth();
    const [days, setDays] = useState<Period>(30);
    const [stats, setStats] = useState<StatsData | null>(null);
    const [failed, setFailed] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [added, setAdded] = useState<Record<number, boolean>>({});
    const [repeatNote, setRepeatNote] = useState<string | null>(null);
    // Ключ-на-действие по индексу частого: повтор после сбоя дедупится сервером.
    const repeatKeys = useRef<Record<number, string>>({});
    // Смена периода на лету: поздний ответ старого запроса не должен затереть новый.
    const reqSeq = useRef(0);

    const load = useCallback(async () => {
        const seq = ++reqSeq.current;
        try {
            const s = await getStats(days);
            if (seq !== reqSeq.current) return;
            setStats(s);
            // Список частого мог перестроиться — пометки/ключи по индексам неверны.
            setAdded({});
            repeatKeys.current = {};
            setFailed(false);
        } catch (err) {
            if (seq !== reqSeq.current) return;
            if (onError(err)) return;
            setFailed(true);
        }
    }, [days, onError]);

    useEffect(() => {
        guard(() => void load());
    }, [guard, load]);

    const refresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    // ref-замок по индексу: быстрый двойной тап иначе добавит два приёма.
    const inflight = useRef<Set<number>>(new Set());
    const repeatMeal = useCallback(
        async (item: FrequentMeal, i: number) => {
            if (inflight.current.has(i)) return;
            inflight.current.add(i);
            tapBuzz();
            setRepeatNote(null);
            // Ключ живёт до успеха; при успехе кнопка прячется (added[i]) —
            // сброс не нужен, повтор после сбоя переиспользует тот же ключ.
            const key = (repeatKeys.current[i] ??= newIdempotencyKey());
            try {
                await addMeal(
                    {
                        description: item.description,
                        meal_type: item.meal_type ?? "snack",
                        calories: item.calories,
                        protein_g: item.protein_g,
                        carbs_g: item.carbs_g,
                        fat_g: item.fat_g,
                    },
                    key,
                );
                successBuzz();
                setAdded((prev) => ({ ...prev, [i]: true }));
            } catch (err) {
                if (onError(err)) return;
                setRepeatNote("Не добавилось — проверь сеть и попробуй ещё.");
            } finally {
                inflight.current.delete(i);
            }
        },
        [onError],
    );

    if (!stats) {
        if (!failed) return <StatsSkeleton theme={theme} />;
        return (
            <SafeAreaView
                style={[styles.safe, { backgroundColor: theme.surface }]}
            >
                <View style={styles.wrap}>
                    <StatsTopBar theme={theme} />
                </View>
                <View style={styles.retryWrap}>
                    <Text style={[styles.retryTitle, { color: theme.ink }]}>
                        Цифры не пришли
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
                        <Text
                            style={[
                                styles.retryText,
                                { color: theme.onAccent },
                            ]}
                        >
                            Повторить
                        </Text>
                    </Pressable>
                </View>
            </SafeAreaView>
        );
    }

    const windowLen = stats.days.length;
    const loggedWindow = stats.days.filter((d) => d.logged);
    const last7 = stats.days.slice(-7);
    const logged7 = last7.filter((d) => d.logged);

    const avgWindow = Math.round(avgOf(loggedWindow.map((d) => d.calories)));
    const avg7 = Math.round(avgOf(logged7.map((d) => d.calories)));
    // При периоде «7» окно и есть неделя — второй столбец дублировал бы среднее.
    const showWeekAvg = windowLen > 7;

    const goals = stats.goals;
    // Макросы и вода следуют выбранному периоду — переключатель глобален.
    const avgProtein = avgOf(loggedWindow.map((d) => d.protein_g));
    const avgCarbs = avgOf(loggedWindow.map((d) => d.carbs_g));
    const avgFat = avgOf(loggedWindow.map((d) => d.fat_g));

    const avgWater = avgOf(loggedWindow.map((d) => d.water_ml));
    const waterGoal = goals.daily_water_ml;
    // «Закрыто N из N» — по всему окну (непрологированный день = 0 = не закрыт).
    const waterDaysHit =
        waterGoal != null
            ? stats.days.filter((d) => d.water_ml >= waterGoal).length
            : null;
    const waterPct = waterGoal ? Math.min(avgWater / waterGoal, 1) : 0;
    const periodLabel = `${windowLen} ${pluralDays(windowLen)}`;

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
    // Инлайн вместо format.weightDeltaText: подпись должна отражать окно, а не «30».
    const weightFootnote = ((): string | null => {
        const parts: string[] = [];
        if (weightDeltaG != null) {
            parts.push(
                `${weightDeltaG > 0 ? "+" : "−"}${kgText(Math.abs(weightDeltaG))} кг за ${windowLen} ${pluralDays(windowLen)}`,
            );
        }
        if (toGoalG != null) {
            parts.push(
                Math.abs(toGoalG) < 100
                    ? "цель достигнута"
                    : `до цели ${kgText(Math.abs(toGoalG))} кг`,
            );
        }
        return parts.length ? parts.join(" · ") : null;
    })();

    const insightLines = buildInsights({
        windowLen,
        loggedWindow,
        goals,
        weightSeries,
        weightDeltaG,
    });

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
                    {/* Top bar */}
                    <FadeIn delay={0}>
                        <StatsTopBar theme={theme} />
                    </FadeIn>

                    {/* Period toggle */}
                    <FadeIn delay={30}>
                        <View style={styles.segment}>
                            {PERIODS.map((p) => {
                                const active = p === days;
                                return (
                                    <Pressable
                                        key={p}
                                        accessibilityRole="button"
                                        accessibilityState={{
                                            selected: active,
                                        }}
                                        accessibilityLabel={`Период ${p} ${pluralDays(p)}`}
                                        onPress={() => {
                                            tapBuzz();
                                            setDays(p);
                                        }}
                                        style={({ pressed }) => [
                                            styles.segmentChip,
                                            {
                                                backgroundColor: active
                                                    ? theme.accent
                                                    : theme.surfaceElevated,
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
                                                styles.segmentText,
                                                TabularNums,
                                                {
                                                    color: active
                                                        ? theme.onAccent
                                                        : theme.inkSecondary,
                                                },
                                            ]}
                                        >
                                            {p}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </FadeIn>

                    {/* Streak hero */}
                    <FadeIn delay={60}>
                        <View style={styles.hero}>
                            <Text
                                style={[
                                    styles.eyebrow,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                СТРИК
                            </Text>
                            <Text
                                style={[
                                    styles.heroValue,
                                    TabularNums,
                                    streakLit
                                        ? {
                                              color: theme.accent,
                                              textShadowColor: theme.accent,
                                              textShadowOffset: {
                                                  width: 0,
                                                  height: 0,
                                              },
                                              textShadowRadius: 22,
                                          }
                                        : { color: theme.inkMuted },
                                ]}
                            >
                                {streakText}
                            </Text>
                            <Text
                                style={[
                                    styles.heroCaption,
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
                                        styles.heroHint,
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
                                    лучший — {stats.streak.best}{" "}
                                    {pluralDays(stats.streak.best)}
                                </Text>
                            )}
                        </View>
                    </FadeIn>

                    {/* Weekly insight */}
                    {insightLines.length > 0 && (
                        <FadeIn delay={90}>
                            <View
                                style={[
                                    styles.block,
                                    { backgroundColor: theme.surfaceElevated },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.eyebrow,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    КОРОТКО
                                </Text>
                                {insightLines.map((line, i) => (
                                    <View key={i} style={styles.insightRow}>
                                        <View
                                            style={[
                                                styles.insightDot,
                                                {
                                                    backgroundColor:
                                                        theme.accent,
                                                },
                                            ]}
                                        />
                                        <Text
                                            style={[
                                                styles.insightText,
                                                { color: theme.inkSecondary },
                                            ]}
                                        >
                                            {line}
                                        </Text>
                                    </View>
                                ))}
                            </View>
                        </FadeIn>
                    )}

                    {/* Calories */}
                    <FadeIn delay={120}>
                        <View
                            style={[
                                styles.block,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.eyebrow,
                                    { color: theme.inkMuted },
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
                            <View style={styles.statRow}>
                                <View style={styles.statCell}>
                                    <Text
                                        style={[
                                            styles.eyebrow,
                                            { color: theme.inkMuted },
                                        ]}
                                    >
                                        {`СРЕДНЕЕ · ${windowLen}`}
                                    </Text>
                                    <Text
                                        style={[
                                            styles.statValue,
                                            TabularNums,
                                            { color: theme.ink },
                                        ]}
                                    >
                                        {avgWindow.toLocaleString("ru-RU")}
                                        <Text
                                            style={[
                                                styles.statUnit,
                                                { color: theme.inkMuted },
                                            ]}
                                        >
                                            {" ккал"}
                                        </Text>
                                    </Text>
                                </View>
                                {showWeekAvg && (
                                    <View style={styles.statCell}>
                                        <Text
                                            style={[
                                                styles.eyebrow,
                                                { color: theme.inkMuted },
                                            ]}
                                        >
                                            ЗА НЕДЕЛЮ
                                        </Text>
                                        <Text
                                            style={[
                                                styles.statValue,
                                                TabularNums,
                                                { color: theme.ink },
                                            ]}
                                        >
                                            {avg7.toLocaleString("ru-RU")}
                                            <Text
                                                style={[
                                                    styles.statUnit,
                                                    { color: theme.inkMuted },
                                                ]}
                                            >
                                                {" ккал"}
                                            </Text>
                                        </Text>
                                    </View>
                                )}
                            </View>
                        </View>
                    </FadeIn>

                    {/* Macros */}
                    <FadeIn delay={180}>
                        <View
                            style={[
                                styles.block,
                                styles.macrosBlock,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <Text
                                style={[
                                    styles.eyebrow,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                МАКРОСЫ · {periodLabel.toUpperCase()}
                            </Text>
                            <MacroBar
                                label="Белки"
                                value={avgProtein}
                                goal={goals.daily_protein_g}
                                color={theme.protein}
                                theme={theme}
                            />
                            <MacroBar
                                label="Углеводы"
                                value={avgCarbs}
                                goal={goals.daily_carbs_g}
                                color={theme.carbs}
                                theme={theme}
                            />
                            <MacroBar
                                label="Жиры"
                                value={avgFat}
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
                                styles.block,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <View style={styles.blockHeader}>
                                <Text
                                    style={[
                                        styles.eyebrow,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    ВОДА · {periodLabel.toUpperCase()}
                                </Text>
                                <Text
                                    style={[
                                        styles.headVal,
                                        TabularNums,
                                        { color: theme.water },
                                    ]}
                                >
                                    {litreText(avgWater)}
                                    {waterGoal != null &&
                                        ` / ${litreText(waterGoal)}`}{" "}
                                    л
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
                                styles.block,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            <View style={styles.blockHeader}>
                                <Text
                                    style={[
                                        styles.eyebrow,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    ВЕС
                                </Text>
                                {lastW != null && (
                                    <Text
                                        style={[
                                            styles.headValBig,
                                            TabularNums,
                                            { color: theme.ink },
                                        ]}
                                    >
                                        {kgText(lastW.weight_g)}
                                        <Text
                                            style={[
                                                styles.statUnit,
                                                { color: theme.inkMuted },
                                            ]}
                                        >
                                            {" кг"}
                                        </Text>
                                    </Text>
                                )}
                            </View>
                            {weightSeries.length >= 2 ? (
                                <WeightSparkline
                                    series={weightSeries}
                                    targetG={stats.weight.target_g}
                                    color={theme.ink}
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
                            {weightFootnote && (
                                <Text
                                    style={[
                                        styles.footnote,
                                        TabularNums,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    {weightFootnote}
                                </Text>
                            )}
                        </View>
                    </FadeIn>

                    {/* Frequent meals */}
                    {stats.frequent.length > 0 && (
                        <FadeIn delay={360}>
                            <View
                                style={[
                                    styles.block,
                                    styles.freqBlock,
                                    { backgroundColor: theme.surfaceElevated },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.eyebrow,
                                        styles.freqEyebrow,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    ЧАСТО ЕШЬ
                                </Text>
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
                                            </Text>
                                        </View>
                                        {item.calories != null && (
                                            <View style={styles.freqKcalCell}>
                                                <Text
                                                    style={[
                                                        styles.freqKcal,
                                                        TabularNums,
                                                        { color: theme.ink },
                                                    ]}
                                                >
                                                    {item.calories.toLocaleString(
                                                        "ru-RU",
                                                    )}
                                                </Text>
                                                <Text
                                                    style={[
                                                        styles.freqKcalUnit,
                                                        {
                                                            color: theme.inkMuted,
                                                        },
                                                    ]}
                                                >
                                                    ккал
                                                </Text>
                                            </View>
                                        )}
                                        {added[i] ? (
                                            <Text
                                                style={[
                                                    styles.freqAdded,
                                                    {
                                                        color: theme.inkSecondary,
                                                    },
                                                ]}
                                            >
                                                Готово
                                            </Text>
                                        ) : (
                                            <Pressable
                                                accessibilityRole="button"
                                                accessibilityLabel={`Добавить «${item.description}» сегодня`}
                                                onPress={() =>
                                                    void repeatMeal(item, i)
                                                }
                                                hitSlop={10}
                                                style={({ pressed }) => [
                                                    styles.repeatBtn,
                                                    {
                                                        backgroundColor:
                                                            theme.surface,
                                                        transform: [
                                                            {
                                                                scale: pressed
                                                                    ? 0.94
                                                                    : 1,
                                                            },
                                                        ],
                                                    },
                                                ]}
                                            >
                                                <Text
                                                    style={[
                                                        styles.repeatIcon,
                                                        {
                                                            color: theme.inkSecondary,
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
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: Spacing.md,
        padding: Spacing.lg,
    },
    retryTitle: {
        fontFamily: Fonts.display,
        fontSize: 28,
        lineHeight: 36,
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
    topBar: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
    },
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 2.5,
    },
    closeAction: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    segment: { flexDirection: "row", gap: Spacing.xs },
    segmentChip: {
        minWidth: 52,
        paddingVertical: 8,
        paddingHorizontal: Spacing.md,
        borderRadius: Radii.pill,
        alignItems: "center",
    },
    segmentText: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    insightRow: {
        flexDirection: "row",
        alignItems: "flex-start",
        gap: Spacing.sm,
    },
    insightDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
    insightText: {
        flex: 1,
        fontFamily: Fonts.sans,
        fontSize: 14,
        lineHeight: 20,
    },
    hero: {
        paddingTop: Spacing.sm,
        paddingBottom: Spacing.md,
        gap: Spacing.xs,
    },
    heroValue: {
        fontFamily: Fonts.displayHero,
        fontSize: 68,
        lineHeight: 72,
        marginTop: Spacing.xs,
    },
    heroCaption: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    heroHint: {
        fontFamily: Fonts.sans,
        fontSize: 13,
        marginTop: Spacing.xs,
    },
    footnote: { fontFamily: Fonts.sans, fontSize: 12, lineHeight: 17 },
    block: {
        borderRadius: Radii.lg,
        paddingHorizontal: Spacing.md,
        paddingVertical: Spacing.lg,
        gap: Spacing.sm,
    },
    macrosBlock: { gap: Spacing.md },
    blockHeader: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        alignSelf: "stretch",
    },
    headVal: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    headValBig: {
        fontFamily: Fonts.displayBold,
        fontSize: 18,
        lineHeight: 24,
    },
    statRow: {
        flexDirection: "row",
        gap: Spacing.xl,
        marginTop: Spacing.xs,
    },
    statCell: { gap: 4 },
    statValue: {
        fontFamily: Fonts.displayBold,
        fontSize: 22,
        lineHeight: 28,
    },
    statUnit: { fontFamily: Fonts.sans, fontSize: 12 },
    freqBlock: { gap: 0, paddingVertical: Spacing.xs },
    freqEyebrow: { paddingTop: Spacing.md, paddingBottom: Spacing.xs },
    freqRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        paddingVertical: Spacing.md,
    },
    freqText: { flex: 1, gap: 3 },
    freqDesc: { fontFamily: Fonts.sansMedium, fontSize: 15, lineHeight: 20 },
    freqMeta: { fontFamily: Fonts.sans, fontSize: 12 },
    freqKcalCell: { alignItems: "flex-end" },
    freqKcal: { fontFamily: Fonts.displayBold, fontSize: 16, lineHeight: 20 },
    freqKcalUnit: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 9,
        letterSpacing: 1.5,
    },
    freqAdded: { fontFamily: Fonts.sansSemiBold, fontSize: 13 },
    freqNote: { paddingVertical: Spacing.sm },
    repeatBtn: {
        width: 38,
        height: 38,
        borderRadius: Radii.pill,
        alignItems: "center",
        justifyContent: "center",
    },
    repeatIcon: { fontFamily: Fonts.sans, fontSize: 17, lineHeight: 20 },
});
