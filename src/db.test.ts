import { test, expect, describe, afterEach } from "bun:test";
import {
    setSqlForTests,
    sha256hex,
    validateGoogleClaims,
    resolveGoogleUser,
    signInUser,
    signUpUser,
    insertMeal,
    listDishes,
    insertDish,
    updateDish,
    deleteDish,
    consumeAuthCode,
    consumeRefreshToken,
    getUserIdByToken,
    createMealExport,
    getMealExportCsv,
    sweepExpiredMealExports,
    deleteAllUserData,
    DUMMY_PASSWORD_HASH,
} from "./db.js";

// Scripted fake for the Bun.sql tagged-template singleton. Each db`...` call
// consumes the next step (rows to resolve or an error to reject); non-template
// calls (the db(object) dynamic-update helper) return an inert marker, and
// db.begin(cb) records a "begin" call and runs cb against the same fake.
// Query text and bound values are recorded so tests can assert on SQL shape.
interface Step {
    rows?: unknown[];
    error?: unknown;
}

interface Call {
    text: string;
    values: unknown[];
}

function installFakeSql(script: Step[]): Call[] {
    const calls: Call[] = [];
    const fake = (
        first: TemplateStringsArray | Record<string, unknown>,
        ...values: unknown[]
    ) => {
        if (!Array.isArray(first) || !("raw" in first)) {
            return { __helper: first };
        }
        const text = (first as readonly string[]).join("?").trim();
        calls.push({ text, values });
        const step = script.shift();
        if (!step) {
            return Promise.reject(new Error(`unexpected query: ${text}`));
        }
        if (step.error) return Promise.reject(step.error);
        return Promise.resolve(step.rows ?? []);
    };
    fake.begin = async (cb: (tx: unknown) => Promise<unknown>) => {
        calls.push({ text: "begin", values: [] });
        return cb(fake);
    };
    setSqlForTests(fake);
    return calls;
}

afterEach(() => {
    // Any query after a test's script runs dry should fail loudly.
    setSqlForTests(() => {
        throw new Error("no fake sql installed");
    });
});

// ---------- Google id_token claims (nonce, email_verified) ----------

describe("validateGoogleClaims", () => {
    const rawNonce = "raw-nonce-value";
    const valid = {
        sub: "google-sub-1",
        email: "User@Example.com",
        email_verified: true,
        nonce: sha256hex(rawNonce),
    };

    test("accepts a matching hashed nonce and lowercases the email", () => {
        const claims = validateGoogleClaims(valid, rawNonce);
        expect(claims).toEqual({
            sub: "google-sub-1",
            email: "user@example.com",
        });
    });

    test("rejects a token minted for someone else's nonce", () => {
        expect(() =>
            validateGoogleClaims(valid, "different-raw-nonce"),
        ).toThrow("Google sign-in failed");
    });

    test("rejects a raw (unhashed) nonce claim", () => {
        // The hex digest is what was sent to Google, so a token echoing the
        // raw value back must not match.
        expect(() =>
            validateGoogleClaims({ ...valid, nonce: rawNonce }, rawNonce),
        ).toThrow("Google sign-in failed");
    });

    test("rejects a missing nonce claim", () => {
        const { nonce: _nonce, ...withoutNonce } = valid;
        expect(() => validateGoogleClaims(withoutNonce, rawNonce)).toThrow(
            "Google sign-in failed",
        );
    });

    test("rejects an unverified email", () => {
        expect(() =>
            validateGoogleClaims({ ...valid, email_verified: false }, rawNonce),
        ).toThrow("Google sign-in failed");
        // Anything but the boolean true is unverified.
        expect(() =>
            validateGoogleClaims(
                { ...valid, email_verified: "true" },
                rawNonce,
            ),
        ).toThrow("Google sign-in failed");
    });
});

test("sha256hex matches the digest oauth.ts sends to Google", () => {
    expect(sha256hex("abc")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
});

// ---------- Password sign-in (bcrypt hashes imported from Supabase) ----------

describe("signInUser", () => {
    test("accepts a bcrypt hash from the Supabase dump", async () => {
        const bcryptHash = await Bun.password.hash("correct horse", {
            algorithm: "bcrypt",
        });
        // Supabase (pgcrypto) emits the $2a$ variant; Bun emits $2b$. The two
        // are byte-identical for normal passwords, so relabeling exercises the
        // exact prefix an imported hash carries.
        const supabaseStyle = bcryptHash.replace(/^\$2b\$/, "$2a$");
        expect(supabaseStyle.startsWith("$2a$")).toBe(true);

        installFakeSql([
            { rows: [{ id: "user-1", password_hash: supabaseStyle }] },
        ]);
        expect(await signInUser("a@b.com", "correct horse")).toBe("user-1");
    });

    test("accepts an argon2id hash for post-migration passwords", async () => {
        const hash = await Bun.password.hash("hunter22", {
            algorithm: "argon2id",
        });
        installFakeSql([{ rows: [{ id: "user-2", password_hash: hash }] }]);
        expect(await signInUser("a@b.com", "hunter22")).toBe("user-2");
    });

    test("rejects a wrong password with the generic message", async () => {
        const hash = await Bun.password.hash("right", { algorithm: "bcrypt" });
        installFakeSql([{ rows: [{ id: "user-1", password_hash: hash }] }]);
        expect(signInUser("a@b.com", "wrong")).rejects.toThrow(
            "Invalid login credentials",
        );
    });

    test("rejects unknown users and Google-only accounts alike", async () => {
        installFakeSql([{ rows: [] }]);
        expect(signInUser("ghost@b.com", "pw123456")).rejects.toThrow(
            "Invalid login credentials",
        );

        installFakeSql([{ rows: [{ id: "user-3", password_hash: null }] }]);
        expect(signInUser("google-only@b.com", "pw123456")).rejects.toThrow(
            "Invalid login credentials",
        );
    });

    test("looks the user up by lowercased email", async () => {
        const hash = await Bun.password.hash("pw123456", {
            algorithm: "bcrypt",
        });
        const calls = installFakeSql([
            { rows: [{ id: "user-1", password_hash: hash }] },
        ]);
        await signInUser("User@Example.COM", "pw123456");
        expect(calls[0]!.values).toContain("user@example.com");
    });
});

test("dummy timing-equalizer hash is a well-formed argon2id hash", async () => {
    expect(DUMMY_PASSWORD_HASH.startsWith("$argon2id$")).toBe(true);
    // Must verify cleanly (to false) — a malformed constant would throw and
    // skip the constant-time work it exists for.
    expect(await Bun.password.verify("anything", DUMMY_PASSWORD_HASH)).toBe(
        false,
    );
});

describe("signUpUser", () => {
    test("maps a unique violation to the registered-user message", async () => {
        installFakeSql([{ error: { code: "23505" } }]);
        expect(signUpUser("a@b.com", "pw123456")).rejects.toThrow(
            "User already registered",
        );
    });

    test("rejects malformed emails before touching the database", async () => {
        const calls = installFakeSql([]);
        for (const bad of ["", "no-at.example.com", "a@b", "a b@c.com"]) {
            expect(signUpUser(bad, "pw123456")).rejects.toThrow(
                "Invalid email address",
            );
        }
        expect(calls.length).toBe(0);
    });

    test("hides raw database errors behind a generic message", async () => {
        installFakeSql([
            { error: new Error("connection refused to 10.0.0.5") },
        ]);
        try {
            await signUpUser("a@b.com", "pw123456");
            throw new Error("should have thrown");
        } catch (err) {
            expect((err as Error).message).toBe("Sign-up failed");
        }
    });

    test("rejects short passwords before touching the database", async () => {
        const calls = installFakeSql([]);
        expect(signUpUser("a@b.com", "123")).rejects.toThrow(
            "at least 6 characters",
        );
        expect(calls.length).toBe(0);
    });

    test("stores an argon2id hash for new users", async () => {
        const calls = installFakeSql([{ rows: [{ id: "user-9" }] }]);
        expect(await signUpUser("A@B.com", "pw123456")).toBe("user-9");
        const [email, hash] = calls[0]!.values as [string, string];
        expect(email).toBe("a@b.com");
        expect(hash.startsWith("$argon2id$")).toBe(true);
        expect(await Bun.password.verify("pw123456", hash)).toBe(true);
    });
});

// ---------- Google user resolution (linking) ----------

describe("resolveGoogleUser", () => {
    test("returns the existing user matched by google_sub", async () => {
        const calls = installFakeSql([{ rows: [{ id: "user-1" }] }]);
        expect(await resolveGoogleUser("sub-1", "a@b.com")).toBe("user-1");
        expect(calls.length).toBe(1);
    });

    test("links a password account by verified email when it has no sub", async () => {
        const calls = installFakeSql([
            { rows: [] }, // by sub: none
            { rows: [{ id: "user-2", google_sub: null }] }, // by email
            { rows: [{ id: "user-2" }] }, // guarded update returns the row
        ]);
        expect(await resolveGoogleUser("sub-2", "a@b.com")).toBe("user-2");
        // The link must be guarded so a concurrently-linked row isn't rebound.
        expect(calls[2]!.text.toLowerCase()).toContain("google_sub is null");
        // Linking must invalidate a possibly pre-planted password: signup
        // never proved email ownership, Google just did.
        expect(calls[2]!.text.toLowerCase()).toContain("password_hash = null");
    });

    test("refuses when the email account already belongs to another Google identity", async () => {
        installFakeSql([
            { rows: [] },
            { rows: [{ id: "user-3", google_sub: "someone-else" }] },
        ]);
        expect(resolveGoogleUser("sub-3", "a@b.com")).rejects.toThrow(
            "Google sign-in failed",
        );
    });

    test("resolves a lost linking race by re-reading the sub owner", async () => {
        installFakeSql([
            { rows: [] },
            { rows: [{ id: "user-4", google_sub: null }] },
            { rows: [] }, // guarded update matched nothing (row changed underneath)
            { rows: [{ id: "winner" }] }, // whoever owns the sub now
        ]);
        expect(await resolveGoogleUser("sub-4", "a@b.com")).toBe("winner");
    });

    test("resolves a concurrent first sign-in (23505 on insert) to the winner", async () => {
        installFakeSql([
            { rows: [] },
            { rows: [] },
            { error: { code: "23505" } },
            { rows: [{ id: "user-5" }] },
        ]);
        expect(await resolveGoogleUser("sub-5", "new@b.com")).toBe("user-5");
    });
});

// ---------- Meal idempotency ----------

function mealRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "meal-1",
        user_id: "user-1",
        logged_at: new Date("2026-07-07T10:00:00.000Z"),
        meal_type: "lunch",
        description: "Soup",
        calories: 300,
        protein_g: "12.5", // numeric comes back as string from the driver
        carbs_g: null,
        fat_g: null,
        notes: null,
        idempotency_key: "auto:abc",
        ...overrides,
    };
}

describe("insertMeal idempotency", () => {
    test("returns the existing row when the key was already used", async () => {
        const calls = installFakeSql([{ rows: [mealRow()] }]);
        const result = await insertMeal("user-1", {
            description: "Soup",
            meal_type: "lunch",
        });
        expect(result.deduplicated).toBe(true);
        expect(result.meal.id).toBe("meal-1");
        // Only the lookup ran — no insert was attempted.
        expect(calls.length).toBe(1);
        expect(calls[0]!.text).toContain("idempotency_key");
    });

    test("resolves a concurrent-retry 23505 to the winner's row", async () => {
        const calls = installFakeSql([
            { rows: [] }, // pre-insert lookup: nothing yet
            { error: { code: "23505" } }, // insert loses the race
            { rows: [mealRow()] }, // re-fetch the winner
        ]);
        const result = await insertMeal("user-1", {
            description: "Soup",
            meal_type: "lunch",
        });
        expect(result.deduplicated).toBe(true);
        expect(result.meal.id).toBe("meal-1");
        expect(calls.length).toBe(3);
    });

    test("normalizes driver types on the way out", async () => {
        installFakeSql([
            { rows: [] },
            { rows: [mealRow({ idempotency_key: null })] },
        ]);
        const { meal, deduplicated } = await insertMeal("user-1", {
            description: "Soup",
            meal_type: "lunch",
        });
        expect(deduplicated).toBe(false);
        expect(meal.logged_at).toBe("2026-07-07T10:00:00.000Z");
        expect(meal.protein_g).toBe(12.5);
        expect(meal.carbs_g).toBeNull();
    });

    test("other insert errors are not swallowed", async () => {
        installFakeSql([
            { rows: [] },
            { error: new Error("connection refused") },
        ]);
        expect(
            insertMeal("user-1", { description: "Soup", meal_type: "lunch" }),
        ).rejects.toThrow("Failed to insert meal");
    });
});

// ---------- Dishes catalog ----------

function dishRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "dish-1",
        user_id: "user-1",
        name: "Protein shake",
        meal_type: "snack",
        calories: 200,
        protein_g: "30.0", // numeric comes back as string from the driver
        carbs_g: "5.0",
        fat_g: "3.0",
        created_at: new Date("2026-07-07T10:00:00.000Z"),
        ...overrides,
    };
}

describe("dishes CRUD", () => {
    test("listDishes returns the catalog ordered case-insensitively by name", async () => {
        const calls = installFakeSql([{ rows: [dishRow()] }]);
        const dishes = await listDishes("user-1");
        expect(dishes).toHaveLength(1);
        expect(dishes[0]!.name).toBe("Protein shake");
        expect(dishes[0]!.protein_g).toBe(30); // string → number on the way out
        const text = calls[0]!.text.toLowerCase();
        expect(text).toContain("from dishes");
        expect(text).toContain("order by lower(name)");
        expect(calls[0]!.values).toContain("user-1");
    });

    test("insertDish upserts on the case-insensitive name", async () => {
        const calls = installFakeSql([{ rows: [dishRow()] }]);
        const dish = await insertDish("user-1", {
            name: "Protein shake",
            meal_type: "snack",
            calories: 200,
            protein_g: 30,
        });
        expect(dish.id).toBe("dish-1");
        const text = calls[0]!.text.toLowerCase();
        expect(text).toContain("insert into dishes");
        expect(text).toContain("on conflict (user_id, lower(name))");
        expect(text).toContain("do update set");
    });

    test("insertDish trims the name and defaults omitted macros to null", async () => {
        const calls = installFakeSql([{ rows: [dishRow()] }]);
        await insertDish("user-1", { name: "  Bun  " });
        expect(calls[0]!.values).toContain("Bun");
        // meal_type + all four macros bound as null
        expect(calls[0]!.values.filter((v) => v === null)).toHaveLength(5);
    });

    test("updateDish patches only the provided fields", async () => {
        const calls = installFakeSql([{ rows: [dishRow({ calories: 250 })] }]);
        const dish = await updateDish("user-1", "dish-1", { calories: 250 });
        expect(dish.calories).toBe(250);
        const text = calls[0]!.text.toLowerCase();
        expect(text).toContain("update dishes set");
        expect(text).toContain("where id =");
    });

    test("updateDish with no fields reads the row back instead of writing", async () => {
        const calls = installFakeSql([{ rows: [dishRow()] }]);
        const dish = await updateDish("user-1", "dish-1", {});
        expect(dish.id).toBe("dish-1");
        expect(calls[0]!.text.toLowerCase()).toContain("select * from dishes");
    });

    test("updateDish throws when the row is missing or not the caller's", async () => {
        installFakeSql([{ rows: [] }]);
        expect(
            updateDish("user-1", "ghost", { calories: 100 }),
        ).rejects.toThrow("Failed to update dish");
    });

    test("deleteDish reports whether a row was removed", async () => {
        installFakeSql([{ rows: [{ id: "dish-1" }] }]);
        expect(await deleteDish("user-1", "dish-1")).toBe(true);

        installFakeSql([{ rows: [] }]);
        expect(await deleteDish("user-1", "ghost")).toBe(false);
    });
});

// ---------- Single-use tokens & expiry ----------

describe("consumeAuthCode", () => {
    test("consumes atomically via delete … returning with an expiry guard", async () => {
        const calls = installFakeSql([
            {
                rows: [
                    {
                        code: "c1",
                        redirect_uri: "https://cb",
                        user_id: "user-1",
                        code_challenge: null,
                    },
                ],
            },
        ]);
        const data = await consumeAuthCode("c1");
        expect(data).toEqual({
            code: "c1",
            redirect_uri: "https://cb",
            user_id: "user-1",
            code_challenge: null,
        });
        const text = calls[0]!.text.toLowerCase();
        expect(text).toContain("delete from auth_codes");
        expect(text).toContain("expires_at >");
        expect(text).toContain("returning");
    });

    test("returns null for a missing or expired code", async () => {
        installFakeSql([{ rows: [] }]);
        expect(await consumeAuthCode("expired")).toBeNull();
    });
});

describe("consumeRefreshToken", () => {
    test("returns the user for a live token, once", async () => {
        const calls = installFakeSql([{ rows: [{ user_id: "user-1" }] }]);
        expect(await consumeRefreshToken("rt")).toBe("user-1");
        const text = calls[0]!.text.toLowerCase();
        expect(text).toContain("delete from refresh_tokens");
        expect(text).toContain("returning");
    });

    test("returns null for a missing or expired token", async () => {
        installFakeSql([{ rows: [] }]);
        expect(await consumeRefreshToken("gone")).toBeNull();
    });
});

test("getUserIdByToken treats expired tokens as absent", async () => {
    const calls = installFakeSql([{ rows: [] }]);
    expect(await getUserIdByToken("stale")).toBeNull();
    expect(calls[0]!.text.toLowerCase()).toContain("expires_at > now()");
});

// ---------- Meal exports ----------

describe("meal exports", () => {
    test("createMealExport replaces the previous export inside a transaction", async () => {
        const calls = installFakeSql([
            { rows: [] }, // delete previous
            { rows: [] }, // insert new
        ]);
        await createMealExport("tok", "user-1", "id,notes", 3600);
        expect(calls[0]!.text).toBe("begin");
        expect(calls[1]!.text.toLowerCase()).toContain(
            "delete from meal_exports",
        );
        expect(calls[2]!.text.toLowerCase()).toContain(
            "insert into meal_exports",
        );
    });

    test("createMealExport surfaces a failed insert as a storage error", async () => {
        installFakeSql([{ rows: [] }, { error: new Error("disk full") }]);
        expect(
            createMealExport("tok", "user-1", "id,notes", 3600),
        ).rejects.toThrow("Failed to store export");
    });

    test("getMealExportCsv treats a database error as a missing export", async () => {
        installFakeSql([{ error: new Error("connection refused") }]);
        expect(await getMealExportCsv("tok")).toBeNull();
    });

    test("sweep swallows database errors and reports zero removed", async () => {
        installFakeSql([{ error: new Error("connection refused") }]);
        expect(await sweepExpiredMealExports()).toBe(0);
    });

    test("getMealExportCsv returns the CSV for a live token", async () => {
        const calls = installFakeSql([{ rows: [{ csv_text: "id,notes" }] }]);
        expect(await getMealExportCsv("tok")).toBe("id,notes");
        expect(calls[0]!.text.toLowerCase()).toContain("expires_at > now()");
    });

    test("getMealExportCsv returns null once the token expired", async () => {
        installFakeSql([{ rows: [] }]);
        expect(await getMealExportCsv("tok")).toBeNull();
    });

    test("sweep deletes by expiry in a single statement", async () => {
        const calls = installFakeSql([
            { rows: [{ token: "a" }, { token: "b" }] },
        ]);
        expect(await sweepExpiredMealExports()).toBe(2);
        expect(calls.length).toBe(1);
        expect(calls[0]!.text.toLowerCase()).toContain(
            "delete from meal_exports",
        );
    });
});

// ---------- Account deletion ----------

test("deleteAllUserData runs both deletes in one transaction", async () => {
    const calls = installFakeSql([
        { rows: [] }, // tool_analytics
        { rows: [] }, // users (cascades the rest)
    ]);
    await deleteAllUserData("user-1");
    expect(calls[0]!.text).toBe("begin");
    expect(calls[1]!.text.toLowerCase()).toContain(
        "delete from tool_analytics",
    );
    expect(calls[2]!.text.toLowerCase()).toContain("delete from users");
});
