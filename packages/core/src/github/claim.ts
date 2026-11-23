// The installation claim flow for a hosted, multi-tenant instance.
//
// Today every installation of the App maps to the org that owns the App. Hosted, an org must
// claim its own installation, and the claim must be provably made by someone signed in to that
// org who really controls the GitHub installation:
//
//  1. A signed-in principal of the org asks for a claim link (`start_installation_claim`). The
//     link is GitHub's install page with a `state`: an HMAC over (org, who, nonce, expiry), with
//     the nonce also stored, single use, in `installation_claims`.
//  2. GitHub sends the browser to the App's setup URL (`/api/v1/github/setup`) with
//     `installation_id`, `state` and, when the App asks for user authorization during install,
//     an OAuth `code`. The state binds the org. It does NOT prove the installation_id, which is
//     just a query parameter anyone can edit.
//  3. So the callback exchanges the code for the user's token and asks GitHub which installations
//     THAT user can access. Access is not ownership (any member of an org sees its installations),
//     so the user must also OWN it: for an organization account, an active admin of that org (read
//     with the user's token); for a personal account, the account is the user. It then re-fetches
//     the installation with the App's own credentials (it must be our App) and only then binds it
//     to the org in the state, consuming the nonce, and audits who claimed it.
//     An installation made without the claim link is claimed from its configure page: the claim
//     names the installation, the link sends the user to its configure page, and the App's
//     "Redirect on update" setting makes GitHub call the same setup URL with `setup_action=update`
//     (and no `state`). The cookie nonce then finds the claim; all other proofs are unchanged and
//     an installation held by another org is never moved.
//  4. The link handed out by `start` points at Turntable, not GitHub. Opening it shows which
//     Turntable org will receive the installation and asks for a confirmation; confirming sets a
//     short-lived HttpOnly cookie holding the nonce and redirects to GitHub. The callback needs
//     that cookie, so a link forwarded to another browser (or one opened by a victim's browser
//     without the confirmation) cannot complete, and an attacker cannot finish a flow the victim
//     started.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type SafeFetch, safeFetch } from "@turntable/net";
import type { Db } from "../db";
import {
  appendAudit,
  consumeInstallationClaim,
  createInstallationClaim,
  getGithubApp,
  getInstallation,
  getInstallationClaim,
  getOrgById,
} from "../db/repos";
import { esc, pageResponse } from "../pages/server-pages";
import type { SecretStore } from "../secrets/store";
import type { GithubFacts } from "./api";
import { SECRET_CLIENT } from "./app-auth";
import { syncInstallation } from "./installations";

export const CLAIM_PATH = "/api/v1/github/setup";
/** Where `start` points: the confirmation page (GET) and its form (POST). */
export const CLAIM_START_PATH = "/api/v1/github/claim";
export const CLAIM_COOKIE = "ls_claim";
/** The double-submit token for the confirmation form. */
export const CSRF_COOKIE = "ls_claim_csrf";
const COOKIE_PATH = "/api/v1/github";
export const SECRET_CLAIM_KEY = "github-app/claim-state-key";
export const CLAIM_TTL_MS = 15 * 60_000;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export class ClaimError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** An installation a GitHub user can reach, with the account it is on. */
export interface UserInstallation {
  id: string;
  accountId: string;
  accountLogin: string;
  /** `Organization` or `User`. */
  accountType: string;
}

/** A GitHub user proven by an OAuth code: who they are, what they reach and whether they admin. */
export interface ClaimUser {
  id: string;
  login: string;
  installations: UserInstallation[];
  /** Active admin of the organization, read with the user's own token. */
  isOrgAdmin(org: string): Promise<boolean>;
}

export interface UserVerifier {
  verify(code: string): Promise<ClaimUser>;
}

export interface ClaimOptions {
  db: Db;
  store: SecretStore;
  /** The server's public base URL; the start link is relative to it (a path when unset). */
  publicUrl?: string | undefined;
  now?: () => number;
}

interface StatePayload {
  /** org id */
  o: string;
  /** started by */
  p: string;
  /** nonce */
  n: string;
  /** expiry, ms */
  e: number;
  /** the installation to configure, when the claim was started for an existing one */
  i?: string;
}

export class InstallationClaims {
  readonly #o: ClaimOptions;

  constructor(o: ClaimOptions) {
    this.#o = o;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** The HMAC key, created on first use and kept sealed in the App org's secret store. */
  async #key(appOrg: string): Promise<Buffer> {
    let k = await this.#o.store.get(appOrg, SECRET_CLAIM_KEY);
    if (k === undefined) {
      k = randomBytes(32).toString("base64url");
      await this.#o.store.set(appOrg, SECRET_CLAIM_KEY, k);
    }
    return Buffer.from(k, "base64url");
  }

  /**
   * Starts a claim for `orgId` by `startedBy`. Returns a Turntable link (the confirmation page)
   * carrying the signed state. `expectedLogin`, when known, restricts who may complete it.
   */
  async start(
    orgId: string,
    startedBy: string,
    opts: { expectedLogin?: string; installationId?: string } = {},
  ): Promise<{ url: string; expiresAt: number }> {
    const app = await getGithubApp(this.#o.db);
    if (!app) throw new ClaimError(503, "no GitHub App is configured");
    const nonce = randomBytes(18).toString("base64url");
    const expiresAt = this.#now() + CLAIM_TTL_MS;
    const body = b64u(
      JSON.stringify({
        o: orgId,
        p: startedBy,
        n: nonce,
        e: expiresAt,
        ...(opts.installationId ? { i: opts.installationId } : {}),
      } satisfies StatePayload),
    );
    const sig = createHmac("sha256", await this.#key(app.orgId))
      .update(`v1.${body}`)
      .digest();
    await createInstallationClaim(
      this.#o.db,
      { orgId },
      {
        nonce,
        startedBy,
        expiresAt,
        ...(opts.expectedLogin ? { expectedLogin: opts.expectedLogin } : {}),
      },
    );
    const state = `v1.${body}.${b64u(sig)}`;
    const base = this.#o.publicUrl?.trim().replace(/\/+$/, "") ?? "";
    return { url: `${base}${CLAIM_START_PATH}?state=${encodeURIComponent(state)}`, expiresAt };
  }

  /** The origin the confirmation form must be submitted from (the public URL's, when set). */
  origin(req: Request): string {
    const base = this.#o.publicUrl?.trim();
    try {
      return new URL(base || req.url).origin;
    } catch {
      return new URL(req.url).origin;
    }
  }

  /** The form's anti-CSRF value: an HMAC of the cookie token and the claim's nonce. */
  async csrfMac(token: string, nonce: string): Promise<string> {
    const app = await getGithubApp(this.#o.db);
    if (!app) throw new ClaimError(503, "no GitHub App is configured");
    return b64u(
      createHmac("sha256", await this.#key(app.orgId))
        .update(`csrf.${token}.${nonce}`)
        .digest(),
    );
  }

  /**
   * GitHub's page for a verified state: the install page, or the configure page of an existing
   * installation when the claim names one. GitHub sends no `state` back from the configure page;
   * the callback then relies on the browser-binding cookie alone.
   */
  async githubUrl(state: string, facts?: GithubFacts): Promise<string> {
    const app = await getGithubApp(this.#o.db);
    if (!app) throw new ClaimError(503, "no GitHub App is configured");
    const st = await this.verify(state);
    if (st?.i !== undefined) {
      const inst = await facts?.getInstallation(st.i).catch(() => undefined);
      if (!inst || inst.appId !== app.appId) {
        throw new ClaimError(404, "that installation does not exist for this App");
      }
      const login = encodeURIComponent(inst.account.login);
      return inst.account.type === "Organization"
        ? `https://github.com/organizations/${login}/settings/installations/${encodeURIComponent(inst.id)}`
        : `https://github.com/settings/installations/${encodeURIComponent(inst.id)}`;
    }
    return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** What the confirmation page shows: the org that will receive the installation. */
  async describe(state: string): Promise<{ orgName: string; nonce: string } | undefined> {
    const st = await this.verify(state);
    if (!st) return undefined;
    const claim = await getInstallationClaim(this.#o.db, st.n);
    if (!claim || claim.usedAt !== null || claim.orgId !== st.o) return undefined;
    const org = await getOrgById(this.#o.db, st.o);
    return org ? { orgName: org.slug, nonce: st.n } : undefined;
  }

  /** The payload of a state whose signature and expiry hold. Undefined for anything else. */
  async verify(state: string): Promise<StatePayload | undefined> {
    const app = await getGithubApp(this.#o.db);
    if (!app) return undefined;
    const parts = state.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return undefined;
    const [, body, sig] = parts as [string, string, string];
    const want = createHmac("sha256", await this.#key(app.orgId))
      .update(`v1.${body}`)
      .digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
      if (typeof p.o !== "string" || typeof p.p !== "string" || typeof p.n !== "string")
        return undefined;
      if (typeof p.e !== "number" || p.e <= this.#now()) return undefined;
      if (p.i !== undefined && typeof p.i !== "string") return undefined;
      return p;
    } catch {
      return undefined;
    }
  }

  /**
   * The setup callback. Verifies the state and the browser cookie, proves the user owns the
   * installation, re-fetches it from GitHub and binds it to the org in the state. Every outcome is
   * audited in that org's chain. Throws ClaimError with the status to send.
   */
  async complete(
    q: {
      installationId: string;
      state: string;
      code: string | undefined;
      cookieNonce?: string;
      /** GitHub's `setup_action`: `install`, or `update` from the configure redirect. */
      action?: string;
    },
    facts: GithubFacts,
    user: UserVerifier,
  ): Promise<{ orgId: string; bound: string[] }> {
    if (!/^\d{1,20}$/.test(q.installationId)) throw new ClaimError(400, "bad installation id");
    let st = await this.verify(q.state);
    // The configure redirect (`update`) carries no `state`. The claim is then found by the nonce in
    // the browser-binding cookie, which only the confirmation page sets; every other proof is the same.
    if (!st && q.action === "update" && q.state === "" && q.cookieNonce) {
      const c = await getInstallationClaim(this.#o.db, q.cookieNonce);
      if (c && c.usedAt === null && c.expiresAt > this.#now()) {
        st = { o: c.orgId, p: c.startedBy, n: c.nonce, e: c.expiresAt };
      }
    }
    if (!st) throw new ClaimError(400, "this claim link is invalid or has expired; start again");
    const refuse = async (status: number, message: string, extra: object = {}): Promise<never> => {
      await this.#audit(st, "error:forbidden", {
        installation_id: q.installationId,
        reason: message,
        ...extra,
      });
      throw new ClaimError(status, message);
    };
    // The browser that confirmed the claim on Turntable is the one that must finish it.
    if (!q.cookieNonce || !safeEqual(q.cookieNonce, st.n)) {
      return refuse(
        403,
        "open the claim link from this Turntable instance and confirm it in the same browser",
      );
    }
    if (!q.code) {
      throw new ClaimError(
        400,
        "GitHub did not send an authorization code: the App must request user authorization during installation",
      );
    }
    let gh: ClaimUser;
    try {
      gh = await user.verify(q.code);
    } catch {
      throw new ClaimError(403, "GitHub did not accept the authorization code");
    }
    const who = { github_user_id: gh.id, github_login: gh.login };
    const claim0 = await getInstallationClaim(this.#o.db, st.n);
    if (claim0?.expectedLogin && claim0.expectedLogin.toLowerCase() !== gh.login.toLowerCase()) {
      return refuse(403, "this claim was started for a different GitHub user", who);
    }
    const inst = gh.installations.find((i) => i.id === q.installationId);
    if (!inst) return refuse(403, "you do not have access to that installation", who);
    // Access is not ownership: an org's installation is visible to every member.
    let owns = false;
    if (inst.accountType === "Organization") {
      try {
        owns = await gh.isOrgAdmin(inst.accountLogin);
      } catch {
        owns = false;
      }
    } else if (inst.accountType === "User") {
      owns = inst.accountId === gh.id;
    }
    if (!owns) {
      return refuse(403, "only an owner of the GitHub account can connect its installation", {
        ...who,
        account: inst.accountLogin,
        account_type: inst.accountType,
      });
    }
    // An installation held by another org is never moved.
    const held = await getInstallation(this.#o.db, q.installationId);
    if (held && held.orgId !== st.o) {
      return refuse(409, "that installation is already connected to another org", who);
    }
    // Consumed only now, after the user proved ownership, so a bad attempt cannot burn the link.
    const claim = await consumeInstallationClaim(this.#o.db, st.n, q.installationId, this.#now(), {
      userId: gh.id,
      login: gh.login,
    });
    if (!claim || claim.orgId !== st.o) {
      throw new ClaimError(400, "this claim link was already used or has expired; start again");
    }
    let r;
    try {
      r = await syncInstallation(this.#o.db, facts, q.installationId, { claimedBy: st.o });
    } catch (e) {
      throw new ClaimError(409, e instanceof Error ? e.message : "could not bind the installation");
    }
    if (r.outcome === "unknown" || r.outcome === "deleted") {
      throw new ClaimError(404, "GitHub does not know that installation");
    }
    await this.#audit(st, "ok", {
      installation_id: q.installationId,
      account: inst.accountLogin,
      account_type: inst.accountType,
      repositories: r.bound.length,
      ...who,
    });
    return { orgId: st.o, bound: r.bound };
  }

  async #audit(st: StatePayload, outcome: string, input: Record<string, unknown>): Promise<void> {
    try {
      await appendAudit(
        this.#o.db,
        { orgId: st.o },
        {
          principalKind: "system",
          principalId: "installation-claim",
          op: "claim_installation",
          effect: "write",
          outcome,
          input: { started_by: st.p, ...input },
        },
      );
    } catch {
      // The claim itself is not undone by a failed audit write; the bind is in the database.
    }
  }
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The OAuth exchange, through the guarded client. The client secret never leaves the store. */
export function githubUserVerifier(o: {
  db: Db;
  store: SecretStore;
  fetch?: SafeFetch;
  oauthBase?: string;
  apiBase?: string;
}): UserVerifier {
  const f = o.fetch ?? safeFetch;
  const oauth = o.oauthBase ?? "https://github.com";
  const api = o.apiBase ?? "https://api.github.com";
  const headers = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "turntable",
  });
  return {
    async verify(code) {
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
        body: JSON.stringify({ client_id: app.clientId, client_secret: secret, code }),
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
      });
      const tj = (await tok.json().catch(() => ({}))) as { access_token?: unknown };
      if (!tok.ok || typeof tj.access_token !== "string") throw new Error("code not accepted");
      const token = tj.access_token;
      const me = await f(`${api}/user`, {
        headers: headers(token),
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
      });
      if (!me.ok) throw new Error(`user: HTTP ${me.status}`);
      const mj = (await me.json()) as { id?: number; login?: string };
      if (typeof mj.id !== "number" || typeof mj.login !== "string") throw new Error("bad user");
      const installations: UserInstallation[] = [];
      for (let page = 1; page <= 20; page += 1) {
        const res = await f(`${api}/user/installations?per_page=100&page=${page}`, {
          headers: headers(token),
          timeoutMs: 15_000,
          maxBytes: 1024 * 1024,
        });
        if (!res.ok) throw new Error(`user installations: HTTP ${res.status}`);
        const j = (await res.json()) as {
          installations?: {
            id: number;
            app_id?: number;
            account?: { id?: number; login?: string; type?: string };
          }[];
        };
        for (const i of j.installations ?? []) {
          if (String(i.app_id ?? app.appId) !== app.appId) continue;
          installations.push({
            id: String(i.id),
            accountId: String(i.account?.id ?? ""),
            accountLogin: i.account?.login ?? "",
            accountType: i.account?.type ?? "",
          });
        }
        if ((j.installations ?? []).length < 100) break;
      }
      return {
        id: String(mj.id),
        login: mj.login,
        installations,
        async isOrgAdmin(org) {
          if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) return false;
          const res = await f(`${api}/user/memberships/orgs/${encodeURIComponent(org)}`, {
            headers: headers(token),
            timeoutMs: 15_000,
            maxBytes: 64 * 1024,
          });
          if (!res.ok) return false;
          const j = (await res.json()) as { role?: string; state?: string };
          return j.role === "admin" && j.state === "active";
        },
      };
    },
  };
}

const shell = (status: number, title: string, body: string, cookies: string[] = []): Response =>
  pageResponse({ status, title, body, cookies, formAction: "'self' https://github.com" });

const page = (status: number, title: string, message: string, cookies: string[] = []): Response =>
  shell(status, title, `<p>${esc(message)}</p>`, cookies);

const CLEAR = [
  `${CLAIM_COOKIE}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`,
  `${CSRF_COOKIE}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`,
];

export interface ClaimHandler {
  handle(req: Request): Promise<Response | undefined>;
}

export function createClaimHandler(o: {
  claims: InstallationClaims;
  facts: GithubFacts;
  user: UserVerifier;
  log?: (line: string) => void;
}): ClaimHandler {
  return {
    async handle(req) {
      const url = new URL(req.url);
      if (url.pathname === CLAIM_START_PATH) return await startPage(o.claims, o.facts, req, url);
      if (url.pathname !== CLAIM_PATH) return undefined;
      if (req.method !== "GET")
        return page(405, "Method not allowed", "Use the link GitHub sent you to.");
      const action = url.searchParams.get("setup_action");
      const id = url.searchParams.get("installation_id");
      // `request`: the install needs an org owner's approval first. Nothing to bind yet.
      if (action === "request" || id === null) {
        return page(
          202,
          "Waiting for approval",
          "GitHub will send you back here once the installation is approved.",
        );
      }
      try {
        const r = await o.claims.complete(
          {
            installationId: id,
            state: url.searchParams.get("state") ?? "",
            ...(action ? { action } : {}),
            code: url.searchParams.get("code") ?? undefined,
            ...(cookieNonce(req) ? { cookieNonce: cookieNonce(req) as string } : {}),
          },
          o.facts,
          o.user,
        );
        return page(
          200,
          "Installation connected",
          `The installation is connected${r.bound.length > 0 ? ` (${r.bound.length} repositories)` : ""}. You can close this page.`,
          CLEAR,
        );
      } catch (e) {
        if (e instanceof ClaimError) {
          o.log?.(`installation claim refused: ${e.message}`);
          return page(e.status, "Could not connect the installation", e.message);
        }
        o.log?.(`installation claim failed: ${e instanceof Error ? e.message : String(e)}`);
        return page(500, "Could not connect the installation", "An error occurred; try again.");
      }
    },
  };
}

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const cookieNonce = (req: Request): string | undefined => cookieValue(req, CLAIM_COOKIE);

/**
 * The confirmation page and its form. GET names the org that will receive the installation and
 * asks for a click; POST (the click) sets the browser-binding cookie and sends the browser to
 * GitHub. Both need a valid, unused state.
 */
async function startPage(
  claims: InstallationClaims,
  facts: GithubFacts,
  req: Request,
  url: URL,
): Promise<Response> {
  const gone = () =>
    page(
      400,
      "Claim link not valid",
      "This claim link is invalid, expired or already used. Start again.",
    );
  if (req.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    const d = await claims.describe(state);
    if (!d) return gone();
    // Double submit: a random token in a Strict cookie, and its HMAC (with the nonce) in the form.
    const token = randomBytes(24).toString("base64url");
    const mac = await claims.csrfMac(token, d.nonce);
    return shell(
      200,
      "Connect a GitHub installation",
      `<p>You are about to connect a GitHub installation to the Turntable org <strong>${esc(d.orgName)}</strong>.</p>` +
        `<p>Only continue if you started this from that org. You will sign in to GitHub next, and only an owner of the GitHub account can complete it.</p>` +
        `<form method="post" action="${CLAIM_START_PATH}"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="csrf" value="${esc(mac)}"><button class="tt-button" type="submit">Continue to GitHub</button></form>`,
      [
        `${CSRF_COOKIE}=${token}; Max-Age=${CLAIM_TTL_MS / 1000}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`,
      ],
    );
  }
  if (req.method !== "POST") return page(405, "Method not allowed", "Use the link you were given.");
  // Only a form served by this instance may submit: another site's page can POST here, but the
  // browser says so (Sec-Fetch-Site, Origin). With neither header, refuse.
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const sameOrigin =
    site !== null ? site === "same-origin" : origin !== null && origin === claims.origin(req);
  if (!sameOrigin)
    return page(403, "Request refused", "Open the claim link on this instance and confirm there.");
  const form = await req.formData().catch(() => undefined);
  const state = typeof form?.get("state") === "string" ? (form.get("state") as string) : "";
  const csrf = typeof form?.get("csrf") === "string" ? (form.get("csrf") as string) : "";
  const d = await claims.describe(state);
  if (!d) return gone();
  const token = cookieValue(req, CSRF_COOKIE);
  if (!token || !csrf || !safeEqual(csrf, await claims.csrfMac(token, d.nonce))) {
    return page(
      403,
      "Request refused",
      "The confirmation expired or did not come from this page. Open the link again.",
    );
  }
  let target: string;
  try {
    target = await claims.githubUrl(state, facts);
  } catch (e) {
    if (e instanceof ClaimError) return page(e.status, "Claim link not valid", e.message);
    throw e;
  }
  const headers = new Headers({ location: target, "cache-control": "no-store" });
  // The binding cookie must reach the callback, a navigation that starts on github.com, so it is
  // Lax: Strict cookies are not sent on a cross-site-initiated navigation and the flow would never
  // complete. The CSRF token above is Strict because it only travels same-site.
  headers.append(
    "set-cookie",
    `${CLAIM_COOKIE}=${d.nonce}; Max-Age=${CLAIM_TTL_MS / 1000}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`,
  );
  headers.append("set-cookie", CLEAR[1] as string);
  return new Response(null, { status: 303, headers });
}
