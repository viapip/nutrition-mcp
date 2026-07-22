import { SQL } from "bun";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { zonedDayStartUtc, zonedNextDayStartUtc } from "./tz.js";
import { decodeEscapeSequences } from "./normalize.js";
import { isWeightUnit, type WeightUnit } from "./units.js";
import { validateDateRange } from "./validate.js";

let sql: SQL | undefined;

function buildSql(): SQL {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error("Missing DATABASE_URL");
    }
    return new SQL(url);
}

export function getSql(): SQL {
    if (!sql) sql = buildSql();
    return sql;
}

/** Test hook: replace the connection singleton with a scripted fake. */
export function setSqlForTests(fake: unknown): void {
    sql = fake as SQL;
}

function errMsg(err: unknown): string {
    console.error("[db] operation failed:", err);
    return classifiedErrMsg(err);
}

function sensitiveErrMsg(err: unknown): string {
    // Query parameters may contain an encrypted API key. Never pass the driver
    // error object to the logger for this write path.
    console.error("[db] sensitive operation failed");
    return classifiedErrMsg(err);
}

function classifiedErrMsg(err: unknown): string {
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") return "conflict";
    if (code === "23514" || code === "22P02" || code === "22003") {
        return "validation_failed";
    }
    return "database_unavailable";
}

export function isServiceUnavailableError(err: unknown): boolean {
    return err instanceof Error && err.message.includes("database_unavailable");
}

export function isValidationError(err: unknown): boolean {
    return err instanceof Error && err.message.includes("validation_failed");
}

export function isConflictError(err: unknown): boolean {
    return err instanceof Error && err.message.includes("conflict");
}

export class NotFoundError extends Error {}

// Postgres unique_violation — the driver surfaces the server error code.
function isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string } | null)?.code === "23505";
}

// ---------- Row normalization ----------
// The driver returns timestamptz as Date and numeric as string (to preserve
// precision); the exported contracts promise ISO strings and numbers, so every
// row is normalized before leaving this module.

function iso(value: unknown): string {
    return value instanceof Date ? value.toISOString() : String(value);
}

function numOrNull(value: unknown): number | null {
    if (value == null) return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

// ---------- Auth ----------

// Matches the minimum Supabase Auth enforced, so imported users' expectations
// (and the login page's error copy) stay the same.
const MIN_PASSWORD_LENGTH = 6;

// Deliberately loose: non-empty local@domain.tld. Real validation happens by
// the mailbox existing; this only rejects obvious garbage.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hash of a random throwaway password. Verified against when the account is
// missing (or has no password) so response time doesn't reveal whether the
// email exists. Exported for tests.
export const DUMMY_PASSWORD_HASH =
    "$argon2id$v=19$m=65536,t=2,p=1$1NxHal//xQW4fkEyoLm6F1jnqV5AC4qeN/WXpr4s+Tc$EOW2N1SQX6grCravmieYV6NhzyJeSlUeXh7Sh9kmB5M";

export async function signUpUser(
    email: string,
    password: string,
): Promise<string> {
    if (!EMAIL_REGEX.test(email)) {
        throw new Error("Invalid email address");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(
            `Password should be at least ${MIN_PASSWORD_LENGTH} characters`,
        );
    }
    // New passwords get argon2id; verify still accepts bcrypt hashes imported
    // from the Supabase dump (the algorithm is encoded in the hash itself).
    const passwordHash = await Bun.password.hash(password, {
        algorithm: "argon2id",
    });

    const db = getSql();
    try {
        const [row] = await db`
            insert into users (email, password_hash)
            values (${email.toLowerCase()}, ${passwordHash})
            returning id`;
        return row.id as string;
    } catch (err) {
        if (isUniqueViolation(err)) throw new Error("User already registered");
        throw new Error(`Sign-up failed: ${errMsg(err)}`);
    }
}

export async function signInUser(
    email: string,
    password: string,
): Promise<string> {
    const db = getSql();
    let row: Record<string, unknown> | undefined;
    try {
        [row] = await db`
            select id, password_hash from users
            where lower(email) = ${email.toLowerCase()}`;
    } catch (err) {
        throw new Error(`Failed to sign in: ${errMsg(err)}`);
    }

    // Same generic message for "no such user", "Google-only account", and
    // "wrong password" so the login form doesn't leak which one it was. The
    // dummy verify keeps the missing-account path as slow as the real one.
    if (!row?.password_hash) {
        await Bun.password
            .verify(password, DUMMY_PASSWORD_HASH)
            .catch(() => {});
        throw new Error("Invalid login credentials");
    }

    let ok = false;
    try {
        ok = await Bun.password.verify(password, row.password_hash as string);
    } catch {
        ok = false; // unparseable/legacy hash — treat as a failed login
    }
    if (!ok) throw new Error("Invalid login credentials");
    return row.id as string;
}

export function sha256hex(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let googleJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getGoogleJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!googleJwks) googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    return googleJwks;
}

export interface GoogleClaims {
    sub: string;
    email: string;
}

/**
 * Validates the app-level claims of an already signature-verified Google
 * id_token. The hex-encoded SHA-256 of the raw nonce is what was sent to
 * Google, so that is what must come back in the token. Accounts are only
 * linked/created for verified emails. Exported for tests.
 */
export function validateGoogleClaims(
    payload: JWTPayload,
    rawNonce: string,
): GoogleClaims {
    if (
        typeof payload.nonce !== "string" ||
        payload.nonce !== sha256hex(rawNonce)
    ) {
        throw new Error("Google sign-in failed");
    }
    if (
        payload.email_verified !== true ||
        typeof payload.email !== "string" ||
        typeof payload.sub !== "string"
    ) {
        throw new Error("Google sign-in failed");
    }
    return { sub: payload.sub, email: payload.email.toLowerCase() };
}

export async function signInWithGoogleIdToken(
    idToken: string,
    nonce: string,
): Promise<string> {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) throw new Error("Google sign-in is not configured");

    // jwtVerify checks the signature against Google's JWKS plus iss/aud/exp.
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(idToken, getGoogleJwks(), {
            issuer: GOOGLE_ISSUERS,
            audience: googleClientId,
        }));
    } catch {
        throw new Error("Google sign-in failed");
    }

    const { sub, email } = validateGoogleClaims(payload, nonce);
    return resolveGoogleUser(sub, email);
}

/**
 * Maps verified Google claims to a user id: match by google_sub, else link an
 * existing account by (verified) email, else create one. Exported for tests.
 */
export async function resolveGoogleUser(
    sub: string,
    email: string,
): Promise<string> {
    const db = getSql();

    let bySub: Record<string, unknown> | undefined;
    try {
        [bySub] = await db`
            select id from users where google_sub = ${sub}`;
    } catch (err) {
        throw new Error(`Google sign-in failed: ${errMsg(err)}`);
    }
    if (bySub) return bySub.id as string;

    // First Google sign-in for an existing password account: link by email
    // (validateGoogleClaims already required email_verified).
    let byEmail: Record<string, unknown> | undefined;
    try {
        [byEmail] = await db`
            select id, google_sub from users where lower(email) = ${email}`;
    } catch (err) {
        throw new Error(`Google sign-in failed: ${errMsg(err)}`);
    }
    if (byEmail) {
        // The account already belongs to a different Google identity — refuse
        // rather than silently rebinding it. (Equal subs can't reach here:
        // the by-sub lookup above would have matched.)
        if (byEmail.google_sub != null)
            throw new Error("Google sign-in failed");
        try {
            // password_hash is nulled on link: signup never proves email
            // ownership, so a pre-planted password on this address must not
            // survive the real owner's first Google sign-in (account
            // takeover). Google just proved ownership; the password didn't.
            const [linked] = await db`
                update users
                set google_sub = ${sub}, email_verified = true,
                    password_hash = null, updated_at = now()
                where id = ${byEmail.id} and google_sub is null
                returning id`;
            if (linked) return linked.id as string;
        } catch (err) {
            // 23505: this sub got linked to another row concurrently.
            if (!isUniqueViolation(err))
                throw new Error(`Google sign-in failed: ${errMsg(err)}`);
        }
        // Lost a race (row gained a sub, or 23505) — resolve by sub.
        let row: Record<string, unknown> | undefined;
        try {
            [row] = await db`
                select id from users where google_sub = ${sub}`;
        } catch (err) {
            throw new Error(`Google sign-in failed: ${errMsg(err)}`);
        }
        if (row) return row.id as string;
        throw new Error("Google sign-in failed");
    }

    // Invite gate: when SIGNUP_CODE is set, brand-new accounts must come
    // through the code-gated signup paths — Google must not auto-provision
    // strangers. Existing accounts (matched by sub/email above) still sign in.
    if (process.env.SIGNUP_CODE) throw new Error("invite_required");

    try {
        const [created] = await db`
            insert into users (email, google_sub, email_verified)
            values (${email}, ${sub}, true)
            returning id`;
        return created.id as string;
    } catch (err) {
        // Concurrent first sign-in — the other request created the user.
        if (isUniqueViolation(err)) {
            let row: Record<string, unknown> | undefined;
            try {
                [row] = await db`
                    select id from users where google_sub = ${sub}`;
            } catch (retryErr) {
                throw new Error(`Google sign-in failed: ${errMsg(retryErr)}`);
            }
            if (row) return row.id as string;
            throw new Error("Google sign-in failed");
        }
        throw new Error(`Google sign-in failed: ${errMsg(err)}`);
    }
}

// ---------- Meals ----------

export type NutritionSource = "estimate" | "barcode" | "dish" | "manual";

export interface Meal {
    id: string;
    user_id: string;
    logged_at: string;
    meal_type: string | null;
    description: string;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    nutrition_source: NutritionSource | null;
    notes: string | null;
    idempotency_key: string | null;
}

export interface MealInput {
    description: string;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    // null clears the stored value on update (insert treats it as "not given")
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
    nutrition_source?: NutritionSource | null;
    logged_at?: string;
    notes?: string | null;
    idempotency_key?: string;
}

export interface MealInsertResult {
    meal: Meal;
    deduplicated: boolean;
}

function mapMeal(row: Record<string, unknown>): Meal {
    return {
        id: row.id as string,
        user_id: row.user_id as string,
        logged_at: iso(row.logged_at),
        meal_type: (row.meal_type as string | null) ?? null,
        description: row.description as string,
        calories: numOrNull(row.calories),
        protein_g: numOrNull(row.protein_g),
        carbs_g: numOrNull(row.carbs_g),
        fat_g: numOrNull(row.fat_g),
        nutrition_source:
            (row.nutrition_source as NutritionSource | null) ?? null,
        notes: (row.notes as string | null) ?? null,
        idempotency_key: (row.idempotency_key as string | null) ?? null,
    };
}

export async function insertMeal(
    userId: string,
    input: MealInput,
): Promise<MealInsertResult> {
    const db = getSql();

    // Retry deduplication requires a stable client-supplied key. When omitted,
    // the write is intentionally non-idempotent because a generated timestamp
    // cannot be reproduced by a later retry.
    const idempotencyKey = input.idempotency_key ?? null;

    try {
        const [row] = await db`
            insert into meals (
                user_id, description, meal_type, calories,
                protein_g, carbs_g, fat_g, nutrition_source, logged_at, notes,
                idempotency_key
            ) values (
                ${userId},
                ${decodeEscapeSequences(input.description)},
                ${input.meal_type},
                ${input.calories ?? null},
                ${input.protein_g ?? null},
                ${input.carbs_g ?? null},
                ${input.fat_g ?? null},
                ${input.nutrition_source ?? null},
                coalesce(${input.logged_at ?? null}::timestamptz, now()),
                ${input.notes != null ? decodeEscapeSequences(input.notes) : null},
                ${idempotencyKey}
            )
            returning *`;
        return { meal: mapMeal(row), deduplicated: false };
    } catch (err) {
        // The idempotency key already exists (a retry, or a concurrent insert
        // that won the race) — return the stored row as a dedup instead of
        // failing. This is the sole dedup path: no pre-insert lookup.
        if (idempotencyKey && isUniqueViolation(err)) {
            const [row] = await db`
                select * from meals
                where user_id = ${userId} and idempotency_key = ${idempotencyKey}`;
            if (row) return { meal: mapMeal(row), deduplicated: true };
        }
        throw new Error(`Failed to insert meal: ${errMsg(err)}`);
    }
}

export async function getMealsByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    return getMealsInRange(userId, date, date, tz);
}

export async function getMealsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<Meal[]> {
    validateDateRange(startDate, endDate);
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    const db = getSql();
    try {
        const rows = await db`
            select id, user_id, logged_at, meal_type, description, calories,
                   protein_g, carbs_g, fat_g, nutrition_source, notes,
                   idempotency_key
            from meals
            where user_id = ${userId}
              and logged_at >= ${startUtc.toISOString()}
              and logged_at < ${endUtc.toISOString()}
            order by logged_at asc`;
        return rows.map(mapMeal);
    } catch (err) {
        throw new Error(`Failed to get meals: ${errMsg(err)}`);
    }
}

export async function getAllMeals(userId: string): Promise<Meal[]> {
    const db = getSql();
    try {
        const rows = await db`
            select * from meals
            where user_id = ${userId}
            order by logged_at asc`;
        return rows.map(mapMeal);
    } catch (err) {
        throw new Error(`Failed to get meals: ${errMsg(err)}`);
    }
}

export async function searchMeals(
    userId: string,
    query: string,
    limit: number = 20,
): Promise<Meal[]> {
    const db = getSql();
    try {
        const literalQuery = query.replace(/[\\%_]/g, "\\$&");
        const literalPattern = `%${literalQuery}%`;
        const rows = await db`
            with search_params as (
                select plainto_tsquery('russian', ${query}) as tsquery
            )
            select id, user_id, logged_at, meal_type, description, calories,
                   protein_g, carbs_g, fat_g, nutrition_source, notes,
                   idempotency_key,
                   lower(trim(description)) = lower(trim(${query})) as exact_match,
                   description ilike ${literalPattern} escape ${"\\"} as literal_match,
                   ts_rank_cd(
                       to_tsvector('russian', description),
                       search_params.tsquery
                   ) as relevance
            from meals
            cross join search_params
            where user_id = ${userId}
              and (
                  to_tsvector('russian', description) @@ search_params.tsquery
                  or description ilike ${literalPattern} escape ${"\\"}
              )
            order by exact_match desc, literal_match desc, relevance desc,
                     logged_at desc
            limit ${Math.min(100, Math.max(1, Math.round(limit)))}`;
        return rows.map(mapMeal);
    } catch (err) {
        throw new Error(`Failed to search meals: ${errMsg(err)}`);
    }
}

export async function deleteMeal(userId: string, id: string): Promise<boolean> {
    const db = getSql();
    try {
        const rows = await db`
            delete from meals where id = ${id} and user_id = ${userId}
            returning id`;
        return rows.length > 0;
    } catch (err) {
        throw new Error(`Failed to delete meal: ${errMsg(err)}`);
    }
}

export async function updateMeal(
    userId: string,
    id: string,
    fields: Partial<MealInput>,
): Promise<Meal> {
    const update: Record<string, unknown> = {};
    if (fields.description !== undefined)
        update.description = decodeEscapeSequences(fields.description);
    if (fields.meal_type !== undefined) update.meal_type = fields.meal_type;
    if (fields.calories !== undefined) update.calories = fields.calories;
    if (fields.protein_g !== undefined) update.protein_g = fields.protein_g;
    if (fields.carbs_g !== undefined) update.carbs_g = fields.carbs_g;
    if (fields.fat_g !== undefined) update.fat_g = fields.fat_g;
    if (fields.nutrition_source !== undefined)
        update.nutrition_source = fields.nutrition_source;
    if (fields.logged_at !== undefined) update.logged_at = fields.logged_at;
    if (fields.notes !== undefined)
        update.notes =
            fields.notes != null
                ? decodeEscapeSequences(fields.notes)
                : fields.notes;

    const db = getSql();
    try {
        const [row] =
            Object.keys(update).length === 0
                ? await db`
                      select * from meals
                      where id = ${id} and user_id = ${userId}`
                : await db`
                      update meals set ${db(update)}
                      where id = ${id} and user_id = ${userId}
                      returning *`;
        if (!row) throw new NotFoundError("meal not found");
        return mapMeal(row);
    } catch (err) {
        if (err instanceof NotFoundError) throw err;
        throw new Error(`Failed to update meal: ${errMsg(err)}`);
    }
}

// ---------- Dishes ----------

export interface Dish {
    id: string;
    user_id: string;
    name: string;
    meal_type: string | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    created_at: string;
}

export interface DishInput {
    name: string;
    // null clears the stored value on update (insert treats it as "not given")
    meal_type?: "breakfast" | "lunch" | "dinner" | "snack" | null;
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
}

function mapDish(row: Record<string, unknown>): Dish {
    return {
        id: row.id as string,
        user_id: row.user_id as string,
        name: row.name as string,
        meal_type: (row.meal_type as string | null) ?? null,
        calories: numOrNull(row.calories),
        protein_g: numOrNull(row.protein_g),
        carbs_g: numOrNull(row.carbs_g),
        fat_g: numOrNull(row.fat_g),
        created_at: iso(row.created_at),
    };
}

export async function listDishes(userId: string): Promise<Dish[]> {
    const db = getSql();
    try {
        const rows = await db`
            select * from dishes
            where user_id = ${userId}
            order by lower(name) asc`;
        return rows.map(mapDish);
    } catch (err) {
        throw new Error(`Failed to get dishes: ${errMsg(err)}`);
    }
}

// Upsert by (user_id, lower(name)): saving a name that already exists overwrites
// it, so "remember this dish" twice never piles up duplicates.
export async function insertDish(
    userId: string,
    input: DishInput,
): Promise<Dish> {
    const db = getSql();
    try {
        const [row] = await db`
            insert into dishes (
                user_id, name, meal_type, calories, protein_g, carbs_g, fat_g
            ) values (
                ${userId},
                ${decodeEscapeSequences(input.name.trim())},
                ${input.meal_type ?? null},
                ${input.calories ?? null},
                ${input.protein_g ?? null},
                ${input.carbs_g ?? null},
                ${input.fat_g ?? null}
            )
            on conflict (user_id, lower(name)) do update set
                name = excluded.name,
                meal_type = excluded.meal_type,
                calories = excluded.calories,
                protein_g = excluded.protein_g,
                carbs_g = excluded.carbs_g,
                fat_g = excluded.fat_g
            returning *`;
        return mapDish(row);
    } catch (err) {
        throw new Error(`Failed to save dish: ${errMsg(err)}`);
    }
}

export async function updateDish(
    userId: string,
    id: string,
    fields: Partial<DishInput>,
): Promise<Dish> {
    const update: Record<string, unknown> = {};
    if (fields.name !== undefined)
        update.name = decodeEscapeSequences(fields.name.trim());
    if (fields.meal_type !== undefined) update.meal_type = fields.meal_type;
    if (fields.calories !== undefined) update.calories = fields.calories;
    if (fields.protein_g !== undefined) update.protein_g = fields.protein_g;
    if (fields.carbs_g !== undefined) update.carbs_g = fields.carbs_g;
    if (fields.fat_g !== undefined) update.fat_g = fields.fat_g;

    const db = getSql();
    try {
        const [row] =
            Object.keys(update).length === 0
                ? await db`
                      select * from dishes
                      where id = ${id} and user_id = ${userId}`
                : await db`
                      update dishes set ${db(update)}
                      where id = ${id} and user_id = ${userId}
                      returning *`;
        if (!row) throw new NotFoundError("dish not found");
        return mapDish(row);
    } catch (err) {
        if (err instanceof NotFoundError) throw err;
        throw new Error(`Failed to update dish: ${errMsg(err)}`);
    }
}

export async function deleteDish(userId: string, id: string): Promise<boolean> {
    const db = getSql();
    try {
        const rows = await db`
            delete from dishes where id = ${id} and user_id = ${userId}
            returning id`;
        return rows.length > 0;
    } catch (err) {
        throw new Error(`Failed to delete dish: ${errMsg(err)}`);
    }
}

// ---------- Profiles ----------

const LLM_KEY_PREFIX = "enc:v1:";
const LLM_KEY_AAD = new TextEncoder().encode("profiles.llm_api_key:enc:v1");

async function llmEncryptionKey(secret: string): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secret),
    );
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
        "encrypt",
        "decrypt",
    ]);
}

export async function encryptLlmApiKey(
    value: string | null,
    secret: string | undefined = process.env.LLM_KEY_SECRET,
): Promise<string | null> {
    if (value == null || !secret) return value;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: LLM_KEY_AAD },
        await llmEncryptionKey(secret),
        new TextEncoder().encode(value),
    );
    return `${LLM_KEY_PREFIX}${Buffer.from(iv).toString("base64url")}:${Buffer.from(ciphertext).toString("base64url")}`;
}

export async function decryptLlmApiKey(
    value: string | null,
    secret: string | undefined = process.env.LLM_KEY_SECRET,
): Promise<string | null> {
    if (value == null || !value.startsWith(LLM_KEY_PREFIX)) return value;
    if (!secret)
        throw new Error("LLM_KEY_SECRET is required for encrypted keys");

    const parts = value.slice(LLM_KEY_PREFIX.length).split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error("Invalid encrypted LLM key");
    }
    try {
        const plaintext = await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: Buffer.from(parts[0], "base64url"),
                additionalData: LLM_KEY_AAD,
            },
            await llmEncryptionKey(secret),
            Buffer.from(parts[1], "base64url"),
        );
        return new TextDecoder().decode(plaintext);
    } catch {
        throw new Error("Invalid encrypted LLM key");
    }
}

export interface Profile {
    user_id: string;
    timezone: string;
    preferred_weight_unit: WeightUnit | null;
    llm_api_key: string | null;
    created_at: string;
    updated_at: string;
}

async function mapProfile(row: Record<string, unknown>): Promise<Profile> {
    return {
        user_id: row.user_id as string,
        timezone: row.timezone as string,
        preferred_weight_unit:
            (row.preferred_weight_unit as WeightUnit | null) ?? null,
        llm_api_key: await decryptLlmApiKey(
            (row.llm_api_key as string | null) ?? null,
        ),
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
    };
}

export async function getProfile(userId: string): Promise<Profile | null> {
    const db = getSql();
    try {
        const [row] = await db`
            select * from profiles where user_id = ${userId}`;
        return row ? await mapProfile(row) : null;
    } catch (err) {
        throw new Error(`Failed to get profile: ${errMsg(err)}`);
    }
}

export async function getUserTimezone(userId: string): Promise<string> {
    const profile = await getProfile(userId);
    return profile?.timezone ?? "UTC";
}

// Returns the user's saved weight-unit preference, or null if they have never
// chosen one. Write paths use null to refuse guessing; display paths coalesce
// to "kg".
export async function getPreferredWeightUnit(
    userId: string,
): Promise<WeightUnit | null> {
    const profile = await getProfile(userId);
    const unit = profile?.preferred_weight_unit;
    return isWeightUnit(unit) ? unit : null;
}

// Upsert the fields provided in `patch`, leaving other columns untouched. On
// first insert, omitted columns fall back to their defaults (UTC / no unit).
export async function upsertProfile(
    userId: string,
    patch: {
        timezone?: string;
        preferred_weight_unit?: WeightUnit | null;
        llm_api_key?: string | null;
    },
): Promise<Profile> {
    const tz = patch.timezone ?? null;
    // null is meaningful for the unit and the key (clears the value), so a
    // separate flag distinguishes "not provided" from "set to null".
    const unitProvided = patch.preferred_weight_unit !== undefined;
    const unit = patch.preferred_weight_unit ?? null;
    const keyProvided = patch.llm_api_key !== undefined;
    const key = keyProvided
        ? await encryptLlmApiKey(patch.llm_api_key ?? null)
        : null;

    const db = getSql();
    try {
        const [row] = await db`
            insert into profiles (user_id, timezone, preferred_weight_unit, llm_api_key)
            values (${userId}, coalesce(${tz}::text, 'UTC'), ${unit}::text, ${key}::text)
            on conflict (user_id) do update set
                timezone = coalesce(${tz}::text, profiles.timezone),
                preferred_weight_unit = case
                    when ${unitProvided}::boolean then ${unit}::text
                    else profiles.preferred_weight_unit
                end,
                llm_api_key = case
                    when ${keyProvided}::boolean then ${key}::text
                    else profiles.llm_api_key
                end,
                updated_at = now()
            returning *`;
        return await mapProfile(row);
    } catch (err) {
        throw new Error(`Failed to save profile: ${sensitiveErrMsg(err)}`);
    }
}

// ---------- Nutrition goals ----------

export interface NutritionGoals {
    user_id: string;
    daily_calories: number | null;
    daily_protein_g: number | null;
    daily_carbs_g: number | null;
    daily_fat_g: number | null;
    daily_water_ml: number | null;
    target_weight_g: number | null;
    updated_at: string;
}

export interface NutritionGoalsInput {
    daily_calories?: number | null;
    daily_protein_g?: number | null;
    daily_carbs_g?: number | null;
    daily_fat_g?: number | null;
    daily_water_ml?: number | null;
    target_weight_g?: number | null;
}

function mapGoals(row: Record<string, unknown>): NutritionGoals {
    return {
        user_id: row.user_id as string,
        daily_calories: numOrNull(row.daily_calories),
        daily_protein_g: numOrNull(row.daily_protein_g),
        daily_carbs_g: numOrNull(row.daily_carbs_g),
        daily_fat_g: numOrNull(row.daily_fat_g),
        daily_water_ml: numOrNull(row.daily_water_ml),
        target_weight_g: numOrNull(row.target_weight_g),
        updated_at: iso(row.updated_at),
    };
}

export async function upsertNutritionGoals(
    userId: string,
    input: NutritionGoalsInput,
): Promise<NutritionGoals> {
    const db = getSql();
    try {
        const [row] = await db`
            insert into nutrition_goals (
                user_id, daily_calories, daily_protein_g, daily_carbs_g,
                daily_fat_g, daily_water_ml, target_weight_g, updated_at
            ) values (
                ${userId},
                ${input.daily_calories ?? null},
                ${input.daily_protein_g ?? null},
                ${input.daily_carbs_g ?? null},
                ${input.daily_fat_g ?? null},
                ${input.daily_water_ml ?? null},
                ${input.target_weight_g ?? null},
                now()
            )
            on conflict (user_id) do update set
                daily_calories = excluded.daily_calories,
                daily_protein_g = excluded.daily_protein_g,
                daily_carbs_g = excluded.daily_carbs_g,
                daily_fat_g = excluded.daily_fat_g,
                daily_water_ml = excluded.daily_water_ml,
                target_weight_g = excluded.target_weight_g,
                updated_at = now()
            returning *`;
        return mapGoals(row);
    } catch (err) {
        throw new Error(`Failed to save goals: ${errMsg(err)}`);
    }
}

/** Atomic partial upsert: omitted fields keep their current value. */
export async function patchNutritionGoals(
    userId: string,
    patch: NutritionGoalsInput,
): Promise<NutritionGoals> {
    const value = (key: keyof NutritionGoalsInput) => patch[key] ?? null;
    const provided = (key: keyof NutritionGoalsInput) =>
        patch[key] !== undefined;
    const db = getSql();
    try {
        const [row] = await db`
            insert into nutrition_goals (
                user_id, daily_calories, daily_protein_g, daily_carbs_g,
                daily_fat_g, daily_water_ml, target_weight_g, updated_at
            ) values (
                ${userId}, ${value("daily_calories")},
                ${value("daily_protein_g")}, ${value("daily_carbs_g")},
                ${value("daily_fat_g")}, ${value("daily_water_ml")},
                ${value("target_weight_g")}, now()
            )
            on conflict (user_id) do update set
                daily_calories = case when ${provided("daily_calories")}::boolean
                    then ${value("daily_calories")}::integer else nutrition_goals.daily_calories end,
                daily_protein_g = case when ${provided("daily_protein_g")}::boolean
                    then ${value("daily_protein_g")}::numeric else nutrition_goals.daily_protein_g end,
                daily_carbs_g = case when ${provided("daily_carbs_g")}::boolean
                    then ${value("daily_carbs_g")}::numeric else nutrition_goals.daily_carbs_g end,
                daily_fat_g = case when ${provided("daily_fat_g")}::boolean
                    then ${value("daily_fat_g")}::numeric else nutrition_goals.daily_fat_g end,
                daily_water_ml = case when ${provided("daily_water_ml")}::boolean
                    then ${value("daily_water_ml")}::integer else nutrition_goals.daily_water_ml end,
                target_weight_g = case when ${provided("target_weight_g")}::boolean
                    then ${value("target_weight_g")}::integer else nutrition_goals.target_weight_g end,
                updated_at = now()
            returning *`;
        return mapGoals(row);
    } catch (err) {
        throw new Error(`Failed to save goals: ${errMsg(err)}`);
    }
}

export async function getNutritionGoals(
    userId: string,
): Promise<NutritionGoals | null> {
    const db = getSql();
    try {
        const [row] = await db`
            select * from nutrition_goals where user_id = ${userId}`;
        return row ? mapGoals(row) : null;
    } catch (err) {
        throw new Error(`Failed to get goals: ${errMsg(err)}`);
    }
}

// ---------- Water log ----------

export interface WaterEntry {
    id: string;
    user_id: string;
    amount_ml: number;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

export interface WaterInput {
    amount_ml: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface WaterInsertResult {
    entry: WaterEntry;
    deduplicated: boolean;
}

function mapWater(row: Record<string, unknown>): WaterEntry {
    return {
        id: row.id as string,
        user_id: row.user_id as string,
        amount_ml: numOrNull(row.amount_ml) ?? 0,
        logged_at: iso(row.logged_at),
        notes: (row.notes as string | null) ?? null,
        created_at: iso(row.created_at),
        idempotency_key: (row.idempotency_key as string | null) ?? null,
    };
}

export async function insertWater(
    userId: string,
    input: WaterInput,
): Promise<WaterInsertResult> {
    const db = getSql();

    const idempotencyKey = input.idempotency_key ?? null;

    try {
        const [row] = await db`
            insert into water_log (
                user_id, amount_ml, logged_at, notes, idempotency_key
            ) values (
                ${userId},
                ${input.amount_ml},
                coalesce(${input.logged_at ?? null}::timestamptz, now()),
                ${input.notes ?? null},
                ${idempotencyKey}
            )
            returning *`;
        return { entry: mapWater(row), deduplicated: false };
    } catch (err) {
        if (idempotencyKey && isUniqueViolation(err)) {
            const [row] = await db`
                select * from water_log
                where user_id = ${userId} and idempotency_key = ${idempotencyKey}`;
            if (row) return { entry: mapWater(row), deduplicated: true };
        }
        throw new Error(`Failed to insert water: ${errMsg(err)}`);
    }
}

export async function getWaterByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<WaterEntry[]> {
    return getWaterInRange(userId, date, date, tz);
}

export async function getWaterInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<WaterEntry[]> {
    validateDateRange(startDate, endDate);
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    const db = getSql();
    try {
        const rows = await db`
            select id, user_id, amount_ml, logged_at, notes, created_at,
                   idempotency_key
            from water_log
            where user_id = ${userId}
              and logged_at >= ${startUtc.toISOString()}
              and logged_at < ${endUtc.toISOString()}
            order by logged_at asc`;
        return rows.map(mapWater);
    } catch (err) {
        throw new Error(`Failed to get water: ${errMsg(err)}`);
    }
}

export async function deleteWater(
    userId: string,
    id: string,
): Promise<boolean> {
    const db = getSql();
    try {
        const rows = await db`
            delete from water_log where id = ${id} and user_id = ${userId}
            returning id`;
        return rows.length > 0;
    } catch (err) {
        throw new Error(`Failed to delete water: ${errMsg(err)}`);
    }
}

// ---------- Weight log ----------

export interface WeightEntry {
    id: string;
    user_id: string;
    weight_g: number;
    logged_at: string;
    notes: string | null;
    created_at: string;
    idempotency_key: string | null;
}

export interface WeightInput {
    weight_g: number;
    logged_at?: string;
    notes?: string;
    idempotency_key?: string;
}

export interface WeightInsertResult {
    entry: WeightEntry;
    deduplicated: boolean;
}

function mapWeight(row: Record<string, unknown>): WeightEntry {
    return {
        id: row.id as string,
        user_id: row.user_id as string,
        weight_g: numOrNull(row.weight_g) ?? 0,
        logged_at: iso(row.logged_at),
        notes: (row.notes as string | null) ?? null,
        created_at: iso(row.created_at),
        idempotency_key: (row.idempotency_key as string | null) ?? null,
    };
}

export async function insertWeight(
    userId: string,
    input: WeightInput,
): Promise<WeightInsertResult> {
    const db = getSql();

    const loggedAt = input.logged_at ?? new Date().toISOString();
    const idempotencyKey = input.idempotency_key ?? null;

    try {
        const [row] = await db`
            insert into weight_log (
                user_id, weight_g, logged_at, notes, idempotency_key
            ) values (
                ${userId},
                ${input.weight_g},
                ${loggedAt},
                ${input.notes ?? null},
                ${idempotencyKey}
            )
            returning *`;
        return { entry: mapWeight(row), deduplicated: false };
    } catch (err) {
        if (idempotencyKey && isUniqueViolation(err)) {
            const [row] = await db`
                select * from weight_log
                where user_id = ${userId} and idempotency_key = ${idempotencyKey}`;
            if (row) return { entry: mapWeight(row), deduplicated: true };
        }
        throw new Error(`Failed to insert weight: ${errMsg(err)}`);
    }
}

export async function getWeightByDate(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<WeightEntry[]> {
    return getWeightInRange(userId, date, date, tz);
}

export async function getWeightInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string = "UTC",
): Promise<WeightEntry[]> {
    validateDateRange(startDate, endDate);
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    const db = getSql();
    try {
        const rows = await db`
            select id, user_id, weight_g, logged_at, notes, created_at,
                   idempotency_key
            from weight_log
            where user_id = ${userId}
              and logged_at >= ${startUtc.toISOString()}
              and logged_at < ${endUtc.toISOString()}
            order by logged_at asc`;
        return rows.map(mapWeight);
    } catch (err) {
        throw new Error(`Failed to get weight: ${errMsg(err)}`);
    }
}

/** Most recent weight entry overall, or null if none logged. */
export async function getLatestWeight(
    userId: string,
): Promise<WeightEntry | null> {
    const db = getSql();
    try {
        const [row] = await db`
            select * from weight_log
            where user_id = ${userId}
            order by logged_at desc
            limit 1`;
        return row ? mapWeight(row) : null;
    } catch (err) {
        throw new Error(`Failed to get latest weight: ${errMsg(err)}`);
    }
}

/** Most recent weight known by the end of a local calendar day. */
export async function getLatestWeightAsOf(
    userId: string,
    date: string,
    tz: string = "UTC",
): Promise<WeightEntry | null> {
    validateDateRange(date, date);
    const endUtc = zonedNextDayStartUtc(date, tz);
    const db = getSql();
    try {
        const [row] = await db`
            select * from weight_log
            where user_id = ${userId}
              and logged_at < ${endUtc.toISOString()}
            order by logged_at desc
            limit 1`;
        return row ? mapWeight(row) : null;
    } catch (err) {
        throw new Error(`Failed to get weight as of date: ${errMsg(err)}`);
    }
}

export async function updateWeight(
    userId: string,
    id: string,
    fields: { weight_g?: number; logged_at?: string; notes?: string | null },
): Promise<WeightEntry> {
    const update: Record<string, unknown> = {};
    if (fields.weight_g !== undefined) update.weight_g = fields.weight_g;
    if (fields.logged_at !== undefined) update.logged_at = fields.logged_at;
    if (fields.notes !== undefined)
        update.notes =
            fields.notes != null
                ? decodeEscapeSequences(fields.notes)
                : fields.notes;

    const db = getSql();
    try {
        const [row] =
            Object.keys(update).length === 0
                ? await db`
                      select * from weight_log
                      where id = ${id} and user_id = ${userId}`
                : await db`
                      update weight_log set ${db(update)}
                      where id = ${id} and user_id = ${userId}
                      returning *`;
        if (!row) throw new NotFoundError("weight entry not found");
        return mapWeight(row);
    } catch (err) {
        if (err instanceof NotFoundError) throw err;
        throw new Error(`Failed to update weight: ${errMsg(err)}`);
    }
}

/** Returns true if an entry was deleted, false if no matching row was found. */
export async function deleteWeight(
    userId: string,
    id: string,
): Promise<boolean> {
    const db = getSql();
    try {
        const rows = await db`
            delete from weight_log
            where id = ${id} and user_id = ${userId}
            returning id`;
        return rows.length > 0;
    } catch (err) {
        throw new Error(`Failed to delete weight: ${errMsg(err)}`);
    }
}

// ---------- Delete all user data ----------

export async function deleteAllUserData(userId: string): Promise<void> {
    const db = getSql();
    try {
        // All-or-nothing: a failure after the analytics delete must not leave
        // a half-deleted account.
        await db.begin(async (tx) => {
            // tool_analytics has no FK (see schema), so clear it explicitly.
            await tx`delete from tool_analytics where user_id = ${userId}`;
            // Every other per-user table (meals, water/weight logs, goals,
            // profile, tokens, auth codes, meal exports) hangs off users(id)
            // with ON DELETE CASCADE, so one delete removes the rest.
            await tx`delete from users where id = ${userId}`;
        });
    } catch (err) {
        throw new Error(`Failed to delete user: ${errMsg(err)}`);
    }
}

// ---------- OAuth tokens ----------

const TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function tokenExpiry(): string {
    return new Date(Date.now() + TOKEN_TTL_MS).toISOString();
}

export async function storeToken(token: string, userId: string): Promise<void> {
    const expiresAt = tokenExpiry();

    const db = getSql();
    try {
        await db`
            insert into oauth_tokens (token, user_id, expires_at)
            values (${token}, ${userId}, ${expiresAt})
            on conflict (token) do update set
                user_id = excluded.user_id,
                expires_at = excluded.expires_at`;
    } catch (err) {
        throw new Error(`Failed to store token: ${errMsg(err)}`);
    }
}

export async function getUserIdByToken(token: string): Promise<string | null> {
    const db = getSql();
    try {
        const [row] = await db`
            select user_id from oauth_tokens
            where token = ${token} and expires_at > now()`;
        return (row?.user_id as string | undefined) ?? null;
    } catch (err) {
        throw new Error(`Failed to look up token: ${errMsg(err)}`);
    }
}

export async function revokeToken(
    token: string,
    userId: string,
): Promise<void> {
    const db = getSql();
    try {
        await db`
            delete from oauth_tokens
            where token = ${token} and user_id = ${userId}`;
    } catch (err) {
        throw new Error(`Failed to revoke token: ${errMsg(err)}`);
    }
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
    const db = getSql();
    try {
        await db`delete from refresh_tokens where user_id = ${userId}`;
    } catch (err) {
        throw new Error(`Failed to revoke refresh tokens: ${errMsg(err)}`);
    }
}

// ---------- Auth codes ----------

export async function storeAuthCode(
    code: string,
    redirectUri: string,
    userId: string,
    codeChallenge?: string,
): Promise<void> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const db = getSql();
    try {
        await db`
            insert into auth_codes (
                code, redirect_uri, user_id, code_challenge, expires_at
            ) values (
                ${code}, ${redirectUri}, ${userId},
                ${codeChallenge ?? null}, ${expiresAt}
            )`;
    } catch (err) {
        throw new Error(`Failed to store auth code: ${errMsg(err)}`);
    }
}

export interface AuthCodeData {
    code: string;
    redirect_uri: string;
    user_id: string;
    code_challenge: string | null;
}

export async function consumeAuthCode(
    code: string,
): Promise<AuthCodeData | null> {
    const db = getSql();
    try {
        // Atomic single-use: delete-returning consumes the code so a second
        // exchange (or a concurrent one) gets nothing.
        const [row] = await db`
            delete from auth_codes
            where code = ${code} and expires_at > now()
            returning code, redirect_uri, user_id, code_challenge`;
        if (!row) return null;
        return {
            code: row.code as string,
            redirect_uri: row.redirect_uri as string,
            user_id: row.user_id as string,
            code_challenge: (row.code_challenge as string | null) ?? null,
        };
    } catch (err) {
        throw new Error(`Failed to consume auth code: ${errMsg(err)}`);
    }
}

/** Validate, consume, and issue both replacements in one transaction. */
export async function redeemAuthCode(
    code: string,
    redirectUri: string | undefined,
    verifierHash: string | undefined,
    accessToken: string,
    refreshToken: string,
): Promise<boolean> {
    const db = getSql();
    try {
        return await db.begin(async (tx) => {
            const [row] = await tx`
                select redirect_uri, user_id, code_challenge
                from auth_codes
                where code = ${code} and expires_at > now()
                for update`;
            if (
                !row ||
                redirectUri !== row.redirect_uri ||
                (row.code_challenge && verifierHash !== row.code_challenge)
            ) {
                return false;
            }
            await tx`delete from auth_codes where code = ${code}`;
            await tx`
                insert into oauth_tokens (token, user_id, expires_at)
                values (${accessToken}, ${row.user_id}, ${tokenExpiry()})`;
            await tx`
                insert into refresh_tokens (token, user_id, expires_at)
                values (${refreshToken}, ${row.user_id}, ${tokenExpiry()})`;
            return true;
        });
    } catch (err) {
        throw new Error(`Failed to redeem auth code: ${errMsg(err)}`);
    }
}

// ---------- Refresh tokens ----------

export async function storeRefreshToken(
    token: string,
    userId: string,
): Promise<void> {
    const expiresAt = tokenExpiry();

    const db = getSql();
    try {
        await db`
            insert into refresh_tokens (token, user_id, expires_at)
            values (${token}, ${userId}, ${expiresAt})`;
    } catch (err) {
        throw new Error(`Failed to store refresh token: ${errMsg(err)}`);
    }
}

export async function consumeRefreshToken(
    token: string,
): Promise<string | null> {
    const db = getSql();
    try {
        // Atomic single-use rotation, same shape as consumeAuthCode.
        const [row] = await db`
            delete from refresh_tokens
            where token = ${token} and expires_at > now()
            returning user_id`;
        return (row?.user_id as string | undefined) ?? null;
    } catch (err) {
        throw new Error(`Failed to consume refresh token: ${errMsg(err)}`);
    }
}

/** Single-use refresh rotation; the old token survives any insertion failure. */
export async function rotateRefreshToken(
    token: string,
    accessToken: string,
    refreshToken: string,
): Promise<boolean> {
    const db = getSql();
    try {
        return await db.begin(async (tx) => {
            const [row] = await tx`
                select user_id from refresh_tokens
                where token = ${token} and expires_at > now()
                for update`;
            if (!row) return false;
            await tx`delete from refresh_tokens where token = ${token}`;
            await tx`
                insert into oauth_tokens (token, user_id, expires_at)
                values (${accessToken}, ${row.user_id}, ${tokenExpiry()})`;
            await tx`
                insert into refresh_tokens (token, user_id, expires_at)
                values (${refreshToken}, ${row.user_id}, ${tokenExpiry()})`;
            return true;
        });
    } catch (err) {
        throw new Error(`Failed to rotate refresh token: ${errMsg(err)}`);
    }
}

// ---------- Meal exports ----------

export async function createMealExport(
    token: string,
    userId: string,
    csvText: string,
    ttlSeconds: number,
): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const db = getSql();
    try {
        // Each export replaces the user's previous one (same behavior as the
        // old fixed-path bucket upload), so stale links die immediately. One
        // transaction: an insert failure must not have deleted the previous
        // export, and concurrent readers never see the user export-less.
        await db.begin(async (tx) => {
            await tx`delete from meal_exports where user_id = ${userId}`;
            await tx`
                insert into meal_exports (token, user_id, csv_text, expires_at)
                values (${token}, ${userId}, ${csvText}, ${expiresAt})`;
        });
    } catch (err) {
        throw new Error(`Failed to store export: ${errMsg(err)}`);
    }
}

/** CSV for a live (unexpired) export token, or null when missing/expired. */
export async function getMealExportCsv(token: string): Promise<string | null> {
    const db = getSql();
    try {
        const [row] = await db`
            select csv_text from meal_exports
            where token = ${token} and expires_at > now()`;
        return (row?.csv_text as string | undefined) ?? null;
    } catch (err) {
        throw new Error(`Failed to get export: ${errMsg(err)}`);
    }
}

/** Deletes expired export rows; returns how many were removed. */
export async function sweepExpiredMealExports(): Promise<number> {
    const db = getSql();
    try {
        return await db.begin(async (tx) => {
            const exports = await tx`
                delete from meal_exports where expires_at < now() returning token`;
            const access = await tx`
                delete from oauth_tokens where expires_at < now() returning token`;
            const refresh = await tx`
                delete from refresh_tokens where expires_at < now() returning token`;
            const codes = await tx`
                delete from auth_codes where expires_at < now() returning code`;
            const analytics = await tx`
                delete from tool_analytics
                where invoked_at < now() - interval '90 days'
                returning id`;
            return (
                exports.length +
                access.length +
                refresh.length +
                codes.length +
                analytics.length
            );
        });
    } catch (err) {
        console.warn("Export sweep failed:", errMsg(err));
        return 0;
    }
}

// ---------- Tool analytics ----------

export interface ToolAnalyticsRecord {
    user_id: string;
    tool_name: string;
    success: boolean;
    duration_ms: number;
    error_category?: string;
    date_range_days?: number;
    mcp_session_id?: string;
    invoked_at: string;
}

export async function insertToolAnalytics(
    record: ToolAnalyticsRecord,
): Promise<void> {
    const db = getSql();
    await db`
        insert into tool_analytics (
            user_id, tool_name, success, duration_ms,
            error_category, date_range_days, mcp_session_id, invoked_at
        ) values (
            ${record.user_id},
            ${record.tool_name},
            ${record.success},
            ${record.duration_ms},
            ${record.error_category ?? null},
            ${record.date_range_days ?? null},
            ${record.mcp_session_id ?? null},
            ${record.invoked_at}
        )`;
}

// ---------- Food cache ----------

export async function getFoodCacheRow(
    source: string,
    sourceId: string,
): Promise<{ payload: unknown; fetched_at: string } | null> {
    const db = getSql();
    const [row] = await db`
        select payload, fetched_at from food_cache
        where source = ${source} and source_id = ${sourceId}`;
    if (!row) return null;
    return { payload: row.payload, fetched_at: iso(row.fetched_at) };
}

export async function putFoodCacheRow(
    source: string,
    sourceId: string,
    payload: unknown,
): Promise<void> {
    const db = getSql();
    await db`
        insert into food_cache (source, source_id, payload, fetched_at)
        values (${source}, ${sourceId}, ${JSON.stringify(payload)}::jsonb, now())
        on conflict (source, source_id) do update set
            payload = excluded.payload,
            fetched_at = excluded.fetched_at`;
}

// ---------- Public landing stats ----------

export interface LandingStats {
    food_logs: number;
    total_calories: number;
    total_protein_g: number;
    total_carbs_g: number;
    total_fat_g: number;
    timezones: number;
    // IANA names of every distinct timezone in use — drives the landing-page
    // world map. Aggregate-only; no per-user data.
    timezone_list: string[];
}

// Aggregate-only totals for the public landing page. One round trip; the
// database does the summing. Never returns per-user rows.
export async function getLandingStats(): Promise<LandingStats> {
    const db = getSql();
    try {
        const [row] = await db`
            with meal_stats as (
                select count(*)::int as food_logs,
                       coalesce(sum(calories), 0)::float8 as total_calories,
                       coalesce(sum(protein_g), 0)::float8 as total_protein_g,
                       coalesce(sum(carbs_g), 0)::float8 as total_carbs_g,
                       coalesce(sum(fat_g), 0)::float8 as total_fat_g
                from meals
            ), profile_stats as (
                select count(distinct timezone)::int as timezones,
                       coalesce(json_agg(distinct timezone), '[]'::json) as timezone_list
                from profiles
            )
            select
                meal_stats.*, profile_stats.*
            from meal_stats cross join profile_stats`;
        return {
            food_logs: numOrNull(row.food_logs) ?? 0,
            total_calories: numOrNull(row.total_calories) ?? 0,
            total_protein_g: numOrNull(row.total_protein_g) ?? 0,
            total_carbs_g: numOrNull(row.total_carbs_g) ?? 0,
            total_fat_g: numOrNull(row.total_fat_g) ?? 0,
            timezones: numOrNull(row.timezones) ?? 0,
            timezone_list: (row.timezone_list as string[]) ?? [],
        };
    } catch (err) {
        throw new Error(`Failed to get landing stats: ${errMsg(err)}`);
    }
}
