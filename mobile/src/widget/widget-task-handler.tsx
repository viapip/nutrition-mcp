import type {
    WidgetInfo,
    WidgetTaskHandlerProps,
} from "react-native-android-widget";

import { getDashboard, getToken } from "@/lib/api";
import { NutritionWidget } from "./NutritionWidget";

export async function buildWidget(
    info: WidgetInfo,
): Promise<React.JSX.Element> {
    const token = await getToken();
    if (!token) return <NutritionWidget width={info.width} state="login" />;
    try {
        const data = await getDashboard();
        return <NutritionWidget width={info.width} data={data} />;
    } catch {
        return <NutritionWidget width={info.width} state="error" />;
    }
}

export async function widgetTaskHandler(
    props: WidgetTaskHandlerProps,
): Promise<void> {
    switch (props.widgetAction) {
        case "WIDGET_ADDED":
        case "WIDGET_UPDATE":
        case "WIDGET_RESIZED":
            props.renderWidget(await buildWidget(props.widgetInfo));
            break;
        default:
            break;
    }
}
