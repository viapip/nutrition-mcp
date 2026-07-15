import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, {
    Circle,
    Defs,
    G,
    Line,
    LinearGradient,
    Path,
    Polyline,
    Rect,
    Stop,
    Text as SvgText,
} from "react-native-svg";

import { Fonts, type Theme } from "@/constants/theme";

// Марки по dataviz-спеке: линии 2px, маркеры >=8px с кольцом, бары с 4px
// скруглением у вершины, зазоры 2px, значения подписаны напрямую

// ---------- Week strip ----------

export interface WeekDay {
    date: string; // YYYY-MM-DD
    /** null = данных нет (нет цели или ещё грузится) */
    pct: number | null;
    over: boolean;
}

interface WeekStripProps {
    days: WeekDay[];
    selected: string;
    today: string;
    theme: Theme;
    width: number;
    onSelect: (date: string) => void;
}

function weekdayLetter(iso: string): string {
    return new Date(`${iso}T12:00:00`)
        .toLocaleDateString("ru-RU", { weekday: "short" })
        .slice(0, 2);
}

/** Неделя: выбранный день — пилюля accent, сегодня — подчёркивание, перебор — danger. */
export function WeekStrip({
    days,
    selected,
    today,
    theme,
    width,
    onSelect,
}: WeekStripProps) {
    // Ужимаем узлы на узких экранах, чтобы 7 дней не наехали друг на друга
    const size = Math.max(
        30,
        Math.min(40, Math.floor(width / days.length) - 6),
    );
    const strokeW = 3;
    const r = (size - strokeW) / 2 - 1;
    const c = 2 * Math.PI * r;

    return (
        <View style={weekStyles.row}>
            {days.map((d) => {
                const active = d.date === selected;
                const isToday = d.date === today;
                const ringColor = d.over ? theme.danger : theme.accent;
                return (
                    <Pressable
                        key={d.date}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={`${weekdayLetter(d.date)}, ${d.date}${
                            d.pct != null
                                ? `, ${Math.round(d.pct * 100)}% калорий`
                                : ""
                        }`}
                        onPress={() => onSelect(d.date)}
                        hitSlop={6}
                        style={weekStyles.day}
                    >
                        <View
                            style={[
                                weekStyles.node,
                                {
                                    width: size,
                                    height: size,
                                    borderRadius: size / 2,
                                },
                                active && { backgroundColor: theme.accent },
                            ]}
                        >
                            {!active && d.pct != null && d.pct > 0 && (
                                <Svg
                                    width={size}
                                    height={size}
                                    style={StyleSheet.absoluteFill}
                                >
                                    <Circle
                                        cx={size / 2}
                                        cy={size / 2}
                                        r={r}
                                        stroke={theme.hairline}
                                        strokeWidth={strokeW}
                                        fill="none"
                                    />
                                    <Circle
                                        cx={size / 2}
                                        cy={size / 2}
                                        r={r}
                                        stroke={ringColor}
                                        strokeWidth={strokeW}
                                        fill="none"
                                        strokeLinecap="round"
                                        strokeDasharray={`${c} ${c}`}
                                        strokeDashoffset={
                                            c * (1 - Math.min(d.pct, 1))
                                        }
                                        transform={`rotate(-90 ${size / 2} ${size / 2})`}
                                    />
                                </Svg>
                            )}
                            <Text
                                style={[
                                    weekStyles.letter,
                                    {
                                        color: active
                                            ? theme.onAccent
                                            : isToday
                                              ? theme.ink
                                              : theme.inkMuted,
                                        fontFamily:
                                            active || isToday
                                                ? Fonts.sansSemiBold
                                                : Fonts.sansMedium,
                                    },
                                ]}
                            >
                                {weekdayLetter(d.date)}
                            </Text>
                        </View>
                        {/* Метка «сегодня», когда просматривают другой день */}
                        <View
                            style={[
                                weekStyles.underline,
                                {
                                    backgroundColor:
                                        isToday && !active
                                            ? theme.accent
                                            : "transparent",
                                },
                            ]}
                        />
                    </Pressable>
                );
            })}
        </View>
    );
}

const weekStyles = StyleSheet.create({
    row: {
        flexDirection: "row",
        justifyContent: "space-between",
    },
    day: { alignItems: "center", gap: 5 },
    node: { alignItems: "center", justifyContent: "center" },
    letter: { fontSize: 12, lineHeight: 16 },
    underline: { width: 14, height: 3, borderRadius: 2 },
});

// ---------- Weight sparkline ----------

interface SparklineProps {
    series: { weight_g: number }[];
    targetG: number | null;
    color: string;
    theme: Theme;
    width: number;
    height?: number;
}

export function WeightSparkline({
    series,
    targetG,
    color,
    theme,
    width,
    height = 72,
}: SparklineProps) {
    if (series.length < 2) return null;

    // Room for min/max/goal labels on the right edge
    const pad = 8;
    const padRight = 44;
    const values = series.map((p) => p.weight_g);
    const all = targetG != null ? [...values, targetG] : values;
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || 1;

    const x = (i: number) =>
        pad + (i / (series.length - 1)) * (width - pad - padRight);
    const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

    const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    const lastX = x(values.length - 1);
    const lastY = y(values[values.length - 1]!);
    const kg = (g: number) => (g / 1000).toFixed(1);

    // Area under the line, closed to the baseline, for the gradient wash
    const area =
        `M ${pad} ${height - pad} L ` +
        values.map((v, i) => `${x(i)} ${y(v)}`).join(" L ") +
        ` L ${lastX} ${height - pad} Z`;

    return (
        <Svg width={width} height={height}>
            <Defs>
                <LinearGradient id="wfill" x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={color} stopOpacity={0.22} />
                    <Stop offset="1" stopColor={color} stopOpacity={0.02} />
                </LinearGradient>
            </Defs>
            <Path d={area} fill="url(#wfill)" />
            {targetG != null && (
                <>
                    <Line
                        x1={pad}
                        y1={y(targetG)}
                        x2={width - padRight}
                        y2={y(targetG)}
                        stroke={theme.inkMuted}
                        strokeWidth={1}
                        strokeDasharray="4 4"
                        strokeOpacity={0.7}
                    />
                    <SvgText
                        x={width - padRight + 6}
                        y={y(targetG) + 3.5}
                        fontSize={10}
                        fill={theme.inkMuted}
                    >
                        {`цель ${kg(targetG)}`}
                    </SvgText>
                </>
            )}
            <Polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
            />
            {/* End marker: r=4 data dot + 2px surface ring, direct-labeled */}
            <Circle cx={lastX} cy={lastY} r={6} fill={theme.surfaceElevated} />
            <Circle cx={lastX} cy={lastY} r={4} fill={color} />
            <SvgText
                x={width - padRight + 6}
                y={lastY + 3.5}
                fontSize={10}
                fontWeight="600"
                fill={theme.ink}
            >
                {kg(values.at(-1)!)}
            </SvgText>
        </Svg>
    );
}

// ---------- Water bars ----------

interface WaterBarsProps {
    byHour: number[]; // 8 three-hour buckets
    color: string;
    theme: Theme;
    width: number;
    height?: number;
}

export function WaterBars({
    byHour,
    color,
    theme,
    width,
    height = 64,
}: WaterBarsProps) {
    const n = byHour.length;
    const gap = 2;
    const slot = width / n;
    const barW = Math.min(24, slot - gap);
    // 500 ml floor keeps a lone glass from towering over the day
    const max = Math.max(...byHour, 500);
    const rx = 4;

    return (
        <View>
            <Svg width={width} height={height}>
                {/* Baseline hairline */}
                <Line
                    x1={0}
                    y1={height - 0.5}
                    x2={width}
                    y2={height - 0.5}
                    stroke={theme.hairline}
                    strokeWidth={1}
                />
                {byHour.map((v, i) => {
                    const cx = i * slot + (slot - barW) / 2;
                    if (v === 0) return null;
                    const h = Math.max((v / max) * (height - 10), rx * 2);
                    // 4px rounded data-end, square baseline: overdraw the bottom corners.
                    return (
                        <G key={i}>
                            <Rect
                                x={cx}
                                y={height - h}
                                width={barW}
                                height={h}
                                rx={rx}
                                fill={color}
                            />
                            <Rect
                                x={cx}
                                y={height - rx}
                                width={barW}
                                height={rx}
                                fill={color}
                            />
                        </G>
                    );
                })}
            </Svg>
            {/* Bucket boundaries: 0/6/12/18/24 local hours */}
            <View style={barStyles.axis}>
                {["0", "6", "12", "18", "24"].map((t) => (
                    <Text
                        key={t}
                        style={[barStyles.tick, { color: theme.inkMuted }]}
                    >
                        {t}
                    </Text>
                ))}
            </View>
        </View>
    );
}

const barStyles = StyleSheet.create({
    axis: {
        flexDirection: "row",
        justifyContent: "space-between",
        marginTop: 2,
    },
    tick: { fontFamily: Fonts.sans, fontSize: 10 },
});

// ---------- Calorie columns (30-day history) ----------

interface CalorieColumnsProps {
    /** Ккал по дням, от старых к новым */
    values: number[];
    goal: number | null;
    theme: Theme;
    width: number;
    height?: number;
}

/** Тонкие колонки по дням: перебор цели — danger, пустые дни — заглушки. */
export function CalorieColumns({
    values,
    goal,
    theme,
    width,
    height = 84,
}: CalorieColumnsProps) {
    const n = values.length;
    if (n === 0) return null;

    // Room for the goal label on the right edge (as in WeightSparkline)
    const padRight = goal != null ? 44 : 0;
    const plotW = width - padRight;
    const gap = 2;
    const slot = plotW / n;
    const barW = Math.max(2, Math.min(10, slot - gap));
    const rx = Math.min(4, barW / 2);
    const topPad = 8;
    const max = Math.max(...values, goal ?? 0, 1);
    const barH = (v: number) => (v / max) * (height - topPad);
    const goalY = goal != null ? height - barH(goal) : 0;

    return (
        <View
            accessible
            accessibilityLabel={`Калории по дням, ${n} ${n === 1 ? "день" : "дней"}${
                goal != null
                    ? `, цель ${goal.toLocaleString("ru-RU")} ккал`
                    : ""
            }`}
        >
            <Svg width={width} height={height}>
                <Line
                    x1={0}
                    y1={height - 0.5}
                    x2={plotW}
                    y2={height - 0.5}
                    stroke={theme.hairline}
                    strokeWidth={1}
                />
                {values.map((v, i) => {
                    const x = i * slot + (slot - barW) / 2;
                    if (v <= 0) {
                        // Пустой день: едва заметный пенёк на базовой линии
                        return (
                            <Rect
                                key={i}
                                x={x}
                                y={height - 3}
                                width={barW}
                                height={3}
                                fill={theme.hairline}
                            />
                        );
                    }
                    const h = Math.max(barH(v), rx * 2);
                    const color =
                        goal != null && v > goal ? theme.danger : theme.accent;
                    // Rounded data-end, square baseline: overdraw the corners
                    return (
                        <G key={i}>
                            <Rect
                                x={x}
                                y={height - h}
                                width={barW}
                                height={h}
                                rx={rx}
                                fill={color}
                            />
                            <Rect
                                x={x}
                                y={height - rx}
                                width={barW}
                                height={rx}
                                fill={color}
                            />
                        </G>
                    );
                })}
                {goal != null && (
                    <>
                        <Line
                            x1={0}
                            y1={goalY}
                            x2={plotW}
                            y2={goalY}
                            stroke={theme.inkMuted}
                            strokeWidth={1}
                            strokeDasharray="4 4"
                            strokeOpacity={0.7}
                        />
                        <SvgText
                            x={plotW + 6}
                            y={goalY + 3.5}
                            fontSize={10}
                            fill={theme.inkMuted}
                        >
                            {goal.toLocaleString("ru-RU")}
                        </SvgText>
                    </>
                )}
            </Svg>
        </View>
    );
}
