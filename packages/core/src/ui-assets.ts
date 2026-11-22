// Embedded web UI. The compiled binary registers its asset files at startup from a generated
// entry (see packages/ui/scripts/compile-entry.ts), so the bundle ships inside the executable
// and nothing is read from the working directory. Without registration (dev, tests) the server
// falls back to a placeholder page.

/** URL path -> file path (an embedded file in the compiled binary, a real file in tests). */
export type UiManifest = Readonly<Record<string, string>>;

let manifest: UiManifest | null = null;

export function registerUiAssets(m: UiManifest | null): void {
  manifest = m;
}

export function hasUi(): boolean {
  return manifest !== null && "/index.html" in manifest;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

const extOf = (p: string): string => p.slice(p.lastIndexOf(".") + 1).toLowerCase();

/** No inline script, no remote origins. Styles: React sets style attributes, so only those are inline. */
export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Serve a UI asset, or the app shell for client-side routes. Returns null when no UI is
 * registered, or when the path is not the UI's to answer (API paths, unknown files).
 */
export function serveUi(
  url: URL,
  method: string,
  baseHeaders: Record<string, string>,
): Response | null {
  if (!manifest) return null;
  const path = url.pathname;
  if (path.startsWith("/api/") || path === "/api" || path === "/healthz") return null;

  let key = path === "/" ? "/index.html" : path;
  let spa = false;
  if (!(key in manifest)) {
    // A path with a file extension that is not an asset is a real 404; anything else is a route.
    if (/\.[a-z0-9]+$/i.test(path)) return null;
    key = "/index.html";
    spa = true;
  }
  const file = manifest[key];
  if (!file) return null;
  const immutable = key.startsWith("/assets/");
  const headers: Record<string, string> = {
    ...baseHeaders,
    "content-type": TYPES[extOf(key)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (key === "/index.html" || spa) headers["content-security-policy"] = UI_CSP;
  return new Response(method === "HEAD" ? null : Bun.file(file), { headers });
}
