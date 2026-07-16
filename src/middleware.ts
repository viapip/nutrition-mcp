import type { Context, Next } from "hono";
import { streamSSE } from "hono/streaming";
import { getUserIdByToken } from "./db.js";
import { getBaseUrl } from "./url.js";
import { checkRateLimit } from "./rate-limit.js";

declare module "hono" {
    interface ContextVariableMap {
        userId: string;
        accessToken: string;
    }
}

function boundaryError(
    c: Context,
    error: string,
    status: 401 | 429 | 503,
    description?: string,
): Response | Promise<Response> {
    if (
        c.req.path === "/api/chat" &&
        c.req.header("accept")?.includes("text/event-stream")
    ) {
        c.status(status);
        return streamSSE(c, (stream) =>
            stream.writeSSE({
                data: JSON.stringify({ type: "error", error }),
            }),
        );
    }
    return c.json(
        description ? { error, error_description: description } : { error },
        status,
    );
}

export const authenticateBearer = async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        const baseUrl = getBaseUrl(c);
        const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
        c.header(
            "WWW-Authenticate",
            `Bearer resource_metadata="${resourceMetadataUrl}"`,
        );
        return boundaryError(c, "unauthorized", 401, "Bearer token required");
    }

    const token = authHeader.substring(7);
    let userId: string | null;
    try {
        userId = await getUserIdByToken(token);
    } catch (err) {
        console.error("Token lookup failed:", err);
        return boundaryError(c, "service_unavailable", 503);
    }

    if (!userId) {
        const baseUrl = getBaseUrl(c);
        const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
        c.header(
            "WWW-Authenticate",
            `Bearer resource_metadata="${resourceMetadataUrl}"`,
        );
        return boundaryError(
            c,
            "invalid_token",
            401,
            "Token is invalid or expired",
        );
    }

    c.set("accessToken", token);
    c.set("userId", userId);
    await next();
};

export const rateLimit = async (c: Context, next: Next) => {
    const userId = c.get("userId") as string | undefined;
    if (!userId) {
        await next();
        return;
    }
    const result = checkRateLimit(userId);
    c.header("X-RateLimit-Limit", String(result.limit));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
        c.header("Retry-After", String(result.retryAfterSeconds ?? 60));
        return boundaryError(
            c,
            "rate_limited",
            429,
            `Rate limit exceeded (${result.limit} requests per minute). Retry after ${result.retryAfterSeconds}s.`,
        );
    }
    await next();
};
