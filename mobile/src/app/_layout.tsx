import {
    Fraunces_300Light_Italic,
    Fraunces_600SemiBold,
} from "@expo-google-fonts/fraunces";
import {
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
} from "@expo-google-fonts/instrument-sans";
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
        Fraunces_300Light_Italic,
        Fraunces_600SemiBold,
        InstrumentSans_400Regular,
        InstrumentSans_500Medium,
        InstrumentSans_600SemiBold,
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
