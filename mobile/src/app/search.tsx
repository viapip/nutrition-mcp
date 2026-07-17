import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    useColorScheme,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Spark } from "@/components/Spark";
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
    newIdempotencyKey,
    searchMeals,
    type MealRow,
} from "@/lib/api";
import { useRequireAuth } from "@/lib/auth";
import { successBuzz, tapBuzz } from "@/lib/haptics";

const MEAL_LABEL: Record<string, string> = {
    breakfast: "Завтрак",
    lunch: "Обед",
    dinner: "Ужин",
    snack: "Перекус",
};

const DEBOUNCE_MS = 300;

type Status = "idle" | "loading" | "ready" | "error";

/** «12 июля» — исходная дата приёма, чтобы различать одинаковые описания. */
function formatDay(iso: string): string {
    return new Date(iso).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
    });
}

/** «Б 46 · У 62 · Ж 22» — как на дашборде, только заданные макросы. */
function macrosLine(meal: MealRow): string {
    return [
        meal.protein_g != null && `Б ${Math.round(meal.protein_g)}`,
        meal.carbs_g != null && `У ${Math.round(meal.carbs_g)}`,
        meal.fat_g != null && `Ж ${Math.round(meal.fat_g)}`,
    ]
        .filter(Boolean)
        .join(" · ");
}

export default function SearchScreen() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];
    const { onError } = useRequireAuth();

    const [query, setQuery] = useState("");
    const [status, setStatus] = useState<Status>("idle");
    const [results, setResults] = useState<MealRow[]>([]);
    // id приёмов, уже перезаписанных в этой выдаче — для инлайнового «Добавлено».
    const [added, setAdded] = useState<Set<string>>(new Set());
    const [note, setNote] = useState<string | null>(null);
    const [retry, setRetry] = useState(0);
    const [focused, setFocused] = useState(false);

    // Отсекает устаревший ответ, если запрос сменили до его прихода.
    const seq = useRef(0);
    // ref-замок по id: быстрый двойной тап иначе запишет два одинаковых приёма.
    const inflight = useRef<Set<string>>(new Set());

    // Дебаунс: правим состояние только внутри таймера — синхронный setState в
    // теле эффекта запрещён (каскадные ре-рендеры). Пока печатают, экран держит
    // прежнюю выдачу и не мигает; «загрузка» встаёт прямо перед запросом.
    useEffect(() => {
        const timer = setTimeout(() => {
            const mine = ++seq.current;
            const q = query.trim();
            if (!q) {
                setStatus("idle");
                setResults([]);
                return;
            }
            setStatus("loading");
            searchMeals(q)
                .then((meals) => {
                    if (mine !== seq.current) return;
                    setResults(meals);
                    setAdded(new Set());
                    setStatus("ready");
                })
                .catch((err) => {
                    if (mine !== seq.current) return;
                    if (onError(err)) return;
                    setStatus("error");
                });
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, retry, onError]);

    // Перезапись = НОВЫЙ приём сегодня; свежий ключ на каждый тап, замок ловит
    // двойной тап одного жеста, а не осознанный повтор.
    const relog = async (meal: MealRow) => {
        if (inflight.current.has(meal.id)) return;
        inflight.current.add(meal.id);
        tapBuzz();
        setNote(null);
        try {
            await addMeal(
                {
                    description: meal.description,
                    meal_type: meal.meal_type ?? "snack",
                    calories: meal.calories,
                    protein_g: meal.protein_g,
                    carbs_g: meal.carbs_g,
                    fat_g: meal.fat_g,
                },
                newIdempotencyKey(),
            );
            successBuzz();
            setAdded((prev) => new Set(prev).add(meal.id));
        } catch (err) {
            if (onError(err)) return;
            setNote("Не записалось — проверь сеть и попробуй ещё.");
        } finally {
            inflight.current.delete(meal.id);
        }
    };

    return (
        <SafeAreaView style={[styles.safe, { backgroundColor: theme.surface }]}>
            <View style={styles.wrap}>
                {/* Header */}
                <View style={styles.header}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Назад к дашборду"
                        onPress={() => router.back()}
                        hitSlop={12}
                    >
                        <Text style={[styles.back, { color: theme.accent }]}>
                            ← Сегодня
                        </Text>
                    </Pressable>
                </View>

                <Text style={[styles.eyebrow, { color: theme.inkMuted }]}>
                    ИСТОРИЯ · ПОИСК
                </Text>

                <TextInput
                    style={[
                        styles.input,
                        {
                            backgroundColor: theme.surfaceElevated,
                            borderColor: focused
                                ? theme.accent
                                : theme.surfaceElevated,
                            color: theme.ink,
                        },
                    ]}
                    placeholder="Что ты уже ел…"
                    placeholderTextColor={theme.inkMuted}
                    cursorColor={theme.accent}
                    selectionColor={theme.accent}
                    value={query}
                    onChangeText={setQuery}
                    autoFocus
                    autoCorrect={false}
                    returnKeyType="search"
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                />

                {note && (
                    <Text style={[styles.note, { color: theme.danger }]}>
                        {note}
                    </Text>
                )}

                <ScrollView
                    style={styles.flex}
                    contentContainerStyle={styles.results}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                >
                    {status === "idle" && (
                        <View style={styles.centered}>
                            <View style={styles.centeredSpark}>
                                <Spark size={26} color={theme.accent} />
                            </View>
                            <Text
                                style={[
                                    styles.hint,
                                    { color: theme.inkSecondary },
                                ]}
                            >
                                Начни печатать — покажу совпадения из твоей
                                истории еды.
                            </Text>
                        </View>
                    )}

                    {status === "loading" && (
                        <View style={styles.centered}>
                            <ActivityIndicator color={theme.accent} />
                        </View>
                    )}

                    {status === "error" && (
                        <View style={styles.centered}>
                            <Text
                                style={[styles.hint, { color: theme.inkMuted }]}
                            >
                                Не получилось найти — проверь соединение.
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                onPress={() => setRetry((n) => n + 1)}
                                style={({ pressed }) => [
                                    styles.retryBtn,
                                    {
                                        backgroundColor: theme.accentSoft,
                                        transform: [
                                            { scale: pressed ? 0.97 : 1 },
                                        ],
                                    },
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.retryText,
                                        { color: theme.accent },
                                    ]}
                                >
                                    Повторить
                                </Text>
                            </Pressable>
                        </View>
                    )}

                    {status === "ready" && results.length === 0 && (
                        <View style={styles.centered}>
                            <Text
                                style={[styles.hint, { color: theme.inkMuted }]}
                            >
                                Ничего не нашлось по «{query.trim()}».
                            </Text>
                        </View>
                    )}

                    {status === "ready" && results.length > 0 && (
                        <View
                            style={[
                                styles.list,
                                { backgroundColor: theme.surfaceElevated },
                            ]}
                        >
                            {results.map((meal, i) => {
                                const macros = macrosLine(meal);
                                const done = added.has(meal.id);
                                return (
                                    <Pressable
                                        key={meal.id}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Записать «${meal.description}» сегодня`}
                                        onPress={() => void relog(meal)}
                                        style={({ pressed }) => [
                                            styles.row,
                                            i > 0 && {
                                                borderTopWidth: 1,
                                                borderTopColor: theme.hairline,
                                            },
                                            pressed && {
                                                backgroundColor: theme.surface,
                                            },
                                        ]}
                                    >
                                        <View style={styles.rowText}>
                                            <Text
                                                style={[
                                                    styles.rowMeta,
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
                                                    {formatDay(meal.logged_at)}
                                                </Text>
                                            </Text>
                                            <Text
                                                style={[
                                                    styles.rowDesc,
                                                    { color: theme.ink },
                                                ]}
                                                numberOfLines={2}
                                            >
                                                {meal.description}
                                            </Text>
                                            {macros !== "" && (
                                                <Text
                                                    style={[
                                                        styles.rowMacros,
                                                        TabularNums,
                                                        {
                                                            color: theme.inkMuted,
                                                        },
                                                    ]}
                                                >
                                                    {macros}
                                                </Text>
                                            )}
                                        </View>
                                        <View style={styles.rowRight}>
                                            {meal.calories != null && (
                                                <Text
                                                    style={[
                                                        styles.rowKcal,
                                                        TabularNums,
                                                        { color: theme.ink },
                                                    ]}
                                                >
                                                    {meal.calories.toLocaleString(
                                                        "ru-RU",
                                                    )}
                                                </Text>
                                            )}
                                            <Text
                                                style={[
                                                    styles.rowAction,
                                                    {
                                                        color: done
                                                            ? theme.accent
                                                            : theme.inkMuted,
                                                    },
                                                ]}
                                            >
                                                {done
                                                    ? "Добавлено ✓"
                                                    : "Записать"}
                                            </Text>
                                        </View>
                                    </Pressable>
                                );
                            })}
                        </View>
                    )}
                </ScrollView>
            </View>
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
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.md,
    },
    header: { paddingVertical: Spacing.sm },
    back: { fontFamily: Fonts.sansMedium, fontSize: 15 },
    eyebrow: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 11,
        letterSpacing: 3,
        marginTop: Spacing.sm,
        marginBottom: Spacing.sm,
    },
    input: {
        fontFamily: Fonts.sans,
        fontSize: 16,
        borderWidth: 1,
        borderRadius: Radii.md,
        paddingHorizontal: Spacing.md,
        paddingVertical: 12,
    },
    note: {
        fontFamily: Fonts.sansMedium,
        fontSize: 13,
        marginTop: Spacing.sm,
    },
    results: {
        paddingTop: Spacing.md,
        paddingBottom: Spacing.xxl,
    },
    centered: {
        alignItems: "center",
        gap: Spacing.md,
        paddingTop: Spacing.xxl,
        paddingHorizontal: Spacing.md,
    },
    centeredSpark: { alignItems: "center" },
    hint: {
        fontFamily: Fonts.sans,
        fontSize: 14,
        lineHeight: 20,
        textAlign: "center",
    },
    retryBtn: {
        borderRadius: Radii.pill,
        paddingHorizontal: Spacing.lg,
        paddingVertical: 10,
    },
    retryText: { fontFamily: Fonts.sansSemiBold, fontSize: 14 },
    list: {
        borderRadius: Radii.xl,
        overflow: "hidden",
    },
    row: {
        flexDirection: "row",
        alignItems: "center",
        gap: Spacing.md,
        paddingVertical: Spacing.md,
        paddingHorizontal: Spacing.lg,
    },
    rowText: { flex: 1, gap: 3 },
    rowMeta: {
        fontFamily: Fonts.sansSemiBold,
        fontSize: 10,
        letterSpacing: 1.5,
    },
    rowDesc: { fontFamily: Fonts.sans, fontSize: 15, lineHeight: 20 },
    rowMacros: { fontFamily: Fonts.sans, fontSize: 12 },
    rowRight: { alignItems: "flex-end", gap: 4 },
    rowKcal: { fontFamily: Fonts.displayBold, fontSize: 17 },
    rowAction: { fontFamily: Fonts.sansSemiBold, fontSize: 12 },
});
