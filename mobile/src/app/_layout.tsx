import {
    GolosText_400Regular,
    GolosText_500Medium,
    GolosText_600SemiBold,
} from "@expo-google-fonts/golos-text";
import {
    Unbounded_200ExtraLight,
    Unbounded_600SemiBold,
    Unbounded_700Bold,
    Unbounded_800ExtraBold,
} from "@expo-google-fonts/unbounded";
import { useFonts } from "expo-font";
import * as QuickActions from "expo-quick-actions";
import { router, Stack, type Href } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform, useColorScheme } from "react-native";

import { Colors } from "@/constants/theme";

SplashScreen.preventAutoHideAsync();

/** Long-press меню иконки → чат (текст/фото). */
function useQuickActions(ready: boolean) {
    const pendingHref = useRef<string | null>(
        (QuickActions.initial?.params?.href as string) ?? null,
    );
    const readyRef = useRef(false);

    // push только после монтирования навигатора
    const flush = useCallback(() => {
        const href = pendingHref.current;
        if (!readyRef.current || !href) return;
        pendingHref.current = null;
        setTimeout(() => router.push(href as Href), 50);
    }, []);

    useEffect(() => {
        void QuickActions.setItems([
            {
                id: "chat_text",
                title: "Написать ассистенту",
                params: { href: "/chat?compose=text" },
            },
            {
                id: "chat_camera",
                title: "Фото еды",
                params: { href: "/chat?compose=camera" },
            },
        ]);
        const sub = QuickActions.addListener((a) => {
            if (typeof a.params?.href === "string") {
                pendingHref.current = a.params.href;
                flush();
            }
        });
        return () => sub.remove();
    }, [flush]);

    useEffect(() => {
        if (!ready) return;
        readyRef.current = true;
        flush();
    }, [ready, flush]);
}

/** Приложение ушло в фон → перерисовать виджет свежими данными. */
function useWidgetRefresh() {
    useEffect(() => {
        if (Platform.OS !== "android") return;
        const sub = AppState.addEventListener("change", (state) => {
            if (state !== "background") return;
            /* eslint-disable @typescript-eslint/no-require-imports -- android-only модуль */
            const {
                requestWidgetUpdate,
            } = require("react-native-android-widget");
            const { buildWidget } = require("@/widget/widget-task-handler");
            /* eslint-enable @typescript-eslint/no-require-imports */
            requestWidgetUpdate({
                widgetName: "NutritionDay",
                renderWidget: buildWidget,
            }).catch(() => {});
        });
        return () => sub.remove();
    }, []);
}

export default function RootLayout() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];

    const [loaded, error] = useFonts({
        Unbounded_200ExtraLight,
        Unbounded_600SemiBold,
        Unbounded_700Bold,
        Unbounded_800ExtraBold,
        GolosText_400Regular,
        GolosText_500Medium,
        GolosText_600SemiBold,
    });
    const ready = loaded || !!error;

    useQuickActions(ready);
    useWidgetRefresh();

    useEffect(() => {
        if (ready) SplashScreen.hideAsync();
    }, [ready]);

    if (!ready) return null;

    return (
        <>
            <StatusBar style={scheme === "dark" ? "light" : "dark"} />
            <Stack
                screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: theme.surface },
                }}
            />
        </>
    );
}
