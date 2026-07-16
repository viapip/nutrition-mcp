import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** Count-up: анимирует число от текущего показанного к `value` (easeOutCubic).
 * Плавно подхватывает прерывание — стартует от того, что сейчас на экране. */
export function useCountUp(value: number, duration = 650): number {
    const [display, setDisplay] = useState(value);
    // Зеркалит последнее показанное число. Обновляем в rAF-тике, НЕ в рендере
    // (react-hooks/refs). Даёт плавный старт, если value сменился на середине.
    const fromRef = useRef(value);
    const rafRef = useRef<number | null>(null);
    useEffect(() => {
        const from = fromRef.current;
        if (from === value) return;
        let start = 0;
        const tick = (ts: number) => {
            if (!start) start = ts;
            const t = Math.min((ts - start) / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            const next = Math.round(from + (value - from) * eased);
            fromRef.current = next;
            setDisplay(next);
            if (t < 1) rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        };
    }, [value, duration]);
    return display;
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
