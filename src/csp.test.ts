import { expect, test } from "bun:test";
import { addCspNonce, contentSecurityPolicy, createCspNonce } from "./csp.js";

test("CSP uses a fresh nonce and applies it to inline script/style tags", () => {
    const first = createCspNonce();
    const second = createCspNonce();
    expect(first).not.toBe(second);

    const html = addCspNonce(
        '<script>run()</script><style>.ok{color:green}</style><script nonce="kept">x</script>',
        first,
    );
    expect(html).toContain(`<script nonce="${first}">run()`);
    expect(html).toContain(`<style nonce="${first}">`);
    expect(html).toContain('<script nonce="kept">');

    const scriptSrc = contentSecurityPolicy(first)
        .split("; ")
        .find((part) => part.startsWith("script-src"));
    expect(scriptSrc).toBe(`script-src 'self' 'nonce-${first}'`);
});

test("all served HTML templates have every script covered by the nonce", async () => {
    for (const file of ["index.html", "login.html", "privacy.html"]) {
        const html = addCspNonce(
            await Bun.file(`./public/${file}`).text(),
            "test-nonce",
        );
        expect(html.match(/<script(?![^>]*\bnonce=)[^>]*>/i)).toBeNull();
    }
});
