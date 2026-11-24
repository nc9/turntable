// Per-flow browser-binding cookies. A flow (an installation claim, a web sign-in) binds itself to
// the browser that started it with a cookie holding its nonce. One shared cookie name let a second
// flow started in the same browser overwrite the first one's binding, so the first callback was
// refused. Here the NAME carries a short hash of the nonce, so parallel flows each keep their own
// cookie, and a callback reads exactly the cookie that matches its state's nonce.
import { createHash } from "node:crypto";

/** How many cookies of one flow kind a browser may hold; the oldest are expired beyond it. */
export const MAX_FLOW_COOKIES = 4;

const SUFFIX = /^[0-9a-f]{16}$/;

/** The 16-hex-character tag of a nonce. Not secret: the nonce is the value. */
export const nonceTag = (nonce: string): string =>
  createHash("sha256").update(`tt-flow-cookie.${nonce}`).digest("hex").slice(0, 16);

/** The cookie name of one flow: `<prefix><tag of nonce>`. */
export const flowCookieName = (prefix: string, nonce: string): string =>
  `${prefix}${nonceTag(nonce)}`;

function all(req: Request): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() });
  }
  return out;
}

/** The value of the cookie named for exactly this nonce (`undefined` when absent). */
export function readFlowCookie(req: Request, prefix: string, nonce: string): string | undefined {
  const want = flowCookieName(prefix, nonce);
  return all(req).find((c) => c.name === want)?.value;
}

/**
 * Every well-formed flow cookie of a kind in the request: its name is `<prefix><tag>` and the tag
 * is the tag of its own value. A cookie that fails that check is not one of ours and is ignored.
 */
export function readFlowCookies(req: Request, prefix: string): { name: string; nonce: string }[] {
  const out: { name: string; nonce: string }[] = [];
  for (const c of all(req)) {
    if (!c.name.startsWith(prefix)) continue;
    const tag = c.name.slice(prefix.length);
    if (SUFFIX.test(tag) && tag === nonceTag(c.value)) out.push({ name: c.name, nonce: c.value });
  }
  return out;
}

/**
 * The cookies of a kind to expire so that, once one more is set, no more than `keep` remain.
 * `rank` orders them oldest first (unknown ranks are oldest); ties keep request order, which
 * browsers send oldest first.
 */
export function excessFlowCookies(
  existing: { name: string; nonce: string }[],
  keep: number,
  rank: (nonce: string) => number = () => 0,
): string[] {
  const room = Math.max(0, keep - 1);
  if (existing.length <= room) return [];
  const sorted = existing
    .map((c, i) => ({ c, i, r: rank(c.nonce) }))
    .sort((a, b) => a.r - b.r || a.i - b.i);
  return sorted.slice(0, existing.length - room).map((x) => x.c.name);
}
