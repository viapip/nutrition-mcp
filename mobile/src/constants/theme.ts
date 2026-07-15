import { Platform } from "react-native";

/**
 * «VOLT» — кислотный лайм на чернильно-чёрном (light: бумага + олива).
 * Дисплей — Unbounded (широкая геометрика, кириллица), текст — Golos Text.
 * Chart hues validated with dataviz six-checks (CVD, chroma, lightness band,
 * contrast) per mode — do not eyeball-adjust protein/carbs/fat/water values.
 * Text tokens hold WCAG >=4.5:1 on their surfaces (computed, not eyeballed).
 */
export const Colors = {
    light: {
        surface: "#f3f5ea",
        surfaceElevated: "#ffffff",
        ink: "#191d10",
        inkSecondary: "#4b523c",
        inkMuted: "#5c644a",
        hairline: "#dde2cd",
        accent: "#4e6c07",
        onAccent: "#ffffff",
        // Прозрачная лаймовая подложка для чипов/подсветок
        accentSoft: "rgba(78, 108, 7, 0.12)",
        protein: "#1f8f56",
        carbs: "#a8730a",
        fat: "#cb3f2e",
        water: "#0c6f9e",
        danger: "#a83223",
    },
    dark: {
        surface: "#0e100b",
        surfaceElevated: "#181b13",
        ink: "#f1f4e8",
        inkSecondary: "#aab29a",
        inkMuted: "#939b81",
        hairline: "#262a1e",
        accent: "#cff54a",
        onAccent: "#161a06",
        accentSoft: "rgba(207, 245, 74, 0.13)",
        protein: "#2fa163",
        carbs: "#bd8a14",
        fat: "#d4553a",
        water: "#2596b3",
        danger: "#ff8672",
    },
} as const;

export type Theme = { [K in keyof (typeof Colors)["light"]]: string };

export const Fonts = {
    display: "Unbounded_600SemiBold",
    displayLight: "Unbounded_200ExtraLight",
    displayBold: "Unbounded_700Bold",
    // Герой-цифры (остаток ккал, стрик) — только для крупных чисел
    displayHero: "Unbounded_800ExtraBold",
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
    pill: 999,
} as const;

export const MaxContentWidth = 560;

export const TabularNums = Platform.select({
    web: { fontVariantNumeric: "tabular-nums" as const },
    default: { fontVariant: ["tabular-nums" as const] },
});
