import { SQL } from "bun";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { zonedDayStartUtc, zonedNextDayStartUtc } from "./tz.js";
import { decodeEscapeSequences } from "./normalize.js";
import { isWeightUnit, type WeightUnit } from "./units.js";

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
    return err instanceof Error ? err.message : String(err);
}

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
        // The raw DB error lands on the login page — log it, show a generic one.
        console.error("Sign-up failed:", errMsg(err));
        throw new Error("Sign-up failed");
    }
}

export async function signInUser(
    email: string,
    password: string,
): Promise<string> {
    const db = getSql();
    const [row] = await db`
        select id, password_hash from users
        where lower(email) = ${email.toLowerCase()}`;

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

    const [bySub] = await db`
        select id from users where google_sub = ${sub}`;
    if (bySub) return bySub.id as string;

    // First Google sign-in for an existing password account: link by email
    // (validateGoogleClaims already required email_verified).
    const [byEmail] = await db`
        select id, google_sub from users where lower(email) = ${email}`;
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
                throw new Error("Google sign-in failed");
        }
        // Lost a race (row gained a sub, or 23505) — resolve by sub.
        const [row] = await db`
            select id from users where google_sub = ${sub}`;
        if (row) return row.id as string;
        throw new Error("Google sign-in failed");
    }

    try {
        const [created] = await db`
            insert into users (email, google_sub, email_verified)
            values (${email}, ${sub}, true)
            returning id`;
        return created.id as string;
    } catch (err) {
        // Concurrent first sign-in — the other request created the user.
        if (isUniqueViolation(err)) {
            const [row] = await db`
                select id from users where google_sub = ${sub}`;
            if (row) return row.id as string;
        }
        throw new Error("Google sign-in failed");
    }
}

// ---------- Idempotency ----------

// Derive a stable idempotency key from the request content so the column is
// always populated and retries dedupe even when the client omits a key. The
// resolved logged_at is part of the digest, so two genuinely separate but
// otherwise-identical entries (logged at different times) get distinct keys and
// are never wrongly merged. A retry replays the same args — including the same
// logged_at — and therefore lands on the same key. The "auto:" prefix marks
// server-derived keys, distinguishing them from client-supplied ones.
function deriveIdempotencyKey(
    parts: (string | number | null | undefined)[],
): string {
    const digest = new Bun.CryptoHasher("sha256")
        .update(parts.map((p) => p ?? "").join("\u0000"))
        .digest("hex");
    return `auto:${digest}`;
}

// ---------- Meals ----------

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
    logged_at?: string;
    notes?: string;
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
        notes: (row.notes as string | null) ?? null,
        idempotency_key: (row.idempotency_key as string | null) ?? null,
    };
}

export async function insertMeal(
    userId: string,
    input: MealInput,
): Promise<MealInsertResult> {
    const db = getSql();

    // Resolve logged_at once so the digest and the persisted row agree.
    const loggedAt = input.logged_at ?? new Date().toISOString();
    // Always populate the key: use the client's if given, otherwise derive a
    // stable one from the request content (see deriveIdempotencyKey).
    const idempotencyKey =
        input.idempotency_key ??
        deriveIdempotencyKey([
            userId,
            input.description,
            input.meal_type,
            input.calories,
            input.protein_g,
            input.carbs_g,
            input.fat_g,
            input.notes,
            loggedAt,
        ]);

    const [existing] = await db`
        select * from meals
        where user_id = ${userId} and idempotency_key = ${idempotencyKey}`;
    if (existing) return { meal: mapMeal(existing), deduplicated: true };

    try {
        const [row] = await db`
            insert into meals (
                user_id, description, meal_type, calories,
                protein_g, carbs_g, fat_g, logged_at, notes, idempotency_key
            ) values (
                ${userId},
                ${decodeEscapeSequences(input.description)},
                ${input.meal_type},
                ${input.calories ?? null},
                ${input.protein_g ?? null},
                ${input.carbs_g ?? null},
                ${input.fat_g ?? null},
                ${loggedAt},
                ${input.notes != null ? decodeEscapeSequences(input.notes) : null},
                ${idempotencyKey}
            )
            returning *`;
        return { meal: mapMeal(row), deduplicated: false };
    } catch (err) {
        // Concurrent retry with the same idempotency key — the other request
        // already inserted the row. Fetch and return it instead of failing.
        if (isUniqueViolation(err)) {
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
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    const db = getSql();
    try {
        const rows = await db`
            select * from meals
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

export async function deleteMeal(userId: string, id: string): Promise<void> {
    const db = getSql();
    try {
        await db`
            delete from meals where id = ${id} and user_id = ${userId}`;
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
        if (!row) throw new Error("meal not found");
        return mapMeal(row);
    } catch (err) {
        throw new Error(`Failed to update meal: ${errMsg(err)}`);
    }
}

// ---------- Profiles ----------

export interface Profile {
    user_id: string;
    timezone: string;
    preferred_weight_unit: WeightUnit | null;
    created_at: string;
    updated_at: string;
}

function mapProfile(row: Record<string, unknown>): Profile {
    return {
        user_id: row.user_id as string,
        timezone: row.timezone as string,
        preferred_weight_unit:
            (row.preferred_weight_unit as WeightUnit | null) ?? null,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
    };
}

export async function getProfile(userId: string): Promise<Profile | null> {
    const db = getSql();
    try {
        const [row] = await db`
            select * from profiles where user_id = ${userId}`;
        return row ? mapProfile(row) : null;
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
    patch: { timezone?: string; preferred_weight_unit?: WeightUnit | null },
): Promise<Profile> {
    const tz = patch.timezone ?? null;
    // null is meaningful for the unit (clears the preference), so a separate
    // flag distinguishes "not provided" from "set to null".
    const unitProvided = patch.preferred_weight_unit !== undefined;
    const unit = patch.preferred_weight_unit ?? null;

    const db = getSql();
    try {
        const [row] = await db`
            insert into profiles (user_id, timezone, preferred_weight_unit)
            values (${userId}, coalesce(${tz}::text, 'UTC'), ${unit}::text)
            on conflict (user_id) do update set
                timezone = coalesce(${tz}::text, profiles.timezone),
                preferred_weight_unit = case
                    when ${unitProvided}::boolean then ${unit}::text
                    else profiles.preferred_weight_unit
                end,
                updated_at = now()
            returning *`;
        return mapProfile(row);
    } catch (err) {
        throw new Error(`Failed to save profile: ${errMsg(err)}`);
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

    // Resolve logged_at once so the digest and the persisted row agree.
    const loggedAt = input.logged_at ?? new Date().toISOString();
    // Always populate the key: use the client's if given, otherwise derive a
    // stable one from the request content (see deriveIdempotencyKey).
    const idempotencyKey =
        input.idempotency_key ??
        deriveIdempotencyKey([userId, input.amount_ml, input.notes, loggedAt]);

    const [existing] = await db`
        select * from water_log
        where user_id = ${userId} and idempotency_key = ${idempotencyKey}`;
    if (existing) return { entry: mapWater(existing), deduplicated: true };

    try {
        const [row] = await db`
            insert into water_log (
                user_id, amount_ml, logged_at, notes, idempotency_key
            ) values (
                ${userId},
                ${input.amount_ml},
                ${loggedAt},
                ${input.notes ?? null},
                ${idempotencyKey}
            )
            returning *`;
        return { entry: mapWater(row), deduplicated: false };
    } catch (err) {
        if (isUniqueViolation(err)) {
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
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    const db = getSql();
    try {
        const rows = await db`
            select * from water_log
            where user_id = ${userId}
              and logged_at >= ${startUtc.toISOString()}
              and logged_at < ${endUtc.toISOString()}
            order by logged_at asc`;
        return rows.map(mapWater);
    } catch (err) {
        throw new Error(`Failed to get water: ${errMsg(err)}`);
    }
}

export async function deleteWater(userId: string, id: string): Promise<void> {
    const db = getSql();
    try {
        await db`
            delete from water_log where id = ${id} and user_id = ${userId}`;
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

    // Resolve logged_at once so the digest and the persisted row agree.
    const loggedAt = input.logged_at ?? new Date().toISOString();
    // Always populate the key: use the client's if given, otherwise derive a
    // stable one from the request content (see deriveIdempotencyKey).
    const idempotencyKey =
        input.idempotency_key ??
        deriveIdempotencyKey([userId, input.weight_g, input.notes, loggedAt]);

    const [existing] = await db`
        select * from weight_log
        where user_id = ${userId} and idempotency_key = ${idempotencyKey}`;
    if (existing) return { entry: mapWeight(existing), deduplicated: true };

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
        if (isUniqueViolation(err)) {
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
    const startUtc = zonedDayStartUtc(startDate, tz);
    const endUtc = zonedNextDayStartUtc(endDate, tz);

    const db = getSql();
    try {
        const rows = await db`
            select * from weight_log
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
        if (!row) throw new Error("weight entry not found");
        return mapWeight(row);
    } catch (err) {
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

export async function storeToken(token: string, userId: string): Promise<void> {
    const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

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
    } catch {
        return null;
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
    } catch {
        return null;
    }
}

// ---------- Refresh tokens ----------

export async function storeRefreshToken(
    token: string,
    userId: string,
): Promise<void> {
    const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

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
    } catch {
        return null;
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
    } catch {
        // Lookup semantics like getUserIdByToken: a DB hiccup reads as "no
        // such export" (404), not a 500.
        return null;
    }
}

/** Deletes expired export rows; returns how many were removed. */
export async function sweepExpiredMealExports(): Promise<number> {
    const db = getSql();
    try {
        const rows = await db`
            delete from meal_exports where expires_at < now() returning token`;
        return rows.length;
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
            select
                (select count(*)::int from meals) as food_logs,
                (select coalesce(sum(calories), 0)::float8 from meals) as total_calories,
                (select coalesce(sum(protein_g), 0)::float8 from meals) as total_protein_g,
                (select coalesce(sum(carbs_g), 0)::float8 from meals) as total_carbs_g,
                (select coalesce(sum(fat_g), 0)::float8 from meals) as total_fat_g,
                (select count(distinct timezone)::int from profiles) as timezones,
                (select coalesce(json_agg(distinct timezone), '[]'::json) from profiles) as timezone_list`;
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

// ---------- Registered clients ----------

export function registerClient(
    clientName: string | null,
    redirectUris: string[],
): void {
    const db = getSql();
    db`
        insert into registered_clients (client_name, redirect_uris)
        values (${clientName}, ${JSON.stringify(redirectUris)}::jsonb)`.then(
        () => {},
        (err: unknown) => {
            console.warn("Failed to persist client registration:", errMsg(err));
        },
    );
}
