import { useSyncExternalStore } from "react";
import { lastOrg } from "./last-org";

// Web sign-in (#430, #477). The server owns the session: an HttpOnly cookie the page cannot read.
// This module only knows what `GET /auth/session` says (who, which orgs), so nothing secret is
// held here and nothing is stored in the browser for it. The last org used is remembered by
// last-org.ts as a convenience and validated against the session's orgs before it is used.

export const SESSION_PATH = "/auth/session";
export const LOGIN_PATH = "/auth/github/login";
export const AUTH_PAGE_PATH = "/auth";
export const LOGOUT_PATH = "/auth/logout";
export const SIGN_IN_PATH = "/sign-in";
export const TOKEN_SIGN_IN_PATH = "/sign-in/token";

export type SessionOrg = { slug: string; name: string; role: string };
export type SessionState = {
  /** `unknown` until the first `GET /auth/session` answers. */
  status: "unknown" | "anonymous" | "signed-in";
  login: string | null;
  orgs: SessionOrg[];
  notice: string | null;
};

const UNKNOWN: SessionState = { status: "unknown", login: null, orgs: [], notice: null };

/** The `GET /auth/session` body, validated. Anything unexpected is treated as signed out. */
export function parseSession(body: unknown): SessionState {
  if (!body || typeof body !== "object") return { ...UNKNOWN, status: "anonymous" };
  const b = body as { signed_in?: unknown; github_login?: unknown; orgs?: unknown };
  if (b.signed_in !== true || !Array.isArray(b.orgs)) return { ...UNKNOWN, status: "anonymous" };
  const orgs: SessionOrg[] = [];
  for (const o of b.orgs) {
    if (!o || typeof o !== "object") continue;
    const { slug, name, role } = o as Record<string, unknown>;
    if (typeof slug === "string" && slug) {
      orgs.push({
        slug,
        name: typeof name === "string" && name ? name : slug,
        role: typeof role === "string" ? role : "",
      });
    }
  }
  return {
    status: "signed-in",
    login: typeof b.github_login === "string" ? b.github_login : null,
    orgs,
    notice: null,
  };
}

/**
 * A `next` value is honoured only when it is a same-origin relative path: it starts with one
 * slash, is not protocol-relative (`//host`, `/\host`), carries no control characters, resolves to
 * the same origin, and is not the sign-in route itself. Anything else is dropped.
 */
export function sanitizeNext(next: unknown): string | undefined {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return undefined;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return undefined;
  try {
    const u = new URL(next, "http://turntable.invalid");
    if (u.origin !== "http://turntable.invalid") return undefined;
  } catch {
    return undefined;
  }
  if (
    next === SIGN_IN_PATH ||
    next.startsWith(`${SIGN_IN_PATH}/`) ||
    next.startsWith(`${SIGN_IN_PATH}?`)
  )
    return undefined;
  if (next === "/") return undefined;
  return next;
}

export const isSignInPath = (path: string): boolean =>
  path === SIGN_IN_PATH || path === TOKEN_SIGN_IN_PATH;

export type Gate =
  | { kind: "app" }
  | { kind: "wait" }
  | { kind: "screen"; screen: "sign-in" | "token" }
  | { kind: "redirect"; to: string; next?: string };

/**
 * What the shell shows. Any logged-out visit ends on the sign-in route; a signed-in visit to it
 * goes on to `next` (or home). The token form is a secondary route, never the landing page.
 */
export function gateFor(input: {
  fixture: boolean;
  hasToken: boolean;
  session: SessionState["status"];
  path: string;
  /** The path (with search) the person asked for, or the `next` of the sign-in route. */
  here: string;
  next?: unknown;
}): Gate {
  if (input.fixture) return { kind: "app" };
  const onSignIn = isSignInPath(input.path);
  if (!input.hasToken && input.session === "unknown") return { kind: "wait" };
  const authed = input.hasToken || input.session === "signed-in";
  if (authed) {
    if (!onSignIn) return { kind: "app" };
    const next = sanitizeNext(input.next);
    return { kind: "redirect", to: next ?? "/" };
  }
  if (onSignIn)
    return { kind: "screen", screen: input.path === TOKEN_SIGN_IN_PATH ? "token" : "sign-in" };
  const next = sanitizeNext(input.here);
  return { kind: "redirect", to: SIGN_IN_PATH, ...(next ? { next } : {}) };
}

/**
 * The org requests are made for in session mode: the one in the URL, else the remembered one,
 * else the only one. Each is accepted only if the session lists it.
 */
export function pickOrg(
  orgs: readonly { slug: string }[],
  opts: { urlSlug?: string | null; remembered?: string | null },
): string | null {
  const has = (s: string | null | undefined): s is string =>
    typeof s === "string" && orgs.some((o) => o.slug === s);
  if (has(opts.urlSlug)) return opts.urlSlug;
  if (has(opts.remembered)) return opts.remembered;
  return orgs.length === 1 ? (orgs[0] as { slug: string }).slug : null;
}

/** The first path segment, which is the org slug on every org route. */
export const urlOrgSlug = (pathname: string): string | null => {
  const seg = pathname.split("/")[1] ?? "";
  return seg && seg !== "-" ? decodeURIComponent(seg) : null;
};

/** The CSRF token sits in the sign-out form of the server's `/auth` page (the cookie is HttpOnly). */
export function csrfFromAuthPage(html: string): string | undefined {
  return /name="csrf"\s+value="([A-Za-z0-9_-]{16,128})"/.exec(html)?.[1];
}

// --- store ---------------------------------------------------------------------------------

let state: SessionState = UNKNOWN;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (s: SessionState) => {
  state = s;
  for (const l of listeners) l();
};

export const getSession = (): SessionState => state;
export const isSessionActive = (): boolean => state.status === "signed-in";

export function useSession(): SessionState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

/** Ask the server who is signed in. Safe to call repeatedly: concurrent calls share one request. */
export function loadSession(
  f: (input: string, init?: RequestInit) => Promise<Response> = (i, n) => fetch(i, n),
): Promise<void> {
  inflight ??= (async () => {
    try {
      const res = await f(SESSION_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { accept: "application/json" },
      });
      set(res.ok ? parseSession(await res.json()) : { ...UNKNOWN, status: "anonymous" });
    } catch {
      set({ ...UNKNOWN, status: "anonymous", notice: "Could not reach the server." });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The server no longer accepts the session (expired or revoked): back to signed out. */
export function sessionEnded(notice: string | null = "Your session ended. Sign in again."): void {
  set({ ...UNKNOWN, status: "anonymous", notice });
}

/** Test seam: forget everything. */
export function resetSession(next: SessionState = UNKNOWN): void {
  inflight = null;
  state = next;
  for (const l of listeners) l();
}

/** The org for requests in session mode. */
export function sessionOrg(pathname: string): string | null {
  return pickOrg(state.orgs, { urlSlug: urlOrgSlug(pathname), remembered: lastOrg() });
}

export type SignOutDeps = {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called last, to leave the app (a full page load, so no signed-in data stays in memory). */
  leave?: (to: string) => void;
};

/**
 * Sign out: read the CSRF token from the server's `/auth` page, POST it to `/auth/logout` (the
 * browser adds the Origin header the server checks), then leave. The local state is cleared even
 * if the server cannot be reached; the cookie then simply expires on its own.
 */
export async function signOut(deps: SignOutDeps = {}): Promise<{ ok: boolean }> {
  const f = deps.fetch ?? ((i: string, n?: RequestInit) => fetch(i, n));
  let ok = false;
  try {
    const page = await f(AUTH_PAGE_PATH, {
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    const csrf = csrfFromAuthPage(await page.text());
    if (csrf) {
      const res = await f(LOGOUT_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf }).toString(),
      });
      // A manual redirect (the server answers 303 to /auth) is an opaque redirect: that is success.
      ok = res.ok || res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
    }
  } catch {
    // fall through: sign out locally
  }
  set({ ...UNKNOWN, status: "anonymous" });
  (deps.leave ?? ((to) => window.location.assign(to)))(SIGN_IN_PATH);
  return { ok };
}
