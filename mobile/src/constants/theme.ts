import { Platform } from "react-native";

/**
 * «SAGE» — мягкая мята на тёмном графите (light: туман + глубокий шалфей).
 * Дисплей — Unbounded (широкая геометрика, кириллица), текст — Golos Text.
 * Chart hues validated with dataviz six-checks (CVD, chroma, lightness band,
 * contrast) per mode — do not eyeball-adjust protein/carbs/fat/water values.
 * Text tokens hold WCAG >=4.5:1 on their surfaces (computed, not eyeballed).
 */
export const Colors = {
    light: {
        surface: "#eef4ef",
        surfaceElevated: "#ffffff",
        ink: "#17201b",
        inkSecondary: "#47554d",
        inkMuted: "#57655c",
        hairline: "#d7e0d9",
        accent: "#1f7a5c",
        onAccent: "#ffffff",
        // Прозрачная мятная подложка для чипов/подсветок
        accentSoft: "rgba(31, 122, 92, 0.12)",
        protein: "#1f8f56",
        carbs: "#a8730a",
        fat: "#cb3f2e",
        water: "#0c6f9e",
        danger: "#a83223",
    },
    dark: {
        surface: "#101413",
        surfaceElevated: "#1a201e",
        ink: "#eef4ef",
        inkSecondary: "#a3b3ab",
        inkMuted: "#8d9c94",
        hairline: "#29312d",
        accent: "#7fd4b4",
        onAccent: "#0c1f18",
        accentSoft: "rgba(127, 212, 180, 0.13)",
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
