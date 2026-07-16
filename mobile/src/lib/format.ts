/** Граммы → «78,2» (1 знак, ru-RU). */
export function kgText(g: number): string {
    return (g / 1000).toLocaleString("ru-RU", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });
}

/** Футнот тренда веса: «−0,4 кг за 30 дней · до цели 4,2 кг».
 * null — когда нечего показать. Порог 100 г = «цель достигнута». */
export function weightDeltaText(
    deltaG: number | null,
    toGoalG: number | null,
): string | null {
    const parts: string[] = [];
    if (deltaG != null) {
        parts.push(
            `${deltaG > 0 ? "+" : "−"}${kgText(Math.abs(deltaG))} кг за 30 дней`,
        );
    }
    if (toGoalG != null) {
        parts.push(
            Math.abs(toGoalG) < 100
                ? "цель достигнута"
                : `до цели ${kgText(Math.abs(toGoalG))} кг`,
        );
    }
    return parts.length ? parts.join(" · ") : null;
}
