import { Platform } from "react-native";

// Handler регистрируем ДО entry — проверенный порядок для expo-router
// (github.com/sAleksovski/react-native-android-widget #128)
if (Platform.OS === "android") {
    /* eslint-disable @typescript-eslint/no-require-imports -- android-only модуль */
    const {
        registerWidgetTaskHandler,
    } = require("react-native-android-widget");
    const { widgetTaskHandler } = require("./src/widget/widget-task-handler");
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerWidgetTaskHandler(widgetTaskHandler);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("expo-router/entry");
