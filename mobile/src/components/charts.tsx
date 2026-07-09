import { useEffect, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
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

import { Fonts, Spacing, TabularNums, type Theme } from "@/constants/theme";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * Chart marks follow dataviz specs: 2px lines, >=8px end markers with a 2px
 * surface ring, bars <=24px with 4px rounded data-ends square at the baseline,
 * 2px surface gaps. Values always direct-labeled (contrast relief channel).
 */

// ---------- Calorie arc (hero gauge) ----------

interface CalorieArcProps {
    eaten: number;
    goal: number | null;
    theme: Theme;
    width: number;
}

/** Полукруглый гейдж дня: гигантская цифра внутри дуги. */
export function CalorieArc({ eaten, goal, theme, width }: CalorieArcProps) {
    const stroke = 14;
    const r = Math.min((width - stroke) / 2, 150);
    const cx = width / 2;
    const cy = r + stroke / 2;
    const halfLen = Math.PI * r;
    const progress = goal ? Math.min(eaten / goal, 1) : 0;
    const over = goal != null && eaten > goal;
    const color = over ? theme.danger : theme.accent;

    const [anim] = useState(() => new Animated.Value(0));
    useEffect(() => {
        Animated.timing(anim, {
            toValue: progress,
            duration: 700,
            useNativeDriver: false, // svg props can't ride the native driver
        }).start();
    }, [progress, anim]);
    const dashOffset = anim.interpolate({
        inputRange: [0, 1],
        outputRange: [halfLen, 0],
    });

    const d = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
    const height = cy + stroke / 2;

    return (
        <View
            accessible
            accessibilityLabel={`Калории: ${Math.round(eaten)}${goal ? ` из ${goal}` : ""}`}
            style={{ width, height }}
        >
            <Svg width={width} height={height}>
                <Path
                    d={d}
                    stroke={color}
                    strokeOpacity={0.16}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    fill="none"
                />
                {goal != null && (
                    <AnimatedPath
                        d={d}
                        stroke={color}
                        strokeWidth={stroke}
                        strokeLinecap="round"
                        fill="none"
                        strokeDasharray={`${halfLen} ${halfLen}`}
                        strokeDashoffset={dashOffset}
                    />
                )}
            </Svg>
            <View style={[arcStyles.center, { width, height }]}>
                <Text
                    style={[arcStyles.value, TabularNums, { color: theme.ink }]}
                >
                    {Math.round(eaten).toLocaleString("ru-RU")}
                </Text>
                <Text style={[arcStyles.caption, { color: theme.inkMuted }]}>
                    {goal != null
                        ? `из ${goal.toLocaleString("ru-RU")} ккал`
                        : "ккал"}
                </Text>
            </View>
        </View>
    );
}

const arcStyles = StyleSheet.create({
    center: {
        position: "absolute",
        top: 0,
        left: 0,
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: 2,
    },
    value: {
        fontFamily: Fonts.displayBold,
        fontSize: 44,
        lineHeight: 52,
    },
    caption: { fontFamily: Fonts.sansMedium, fontSize: 13, lineHeight: 18 },
});

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

/** Неделя одним взглядом: кольцо-прогресс на каждый день, тап — перейти. */
export function WeekStrip({
    days,
    selected,
    today,
    theme,
    width,
    onSelect,
}: WeekStripProps) {
    // Ужимаем кольца на узких экранах, чтобы 7 дней не наехали друг на друга
    const size = Math.max(
        24,
        Math.min(34, Math.floor(width / days.length) - 8),
    );
    const strokeW = 3.5;
    const r = (size - strokeW) / 2;
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
                                weekStyles.ringWrap,
                                { borderRadius: size / 2 + 2 },
                                active && {
                                    backgroundColor: theme.accentSoft,
                                },
                            ]}
                        >
                            <Svg width={size} height={size}>
                                <Circle
                                    cx={size / 2}
                                    cy={size / 2}
                                    r={r}
                                    stroke={theme.hairline}
                                    strokeWidth={strokeW}
                                    fill="none"
                                />
                                {d.pct != null && d.pct > 0 && (
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
                                )}
                            </Svg>
                        </View>
                        <Text
                            style={[
                                weekStyles.letter,
                                {
                                    color: active
                                        ? theme.accent
                                        : isToday
                                          ? theme.ink
                                          : theme.inkMuted,
                                    fontFamily: active
                                        ? Fonts.sansSemiBold
                                        : Fonts.sansMedium,
                                },
                            ]}
                        >
                            {weekdayLetter(d.date)}
                        </Text>
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
    day: { alignItems: "center", gap: 4 },
    ringWrap: { padding: 2 },
    letter: { fontSize: 11, lineHeight: 14 },
});

// ---------- Macro ring ----------

interface MacroRingProps {
    label: string;
    eaten: number;
    goal: number | null;
    unit: string;
    color: string;
    theme: Theme;
    size?: number;
}

export function MacroRing({
    label,
    eaten,
    goal,
    unit,
    color,
    theme,
    size = 92,
}: MacroRingProps) {
    const stroke = 8;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const progress = goal ? Math.min(eaten / goal, 1) : 0;
    const over = goal != null && eaten > goal;

    // Sweep to the new value (e.g. returning from chat after logging a meal).
    const [anim] = useState(() => new Animated.Value(0));
    useEffect(() => {
        Animated.timing(anim, {
            toValue: progress,
            duration: 600,
            useNativeDriver: false, // svg props can't ride the native driver
        }).start();
    }, [progress, anim]);
    const dashOffset = anim.interpolate({
        inputRange: [0, 1],
        outputRange: [c, 0],
    });

    return (
        <View
            style={ringStyles.wrap}
            accessible
            accessibilityLabel={`${label}: ${Math.round(eaten)} из ${goal ?? "—"} ${unit}`}
        >
            <Svg width={size} height={size}>
                {/* Track: lighter step of the same hue */}
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    stroke={color}
                    strokeOpacity={0.18}
                    strokeWidth={stroke}
                    fill="none"
                />
                {goal != null && (
                    <AnimatedCircle
                        cx={size / 2}
                        cy={size / 2}
                        r={r}
                        stroke={color}
                        strokeWidth={stroke}
                        fill="none"
                        strokeLinecap="round"
                        strokeDasharray={`${c} ${c}`}
                        strokeDashoffset={dashOffset}
                        transform={`rotate(-90 ${size / 2} ${size / 2})`}
                    />
                )}
            </Svg>
            <View style={[ringStyles.center, { height: size }]}>
                <Text
                    style={[
                        ringStyles.value,
                        TabularNums,
                        { color: theme.ink },
                    ]}
                >
                    {Math.round(eaten)}
                </Text>
                <Text
                    style={[
                        ringStyles.unit,
                        { color: over ? theme.danger : theme.inkMuted },
                    ]}
                >
                    {goal
                        ? over
                            ? `+${Math.round(eaten - goal)} ${unit}`
                            : `/ ${goal} ${unit}`
                        : unit}
                </Text>
            </View>
            <View style={ringStyles.labelRow}>
                <View style={[ringStyles.swatch, { backgroundColor: color }]} />
                <Text style={[ringStyles.label, { color: theme.inkSecondary }]}>
                    {label}
                </Text>
            </View>
        </View>
    );
}

const ringStyles = StyleSheet.create({
    wrap: { alignItems: "center" },
    center: {
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        alignItems: "center",
        justifyContent: "center",
    },
    value: { fontFamily: Fonts.display, fontSize: 17, lineHeight: 22 },
    unit: { fontFamily: Fonts.sans, fontSize: 11, lineHeight: 14 },
    labelRow: {
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        marginTop: Spacing.sm,
    },
    swatch: { width: 8, height: 8, borderRadius: 4 },
    label: { fontFamily: Fonts.sansMedium, fontSize: 13 },
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
