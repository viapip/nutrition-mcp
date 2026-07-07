import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// expo-haptics is a no-op only sometimes on web; guard explicitly.
const native = Platform.OS === "ios" || Platform.OS === "android";

/** Light tick for taps that log something. */
export function tapBuzz() {
    if (native) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** Success notification for a completed save. */
export function successBuzz() {
    if (native) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
}
