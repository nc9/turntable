// The one layout for every HTML page the server renders itself (setup, claim, the loopback CLI
// page, the missing-UI fallback). A page is a title and a body of trusted markup: callers escape
// every dynamic value with `esc`. The pages carry no script and no inline style, so the CSP is
// `style-src 'self'`: the stylesheet and the two fonts are served from `/_pages/` by
// `servePageAsset`, embedded in the binary, with a content hash in the path. There is no
// auto-submitting form: the page that sends a manifest to GitHub shows a button to press.
import { createHash } from "node:crypto";
import geistFont from "../../../ui/src/fonts/Geist-Variable.woff2" with { type: "file" };
import monoFont from "../../../ui/src/fonts/GeistMono-Variable.woff2" with { type: "file" };
import { PAGE_CSS } from "./page-style";

const sha = (b: string | Uint8Array): string =>
  createHash("sha256").update(b).digest("hex").slice(0, 12);

const geist = await Bun.file(geistFont).bytes();
const mono = await Bun.file(monoFont).bytes();

const CSS = PAGE_CSS.replace("__GEIST__", sha(geist)).replace("__GEIST_MONO__", sha(mono));
/** The stylesheet's URL: the hash of its content is in the path, so it can be cached for good. */
export const PAGE_STYLE_PATH = `/_pages/${sha(CSS)}.css`;
const FONT_PATHS = {
  "/_pages/fonts/geist.woff2": geist,
  "/_pages/fonts/geist-mono.woff2": mono,
} as const;

/** HTML-escape a value for text or a double-quoted attribute. */
export const esc = (v: string): string =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Serves the stylesheet and fonts, or undefined for any other path. Same-origin, GET and HEAD. */
export function servePageAsset(req: Request): Response | undefined {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  const path = new URL(req.url).pathname;
  const common = { "x-content-type-options": "nosniff", "cache-control": IMMUTABLE };
  if (path === PAGE_STYLE_PATH) {
    return new Response(req.method === "HEAD" ? null : CSS, {
      headers: { ...common, "content-type": "text/css; charset=utf-8" },
    });
  }
  const font = (FONT_PATHS as Record<string, Uint8Array>)[path];
  if (font) {
    return new Response(req.method === "HEAD" ? null : font, {
      headers: { ...common, "content-type": "font/woff2" },
    });
  }
  return undefined;
}

/**
 * The CSP of a server-rendered page. `formAction` is the page's own form target: `'none'` for a
 * page with no form, `'self'` for one that posts to this server, and an origin for one that posts
 * to GitHub.
 */
export function pageCsp(formAction: string = "'none'"): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface PageOptions {
  title: string;
  /** Trusted markup. Escape every dynamic value with `esc`. */
  body: string;
}

/** A full HTML document: header, then the body in a card under the title. */
export function renderPage(o: PageOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(o.title)}</title><link rel="stylesheet" href="${PAGE_STYLE_PATH}"></head>
<body><header class="tt-header"><span class="tt-mark"></span>Turntable</header>
<main class="tt-main"><div class="tt-card"><h1>${esc(o.title)}</h1>
${o.body}
</div></main></body></html>
`;
}

export interface PageResponseOptions extends PageOptions {
  status?: number;
  formAction?: string;
  cookies?: readonly string[];
  /** Pages that carry or follow a one-time state are never cached. Default true. */
  noStore?: boolean;
}

/** The headers of a server-rendered page, for a caller that has rendered the document itself. */
export function pageHeaders(o: Omit<PageResponseOptions, "title" | "body"> = {}): Headers {
  const h = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": pageCsp(o.formAction),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  if (o.noStore !== false) h.set("cache-control", "no-store");
  for (const c of o.cookies ?? []) h.append("set-cookie", c);
  return h;
}

/** A rendered page with the security headers. */
export function pageResponse(o: PageResponseOptions): Response {
  return new Response(renderPage(o), { status: o.status ?? 200, headers: pageHeaders(o) });
}
