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
  appendEvent,
  consumeInstallationClaim,
  createInstallationClaim,
  getGithubApp,
  getInstallation,
  getInstallationClaim,
  getOrgById,
  latestAuditContaining,
} from "../db/repos";
import { esc, pageResponse } from "../pages/server-pages";
import {
  excessFlowCookies,
  flowCookieName,
  MAX_FLOW_COOKIES,
  readFlowCookies,
} from "../auth/flow-cookies";
import { KeyCache } from "../secrets/ensure-key";
import type { SecretStore } from "../secrets/store";
import type { GithubFacts } from "./api";
import { SECRET_CLIENT } from "./app-auth";
import { syncInstallation } from "./installations";
import {
  notInstallationOwnerMessage,
  ownershipUnverifiableMessage,
  proveInstallationOwnership,
} from "./ownership";

export { notInstallationOwnerMessage } from "./ownership";

export const CLAIM_PATH = "/api/v1/github/setup";
/** Where `start` points: the confirmation page (GET) and its form (POST). */
export const CLAIM_START_PATH = "/api/v1/github/claim";
// Each claim has its OWN cookies, named from a short hash of its nonce, so two claims started in one
// browser do not overwrite each other's binding (#443). The callback reads the cookie that matches
// its state's nonce, exactly. At most MAX_FLOW_COOKIES of each kind are kept; the oldest expire.
export const CLAIM_COOKIE = "ls_claim";
/** The double-submit token for the confirmation form. */
export const CSRF_COOKIE = "ls_claim_csrf";
const CLAIM_COOKIE_PREFIX = `${CLAIM_COOKIE}_`;
const CSRF_COOKIE_PREFIX = `${CSRF_COOKIE}_`;
/** The binding cookie's name for one claim. */
export const claimCookieName = (nonce: string): string =>
  flowCookieName(CLAIM_COOKIE_PREFIX, nonce);
/** The confirmation form's CSRF cookie name for one claim. */
export const claimCsrfCookieName = (nonce: string): string =>
  flowCookieName(CSRF_COOKIE_PREFIX, nonce);
const COOKIE_PATH = "/api/v1/github";
export const SECRET_CLAIM_KEY = "github-app/claim-state-key";
export const CLAIM_TTL_MS = 15 * 60_000;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export class ClaimError extends Error {
  readonly status: number;
  /** Set when the claim was identified before it was refused: a popup tells its opener. */
  readonly claimId: string | undefined;
  constructor(status: number, message: string, claimId?: string) {
    super(message);
    this.status = status;
    this.claimId = claimId;
  }
}

/**
 * A claim started for a popup carries `popup.` in front of its nonce (the nonce is random and
 * never holds a dot otherwise). The mark survives the configure-page redirect, which carries no
 * state, and needs no column. The claim id the ops show is the nonce.
 */
export const POPUP_NONCE_PREFIX = "popup.";
export const isPopupClaim = (nonce: string): boolean => nonce.startsWith(POPUP_NONCE_PREFIX);

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
  readonly #keys: KeyCache;

  constructor(o: ClaimOptions) {
    this.#o = o;
    this.#keys = new KeyCache(o.store, SECRET_CLAIM_KEY);
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /**
   * The HMAC key: created on first use with insert-if-absent, then always the value the App org's
   * secret store holds, so concurrent first uses and other processes share one key.
   */
  #key(appOrg: string): Promise<Buffer> {
    return this.#keys.get(appOrg);
  }

  /**
   * Starts a claim for `orgId` by `startedBy`. Returns a Turntable link (the confirmation page)
   * carrying the signed state. `expectedLogin`, when known, restricts who may complete it.
   */
  async start(
    orgId: string,
    startedBy: string,
    opts: { expectedLogin?: string; installationId?: string; popup?: boolean } = {},
  ): Promise<{ url: string; expiresAt: number; claimId: string }> {
    const app = await getGithubApp(this.#o.db);
    if (!app) throw new ClaimError(503, "no GitHub App is configured");
    const nonce = `${opts.popup ? POPUP_NONCE_PREFIX : ""}${randomBytes(18).toString("base64url")}`;
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
        ...(opts.installationId ? { installationId: opts.installationId } : {}),
      },
    );
    const state = `v1.${body}.${b64u(sig)}`;
    const base = this.#o.publicUrl?.trim().replace(/\/+$/, "") ?? "";
    return {
      url: `${base}${CLAIM_START_PATH}?state=${encodeURIComponent(state)}`,
      expiresAt,
      claimId: nonce,
    };
  }

  /**
   * Where a claim of `orgId` stands. A claim of another org is `undefined`, the same as one that
   * does not exist. `refused` is read back from the org's audit chain: a refusal does not spend
   * the claim (the person may retry with the right GitHub account), so it is a state of an
   * unspent claim, and the next success or the expiry replaces it.
   */
  async status(
    orgId: string,
    claimId: string,
  ): Promise<
    | {
        state: "pending" | "completed" | "expired" | "refused";
        installationId?: string;
        accountLogin?: string;
        reason?: string;
      }
    | undefined
  > {
    const claim = await getInstallationClaim(this.#o.db, claimId);
    if (!claim || claim.orgId !== orgId) return undefined;
    if (claim.usedAt !== null) {
      const inst = claim.installationId
        ? await getInstallation(this.#o.db, claim.installationId)
        : undefined;
      return {
        state: "completed",
        ...(claim.installationId ? { installationId: claim.installationId } : {}),
        ...(inst ? { accountLogin: inst.accountLogin } : {}),
      };
    }
    if (claim.expiresAt <= this.#now()) return { state: "expired" };
    const refusal = await latestAuditContaining(
      this.#o.db,
      { orgId },
      {
        op: "claim_installation",
        outcome: "error:forbidden",
        contains: `"claim_id":${JSON.stringify(claimId)}`,
        since: claim.createdAt,
      },
    );
    if (refusal) {
      let reason: string | undefined;
      try {
        const r = (JSON.parse(refusal.input) as { reason?: unknown }).reason;
        if (typeof r === "string") reason = r;
      } catch {
        reason = undefined;
      }
      return { state: "refused", ...(reason ? { reason } : {}) };
    }
    return { state: "pending" };
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

  /** Whether `given` is the form value for this token and nonce (re-reads the key once if stale). */
  async csrfOk(token: string, nonce: string, given: string): Promise<boolean> {
    const app = await getGithubApp(this.#o.db);
    if (!app) throw new ClaimError(503, "no GitHub App is configured");
    return this.#keys.verify(app.orgId, (k) =>
      safeEqual(given, b64u(createHmac("sha256", k).update(`csrf.${token}.${nonce}`).digest())),
    );
  }

  /** Expiry of the claim a cookie names, to rank cookies for the cap. Unknown ranks oldest. */
  async expiryOf(nonce: string): Promise<number> {
    const c = await getInstallationClaim(this.#o.db, nonce).catch(() => undefined);
    return c?.expiresAt ?? 0;
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
    const given = Buffer.from(sig, "base64url");
    const good = await this.#keys.verify(app.orgId, (k) => {
      const want = createHmac("sha256", k).update(`v1.${body}`).digest();
      return given.length === want.length && timingSafeEqual(given, want);
    });
    if (!good) return undefined;
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
      /** The nonces held by this browser's well-formed claim cookies (name and value agree). */
      cookieNonces?: string[];
      /** GitHub's `setup_action`: `install`, or `update` from the configure redirect. */
      action?: string;
    },
    facts: GithubFacts,
    user: UserVerifier,
  ): Promise<{ orgId: string; bound: string[]; nonce: string; popup: boolean }> {
    if (!/^\d{1,20}$/.test(q.installationId)) throw new ClaimError(400, "bad installation id");
    let st = await this.verify(q.state);
    // The configure redirect (`update`) carries no `state`. The claim is then found by the nonce in
    // the browser-binding cookie, which only the confirmation page sets. That cookie is Lax, so it
    // also rides on a link an attacker sends: the claim is therefore pinned to the installation it
    // was started for, and any other installation id is refused before an owner check or a token
    // exchange. A claim started without an installation can only finish through the signed state.
    if (!st && q.action === "update" && q.state === "") {
      for (const n of q.cookieNonces ?? []) {
        const c = await getInstallationClaim(this.#o.db, n);
        if (
          c &&
          c.usedAt === null &&
          c.expiresAt > this.#now() &&
          c.installationId !== null &&
          c.installationId === q.installationId
        ) {
          st = { o: c.orgId, p: c.startedBy, n: c.nonce, e: c.expiresAt, i: c.installationId };
          break;
        }
      }
    }
    // A signed state that names an installation only claims that one.
    if (st?.i !== undefined && st.i !== q.installationId) st = undefined;
    if (!st) throw new ClaimError(400, "this claim link is invalid or has expired; start again");
    const refuse = async (status: number, message: string, extra: object = {}): Promise<never> => {
      await this.#audit(st, "error:forbidden", {
        installation_id: q.installationId,
        reason: message,
        ...extra,
      });
      await this.#emit(st, "refused");
      throw new ClaimError(status, message, st.n);
    };
    // The browser that confirmed the claim on Turntable is the one that must finish it.
    // Exactly this claim's cookie: its name is derived from the nonce, so another claim's cookie
    // in the same browser neither helps nor blocks it.
    if (!(q.cookieNonces ?? []).some((n) => safeEqual(n, st.n))) {
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
    const verdict = await proveInstallationOwnership(this.#o.db, {
      installationId: q.installationId,
      accountType: inst.accountType,
      accountId: inst.accountId,
      claimantGithubId: gh.id,
      isOrgAdmin: () => gh.isOrgAdmin(inst.accountLogin),
    });
    if (!verdict.owns) {
      const unverifiable = verdict.reason === "ownership_unverifiable";
      return refuse(
        403,
        unverifiable
          ? ownershipUnverifiableMessage(inst.accountLogin)
          : notInstallationOwnerMessage(inst.accountLogin),
        {
          ...who,
          account: inst.accountLogin,
          account_type: inst.accountType,
          refusal: verdict.reason,
        },
      );
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
      r = await syncInstallation(this.#o.db, facts, q.installationId, {
        claimedBy: st.o,
      });
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
    await this.#emit(st, "completed");
    return { orgId: st.o, bound: r.bound, nonce: st.n, popup: isPopupClaim(st.n) };
  }

  /** Tells the org's live feed where a claim stands. Best effort, like the audit write. */
  async #emit(st: StatePayload, state: "completed" | "refused"): Promise<void> {
    try {
      await appendEvent(
        this.#o.db,
        { orgId: st.o },
        { type: "installation_claim.updated", payload: { claim_id: st.n, state } },
      );
    } catch {
      // A missed notification is not a failed claim: the state is read back with get_installation_claim.
    }
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
          input: { claim_id: st.n, started_by: st.p, ...input },
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
          // A failed call is not "not an admin": the caller tells the two apart (#573).
          if (!res.ok) throw new Error(`org membership: HTTP ${res.status}`);
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

/**
 * The page a popup claim ends on: the result for the person, and one script that tells the window
 * that opened the popup. The message goes to the instance's own origin only, never `*`, so no
 * other page can receive it, and the script is allowed by a per-response nonce (the CSP has no
 * other script source). A finished claim closes the window; a refused one stays to say why.
 */
export function popupResultPage(o: {
  status: number;
  title: string;
  message: string;
  origin: string;
  claimId: string | undefined;
  state: "completed" | "refused";
  cookies?: string[];
}): Response {
  const nonce = randomBytes(16).toString("base64url");
  const msg = JSON.stringify({
    type: "turntable.claim",
    claim_id: o.claimId ?? "",
    state: o.state,
  });
  // JSON inside a script: `<` and the line separators are escaped so no value can end the script.
  const lit = (v: string): string =>
    v.replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const script =
    o.claimId === undefined
      ? ""
      : `<script nonce="${nonce}">if(window.opener){window.opener.postMessage(${lit(msg)},${lit(JSON.stringify(o.origin))});}${
          o.state === "completed" ? "window.close();" : ""
        }</script>`;
  return pageResponse({
    status: o.status,
    title: o.title,
    body: `<p>${esc(o.message)}</p>${script}`,
    cookies: o.cookies ?? [],
    scriptNonce: nonce,
    formAction: "'none'",
  });
}

const clearClaim = (name: string): string =>
  `${name}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;
const clearCsrf = (name: string): string =>
  `${name}=; Max-Age=0; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

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
      const held = claimCookies(req);
      try {
        const r = await o.claims.complete(
          {
            installationId: id,
            state: url.searchParams.get("state") ?? "",
            ...(action ? { action } : {}),
            code: url.searchParams.get("code") ?? undefined,
            cookieNonces: held.map((c) => c.nonce),
          },
          o.facts,
          o.user,
        );
        const message = `The installation is connected${r.bound.length > 0 ? ` (${r.bound.length} repositories)` : ""}. You can close this page.`;
        // Only this claim's cookies go; a parallel claim in this browser keeps its own.
        const cookies = [
          ...(r.nonce
            ? [clearClaim(claimCookieName(r.nonce)), clearCsrf(claimCsrfCookieName(r.nonce))]
            : []),
        ];
        if (r.popup) {
          return popupResultPage({
            status: 200,
            title: "Installation connected",
            message,
            origin: o.claims.origin(req),
            claimId: r.nonce,
            state: "completed",
            cookies,
          });
        }
        return page(200, "Installation connected", message, cookies);
      } catch (e) {
        if (e instanceof ClaimError) {
          o.log?.(`installation claim refused: ${e.message}`);
          if (e.claimId !== undefined && isPopupClaim(e.claimId)) {
            return popupResultPage({
              status: e.status,
              title: "Could not connect the installation",
              message: e.message,
              origin: o.claims.origin(req),
              claimId: e.claimId,
              state: "refused",
            });
          }
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

const claimCookies = (req: Request) => readFlowCookies(req, CLAIM_COOKIE_PREFIX);

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
        `${claimCsrfCookieName(d.nonce)}=${token}; Max-Age=${CLAIM_TTL_MS / 1000}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`,
        // A browser keeps at most MAX_FLOW_COOKIES confirmation tokens; the earliest are expired.
        ...excessFlowCookies(readFlowCookies(req, CSRF_COOKIE_PREFIX), MAX_FLOW_COOKIES)
          .filter((n) => n !== claimCsrfCookieName(d.nonce))
          .map(clearCsrf),
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
  const token = cookieValue(req, claimCsrfCookieName(d.nonce));
  if (!token || !csrf || !(await claims.csrfOk(token, d.nonce, csrf))) {
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
    `${claimCookieName(d.nonce)}=${d.nonce}; Max-Age=${CLAIM_TTL_MS / 1000}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`,
  );
  headers.append("set-cookie", clearCsrf(claimCsrfCookieName(d.nonce)));
  // Cap the browser's claim cookies: expire the claims that end soonest, past MAX_FLOW_COOKIES.
  const held = readFlowCookies(req, CLAIM_COOKIE_PREFIX).filter((c) => c.nonce !== d.nonce);
  const ranks = new Map<string, number>();
  for (const c of held) ranks.set(c.nonce, await claims.expiryOf(c.nonce));
  for (const name of excessFlowCookies(held, MAX_FLOW_COOKIES, (n) => ranks.get(n) ?? 0)) {
    headers.append("set-cookie", clearClaim(name));
  }
  return new Response(null, { status: 303, headers });
}
