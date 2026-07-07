import { useEffect, useState } from "react";
import { Animated, View, Text, StyleSheet } from "react-native";
import Svg, { Circle, G, Polyline, Line, Rect } from "react-native-svg";

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
        <View style={ringStyles.wrap}>
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
                <Text style={[ringStyles.unit, { color: theme.inkMuted }]}>
                    {goal ? `/ ${goal}${unit}` : unit}
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

    const pad = 8;
    const values = series.map((p) => p.weight_g);
    const all = targetG != null ? [...values, targetG] : values;
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || 1;

    const x = (i: number) =>
        pad + (i / (series.length - 1)) * (width - pad * 2);
    const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

    const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    const lastX = x(values.length - 1);
    const lastY = y(values[values.length - 1]);

    return (
        <Svg width={width} height={height}>
            {targetG != null && (
                <Line
                    x1={pad}
                    y1={y(targetG)}
                    x2={width - pad}
                    y2={y(targetG)}
                    stroke={theme.hairline}
                    strokeWidth={1}
                />
            )}
            <Polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
            />
            {/* End marker: r=4 data dot + 2px surface ring */}
            <Circle cx={lastX} cy={lastY} r={6} fill={theme.surfaceElevated} />
            <Circle cx={lastX} cy={lastY} r={4} fill={color} />
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
    const max = Math.max(...byHour, 1);
    const rx = 4;

    return (
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
    );
}
