import { FlexWidget, TextWidget } from "react-native-android-widget";

import type { DashboardData } from "@/lib/api";

/** Виджет «день»: остаток ккал, макросы, кнопки в чат. RemoteViews не умеют
 * ввод текста и кастомные шрифты — системный sans, всегда SAGE dark. */

// Синхронизировать с constants/theme.ts (dark)
const C = {
    surface: "#101413",
    surfaceElevated: "#1a201e",
    ink: "#eef4ef",
    inkMuted: "#8d9c94",
    accent: "#7fd4b4",
    onAccent: "#0c1f18",
    danger: "#ff8672",
    protein: "#2fa163",
    carbs: "#bd8a14",
    fat: "#d4553a",
    water: "#2596b3",
} as const;

const PAD = 14;

function fmt(n: number): string {
    return Math.round(n).toLocaleString("ru-RU");
}

function ChatButton({
    emoji,
    uri,
    label,
}: {
    emoji: string;
    uri: string;
    label: string;
}) {
    return (
        <FlexWidget
            clickAction="OPEN_URI"
            clickActionData={{ uri }}
            accessibilityLabel={label}
            style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: C.surfaceElevated,
                alignItems: "center",
                justifyContent: "center",
            }}
        >
            <TextWidget text={emoji} style={{ fontSize: 19 }} />
        </FlexWidget>
    );
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <FlexWidget
            clickAction="OPEN_APP"
            style={{
                width: "match_parent",
                height: "match_parent",
                backgroundColor: C.surface,
                borderRadius: 24,
                padding: PAD,
                flexDirection: "column",
                justifyContent: "center",
            }}
        >
            {children}
        </FlexWidget>
    );
}

export function NutritionWidget({
    width,
    data,
    state,
}: {
    width: number;
    data?: DashboardData;
    state?: "login" | "error";
}) {
    if (!data) {
        return (
            <Shell>
                <TextWidget
                    text={
                        state === "login"
                            ? "Войди в приложение —\nдень будет тут"
                            : "Нет связи — тапни,\nчтобы обновить"
                    }
                    style={{
                        fontSize: 14,
                        color: C.inkMuted,
                        textAlign: "center",
                    }}
                />
            </Shell>
        );
    }

    const { eaten, goal } = data.calories;
    const over = goal != null && eaten > goal;
    const big = goal != null ? Math.abs(goal - eaten) : eaten;
    const label =
        goal == null
            ? "СЪЕДЕНО, ККАЛ"
            : over
              ? "ПЕРЕБОР, ККАЛ"
              : "ОСТАЛОСЬ, ККАЛ";
    const pct = goal ? Math.min(eaten / goal, 1) : 0;
    const barW = Math.max(width - PAD * 2, 60);

    return (
        <Shell>
            <FlexWidget
                style={{
                    width: "match_parent",
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                }}
            >
                <FlexWidget style={{ flexDirection: "column" }}>
                    <TextWidget
                        text={label}
                        style={{
                            fontSize: 10,
                            letterSpacing: 0.2,
                            color: C.inkMuted,
                        }}
                    />
                    <TextWidget
                        text={fmt(big)}
                        style={{
                            fontSize: 38,
                            fontWeight: "800",
                            color: over ? C.danger : C.accent,
                        }}
                    />
                    {goal != null && (
                        <TextWidget
                            text={`${fmt(eaten)} из ${fmt(goal)}`}
                            style={{ fontSize: 12, color: C.inkMuted }}
                        />
                    )}
                </FlexWidget>
                <FlexWidget style={{ flexDirection: "row", flexGap: 8 }}>
                    <ChatButton
                        emoji="✍️"
                        uri="nutrition://chat?compose=text"
                        label="Написать ассистенту"
                    />
                    <ChatButton
                        emoji="📷"
                        uri="nutrition://chat?compose=camera"
                        label="Фото еды"
                    />
                </FlexWidget>
            </FlexWidget>

            {goal != null && (
                <FlexWidget
                    style={{
                        width: barW,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: C.surfaceElevated,
                        marginTop: 8,
                        flexDirection: "row",
                    }}
                >
                    <FlexWidget
                        style={{
                            width: Math.max(Math.round(barW * pct), 6),
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: over ? C.danger : C.accent,
                        }}
                    />
                </FlexWidget>
            )}

            <FlexWidget
                style={{
                    width: "match_parent",
                    flexDirection: "row",
                    justifyContent: "space-between",
                    marginTop: 8,
                }}
            >
                <TextWidget
                    text={`Б ${fmt(data.macros.protein.eaten)}`}
                    style={{
                        fontSize: 12,
                        fontWeight: "600",
                        color: C.protein,
                    }}
                />
                <TextWidget
                    text={`У ${fmt(data.macros.carbs.eaten)}`}
                    style={{ fontSize: 12, fontWeight: "600", color: C.carbs }}
                />
                <TextWidget
                    text={`Ж ${fmt(data.macros.fat.eaten)}`}
                    style={{ fontSize: 12, fontWeight: "600", color: C.fat }}
                />
                <TextWidget
                    text={`💧 ${(data.water.total_ml / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} л`}
                    style={{ fontSize: 12, fontWeight: "600", color: C.water }}
                />
            </FlexWidget>
        </Shell>
    );
}
