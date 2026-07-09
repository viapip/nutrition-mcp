import {
    GolosText_400Regular,
    GolosText_500Medium,
    GolosText_600SemiBold,
} from "@expo-google-fonts/golos-text";
import {
    Unbounded_200ExtraLight,
    Unbounded_600SemiBold,
    Unbounded_700Bold,
} from "@expo-google-fonts/unbounded";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme } from "react-native";

import { Colors } from "@/constants/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
    const scheme = useColorScheme();
    const theme = Colors[scheme === "dark" ? "dark" : "light"];

    const [loaded, error] = useFonts({
        Unbounded_200ExtraLight,
        Unbounded_600SemiBold,
        Unbounded_700Bold,
        GolosText_400Regular,
        GolosText_500Medium,
        GolosText_600SemiBold,
    });

    useEffect(() => {
        if (loaded || error) SplashScreen.hideAsync();
    }, [loaded, error]);

    if (!loaded && !error) return null;

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
