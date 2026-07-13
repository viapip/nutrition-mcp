# Setting up Google Auth

This guide walks through enabling **"Continue with Google"** sign-in for nutrition-mcp.

> **Read this first — the one thing tutorials get wrong for this project.**
> This server runs the Google OAuth redirect **itself** and verifies the
> resulting ID token against Google's JWKS on the server. So **Google must
> redirect back to _your_ server**: the redirect URI you register in Google is
> `https://nutrition.viapip.com/auth/google/callback`. No third-party auth
> provider is involved.

---

## 1. Google Cloud Console

Open <https://console.cloud.google.com/> and select your project (e.g.
`nutrition-mcp`). Everything below lives under **Google Auth Platform** in the
left sidebar (the newer unified UI that replaced the old single "OAuth consent
screen" page).

### A. Branding

App name, support email, and developer contact. This is the "Create Google Auth
configuration" step — usually already done when the project is created. Only
revisit to add a logo or homepage/privacy links.

### B. Data Access _(= old "Scopes")_

1. Sidebar → **Data Access** → **Add or remove scopes**.
2. Add these three non-sensitive scopes (no Google verification review required):
    - `openid`
    - `.../auth/userinfo.email`
    - `.../auth/userinfo.profile`
3. **Update** → **Save**.

### C. Audience _(= old "Publishing status / Test users")_

1. Sidebar → **Audience**.
2. While status is **Testing**, only listed users can sign in → add your Google
   email under **Test users**, **or**
3. Click **Publish app** to allow anyone (instant for the basic scopes above —
   no review needed).

### D. Clients _(= old "Credentials → OAuth client ID")_ — the main step

1. Sidebar → **Clients** → **Create client**.
2. **Application type: Web application**.
3. Name: anything (e.g. `nutrition-mcp web`).
4. **Authorized redirect URIs** — add both:
    - `http://localhost:8080/auth/google/callback` (local dev)
    - `https://nutrition.viapip.com/auth/google/callback` (production)
5. **Create**, then copy the **Client ID** and **Client secret**.

> ⚠️ **Don't confuse the two URI fields.** The callback path goes in
> **Authorized redirect URIs**. If you paste it into **Authorized JavaScript
> origins** you'll get _"Invalid Origin: URIs must not contain a path or end with
> '/'."_ — that field only accepts an origin (scheme + host + port, no path).
> Leave **Authorized JavaScript origins** empty; we don't use Google's browser
> SDK.

> The redirect URIs must match byte-for-byte what the server builds from the
> request headers. Add a callback URL for every host you serve from (staging,
> previews, etc.).

---

## 2. Will existing email/password users be linked when they sign in with Google?

**Yes — automatically — as long as the Google account's email matches the email
they registered with.** `signInWithGoogleIdToken` (`src/db.ts`) links a Google
identity (`google_sub`) to an existing `users` row whenever the token's email
matches and Google reports it **verified** (`email_verified: true`) — a Google
token with an unverified email is never linked.

Linking also **clears the account's password**: password signup never proves
ownership of the address, so a password planted on someone else's email must
not survive the real owner's first Google sign-in (pre-account-takeover).
After linking, the account is Google-only.

So the outcomes are:

| Situation                                           | Result                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Google email matches an existing password account   | Linked to the **same** user — data kept, password invalidated |
| Google email is new                                 | A fresh user is created                                       |
| Google email differs from the user's registered one | No match → a separate account                                 |

Nothing in the app or on the user's part is required for linking — it happens
server-side during sign-in.

---

## 3. Environment variables

**Local** — add to `.env` (Bun auto-loads it):

```
GOOGLE_CLIENT_ID=<client id from step 1.D>
GOOGLE_CLIENT_SECRET=<client secret from step 1.D>
```

**Production** — set the same two variables in the deployment environment for
`nutrition.viapip.com`.

Until these are set, the Google button still renders but clicking it returns
`{"error":"google_not_configured"}`. Email/password sign-in works regardless.

---

## 4. Test end-to-end (local)

1. Restart the server to load the new env vars: `bun run src/index.ts`.
2. Open (substitute your real `OAUTH_CLIENT_ID`):
    ```
    http://localhost:8080/authorize?response_type=code&client_id=<OAUTH_CLIENT_ID>&redirect_uri=http://localhost:8080/health&state=test
    ```
    `/health` is a throwaway redirect target so you can read the result off the
    URL bar.
3. Click **Continue with Google** and pick an account. You should bounce:
   `/authorize/google` → Google → `/auth/google/callback` →
   `…/health?code=…&state=test`.
4. Check the database: `docker compose exec postgres psql -U nutrition -c
"select email, google_sub from users"` — the account should have a
   `google_sub`.
5. _(Optional, full token check)_ exchange the `code` for a token and call `/mcp`:
    ```
    curl -X POST http://localhost:8080/token \
      -d grant_type=authorization_code -d code=<authCode> \
      -d redirect_uri=http://localhost:8080/health \
      -d client_id=<OAUTH_CLIENT_ID> -d client_secret=<OAUTH_CLIENT_SECRET>
    ```
    then
    ```
    curl http://localhost:8080/mcp \
      -H "Authorization: Bearer <access_token>" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
    ```
    Expect a tool list, not a 401.

---

## Troubleshooting

| Symptom                                           | Cause / fix                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| _"Invalid Origin: URIs must not contain a path…"_ | You typed the callback into **Authorized JavaScript origins**. Use **Authorized redirect URIs** instead.                                        |
| `redirect_uri_mismatch` on Google's screen        | The callback URL isn't registered, or differs (http vs https, port, trailing slash). Add the exact one to **Authorized redirect URIs**.         |
| `{"error":"google_not_configured"}`               | `GOOGLE_CLIENT_ID`/`SECRET` not set in that environment.                                                                                        |
| "Access blocked / app not verified"               | Consent screen still in **Testing** — add your email under **Audience → Test users**, or **Publish**.                                           |
| Sign-in fails right after Google consent          | `GOOGLE_CLIENT_ID` doesn't match the client that issued the token (`aud` check), or the token's nonce didn't match — retry from the login page. |
| Two separate users for the same person            | The Google email differs from the one they registered with, so there was no verified match to link on.                                          |

---

## How it works (reference)

```
login page → [Continue with Google]
  → GET /authorize/google?session_id=X
      → 302 to accounts.google.com (state=session_id, nonce=sha256hex(rawNonce))
  → Google consent → 302 to GET /auth/google/callback?code=…&state=session_id
      → POST oauth2.googleapis.com/token  → id_token   (server-to-server)
      → verify id_token (jose + Google JWKS: iss, aud, exp, hashed nonce)
      → find user by google_sub, else link verified email, else create
      → mint our auth code + 302 to the MCP client's redirect_uri
```

Relevant code: `src/oauth.ts` (`/authorize/google`, `/auth/google/callback`),
`src/db.ts` (`signInWithGoogleIdToken`).
