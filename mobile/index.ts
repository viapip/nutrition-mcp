import "expo-router/entry";

import { Platform } from "react-native";

// Widget task handler; require — модуль android-only
if (Platform.OS === "android") {
    const {
        registerWidgetTaskHandler,
    } = require("react-native-android-widget");
    const { widgetTaskHandler } = require("./src/widget/widget-task-handler");
    registerWidgetTaskHandler(widgetTaskHandler);
}
