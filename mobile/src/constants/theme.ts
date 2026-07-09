import { Platform } from "react-native";

/**
 * Editorial-organic theme: warm paper surfaces, forest-green brand ink.
 * Chart hues validated with dataviz six-checks (CVD, chroma, contrast)
 * per mode — do not eyeball-adjust protein/carbs/fat/water values.
 */
export const Colors = {
    light: {
        surface: "#f7f2e9",
        surfaceElevated: "#fffcf5",
        ink: "#20261f",
        inkSecondary: "#5a6154",
        // 4.5:1 on surface — muted text stays readable at 12px
        inkMuted: "#6b7164",
        hairline: "#e3dccd",
        accent: "#2e6b45",
        onAccent: "#f7f2e9",
        protein: "#2e8b57",
        carbs: "#b87708",
        fat: "#c65332",
        water: "#1d7f8c",
        danger: "#b3342a",
    },
    dark: {
        surface: "#191b17",
        surfaceElevated: "#22251f",
        ink: "#efeadd",
        inkSecondary: "#a8ad9e",
        // 4.5:1 on surfaceElevated; hairline lifted so card borders survive dark
        inkMuted: "#8b9180",
        hairline: "#3c4136",
        accent: "#6fb389",
        onAccent: "#191b17",
        protein: "#3d9e63",
        carbs: "#bf830c",
        fat: "#cd6540",
        water: "#2fa3b3",
        danger: "#d96a5e",
    },
} as const;

export type Theme = { [K in keyof (typeof Colors)["light"]]: string };

export const Fonts = {
    display: "Fraunces_600SemiBold",
    displayLight: "Fraunces_300Light_Italic",
    sans: "InstrumentSans_400Regular",
    sansMedium: "InstrumentSans_500Medium",
    sansSemiBold: "InstrumentSans_600SemiBold",
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
    sm: 8,
    md: 14,
    lg: 22,
} as const;

export const MaxContentWidth = 560;

export const TabularNums = Platform.select({
    web: { fontVariantNumeric: "tabular-nums" as const },
    default: { fontVariant: ["tabular-nums" as const] },
});
