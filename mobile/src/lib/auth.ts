import { router } from "expo-router";
import { useCallback } from "react";

import { getToken, isUnauthorized } from "./api";

/** 401-обработка экранов: гейт по токену и превращение пойманного 401 в
 * переход на /login. Один хелпер вместо десятка одинаковых блоков. */
export function useRequireAuth() {
    // Гейт: `onAuthed` выполняется только с токеном; нет токена или reject
    // SecureStore — оба ведут на login (без вечного скелетона).
    const guard = useCallback((onAuthed?: () => void) => {
        getToken()
            .then((t) => {
                if (!t) router.replace("/login");
                else onAuthed?.();
            })
            .catch(() => router.replace("/login"));
    }, []);
    // В catch: на 401 уводим на login и сообщаем, что обработали.
    const onError = useCallback((err: unknown) => {
        if (isUnauthorized(err)) {
            router.replace("/login");
            return true;
        }
        return false;
    }, []);
    return { guard, onError };
}
