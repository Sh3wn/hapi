/**
 * `Vite base` doubles as the router's `basepath`: the bundle may be served from
 * a sub-path (e.g. GitHub Pages at `/<repo>/`), and TanStack Router only strips
 * that prefix when it is told about it. Without it every route under a sub-path
 * falls through to the not-found fallback.
 */

/** Router `basepath` for an explicit Vite base (`/` when unset or all slashes). */
export function routerBasepathFromBase(baseUrl: string | undefined): string {
    return (baseUrl ?? '/').replace(/\/+$/, '') || '/'
}