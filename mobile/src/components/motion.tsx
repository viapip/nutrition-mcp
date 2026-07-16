import { useEffect, useState, type ReactNode } from "react";
import { Animated } from "react-native";

/** Staggered entrance: fade + lift, once per mount. */
export function FadeIn({
    delay,
    children,
}: {
    delay: number;
    children: ReactNode;
}) {
    const [anim] = useState(() => new Animated.Value(0));
    useEffect(() => {
        Animated.timing(anim, {
            toValue: 1,
            duration: 420,
            delay,
            useNativeDriver: true,
        }).start();
    }, [anim, delay]);
    return (
        <Animated.View
            style={{
                opacity: anim,
                transform: [
                    {
                        translateY: anim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [14, 0],
                        }),
                    },
                ],
            }}
        >
            {children}
        </Animated.View>
    );
}

/** Пульсирующая непрозрачность (0.35↔0.75) для скелетон-плейсхолдеров. */
export function usePulse(): Animated.Value {
    const [pulse] = useState(() => new Animated.Value(0.35));
    useEffect(() => {
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(pulse, {
                    toValue: 0.75,
                    duration: 700,
                    useNativeDriver: true,
                }),
                Animated.timing(pulse, {
                    toValue: 0.35,
                    duration: 700,
                    useNativeDriver: true,
                }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [pulse]);
    return pulse;
}
