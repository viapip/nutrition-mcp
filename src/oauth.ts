import { Hono, type Context } from "hono";
import {
    storeAuthCode,
    signUpUser,
    signInUser,
    signInWithGoogleIdToken,
    redeemAuthCode,
    rotateRefreshToken,
    isServiceUnavailableError,
} from "./db.js";
import { getBaseUrl } from "./url.js";
import { checkRateLimit } from "./rate-limit.js";

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_AUTHORIZE_SESSIONS = 500;

interface OAuthSession {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
    clientId: string;
    // Raw nonce for an in-flight Google sign-in; the hashed form is sent to
    // Google and the raw value is handed to signInWithIdToken on callback.
    googleNonce?: string;
}

// In-memory session store (sessions are short-lived, 10min TTL)
const sessions = new Map<
    string,
    { session: OAuthSession; expiresAt: number; inFlight?: boolean }
>();

type SessionEntry = NonNullable<ReturnType<typeof sessions.get>>;

function claimSession(entry: SessionEntry): boolean {
    if (entry.inFlight) return false;
    entry.inFlight = true;
    return true;
}

function releaseSession(sessionId: string, entry: SessionEntry): void {
    if (sessions.get(sessionId) === entry) entry.inFlight = false;
}

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [key, value] of sessions) {
        if (value.expiresAt < now) sessions.delete(key);
    }
}

setInterval(cleanExpiredSessions, 60 * 1000);

function base64URLEncode(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

async function pkceHash(verifier: string): Promise<string> {
    return base64URLEncode(
        await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
        ),
    );
}

// Brute-force guard for the credential endpoints (Supabase Auth used to
// provide this for free). Two sliding windows from rate-limit.ts — per client
// IP and per target email — so neither rotating IPs (single-account attack)
// nor rotating emails (spray from one host) bypasses the limit. XFF is
// trustworthy only because the deployment sits behind a proxy that sets it
// (same assumption as the /mcp rate limiter); exposed directly, the header is
// client-controlled and only the email bucket still holds.
export function loginRateLimited(c: Context, email?: string): boolean {
    const ip =
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkRateLimit(`login:ip:${ip}`).allowed) return true;
    if (
        email &&
        !checkRateLimit(`login:email:${email.toLowerCase()}`).allowed
    ) {
        return true;
    }
    return false;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export async function renderLoginPage(
    sessionId: string,
    error?: string,
): Promise<string> {
    const template = await Bun.file("./public/login.html").text();
    const errorHtml = error
        ? `<div class="error-banner">${escapeHtml(error)}</div>`
        : "";
    return template
        .replaceAll("{{SESSION_ID}}", escapeHtml(sessionId))
        .replaceAll("{{ERROR}}", errorHtml);
}

// Mint an authorization code for the now-authenticated user and redirect back to
// the MCP client. Shared by the password (/approve) and Google callback paths so
// the two can't drift. Consumes the session.
async function finishAuthorization(
    c: Context,
    sessionId: string,
    session: OAuthSession,
    userId: string,
): Promise<Response> {
    const authCode = crypto.randomUUID();
    await storeAuthCode(
        authCode,
        session.redirectUri,
        userId,
        session.codeChallenge,
    );
    sessions.delete(sessionId);

    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.set("code", authCode);
    redirectUrl.searchParams.set("state", session.state);

    return c.redirect(redirectUrl.toString());
}

/**
 * OAuth 2.0 Security BCP: redirect_uri MUST be validated, or an attacker can
 * craft an /authorize link on this trusted origin with their own redirect_uri,
 * have the victim log in, and receive the auth code (account takeover). We
 * accept loopback (native MCP clients bind an ephemeral localhost port) plus an
 * explicit host allowlist from OAUTH_ALLOWED_REDIRECT_HOSTS (comma-separated;
 * defaults to Claude's MCP client hosts).
 */
function allowedRedirectUri(uri: string): boolean {
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return false;
    }
    const host = url.hostname;
    // WHATWG URL keeps the brackets on IPv6 hosts ("[::1]").
    const loopback =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]";
    if (loopback && (url.protocol === "http:" || url.protocol === "https:")) {
        return true;
    }
    if (url.protocol !== "https:") return false;
    const allow = (
        process.env.OAUTH_ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com"
    )
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
    return allow.some((a) => host === a || host.endsWith(`.${a}`));
}

export function createOAuthRouter() {
    const oauth = new Hono();

    const clientId = process.env.OAUTH_CLIENT_ID;
    const clientSecret = process.env.OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error("Missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET");
    }

    // Dynamic client registration (required by MCP spec). All clients share the
    // one configured credential, so this just echoes it back.
    oauth.post("/register", async (c) => {
        const body = await c.req.json();
        return c.json({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: body.redirect_uris || [],
        });
    });

    // Authorization endpoint
    oauth.get("/authorize", async (c) => {
        const responseType = c.req.query("response_type");
        const reqClientId = c.req.query("client_id");
        const redirectUri = c.req.query("redirect_uri");
        const state = c.req.query("state");
        const codeChallenge = c.req.query("code_challenge");
        const codeChallengeMethod = c.req.query("code_challenge_method");

        if (responseType !== "code") {
            return c.json({ error: "unsupported_response_type" }, 400);
        }
        if (!redirectUri || !state || !reqClientId) {
            return c.json(
                {
                    error: "invalid_request",
                    error_description:
                        "client_id, redirect_uri, and state are required",
                },
                400,
            );
        }
        if (reqClientId !== clientId) {
            return c.json({ error: "invalid_client" }, 400);
        }
        if (!allowedRedirectUri(redirectUri)) {
            return c.json(
                {
                    error: "invalid_request",
                    error_description: "redirect_uri not allowed",
                },
                400,
            );
        }
        if (
            (codeChallenge &&
                (codeChallengeMethod !== "S256" ||
                    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))) ||
            (!codeChallenge && codeChallengeMethod)
        ) {
            return c.json(
                {
                    error: "invalid_request",
                    error_description: "PKCE must use S256",
                },
                400,
            );
        }
        // TODO: make PKCE mandatory once all deployed MCP clients send it.

        cleanExpiredSessions();
        if (sessions.size >= MAX_AUTHORIZE_SESSIONS) {
            return c.json({ error: "rate_limited" }, 429);
        }
        const ip =
            c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
        if (!checkRateLimit(`authorize:ip:${ip}`).allowed) {
            return c.json({ error: "rate_limited" }, 429);
        }

        // Store session and show login page
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, {
            session: {
                state,
                redirectUri,
                codeChallenge,
                clientId: reqClientId,
            },
            expiresAt: Date.now() + SESSION_TTL_MS,
        });

        return c.html(await renderLoginPage(sessionId));
    });

    // Login/register endpoint — user submits email + password
    oauth.post("/approve", async (c) => {
        const body = await c.req.parseBody();
        const sessionId = body.session_id as string;
        const email = (body.email as string)?.trim().toLowerCase();
        const password = body.password as string;

        if (loginRateLimited(c, email)) {
            return c.json({ error: "rate_limited" }, 429);
        }

        if (!sessionId || !email || !password) {
            return c.json({ error: "invalid_request" }, 400);
        }

        const entry = sessions.get(sessionId);
        if (!entry || entry.expiresAt < Date.now()) {
            sessions.delete(sessionId);
            return c.json({ error: "session_expired" }, 400);
        }
        if (!claimSession(entry)) {
            return c.json({ error: "session_in_use" }, 409);
        }

        try {
            let userId: string;
            try {
                userId = await signInUser(email, password);
            } catch (err) {
                if (isServiceUnavailableError(err)) {
                    console.error("OAuth sign-in failed:", err);
                    return c.json({ error: "service_unavailable" }, 503);
                }
                // Sign-in failed: either the email is free (create the account) or
                // it exists with a wrong password. Gate new accounts behind the
                // same invite code as /api/signup so OAuth can't bypass it.
                const required = process.env.SIGNUP_CODE;
                if (required && body.code !== required) {
                    return c.html(
                        await renderLoginPage(
                            sessionId,
                            "Invalid invite code.",
                        ),
                        400,
                    );
                }
                try {
                    userId = await signUpUser(email, password);
                } catch (err: unknown) {
                    if (isServiceUnavailableError(err)) {
                        return c.json({ error: "service_unavailable" }, 503);
                    }
                    const message =
                        err instanceof Error
                            ? err.message
                            : "Authentication failed";
                    // A unique violation means the email is taken, so sign-in just
                    // failed on a wrong password — show a generic login error, never
                    // "already registered" (which would confirm the account exists).
                    const shown =
                        message === "User already registered"
                            ? "Invalid email or password."
                            : message;
                    return c.html(await renderLoginPage(sessionId, shown), 400);
                }
            }

            try {
                return await finishAuthorization(
                    c,
                    sessionId,
                    entry.session,
                    userId,
                );
            } catch (err) {
                if (isServiceUnavailableError(err)) {
                    return c.json({ error: "service_unavailable" }, 503);
                }
                throw err;
            }
        } finally {
            releaseSession(sessionId, entry);
        }
    });

    // Google sign-in — step 1: redirect the user to Google's consent screen.
    // We run the Google OAuth dance ourselves so nothing needs to persist
    // across requests beyond the existing in-memory session.
    oauth.get("/authorize/google", async (c) => {
        const googleClientId = process.env.GOOGLE_CLIENT_ID;
        const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
        if (!googleClientId || !googleClientSecret) {
            return c.json({ error: "google_not_configured" }, 500);
        }

        const sessionId = c.req.query("session_id");
        if (!sessionId) {
            return c.json({ error: "invalid_request" }, 400);
        }

        cleanExpiredSessions();
        const entry = sessions.get(sessionId);
        if (!entry || entry.expiresAt < Date.now()) {
            sessions.delete(sessionId);
            return c.json({ error: "session_expired" }, 400);
        }

        // Fresh nonce per attempt. The SHA-256 *hex* digest goes to Google and
        // the raw value is handed to signInWithGoogleIdToken on callback,
        // which recomputes the digest and compares it to the token's nonce.
        const rawNonce = crypto.randomUUID();
        const hashedNonce = new Bun.CryptoHasher("sha256")
            .update(rawNonce)
            .digest("hex");
        entry.session.googleNonce = rawNonce;

        const googleUrl = new URL(
            "https://accounts.google.com/o/oauth2/v2/auth",
        );
        googleUrl.searchParams.set("client_id", googleClientId);
        googleUrl.searchParams.set(
            "redirect_uri",
            `${getBaseUrl(c)}/auth/google/callback`,
        );
        googleUrl.searchParams.set("response_type", "code");
        googleUrl.searchParams.set("scope", "openid email profile");
        googleUrl.searchParams.set("state", sessionId);
        googleUrl.searchParams.set("nonce", hashedNonce);
        googleUrl.searchParams.set("prompt", "select_account");

        return c.redirect(googleUrl.toString());
    });

    // Google sign-in — step 2: Google redirects back here. Exchange the code for
    // an ID token (back-channel), verify it against Google's JWKS and resolve
    // it to a user, then mint our authorization code exactly like the password
    // path.
    oauth.get("/auth/google/callback", async (c) => {
        if (loginRateLimited(c)) {
            return c.json({ error: "rate_limited" }, 429);
        }

        const sessionId = c.req.query("state");
        if (!sessionId) {
            return c.json({ error: "invalid_request" }, 400);
        }

        cleanExpiredSessions();
        const entry = sessions.get(sessionId);
        if (!entry || entry.expiresAt < Date.now()) {
            sessions.delete(sessionId);
            return c.json({ error: "session_expired" }, 400);
        }

        // Surface user-cancelled / denied consent without treating it as a crash.
        const renderError = async (message: string) => {
            entry.session.googleNonce = undefined;
            return c.html(await renderLoginPage(sessionId, message), 400);
        };

        if (c.req.query("error")) {
            return renderError(
                "Google sign-in was cancelled. Please try again.",
            );
        }

        const code = c.req.query("code");
        const rawNonce = entry.session.googleNonce;
        // googleNonce is only set by /authorize/google, so its absence means this
        // callback didn't originate from a flow we started.
        if (!code || !rawNonce) {
            return renderError("Google sign-in failed. Please try again.");
        }

        const googleClientId = process.env.GOOGLE_CLIENT_ID;
        const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
        if (!googleClientId || !googleClientSecret) {
            return c.json({ error: "google_not_configured" }, 500);
        }
        if (!claimSession(entry)) {
            return c.json({ error: "session_in_use" }, 409);
        }

        try {
            const tokenRes = await fetch(
                "https://oauth2.googleapis.com/token",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                        code,
                        client_id: googleClientId,
                        client_secret: googleClientSecret,
                        // Must byte-match the redirect_uri sent in /authorize/google.
                        redirect_uri: `${getBaseUrl(c)}/auth/google/callback`,
                        grant_type: "authorization_code",
                    }),
                },
            );

            if (!tokenRes.ok) {
                return renderError("Google sign-in failed. Please try again.");
            }

            const tokenData = (await tokenRes.json()) as { id_token?: string };
            if (!tokenData.id_token) {
                return renderError("Google sign-in failed. Please try again.");
            }

            const userId = await signInWithGoogleIdToken(
                tokenData.id_token,
                rawNonce,
            );

            return await finishAuthorization(
                c,
                sessionId,
                entry.session,
                userId,
            );
        } catch (err) {
            console.error("Google sign-in failed:", err);
            if (isServiceUnavailableError(err)) {
                return c.json({ error: "service_unavailable" }, 503);
            }
            const message =
                err instanceof Error && err.message === "invite_required"
                    ? "Registration is invite-only. Ask the owner for access."
                    : "Google sign-in failed. Please try again.";
            return renderError(message);
        } finally {
            releaseSession(sessionId, entry);
        }
    });

    // Token endpoint
    oauth.post("/token", async (c) => {
        const body = await c.req.parseBody();
        const grantType = body.grant_type as string;
        const code = body.code as string;
        const codeVerifier = body.code_verifier as string | undefined;
        const redirectUri = body.redirect_uri as string;
        const reqClientId = body.client_id as string | undefined;
        const reqClientSecret = body.client_secret as string | undefined;

        if (grantType === "refresh_token") {
            const refreshToken = body.refresh_token as string;
            if (!refreshToken) {
                return c.json({ error: "invalid_request" }, 400);
            }

            const newAccessToken = crypto.randomUUID();
            const newRefreshToken = crypto.randomUUID();
            try {
                if (
                    !(await rotateRefreshToken(
                        refreshToken,
                        newAccessToken,
                        newRefreshToken,
                    ))
                ) {
                    return c.json({ error: "invalid_grant" }, 400);
                }
            } catch (err) {
                console.error("Refresh-token rotation failed:", err);
                return c.json({ error: "service_unavailable" }, 503);
            }

            return c.json({
                access_token: newAccessToken,
                token_type: "Bearer",
                expires_in: 365 * 24 * 60 * 60,
                refresh_token: newRefreshToken,
            });
        }

        if (grantType !== "authorization_code") {
            return c.json({ error: "unsupported_grant_type" }, 400);
        }

        if (!code || !redirectUri) {
            return c.json({ error: "invalid_request" }, 400);
        }

        // Validate client credentials if provided
        if (reqClientId && reqClientId !== clientId) {
            return c.json({ error: "invalid_client" }, 401);
        }
        if (reqClientSecret && reqClientSecret !== clientSecret) {
            return c.json({ error: "invalid_client" }, 401);
        }

        const accessToken = crypto.randomUUID();
        const refreshToken = crypto.randomUUID();
        const verifierHash = codeVerifier
            ? await pkceHash(codeVerifier)
            : undefined;
        try {
            if (
                !(await redeemAuthCode(
                    code,
                    redirectUri,
                    verifierHash,
                    accessToken,
                    refreshToken,
                ))
            ) {
                return c.json({ error: "invalid_grant" }, 400);
            }
        } catch (err) {
            console.error("Authorization-code exchange failed:", err);
            return c.json(
                {
                    error: isServiceUnavailableError(err)
                        ? "service_unavailable"
                        : "token_exchange_failed",
                },
                503,
            );
        }

        return c.json({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 365 * 24 * 60 * 60,
            refresh_token: refreshToken,
        });
    });

    return oauth;
}
