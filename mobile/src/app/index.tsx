import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
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
    addWater,
    getDashboard,
    getToken,
    logout,
    removeWater,
    type DashboardData,
    type MealRow,
} from "@/lib/api";
import { tapBuzz, successBuzz } from "@/lib/haptics";

const MEAL_LABEL: Record<string, string> = {
    breakfast: "Breakfast",
    lunch: "Lunch",
    dinner: "Dinner",
    snack: "Snack",
};

const WATER_PRESETS = [150, 250, 500];

function formatDate(iso: string): string {
    return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
    });
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
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
            setData(await getDashboard());
            setFailed(false);
        } catch (err) {
            // Only a rejected token means logout; a transient server/network
            // error keeps whatever is on screen and lets the user retry.
            if (err instanceof Error && err.message === "unauthorized") {
                router.replace("/login");
            } else {
                setFailed(true);
            }
        }
    }, []);

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
                    Can’t reach{"\n"}
                    <Text style={{ color: theme.accent }}>the kitchen.</Text>
                </Text>
                <Text style={[styles.retryHint, { color: theme.inkMuted }]}>
                    Check your connection — your data is safe on the server.
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
                        Try again
                    </Text>
                </Pressable>
            </SafeAreaView>
        );
    }

    const kcalPct = data.calories.goal
        ? Math.min(data.calories.eaten / data.calories.goal, 1)
        : 0;
    const waterPct = data.water.goal_ml
        ? Math.min(data.water.total_ml / data.water.goal_ml, 1)
        : 0;
    const lastWeightPoint = data.weight.series.at(-1) ?? null;

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
                    <Text style={[styles.eyebrow, { color: theme.inkMuted }]}>
                        {formatDate(data.date).toUpperCase()}
                    </Text>
                    <View style={styles.titleRow}>
                        <Text style={[styles.h1, { color: theme.ink }]}>
                            Today
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
                                    Settings
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
                                    Goals
                                </Text>
                            </Pressable>
                        </View>
                    </View>

                    {/* Hero: calories */}
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
                            Calories
                        </Text>
                        <View style={styles.heroRow}>
                            <Text
                                style={[styles.heroValue, { color: theme.ink }]}
                            >
                                {data.calories.eaten.toLocaleString("en-US")}
                            </Text>
                            {data.calories.goal != null && (
                                <Text
                                    style={[
                                        styles.heroGoal,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    of{" "}
                                    {data.calories.goal.toLocaleString("en-US")}{" "}
                                    kcal
                                </Text>
                            )}
                        </View>
                        {data.calories.goal != null && (
                            <View
                                style={[
                                    styles.meterTrack,
                                    { backgroundColor: theme.hairline },
                                ]}
                            >
                                <View
                                    style={[
                                        styles.meterFill,
                                        {
                                            backgroundColor: theme.accent,
                                            width: `${kcalPct * 100}%`,
                                        },
                                    ]}
                                />
                            </View>
                        )}
                    </View>

                    {/* Macro rings */}
                    <View
                        style={[
                            styles.card,
                            styles.ringsRow,
                            {
                                backgroundColor: theme.surfaceElevated,
                                borderColor: theme.hairline,
                            },
                        ]}
                    >
                        <MacroRing
                            label="Protein"
                            eaten={data.macros.protein.eaten}
                            goal={data.macros.protein.goal}
                            unit="g"
                            color={theme.protein}
                            theme={theme}
                        />
                        <MacroRing
                            label="Carbs"
                            eaten={data.macros.carbs.eaten}
                            goal={data.macros.carbs.goal}
                            unit="g"
                            color={theme.carbs}
                            theme={theme}
                        />
                        <MacroRing
                            label="Fat"
                            eaten={data.macros.fat.eaten}
                            goal={data.macros.fat.goal}
                            unit="g"
                            color={theme.fat}
                            theme={theme}
                        />
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
                                Water
                            </Text>
                            <Text
                                style={[
                                    styles.cardValue,
                                    TabularNums,
                                    { color: theme.ink },
                                ]}
                            >
                                {(data.water.total_ml / 1000).toFixed(1)}
                                {data.water.goal_ml != null &&
                                    ` / ${(data.water.goal_ml / 1000).toFixed(1)}`}{" "}
                                L
                            </Text>
                        </View>
                        <WaterBars
                            byHour={data.water.by_hour}
                            color={theme.water}
                            theme={theme}
                            width={contentW}
                        />
                        <View style={styles.chipRow}>
                            {WATER_PRESETS.map((ml) => (
                                <Pressable
                                    key={ml}
                                    accessibilityRole="button"
                                    onPress={() => {
                                        tapBuzz();
                                        void addWater(ml).then(load);
                                    }}
                                    style={[
                                        styles.chip,
                                        { borderColor: theme.hairline },
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.chipText,
                                            { color: theme.water },
                                        ]}
                                    >
                                        +{ml} ml
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                        {data.water.entries.length > 0 && (
                            <View style={styles.chipRow}>
                                {data.water.entries.map((e) => (
                                    <Pressable
                                        key={e.id}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Delete ${e.amount_ml} ml`}
                                        onPress={() => {
                                            tapBuzz();
                                            void removeWater(e.id).then(load);
                                        }}
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
                                            {e.amount_ml} ml{"  "}
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
                        {data.water.goal_ml != null && (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                {Math.round(waterPct * 100)}% of daily goal —
                                tap an entry to remove it
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
                                Weight · 30 days
                            </Text>
                            {data.weight.current_g != null && (
                                <Text
                                    style={[
                                        styles.cardValue,
                                        TabularNums,
                                        { color: theme.ink },
                                    ]}
                                >
                                    {(data.weight.current_g / 1000).toFixed(1)}{" "}
                                    kg
                                </Text>
                            )}
                        </View>
                        {data.weight.series.length >= 2 && (
                            <WeightSparkline
                                series={data.weight.series}
                                targetG={data.weight.target_g}
                                color={theme.accent}
                                theme={theme}
                                width={contentW}
                            />
                        )}
                        <View style={styles.chipRow}>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() =>
                                    setWeightEditor({
                                        visible: true,
                                        entry: null,
                                    })
                                }
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
                                    Log weight
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
                                        Edit last
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                        {data.weight.target_g != null && (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                Goal: {(data.weight.target_g / 1000).toFixed(1)}{" "}
                                kg
                            </Text>
                        )}
                    </View>

                    {/* Meals */}
                    <View style={styles.titleRow}>
                        <Text style={[styles.h2, { color: theme.ink }]}>
                            Meals
                        </Text>
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
                                + Add
                            </Text>
                        </Pressable>
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
                        {data.meals.length === 0 && (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                Nothing logged yet — tell the assistant what you
                                ate.
                            </Text>
                        )}
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
                                            "Meal"
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
                            </Pressable>
                        ))}
                    </View>

                    <Pressable
                        accessibilityRole="button"
                        onPress={async () => {
                            await logout();
                            router.replace("/login");
                        }}
                    >
                        <Text
                            style={[styles.signOut, { color: theme.inkMuted }]}
                        >
                            Sign out
                        </Text>
                    </Pressable>
                </View>
            </ScrollView>

            {/* Assistant FAB */}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open assistant chat"
                onPress={() => router.push("/chat")}
                style={({ pressed }) => [
                    styles.fab,
                    {
                        backgroundColor: theme.accent,
                        opacity: pressed ? 0.9 : 1,
                    },
                ]}
            >
                <Text style={[styles.fabText, { color: theme.onAccent }]}>
                    ✳ Assistant
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
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 12,
        letterSpacing: 2.5,
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
    heroValue: { fontFamily: Fonts.sansSemiBold, fontSize: 52, lineHeight: 58 },
    heroGoal: { fontFamily: Fonts.sans, fontSize: 15 },
    meterTrack: { height: 8, borderRadius: 4, overflow: "hidden" },
    meterFill: { height: 8, borderRadius: 4 },
    ringsRow: {
        flexDirection: "row",
        justifyContent: "space-around",
        paddingVertical: Spacing.lg,
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
        paddingVertical: 7,
    },
    chipText: { fontFamily: Fonts.sansMedium, fontSize: 13 },
    footnote: { fontFamily: Fonts.sans, fontSize: 12 },
    mealsCard: { gap: 0 },
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
    mealKcal: { fontFamily: Fonts.sansSemiBold, fontSize: 15 },
    signOut: {
        fontFamily: Fonts.sansMedium,
        fontSize: 14,
        textAlign: "center",
        paddingVertical: Spacing.md,
    },
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
