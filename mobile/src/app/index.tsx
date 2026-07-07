import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
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
import {
    Colors,
    Fonts,
    MaxContentWidth,
    Radii,
    Spacing,
    TabularNums,
} from "@/constants/theme";
import { getDashboard, getToken, logout, type DashboardData } from "@/lib/api";

const MEAL_LABEL: Record<string, string> = {
    breakfast: "Breakfast",
    lunch: "Lunch",
    dinner: "Dinner",
    snack: "Snack",
};

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

export default function DashboardScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];
    const { width } = useWindowDimensions();
    const contentW =
        Math.min(width, MaxContentWidth) - Spacing.lg * 2 - Spacing.md * 2;

    const [data, setData] = useState<DashboardData | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async () => {
        try {
            setData(await getDashboard());
        } catch {
            router.replace("/login");
        }
    }, []);

    useEffect(() => {
        getToken().then((t) => {
            if (!t) router.replace("/login");
            else load();
        });
    }, [load]);

    const refresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    if (!data) return null;

    const kcalPct = data.calories.goal
        ? Math.min(data.calories.eaten / data.calories.goal, 1)
        : 0;
    const waterPct = data.water.goal_ml
        ? Math.min(data.water.total_ml / data.water.goal_ml, 1)
        : 0;

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
                    <Text style={[styles.h1, { color: theme.ink }]}>Today</Text>

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
                        {data.water.goal_ml != null && (
                            <Text
                                style={[
                                    styles.footnote,
                                    { color: theme.inkMuted },
                                ]}
                            >
                                {Math.round(waterPct * 100)}% of daily goal
                            </Text>
                        )}
                    </View>

                    {/* Weight */}
                    {data.weight.series.length >= 2 && (
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
                                        {(data.weight.current_g / 1000).toFixed(
                                            1,
                                        )}{" "}
                                        kg
                                    </Text>
                                )}
                            </View>
                            <WeightSparkline
                                series={data.weight.series}
                                targetG={data.weight.target_g}
                                color={theme.accent}
                                theme={theme}
                                width={contentW}
                            />
                            {data.weight.target_g != null && (
                                <Text
                                    style={[
                                        styles.footnote,
                                        { color: theme.inkMuted },
                                    ]}
                                >
                                    Goal:{" "}
                                    {(data.weight.target_g / 1000).toFixed(1)}{" "}
                                    kg
                                </Text>
                            )}
                        </View>
                    )}

                    {/* Meals */}
                    <Text style={[styles.h2, { color: theme.ink }]}>Meals</Text>
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
                                Nothing logged yet — tell Claude what you ate.
                            </Text>
                        )}
                        {data.meals.map((meal, i) => (
                            <View
                                key={meal.id}
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
                            </View>
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
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safe: { flex: 1 },
    scroll: { paddingBottom: Spacing.xxl },
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
});
