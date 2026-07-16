import { test, expect, afterEach } from "bun:test";
import { runChatTurn, executeTool } from "./chat.js";
import { setSqlForTests } from "./db.js";

// Same scripted fake as db.test.ts: each db`...` call consumes the next step.
function installFakeSql(script: { rows?: unknown[] }[]): {
    text: string;
    values: unknown[];
}[] {
    const calls: { text: string; values: unknown[] }[] = [];
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
        if (!step) return Promise.reject(new Error(`unexpected: ${text}`));
        return Promise.resolve(step.rows ?? []);
    };
    setSqlForTests(fake);
    return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
    setSqlForTests(() => {
        throw new Error("no fake sql installed");
    });
});

function fakeLlm(responses: unknown[]): unknown[] {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string));
        const message = responses.shift();
        return new Response(JSON.stringify({ choices: [{ message }] }), {
            status: 200,
        });
    }) as typeof fetch;
    return bodies;
}

const waterRow = {
    id: "w1",
    user_id: "u1",
    amount_ml: 300,
    logged_at: "2026-07-07T10:00:00Z",
    notes: null,
    created_at: "2026-07-07T10:00:00Z",
    idempotency_key: "auto:x",
};

const dishRow = {
    id: "d1",
    user_id: "u1",
    name: "Protein shake",
    meal_type: "snack",
    calories: 200,
    protein_g: "30.0",
    carbs_g: "5.0",
    fat_g: "3.0",
    created_at: "2026-07-07T10:00:00Z",
};

test("runChatTurn executes a tool call and returns the final text", async () => {
    const sqlCalls = installFakeSql([
        { rows: [] }, // getUserTimezone → profile miss → UTC
        { rows: [waterRow] }, // insertWater: insert returning
    ]);
    const llmBodies = fakeLlm([
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "c1",
                    function: {
                        name: "log_water",
                        arguments: '{"amount_ml":300}',
                    },
                },
            ],
        },
        { role: "assistant", content: "Записал 300 мл воды." },
    ]);

    const toolEvents: string[] = [];
    const reply = await runChatTurn(
        "u1",
        [{ role: "user", content: "выпил стакан воды 300мл" }],
        "test-key",
        (name) => toolEvents.push(name),
    );

    expect(reply.message).toBe("Записал 300 мл воды.");
    expect(reply.proposals).toEqual([]);
    expect(toolEvents).toEqual(["log_water"]);
    // insert got the parsed amount
    expect(sqlCalls[1]!.values).toContain(300);
    // second LLM call carries the tool result back
    const second = llmBodies[1] as { messages: { role: string }[] };
    expect(second.messages.at(-1)!.role).toBe("tool");
});

test("executeTool converts weight kg to grams and reports bad input", async () => {
    const calls = installFakeSql([
        {
            rows: [
                {
                    id: "kg1",
                    user_id: "u1",
                    weight_g: 78200,
                    logged_at: "2026-07-07T10:00:00Z",
                    notes: null,
                    created_at: "2026-07-07T10:00:00Z",
                    idempotency_key: "auto:x",
                },
            ],
        },
    ]);
    const ok = JSON.parse(
        await executeTool("u1", "log_weight", {
            weight_kg: 78.2,
        }),
    );
    expect(ok.logged).toBe(true);
    expect(calls[0]!.values).toContain(78200);

    const bad = JSON.parse(
        await executeTool("u1", "log_weight", {
            weight_kg: -5,
        }),
    );
    expect(bad.error).toContain("invalid number");

    const unknown = JSON.parse(await executeTool("u1", "nope", {}));
    expect(unknown.error).toContain("unknown tool");
});

test("executeTool threads a turn idempotency key into the write", async () => {
    const calls = installFakeSql([
        { rows: [waterRow] }, // insertWater: insert returning
    ]);
    const res = JSON.parse(
        await executeTool("u1", "log_water", { amount_ml: 300 }, "turn-key-1"),
    );
    expect(res.logged).toBe(true);
    // The client key is written on the insert; a re-sent turn dedups on the
    // unique idempotency_key instead of double-writing.
    expect(calls[0]!.values).toContain("turn-key-1");
});

test("executeTool set_goals merges with current goals", async () => {
    const goalsRow = {
        user_id: "u1",
        daily_calories: 2000,
        daily_protein_g: 150,
        daily_carbs_g: null,
        daily_fat_g: null,
        daily_water_ml: 2000,
        target_weight_g: 74000,
        updated_at: "2026-07-07T10:00:00Z",
    };
    const calls = installFakeSql([
        { rows: [goalsRow] }, // getNutritionGoals
        { rows: [{ ...goalsRow, daily_calories: 1800 }] }, // upsert returning
    ]);
    const res = JSON.parse(
        await executeTool("u1", "set_goals", { daily_calories: 1800 }),
    );
    expect(res.saved).toBe(true);
    // changed field is written, untouched ones survive the merge
    expect(calls[1]!.values).toContain(1800);
    expect(calls[1]!.values).toContain(150);
    expect(calls[1]!.values).toContain(74000);
});

test("runChatTurn stops before running tools when the client aborted", async () => {
    installFakeSql([
        { rows: [] }, // getUserTimezone
    ]);
    fakeLlm([
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "c1",
                    function: {
                        name: "log_water",
                        arguments: '{"amount_ml":300}',
                    },
                },
            ],
        },
    ]);
    const ctrl = new AbortController();
    ctrl.abort();
    // Aborted before the tool round → no insertWater SQL steps are consumed,
    // otherwise the fake script would reject with "unexpected".
    await expect(
        runChatTurn(
            "u1",
            [{ role: "user", content: "log water" }],
            "test-key",
            undefined,
            ctrl.signal,
        ),
    ).rejects.toThrow("aborted");
});

test("executeTool rejects implausible weight", async () => {
    installFakeSql([]);
    const bad = JSON.parse(
        await executeTool("u1", "log_weight", { weight_kg: 8000 }),
    );
    expect(bad.error).toContain("plausible");
});

test("runChatTurn falls back to a canned reply when the LLM dies after a logged tool", async () => {
    installFakeSql([
        { rows: [] }, // getUserTimezone
        { rows: [waterRow] }, // insertWater: insert returning
    ]);
    // Only one scripted response: the second LLM call gets no message and throws.
    fakeLlm([
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "c1",
                    function: {
                        name: "log_water",
                        arguments: '{"amount_ml":300}',
                    },
                },
            ],
        },
    ]);

    const reply = await runChatTurn(
        "u1",
        [{ role: "user", content: "log 300 ml water" }],
        "test-key",
    );
    expect(reply.message).toContain("Записал —");
});

test("propose_meal returns a card and writes nothing to the database", async () => {
    // Only the timezone lookup is scripted: any insert would hit "unexpected".
    installFakeSql([{ rows: [] }]);
    fakeLlm([
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "c1",
                    function: {
                        name: "propose_meal",
                        arguments:
                            '{"description":"Овсянка с бананом","meal_type":"breakfast","calories":320,"protein_g":9}',
                    },
                },
            ],
        },
        { role: "assistant", content: "Прикинул на глаз — проверь карточку." },
    ]);

    const reply = await runChatTurn(
        "u1",
        [{ role: "user", content: "съел овсянку с бананом" }],
        "test-key",
    );
    expect(reply.proposals).toEqual([
        {
            description: "Овсянка с бананом",
            meal_type: "breakfast",
            calories: 320,
            protein_g: 9,
        },
    ]);
    expect(reply.message).toContain("карточку");
});

test("prose claiming a proposal without a tool call gets nudged into propose_meal", async () => {
    installFakeSql([{ rows: [] }]); // timezone lookup only
    const llmBodies = fakeLlm([
        // Round 1: mimics history — claims a card, calls nothing.
        {
            role: "assistant",
            content:
                "Предложила: 150 г черешни — 75 ккал. Подтвердите для сохранения.",
        },
        // Round 2 (after the nudge): actually proposes.
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "c1",
                    function: {
                        name: "propose_meal",
                        arguments:
                            '{"description":"Черешня, 150 г","meal_type":"snack","calories":75}',
                    },
                },
            ],
        },
        { role: "assistant", content: "Прикинула 75 ккал — проверь карточку." },
    ]);

    const reply = await runChatTurn(
        "u1",
        [{ role: "user", content: "Грам 150 черешни" }],
        "test-key",
    );
    expect(reply.proposals).toEqual([
        { description: "Черешня, 150 г", meal_type: "snack", calories: 75 },
    ]);
    // Round 2 request carries the corrective system message.
    const secondBody = llmBodies[1] as {
        messages: { role: string; content?: string }[];
    };
    const last = secondBody.messages[secondBody.messages.length - 1]!;
    expect(last.role).toBe("system");
    expect(last.content).toContain("CHECK FAILED");
});

test("assistant consults the dish catalog before proposing a saved item", async () => {
    installFakeSql([
        { rows: [] }, // getUserTimezone → UTC
        { rows: [dishRow] }, // list_dishes
    ]);
    fakeLlm([
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "c1",
                    function: { name: "list_dishes", arguments: "{}" },
                },
            ],
        },
        // Model reuses the saved macros verbatim in the proposal.
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "c2",
                    function: {
                        name: "propose_meal",
                        arguments:
                            '{"description":"Protein shake","meal_type":"snack","calories":200,"protein_g":30,"carbs_g":5,"fat_g":3}',
                    },
                },
            ],
        },
        {
            role: "assistant",
            content: "Это твой протеиновый коктейль — 200 ккал.",
        },
    ]);

    const events: string[] = [];
    const reply = await runChatTurn(
        "u1",
        [{ role: "user", content: "выпил протеиновый коктейль" }],
        "test-key",
        (name) => events.push(name),
    );

    expect(events).toEqual(["list_dishes", "propose_meal"]);
    expect(reply.proposals).toEqual([
        {
            description: "Protein shake",
            meal_type: "snack",
            calories: 200,
            protein_g: 30,
            carbs_g: 5,
            fat_g: 3,
        },
    ]);
    expect(reply.message).toContain("коктейль");
});

test("executeTool save_dish upserts the catalog without logging a meal", async () => {
    const calls = installFakeSql([
        { rows: [dishRow] }, // insertDish upsert returning
    ]);
    const res = JSON.parse(
        await executeTool("u1", "save_dish", {
            name: "Protein shake",
            meal_type: "snack",
            calories: 200,
            protein_g: 30,
        }),
    );
    expect(res.saved).toBe(true);
    expect(res.dish.name).toBe("Protein shake");
    expect(res.dish.protein_g).toBe(30); // driver string normalized to number
    // A single upsert targeting the case-insensitive name conflict.
    expect(calls.length).toBe(1);
    const text = calls[0]!.text.toLowerCase();
    expect(text).toContain("insert into dishes");
    expect(text).toContain("on conflict (user_id, lower(name))");
});

test("innocent suggestion prose is returned as-is without a nudge", async () => {
    installFakeSql([{ rows: [] }]);
    const llmBodies = fakeLlm([
        {
            role: "assistant",
            content: "Могу предложить куриную грудку с рисом или омлет.",
        },
    ]);

    const reply = await runChatTurn(
        "u1",
        [{ role: "user", content: "что мне поесть на ужин?" }],
        "test-key",
    );
    expect(reply.message).toContain("куриную грудку");
    expect(reply.proposals).toEqual([]);
    expect(llmBodies.length).toBe(1); // single round — guard stayed quiet
});
