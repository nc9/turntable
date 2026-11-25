// "Sign in with GitHub" (#430) through the instance's own GitHub App (user-to-server OAuth).
//
//   GET  /auth                      the sign-in page, or who is signed in and a sign-out button
//   GET  /auth/session              the same as JSON
//   GET  /auth/github/login         starts: single-use state, a browser-binding cookie, then GitHub
//   GET  /auth/github/callback      finishes: state and cookie must match, the nonce is spent
//                                   BEFORE the code is exchanged, then the user's numeric id is read
//   POST /auth/logout               revokes the session (Origin must match, and a CSRF token)
//
// The state is an HMAC over a nonce and an expiry, like the installation claim's. The nonce also
// sits in a short-lived `__Host-` cookie and in `login_states`, where it is spent atomically, so a
// state cannot be replayed and a link opened in another browser cannot finish. The identity is the
// numeric GitHub user id. Roles come from Turntable's membership rows, which only an invite or the
// instance administrator creates: signing in never grants an org.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type SafeFetch, safeFetch } from "@turntable/net";
import type { Db } from "../db";
import {
  completeSignIn,
  consumeLoginState,
  createLoginState,
  getGithubApp,
  getIdentityByUserId,
  listMembershipsOfUser,
} from "../db/repos";
import { SECRET_CLIENT } from "../github/app-auth";
import { esc, pageResponse } from "../pages/server-pages";
import { KeyCache } from "../secrets/ensure-key";
import type { SettingsRuntime } from "../settings/resolve";
import { selfServeAllows } from "./self-serve";
import { parseTokenResponse, type UserTokens, type UserTokenSet } from "./user-tokens";
import type { SecretStore } from "../secrets/store";
import {
  excessFlowCookies,
  flowCookieName,
  MAX_FLOW_COOKIES,
  readFlowCookie,
  readFlowCookies,
} from "./flow-cookies";
import {
  csrfToken,
  LOGIN_COOKIE,
  newSessionId,
  readCookie,
  SESSION_COOKIE,
  sessionHash,
  type WebSessions,
} from "./web-sessions";

export const AUTH_PAGE_PATH = "/auth";
export const LOGIN_PATH = "/auth/github/login";
export const CALLBACK_PATH = "/auth/github/callback";
export const LOGOUT_PATH = "/auth/logout";
export const SESSION_INFO_PATH = "/auth/session";
export const SECRET_LOGIN_KEY = "github-app/login-state-key";
export const LOGIN_TTL_MS = 10 * 60_000;
const LOGIN_COOKIE_PREFIX = `${LOGIN_COOKIE}_`;
/** The binding cookie's name for one sign-in: a tag of its nonce, so parallel sign-ins coexist. */
export const loginCookieName = (nonce: string): string =>
  flowCookieName(LOGIN_COOKIE_PREFIX, nonce);

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** A GitHub user proven by an OAuth code. Only what sign-in needs: the numeric id and the login. */
export type GithubIdentity = {
  id: string;
  login: string;
  /** The user-to-server token set the exchange gave, to be sealed for the session. */
  tokens?: UserTokenSet | undefined;
};

export interface IdentityVerifier {
  verify(code: string, redirectUri: string): Promise<GithubIdentity>;
}

/**
 * The OAuth exchange through the guarded client. The user's token set is handed back to the
 * caller, which seals it for the session (auth/user-tokens.ts); nothing here stores or logs it.
 */
export function githubIdentityVerifier(o: {
  db: Db;
  store: SecretStore;
  fetch?: SafeFetch;
  oauthBase?: string;
  apiBase?: string;
}): IdentityVerifier {
  const f = o.fetch ?? safeFetch;
  const oauth = o.oauthBase ?? "https://github.com";
  const api = o.apiBase ?? "https://api.github.com";
  return {
    async verify(code, redirectUri) {
      const app = await getGithubApp(o.db);
      if (!app) throw new Error("no GitHub App is configured");
      const secret = await o.store.get(app.orgId, SECRET_CLIENT);
      if (!secret) throw new Error("the App's client secret is missing");
      const tok = await f(`${oauth}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "turntable",
        },
        body: JSON.stringify({
          client_id: app.clientId,
          client_secret: secret,
          code,
          redirect_uri: redirectUri,
        }),
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
      });
      const tj = (await tok.json().catch(() => ({}))) as unknown;
      const tokens = tok.ok ? parseTokenResponse(tj, Date.now()) : undefined;
      if (!tokens) throw new Error("code not accepted");
      const me = await f(`${api}/user`, {
        headers: {
          authorization: `Bearer ${tokens.access}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "turntable",
        },
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
      });
      if (!me.ok) throw new Error(`user: HTTP ${me.status}`);
      const mj = (await me.json()) as { id?: unknown; login?: unknown };
      if (typeof mj.id !== "number" || typeof mj.login !== "string") throw new Error("bad user");
      if (!/^[A-Za-z0-9-]{1,39}$/.test(mj.login)) throw new Error("bad login");
      return { id: String(mj.id), login: mj.login, tokens };
    },
  };
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const page = (status: number, title: string, body: string, cookies: string[] = []): Response =>
  pageResponse({ status, title, body, cookies, formAction: "'self' https://github.com" });

const note = (status: number, title: string, message: string, cookies: string[] = []): Response =>
  page(status, title, `<p>${esc(message)}</p><p><a href="${AUTH_PAGE_PATH}">Back</a></p>`, cookies);

const clearLoginCookie = (name: string): string =>
  `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

export interface AuthHandler {
  handle(req: Request): Promise<Response | undefined>;
}

export interface AuthHandlerOptions {
  db: Db;
  store: SecretStore;
  sessions: WebSessions;
  identity: IdentityVerifier;
  /** Seals the user's GitHub token for the session; without it the token is dropped as before. */
  userTokens?: UserTokens | undefined;
  /** For `self_serve_orgs`: a GitHub account with no org may sign in when it allows them. */
  settings?: SettingsRuntime | undefined;
  log?: (line: string) => void;
}

export function createAuthHandler(o: AuthHandlerOptions): AuthHandler {
  const redirectUri = `${o.sessions.origin}${CALLBACK_PATH}`;

  // The HMAC key is created on first use with insert-if-absent and always read back from the
  // store, so concurrent first uses (this process or another over the same database) share ONE key.
  // The cache holds only a value read back from the store; a failed verify re-reads once.
  const keys = new KeyCache(o.store, SECRET_LOGIN_KEY);
  const key = (appOrg: string): Promise<Buffer> => keys.get(appOrg);

  const sign = (k: Buffer, body: string): Buffer =>
    createHmac("sha256", k).update(`login.v1.${body}`).digest();

  /** The nonce of a state whose signature and expiry hold. */
  async function verifyState(state: string, appOrg: string): Promise<string | undefined> {
    const parts = state.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return undefined;
    const [, body, sig] = parts as [string, string, string];
    const given = Buffer.from(sig, "base64url");
    const good = await keys.verify(appOrg, (k) => {
      const want = sign(k, body);
      return given.length === want.length && timingSafeEqual(given, want);
    });
    if (!good) return undefined;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        n?: unknown;
        e?: unknown;
      };
      if (typeof p.n !== "string" || typeof p.e !== "number" || p.e <= o.sessions.now()) {
        return undefined;
      }
      return p.n;
    } catch {
      return undefined;
    }
  }

  async function start(req: Request): Promise<Response> {
    const app = await getGithubApp(o.db);
    if (!app) return note(503, "Sign-in unavailable", "No GitHub App is configured.");
    const now = o.sessions.now();
    const nonce = randomBytes(18).toString("base64url");
    const expiresAt = now + LOGIN_TTL_MS;
    await createLoginState(o.db, nonce, expiresAt, now);
    const body = b64u(JSON.stringify({ n: nonce, e: expiresAt }));
    const state = `v1.${body}.${b64u(sign(await key(app.orgId), body))}`;
    const target =
      `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
    const headers = new Headers({ location: target, "cache-control": "no-store" });
    // Lax: the callback is a navigation that starts on github.com. One cookie per sign-in, named
    // from its nonce, so a second tab does not replace the first one's binding; the oldest beyond
    // the cap are expired.
    headers.append(
      "set-cookie",
      `${loginCookieName(nonce)}=${nonce}; Max-Age=${LOGIN_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    for (const name of excessFlowCookies(
      readFlowCookies(req, LOGIN_COOKIE_PREFIX),
      MAX_FLOW_COOKIES,
    )) {
      headers.append("set-cookie", clearLoginCookie(name));
    }
    return new Response(null, { status: 303, headers });
  }

  async function callback(req: Request, url: URL): Promise<Response> {
    const app = await getGithubApp(o.db);
    if (!app) return note(503, "Sign-in unavailable", "No GitHub App is configured.");
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const stateNonce = await verifyState(state, app.orgId);
    // Exactly this sign-in's cookie: its name is derived from the state's nonce.
    // The cookie must carry this state's nonce exactly, not merely sit under its name.
    const held = stateNonce ? readFlowCookie(req, LOGIN_COOKIE_PREFIX, stateNonce) : undefined;
    const cookieNonce = held !== undefined && safeEqual(held, stateNonce!) ? held : undefined;
    const clearThis = stateNonce ? [clearLoginCookie(loginCookieName(stateNonce))] : [];
    // The browser that started the sign-in must be the one that finishes it. Nothing is spent
    // until the signature, the expiry and the cookie all agree.
    if (!stateNonce || !cookieNonce) {
      return note(
        403,
        "Sign-in refused",
        "This sign-in did not start in this browser, or it expired. Start again.",
        clearThis,
      );
    }
    if (!(await consumeLoginState(o.db, stateNonce, o.sessions.now()))) {
      return note(403, "Sign-in refused", "This sign-in was already used. Start again.", [
        ...clearThis,
      ]);
    }
    if (url.searchParams.has("error") || code === "") {
      return note(400, "Sign-in cancelled", "GitHub did not authorize the sign-in.", [
        ...clearThis,
      ]);
    }
    let who: GithubIdentity;
    try {
      who = await o.identity.verify(code, redirectUri);
    } catch {
      return note(403, "Sign-in refused", "GitHub did not accept the authorization.", [
        ...clearThis,
      ]);
    }
    const id = newSessionId();
    const { absoluteMs } = await o.sessions.lifetimes();
    const result = await completeSignIn(o.db, {
      githubUserId: who.id,
      login: who.login,
      now: o.sessions.now(),
      sessionHash: sessionHash(id),
      absoluteMs,
      // An account with no org and no invite still gets a session when the instance lets that
      // login create an org. The session holds no org, so it reaches the account ops only.
      allowNoMembership: await selfServeAllows(o.settings, o.db, who.login),
    });
    if (!result.ok) {
      o.log?.(`sign-in refused: GitHub user ${who.id} has no membership and no invite`);
      return note(
        403,
        "No access",
        "This GitHub account is not a member of any org on this instance. Ask an org admin to invite your GitHub login, then sign in again.",
        clearThis,
      );
    }
    if (o.userTokens) {
      // Best effort: without the sealed token the person is asked to sign in again when an
      // onboarding step needs GitHub, which is safe.
      try {
        if (who.tokens) await o.userTokens.save(sessionHash(id), who.tokens);
        await o.userTokens.sweep();
      } catch (e) {
        o.log?.(
          `sign-in: could not store the GitHub user token: ${e instanceof Error ? e.name : "error"}`,
        );
      }
    }
    const headers = new Headers({ location: "/", "cache-control": "no-store" });
    headers.append("set-cookie", o.sessions.setCookie(id, absoluteMs));
    for (const c of clearThis) headers.append("set-cookie", c);
    return new Response(null, { status: 303, headers });
  }

  async function current(
    req: Request,
  ): Promise<
    | { cookie: string; login: string; orgs: { slug: string; name: string; role: string }[] }
    | undefined
  > {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (!cookie) return undefined;
    const live = await o.sessions.resolve(cookie);
    if (!live) return undefined;
    const identity = await getIdentityByUserId(o.db, live.userId);
    const orgs = await listMembershipsOfUser(o.db, live.userId);
    return {
      cookie,
      login: identity?.login ?? "unknown",
      orgs: orgs.map((m) => ({ slug: m.slug, name: m.name, role: m.role })),
    };
  }

  async function home(req: Request): Promise<Response> {
    const me = await current(req);
    if (!me) {
      return page(
        200,
        "Sign in",
        `<p>Sign in with the GitHub account an org admin invited.</p>` +
          `<form method="get" action="${LOGIN_PATH}"><button class="tt-button" type="submit">Sign in with GitHub</button></form>`,
      );
    }
    const rows = me.orgs
      .map((m) => `<li><strong>${esc(m.slug)}</strong> (${esc(m.role)})</li>`)
      .join("");
    return page(
      200,
      "Signed in",
      `<p>Signed in as <strong>${esc(me.login)}</strong>.</p><ul>${rows}</ul>` +
        `<form method="post" action="${LOGOUT_PATH}"><input type="hidden" name="csrf" value="${esc(csrfToken(me.cookie))}"><button class="tt-button" type="submit">Sign out</button></form>`,
    );
  }

  // Same-origin only: no CORS header is ever added here, so only this origin's script can read the
  // CSRF token, and `no-store` keeps it out of caches.
  async function info(req: Request): Promise<Response> {
    const me = await current(req);
    const body = me
      ? { signed_in: true, github_login: me.login, orgs: me.orgs, csrf: csrfToken(me.cookie) }
      : { signed_in: false };
    return Response.json(body, {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      },
    });
  }

  async function logout(req: Request): Promise<Response> {
    // CSRF: the Origin is the configured public origin, and the form carries the session's token.
    if (!o.sessions.sameOrigin(req)) {
      return note(403, "Request refused", "Sign out from the page of this instance.");
    }
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie) {
      const form = await req.formData().catch(() => undefined);
      const given = typeof form?.get("csrf") === "string" ? (form.get("csrf") as string) : "";
      if (!given || !safeEqual(given, csrfToken(cookie))) {
        return note(403, "Request refused", "The sign-out form expired. Reload and try again.");
      }
      await o.sessions.revoke(cookie);
      // The user's GitHub token goes with the session it was bound to.
      await o.userTokens?.remove(sessionHash(cookie)).catch(() => {});
    }
    const headers = new Headers({ location: AUTH_PAGE_PATH, "cache-control": "no-store" });
    headers.append("set-cookie", o.sessions.clearCookie());
    return new Response(null, { status: 303, headers });
  }

  return {
    async handle(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const get = req.method === "GET";
      try {
        if (p === AUTH_PAGE_PATH || p === `${AUTH_PAGE_PATH}/`) {
          return get ? await home(req) : note(405, "Method not allowed", "Use GET.");
        }
        if (p === SESSION_INFO_PATH) {
          return get ? await info(req) : note(405, "Method not allowed", "Use GET.");
        }
        if (p === LOGIN_PATH)
          return get ? await start(req) : note(405, "Method not allowed", "Use GET.");
        if (p === CALLBACK_PATH) {
          return get ? await callback(req, url) : note(405, "Method not allowed", "Use GET.");
        }
        if (p === LOGOUT_PATH) {
          return req.method === "POST"
            ? await logout(req)
            : note(405, "Method not allowed", "Use the sign-out button.");
        }
        return undefined;
      } catch (e) {
        o.log?.(`sign-in error: ${e instanceof Error ? e.message : String(e)}`);
        return note(500, "Something went wrong", "An error occurred; try again.");
      }
    },
  };
}
