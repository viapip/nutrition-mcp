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

test("runChatTurn executes a tool call and returns the final text", async () => {
    const sqlCalls = installFakeSql([
        { rows: [] }, // getUserTimezone → profile miss → UTC
        { rows: [] }, // insertWater: idempotency lookup
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

    process.env.LLM_API_KEY = "test-key";
    const reply = await runChatTurn("u1", [
        { role: "user", content: "выпил стакан воды 300мл" },
    ]);

    expect(reply).toBe("Записал 300 мл воды.");
    // insert got the parsed amount
    expect(sqlCalls[2]!.values).toContain(300);
    // second LLM call carries the tool result back
    const second = llmBodies[1] as { messages: { role: string }[] };
    expect(second.messages.at(-1)!.role).toBe("tool");
});

test("executeTool converts weight kg to grams and reports bad input", async () => {
    const calls = installFakeSql([
        { rows: [] },
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
    expect(calls[1]!.values).toContain(78200);

    const bad = JSON.parse(
        await executeTool("u1", "log_weight", {
            weight_kg: -5,
        }),
    );
    expect(bad.error).toContain("invalid number");

    const unknown = JSON.parse(await executeTool("u1", "nope", {}));
    expect(unknown.error).toContain("unknown tool");
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
        { rows: [] }, // insertWater: idempotency lookup
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

    process.env.LLM_API_KEY = "test-key";
    const reply = await runChatTurn("u1", [
        { role: "user", content: "log 300 ml water" },
    ]);
    expect(reply).toContain("Logged it");
});
