/**
 * Notification payloads carry app paths (`/sessions/<id>`, or the bundle's own
 * `pwa-*.png` assets) relative to the app root, but a sub-path deployment (e.g.
 * GitHub Pages at `/<repo>/`) serves the app below the origin. The service
 * worker resolves them against its own scope, which is the app root.
 */

/** Absolute (`https://…`) and protocol-relative (`//host/…`) input is already complete. */
function isAbsoluteUrl(value: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')
}

/**
 * Resolve a payload URL against the app root `scope`. An empty/absent URL means
 * the app root itself; a leading slash is treated as app-relative, not as an
 * origin-relative path that would drop the deployment's base.
 */
export function resolveNotificationUrl(rawUrl: string | undefined, scope: string, fallback = ''): string {
    const candidate = rawUrl?.trim() || fallback
    if (isAbsoluteUrl(candidate)) {
        return candidate
    }
    return new URL(candidate.replace(/^\/+/, ''), scope).href
}