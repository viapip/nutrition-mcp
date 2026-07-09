import { Platform } from "react-native";

/**
 * «Ember» — dark-first: раскалённый янтарь на тёплом угле.
 * Дисплей — Unbounded (широкая геометрика, кириллица), текст — Golos Text.
 * Chart hues validated with dataviz six-checks (CVD, chroma, lightness band,
 * contrast) per mode — do not eyeball-adjust protein/carbs/fat/water values.
 * Text tokens hold WCAG >=4.5:1 on their surfaces (computed, not eyeballed).
 */
export const Colors = {
    light: {
        surface: "#f6efe3",
        surfaceElevated: "#ffffff",
        ink: "#241d12",
        inkSecondary: "#5f5747",
        inkMuted: "#6f6757",
        hairline: "#e7ddca",
        accent: "#b04b0b",
        onAccent: "#ffffff",
        // Прозрачная янтарная подложка для чипов/подсветок
        accentSoft: "rgba(176, 75, 11, 0.10)",
        protein: "#1f8f56",
        carbs: "#a8730a",
        fat: "#cb3f2e",
        water: "#0c6f9e",
        danger: "#b3342a",
    },
    dark: {
        surface: "#16130f",
        surfaceElevated: "#201c16",
        ink: "#f2ead9",
        inkSecondary: "#b3a892",
        inkMuted: "#a1977f",
        hairline: "#3a332a",
        accent: "#ffa64d",
        onAccent: "#241304",
        accentSoft: "rgba(255, 166, 77, 0.13)",
        protein: "#2fa163",
        carbs: "#bd8a14",
        fat: "#d4553a",
        water: "#2596b3",
        danger: "#f07868",
    },
} as const;

export type Theme = { [K in keyof (typeof Colors)["light"]]: string };

export const Fonts = {
    display: "Unbounded_600SemiBold",
    displayLight: "Unbounded_200ExtraLight",
    displayBold: "Unbounded_700Bold",
    sans: "GolosText_400Regular",
    sansMedium: "GolosText_500Medium",
    sansSemiBold: "GolosText_600SemiBold",
} as const;

export const Spacing = {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
} as const;

export const Radii = {
    sm: 10,
    md: 16,
    lg: 24,
    xl: 32,
} as const;

export const MaxContentWidth = 560;

export const TabularNums = Platform.select({
    web: { fontVariantNumeric: "tabular-nums" as const },
    default: { fontVariant: ["tabular-nums" as const] },
});
