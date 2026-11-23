// The App manifest flow for an instance with no shell (Railway and the like). `turntable
// github-app create` serves a loopback page on the machine that holds the data dir, so a hosted
// instance could never get its App credentials. This serves the same flow from the instance:
//
//  1. An operator opens GET /api/v1/instance/github-app/manifest (a small form) and submits it, or
//     POSTs the same fields with `Authorization: Bearer <setup token>`. The setup token is a
//     secret the operator generated; only its sha256 is configured
//     (TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256), like the bootstrap token.
//  2. The reply is a page that posts the App manifest to GitHub. Its `state` is an HMAC over (org,
//     nonce, expiry, rotate flag, requested name and owner, a MAC of a browser-binding secret), the
//     nonce is stored and single use, and a HttpOnly cookie holds the secret itself, so only the
//     browser that started the flow can finish it.
//  3. GitHub sends the browser to GET /api/v1/github/app-callback with a one-time `code` and the
//     state. The code is exchanged for the App's credentials, which go straight into the sealed
//     secret store. They are never printed, logged or put in a response.
//  4. Once an App exists, a second create is refused unless the request asks to replace it. The
//     route closes after the first success (until restart) and after a few hours from boot.
//
// Every step is audited in the owning org's chain; a refusal before an org is known goes to the
// system chain through the throttled failure path.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type SafeFetch, safeFetch } from "@turntable/net";
import { auditFailure } from "../audit/failures";
import type { Db } from "../db";
import {
  appendAudit,
  consumeManifestNonce,
  createManifestNonce,
  getGithubApp,
  getOrgBySlug,
  hasOpenManifestNonce,
} from "../db/repos";
import { hashToken } from "../ops/tokens";
import type { SecretStore } from "../secrets/store";
import { signAppJwt } from "./app-auth";
import {
  AppStateError,
  buildManifest,
  convertManifest,
  manifestPage,
  storeApp,
  type ManifestConversion,
} from "./manifest";
import { clientAddress, parseTrustedProxies, type TrustedProxies } from "./trusted-proxies";
import { WEBHOOK_PATH } from "./webhook";

export const MANIFEST_PATH = "/api/v1/instance/github-app/manifest";
export const MANIFEST_CALLBACK_PATH = "/api/v1/github/app-callback";
export const MANIFEST_COOKIE = "ls_manifest";
export const MANIFEST_TTL_MS = 15 * 60_000;
export const SECRET_MANIFEST_KEY = "github-app/manifest-state-key";
const COOKIE_PATH = "/api/v1/github";
/** Failed setup-token attempts allowed per minute, per client address. */
export const SETUP_FAILURES_PER_MINUTE = 10;
/** The most a start request may send. The form is a handful of short fields. */
export const MAX_BODY_BYTES = 4096;
/** How long after boot the route stays open, unless an App is created first. */
export const DEFAULT_OPEN_MS = 6 * 3600_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,33}$/;
const GH_ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** Shapes of what the state carries, checked before any key is looked up. */
const ORG_ID = /^[0-9A-Z]{26}$/;
const NONCE = /^[A-Za-z0-9_-]{24}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

interface StatePayload {
  /** Owning org id. */
  o: string;
  /** Nonce. */
  n: string;
  /** Expiry, ms. */
  e: number;
  /** The request asked to replace an existing App. */
  r: boolean;
  /**
   * MAC of the browser-binding secret. The cookie holds the secret itself, which never appears in
   * a URL, so someone who sees the state (history, referer, GitHub) cannot finish the flow.
   */
  k: string;
  /** The GitHub organization the App was requested under, when one was. */
  g?: string;
  /** The App name that was requested. */
  m: string;
}

export interface HostedManifestOptions {
  db: Db;
  store: SecretStore;
  /** The server's public base URL: the manifest's URLs and the callback are relative to it. */
  publicUrl: string;
  /** sha256 (hex) of the setup token. */
  setupTokenSha256: string;
  /** The installation claim flow is on: the manifest then carries its setup URL. */
  claimFlow?: boolean;
  fetch?: SafeFetch;
  apiBase?: string;
  now?: () => number;
  log?: (line: string) => void;
  /** Called after an App is replaced, so cached installation tokens of the old one are dropped. */
  onReplaced?: () => void;
  /** The proxies in front of the server, for keying the failure limiter on the real client. */
  trustedProxies?: TrustedProxies;
  /**
   * The slugs of the orgs that may own the App. On a hosted instance this is the system or
   * bootstrap org, never a customer org (an App's owner holds every installation of it). Absent:
   * any org (a single-tenant instance).
   */
  ownerOrgSlugs?: readonly string[];
  /** How long after start up the route stays open. Default 6 hours. */
  openForMs?: number;
}

export interface HostedManifestHandler {
  /** `peer` is the socket's remote address, used to key the failure limiter. */
  handle(req: Request, peer?: string): Promise<Response | undefined>;
}

const esc = (v: string): string =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function headers(formAction: string, cookies: string[] = []): Headers {
  const h = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

const shell = (
  status: number,
  title: string,
  inner: string,
  o: { formAction?: string; cookies?: string[] } = {},
): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto"><h1>${esc(title)}</h1>${inner}</body>`,
    { status, headers: headers(o.formAction ?? "'none'", o.cookies) },
  );

const note = (status: number, title: string, message: string, cookies: string[] = []): Response =>
  shell(status, title, `<p>${esc(message)}</p>`, { cookies });

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The form of a request, read with a cap. "too_large" when it is over; undefined when unreadable. */
type Form = Awaited<ReturnType<Response["formData"]>>;
async function readForm(req: Request): Promise<Form | undefined | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "too_large";
  if (!req.body) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return "too_large";
    }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks), {
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  })
    .formData()
    .catch(() => undefined);
}

export function createHostedManifestHandler(o: HostedManifestOptions): HostedManifestHandler {
  const hash = o.setupTokenSha256.trim().toLowerCase();
  if (!SHA256_HEX.test(hash)) {
    throw new Error("TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256 must be 64 hex characters (a sha256)");
  }
  const base = o.publicUrl.trim().replace(/\/+$/, "");
  const u = new URL(base);
  const secure = u.protocol === "https:";
  const callback = `${base}${MANIFEST_CALLBACK_PATH}`;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const cookieAttrs = `Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const clearCookie = `${MANIFEST_COOKIE}=; Max-Age=0; ${cookieAttrs}`;
  const trusted = o.trustedProxies ?? parseTrustedProxies(undefined);
  const openUntil = now() + (o.openForMs ?? DEFAULT_OPEN_MS);
  /** Set after an App is created: the route stays shut until the process restarts. */
  let done = false;
  const isOpen = (): boolean => !done && now() < openUntil;
  /** Starting and finishing run one at a time in this process. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const closedPage = (): Response =>
    note(
      410,
      "Closed",
      done
        ? "The App was created. This page stays closed until the instance restarts."
        : "This page closes a few hours after the instance starts. Restart the instance to open it again.",
    );
  /** Failed setup-token attempts per client in the current minute. A correct token is never counted or refused. */
  const failures = new Map<string, { windowStart: number; count: number }>();
  const MAX_TRACKED = 10_000;
  const overLimit = (client: string): boolean => {
    const f = failures.get(client);
    return (
      f !== undefined && now() - f.windowStart < 60_000 && f.count >= SETUP_FAILURES_PER_MINUTE
    );
  };
  const noteFailure = (client: string): void => {
    const t = now();
    const f = failures.get(client);
    if (!f || t - f.windowStart >= 60_000) {
      if (failures.size >= MAX_TRACKED) failures.clear();
      failures.set(client, { windowStart: t, count: 1 });
    } else f.count += 1;
  };

  /** The state key: created on first start, sealed in the owning org's store. */
  const keyFor = async (orgId: string, create: boolean): Promise<Buffer | undefined> => {
    let k = await o.store.get(orgId, SECRET_MANIFEST_KEY);
    if (k === undefined) {
      if (!create) return undefined;
      k = randomBytes(32).toString("base64url");
      await o.store.set(orgId, SECRET_MANIFEST_KEY, k);
    }
    return Buffer.from(k, "base64url");
  };

  const sign = (key: Buffer, body: string): string =>
    b64u(createHmac("sha256", key).update(`m1.${body}`).digest());

  /** The MAC of the browser-binding secret, bound to the nonce. Only this goes in the state. */
  const bindMac = (key: Buffer, secret: string, nonce: string): string =>
    b64u(createHmac("sha256", key).update(`m1.bind.${secret}.${nonce}`).digest());

  /** The state's payload when its signature and expiry hold; undefined for anything else. */
  const verify = async (state: string): Promise<StatePayload | undefined> => {
    const parts = state.split(".");
    if (parts.length !== 3 || parts[0] !== "m1") return undefined;
    const [, body, sig] = parts as [string, string, string];
    let p: StatePayload;
    try {
      p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    } catch {
      return undefined;
    }
    if (
      typeof p.o !== "string" ||
      !ORG_ID.test(p.o) ||
      typeof p.n !== "string" ||
      !NONCE.test(p.n) ||
      typeof p.e !== "number" ||
      typeof p.r !== "boolean" ||
      typeof p.k !== "string" ||
      !MAC.test(p.k) ||
      typeof p.m !== "string" ||
      !APP_NAME.test(p.m) ||
      (p.g !== undefined && (typeof p.g !== "string" || !GH_ORG.test(p.g)))
    )
      return undefined;
    // The key is the claimed org's; nothing in the body is trusted until the MAC holds.
    const key = await keyFor(p.o, false);
    if (!key || !safeEqual(sig, sign(key, body))) return undefined;
    return p.e > now() ? p : undefined;
  };

  const audit = async (
    orgId: string,
    op: string,
    outcome: string,
    input: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await appendAudit(
        o.db,
        { orgId },
        {
          principalKind: "setup-token",
          principalId: "env",
          op,
          effect: "write",
          outcome,
          input,
        },
      );
    } catch {
      // A failed audit write does not undo a flow step; the database state stands.
    }
  };

  const formPage = (): Response =>
    !isOpen()
      ? closedPage()
      : shell(
          200,
          "Create the Turntable GitHub App",
          `<p>Sends the App manifest to GitHub, where you approve it. The App's credentials are stored on this instance and never shown.</p>
<form method="post" action="${MANIFEST_PATH}" autocomplete="off">
<p><label>Setup token<br><input type="password" name="setup_token" required autocomplete="off" size="48"></label></p>
<p><label>Turntable org that will own the App (its slug)<br><input name="org" required pattern="[a-z0-9][a-z0-9-]{0,62}" size="24"${o.ownerOrgSlugs?.[0] ? ` value="${esc(o.ownerOrgSlugs[0])}"` : ""}></label></p>
<p><label>App name<br><input name="name" value="Turntable" maxlength="34" size="24"></label></p>
<p><label>Create it under this GitHub organization (blank for your own account)<br><input name="gh_org" maxlength="39" size="24"></label></p>
<p><label><input type="checkbox" name="rotate" value="1"> Replace the App this instance already has</label></p>
<button type="submit">Continue</button>
</form>`,
          { formAction: "'self'" },
        );

  const start = async (req: Request, peer: string | undefined): Promise<Response> => {
    // The body is capped before it is parsed, and before the token is looked at.
    const form = await readForm(req);
    if (form === "too_large") return note(413, "Request too large", "That request is too big.");
    if (!isOpen()) return closedPage();
    const field = (name: string): string => {
      const v = form?.get(name);
      return typeof v === "string" ? v.trim() : "";
    };
    const bearer = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    const token = bearer ?? field("setup_token");
    // The token is checked first: a correct one is never throttled, so noise from elsewhere
    // cannot lock the operator out. Only failures are counted, per client address.
    if (!token || !safeEqual(hashToken(token), hash)) {
      const client = clientAddress(req.headers, peer, trusted);
      if (overLimit(client)) return note(429, "Too many attempts", "Wait a minute and try again.");
      noteFailure(client);
      await auditFailure(
        o.db,
        {
          principalKind: "setup-token",
          principalId: "unknown",
          op: "github_app_manifest_start",
          outcome: "error:unauthenticated",
          source: `setup-token:${client}`,
        },
        now,
      );
      return note(401, "Not authorised", "The setup token is missing or wrong.");
    }

    const slug = field("org");
    const name = field("name") || "Turntable";
    const ghOrg = field("gh_org");
    const rotate = field("rotate") === "1" || field("rotate") === "true";
    if (!ORG_SLUG.test(slug)) return note(400, "Bad request", "Give the org's slug.");
    if (!APP_NAME.test(name))
      return note(400, "Bad request", "The App name is 1 to 34 letters, digits, spaces, . _ -.");
    if (ghOrg !== "" && !GH_ORG.test(ghOrg))
      return note(400, "Bad request", "That is not a GitHub organization name.");
    if (o.ownerOrgSlugs && !o.ownerOrgSlugs.includes(slug))
      return note(
        403,
        "Not allowed",
        `The App can be owned by ${o.ownerOrgSlugs.join(" or ")} only, never a customer org.`,
      );
    const org = await getOrgBySlug(o.db, slug);
    if (!org)
      return note(404, "No such org", "Create the org first (the bootstrap org, or an operator).");

    return serial(async () => {
      const existing = await getGithubApp(o.db);
      if (existing && !rotate) {
        await audit(org.id, "github_app_manifest_start", "error:app_exists", {
          existing_app_id: existing.appId,
        });
        return note(
          409,
          "An App already exists",
          `This instance already has the GitHub App ${existing.slug}. To replace it, submit again with "Replace the App" ticked. Installations of the old App stop working.`,
        );
      }
      if (existing && existing.orgId !== org.id) {
        await audit(org.id, "github_app_manifest_start", "error:other_org", {
          existing_app_id: existing.appId,
        });
        return note(409, "An App already exists", "The existing App belongs to another org.");
      }
      // One flow at a time: a second start while one is unexpired and unfinished could race it.
      if (await hasOpenManifestNonce(o.db, now())) {
        await audit(org.id, "github_app_manifest_start", "error:flow_in_progress", {});
        return note(
          409,
          "A flow is already in progress",
          "Finish the one that was started, or wait up to 15 minutes for it to expire.",
        );
      }

      const key = (await keyFor(org.id, true))!;
      const nonce = randomBytes(18).toString("base64url");
      // The cookie holds this secret; the state holds only its MAC.
      const bindSecret = randomBytes(24).toString("base64url");
      const expiresAt = now() + MANIFEST_TTL_MS;
      const body = b64u(
        JSON.stringify({
          o: org.id,
          n: nonce,
          e: expiresAt,
          r: rotate,
          k: bindMac(key, bindSecret, nonce),
          m: name,
          ...(ghOrg ? { g: ghOrg } : {}),
        } satisfies StatePayload),
      );
      const state = `m1.${body}.${sign(key, body)}`;
      await createManifestNonce(
        o.db,
        { orgId: org.id },
        { nonce, startedBy: "setup-token", expiresAt },
      );
      await audit(org.id, "github_app_manifest_start", "ok", {
        name,
        ...(ghOrg ? { gh_org: ghOrg } : {}),
        rotate,
      });
      // The page is built by manifestPage (it posts the manifest to github.com); only its headers
      // differ here: no inline script, the form may go to GitHub only, and the binding cookie.
      return new Response(manifestPage(requestedManifest(name), state, ghOrg || undefined), {
        status: 200,
        headers: headers("https://github.com", [
          `${MANIFEST_COOKIE}=${bindSecret}; Max-Age=${MANIFEST_TTL_MS / 1000}; ${cookieAttrs}`,
        ]),
      });
    });
  };

  const requestedManifest = (name: string) =>
    buildManifest({
      name,
      url: base,
      redirectUrl: callback,
      ...(o.claimFlow ? { claimFlow: true } : {}),
    });

  const getFromGithub = async (path: string, c: ManifestConversion): Promise<unknown> => {
    const res = await (o.fetch ?? safeFetch)(`${o.apiBase ?? "https://api.github.com"}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${signAppJwt(String(c.id), c.pem, now())}`,
        "user-agent": "turntable",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error("unreadable");
    return res.json();
  };

  /**
   * Why a converted App is not the one this flow asked for, or undefined when it is. The state
   * (signed) carries the requested name and owner; the App must match them, its page must be on
   * github.com, and, read back with its own credentials, its permissions and events must be no
   * broader than the manifest's and its webhook must point at this instance. Class names only.
   */
  const appMismatch = async (
    c: ManifestConversion,
    st: StatePayload,
  ): Promise<string | undefined> => {
    if (c.html_url !== `https://github.com/apps/${c.slug}`) return "page_not_on_github";
    if (st.g && c.owner.login.toLowerCase() !== st.g.toLowerCase()) return "owner_differs";
    if (c.name.trim().toLowerCase() !== st.m.trim().toLowerCase()) return "name_differs";
    try {
      const requested = requestedManifest(st.m) as {
        default_permissions: Record<string, string>;
        default_events: string[];
      };
      const app = (await getFromGithub("/app", c)) as {
        owner?: { login?: unknown };
        permissions?: Record<string, unknown>;
        events?: unknown;
      };
      if (app.owner?.login !== c.owner.login) return "owner_differs";
      for (const [k, v] of Object.entries(app.permissions ?? {})) {
        const want = requested.default_permissions[k];
        const ok = want !== undefined && (v === want || (v === "read" && want === "write"));
        if (!ok) return "permissions_broader";
      }
      if (
        Array.isArray(app.events) &&
        !app.events.every((e) => typeof e === "string" && requested.default_events.includes(e))
      )
        return "events_broader";
      const hook = (await getFromGithub("/app/hook/config", c)) as { url?: unknown };
      if (hook.url !== `${base}${WEBHOOK_PATH}`) return "webhook_elsewhere";
    } catch {
      return "unreadable";
    }
    return undefined;
  };

  const finish = async (req: Request, url: URL): Promise<Response> => {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const st = await verify(state);
    if (!st) {
      await auditFailure(
        o.db,
        {
          principalKind: "setup-token",
          principalId: "unknown",
          op: "github_app_manifest_callback",
          outcome: "error:bad_state",
          source: "manifest-callback",
        },
        now,
      );
      return note(400, "Link not valid", "This link is invalid or has expired. Start again.");
    }
    const refuse = async (status: number, message: string, outcome: string): Promise<Response> => {
      await audit(st.o, "github_app_manifest_callback", `error:${outcome}`, {});
      log(`github app manifest callback refused: ${outcome}`);
      return note(status, "Could not create the App", message);
    };
    // The browser that started the flow is the one that must finish it.
    const cookie = cookieValue(req, MANIFEST_COOKIE);
    const key = await keyFor(st.o, false);
    if (!cookie || !key || !safeEqual(bindMac(key, cookie, st.n), st.k)) {
      return refuse(
        403,
        "Open the page from this instance and finish in the same browser. Start again.",
        "no_binding",
      );
    }
    return serial(async () => {
      const existing = await getGithubApp(o.db);
      if (existing && !st.r) {
        return refuse(
          409,
          "An App already exists. Start again and ask to replace it.",
          "app_exists",
        );
      }
      if (existing && existing.orgId !== st.o) {
        return refuse(409, "The existing App belongs to another org.", "other_org");
      }
      // Consumed before the exchange, so a link is used once even if GitHub or the store fails.
      if (!(await consumeManifestNonce(o.db, st.n, now()))) {
        return refuse(400, "This link was already used or has expired. Start again.", "nonce_used");
      }
      const fail = async (outcome: string): Promise<Response> => {
        await audit(st.o, "github_app_manifest_callback", `error:${outcome}`, {});
        log(`github app manifest failed: ${outcome}`);
        return note(
          502,
          "Could not create the App",
          "GitHub did not complete the manifest, it returned an App that does not match this request, or the credentials could not be stored. Nothing was stored. Start again.",
          [clearCookie],
        );
      };
      // GitHub's replies are never logged or audited: they can carry the credentials.
      let conv: ManifestConversion;
      try {
        conv = await convertManifest(code, o.fetch ?? safeFetch, o.apiBase);
      } catch {
        return fail("exchange_failed");
      }
      // Nothing is sealed until the App is shown to be the one this flow asked for: a code from
      // someone else's App (a stolen link, a tampered form) would otherwise put their credentials here.
      const mismatch = await appMismatch(conv, st);
      if (mismatch) {
        await audit(st.o, "github_app_manifest_callback", "error:app_mismatch", {
          reason: mismatch,
          app_id: String(conv.id),
        });
        log(`github app manifest refused: ${mismatch}`);
        return fail("app_mismatch");
      }
      let app;
      try {
        app = await storeApp(o.db, o.store, st.o, conv, {
          principal: { kind: "setup-token", id: "env" },
          existing: st.r ? "replace" : "refuse",
        });
      } catch (e) {
        if (e instanceof AppStateError) return refuse(409, e.message, e.reason);
        return fail("store_failed");
      }
      done = true;
      if (app.replaced.length > 0) o.onReplaced?.();
      log(`github app ${app.slug} (id ${app.appId}) created through the hosted manifest flow`);
      const retired =
        app.replaced.length > 0
          ? `<p>The old App was replaced. ${app.retired.installations} installation(s) of it were marked deleted and ${app.retired.repos} repository binding(s) were removed. Install the new App again to bind them.</p>`
          : "";
      return shell(
        200,
        "The GitHub App was created",
        `<p>The App <strong>${esc(app.slug)}</strong> was created and its credentials are stored on this instance. They are not shown.</p>${retired}<p>Next, install it on your repositories: <a href="${esc(app.htmlUrl)}/installations/new" rel="noreferrer">${esc(app.htmlUrl)}/installations/new</a></p><p>This page is now closed until the instance restarts. Remove <code>TURNTABLE_GITHUB_APP_SETUP_TOKEN_SHA256</code> from the instance's variables.</p>`,
        { cookies: [clearCookie] },
      );
    });
  };

  return {
    async handle(req, peer) {
      const url = new URL(req.url);
      if (url.pathname === MANIFEST_PATH) {
        if (req.method === "GET") return formPage();
        if (req.method === "POST") return start(req, peer);
        return note(405, "Method not allowed", "Use GET for the form or POST to submit it.");
      }
      if (url.pathname === MANIFEST_CALLBACK_PATH) {
        if (req.method !== "GET")
          return note(405, "Method not allowed", "GitHub sends the browser here with GET.");
        return finish(req, url);
      }
      return undefined;
    },
  };
}
