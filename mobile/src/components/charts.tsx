import { useEffect, useState } from "react";
import { Animated, View, Text, StyleSheet } from "react-native";
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

/**
 * Chart marks follow dataviz specs: 2px lines, >=8px end markers with a 2px
 * surface ring, bars <=24px with 4px rounded data-ends square at the baseline,
 * 2px surface gaps. Values always direct-labeled (contrast relief channel).
 */

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
            <View style={ringStyles.center}>
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
        height: 92,
        alignItems: "center",
        justifyContent: "center",
    },
    value: { fontFamily: Fonts.sansSemiBold, fontSize: 20, lineHeight: 24 },
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
