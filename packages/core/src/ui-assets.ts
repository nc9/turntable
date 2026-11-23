// Embedded web UI. The compiled binary registers its asset files at startup from a generated
// entry (see packages/ui/scripts/compile-entry.ts), so the bundle ships inside the executable
// and nothing is read from the working directory. Without registration (dev, tests) the server
// falls back to a placeholder page.
//
// Dev mode (running from source, never the compiled binary): `enableDevUi` serves a built bundle
// straight from a directory, `packages/ui/dist` by default or LONGSHORE_UI_DIR, so the dev loop
// is `bun run --cwd packages/ui build` and reload. The directory is read per request, so a
// rebuild shows without a restart. A request can only reach regular files inside that directory.
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** URL path -> file path (an embedded file in the compiled binary, a real file in tests). */
export type UiManifest = Readonly<Record<string, string>>;

let manifest: UiManifest | null = null;
/** Real path of the dev directory, when dev mode is on. */
let devDir: string | null = null;

export function registerUiAssets(m: UiManifest | null): void {
  manifest = m;
  devDir = null;
}

export function hasUi(): boolean {
  return (manifest !== null && "/index.html" in manifest) || devDir !== null;
}

/** True inside a `bun build --compile` executable, whose files live in a virtual filesystem. */
export function compiledBinary(main: string = Bun.main): boolean {
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN/.test(main);
}

/** `packages/ui/dist`, relative to this source file. */
const SOURCE_DIST = resolve(import.meta.dir, "../../ui/dist");

export type DevUi = { dir: string; source: "env" | "source" };

/**
 * Turns dev mode on when the process runs from source, no embedded UI is registered and a built
 * bundle (an index.html) exists: LONGSHORE_UI_DIR if set, else `packages/ui/dist`. Returns what
 * it chose, or undefined. The compiled binary never reads UI assets from disk: it returns
 * undefined whatever the environment says.
 */
export function enableDevUi(
  env: Record<string, string | undefined> = process.env,
  o: { compiled?: boolean; sourceDist?: string } = {},
): DevUi | undefined {
  if (o.compiled ?? compiledBinary()) return undefined;
  if (hasUi()) return undefined;
  const fromEnv = env.LONGSHORE_UI_DIR?.trim();
  const dir = fromEnv ? resolve(fromEnv) : (o.sourceDist ?? SOURCE_DIST);
  try {
    const real = realpathSync(dir);
    if (!statSync(resolve(real, "index.html")).isFile()) return undefined;
    devDir = real;
  } catch {
    return undefined;
  }
  return { dir: devDir, source: fromEnv ? "env" : "source" };
}

/** A regular file inside the dev directory for a URL path, or undefined. No path leaves the directory. */
function devFile(key: string): string | undefined {
  if (devDir === null || key.includes("\0") || key.includes("\\")) return undefined;
  const full = resolve(devDir, `.${key}`);
  if (!full.startsWith(devDir + sep)) return undefined;
  try {
    // A symlink that leads out of the directory is not served.
    const real = realpathSync(full);
    if (!real.startsWith(devDir + sep)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
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

/**
 * No inline script, no remote origins. Styles: React sets style attributes, so only those are
 * inline. `connect-src` names the page's own host for WebSocket (`'self'` alone does not cover ws
 * in every browser); `host` is the request's Host header, validated as host[:port].
 */
export function uiCsp(host: string): string {
  const ws = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(host)
    ? ` ws://${host} wss://${host}`
    : "";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    `connect-src 'self'${ws}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Serve a UI asset, or the app shell for client-side routes. Returns null when no UI is
 * registered, or when the path is not the UI's to answer (API paths, unknown files).
 */
export function serveUi(
  url: URL,
  method: string,
  baseHeaders: Record<string, string>,
): Response | null {
  if (!manifest && devDir === null) return null;
  const path = url.pathname;
  if (path.startsWith("/api/") || path === "/api" || path === "/healthz") return null;

  const lookup = (k: string): string | undefined =>
    manifest ? (Object.hasOwn(manifest, k) ? manifest[k] : undefined) : devFile(k);
  let key = path === "/" ? "/index.html" : path;
  let spa = false;
  let file = lookup(key);
  if (file === undefined) {
    // A path with a file extension that is not an asset is a real 404; anything else is a route.
    if (/\.[a-z0-9]+$/i.test(path)) return null;
    key = "/index.html";
    spa = true;
    file = lookup(key);
  }
  if (!file) return null;
  const immutable = key.startsWith("/assets/");
  const headers: Record<string, string> = {
    ...baseHeaders,
    "content-type": TYPES[extOf(key)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (key === "/index.html" || spa) headers["content-security-policy"] = uiCsp(url.host);
  return new Response(method === "HEAD" ? null : Bun.file(file), { headers });
}
