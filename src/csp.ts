const CSP_NONCE_BYTES = 16;

export function createCspNonce(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(CSP_NONCE_BYTES));
    return btoa(String.fromCharCode(...bytes));
}

export function addCspNonce(html: string, nonce: string): string {
    return html.replace(
        /<(script|style)(?![^>]*\bnonce=)(?=[\s>])/gi,
        `<$1 nonce="${nonce}"`,
    );
}

export function contentSecurityPolicy(nonce: string): string {
    return [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        "connect-src 'self'",
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
        `style-src-elem 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net https://fonts.googleapis.com`,
        "style-src-attr 'unsafe-inline'",
        "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net",
        "img-src 'self'",
        "frame-ancestors 'none'",
    ].join("; ");
}
