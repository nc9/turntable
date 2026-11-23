// The App manifest flow for an instance with no shell (Railway and the like). `longshore
// github-app create` serves a loopback page on the machine that holds the data dir, so a hosted
// instance could never get its App credentials. This serves the same flow from the instance:
//
//  1. An operator opens GET /api/v1/instance/github-app/manifest (a small form) and submits it, or
//     POSTs the same fields with `Authorization: Bearer <setup token>`. The setup token is a
//     secret the operator generated; only its sha256 is configured
//     (LONGSHORE_GITHUB_APP_SETUP_TOKEN_SHA256), like the bootstrap token.
//  2. The reply is a page that posts the App manifest to GitHub. Its `state` is an HMAC over (org,
//     nonce, expiry, rotate flag), the nonce is stored and single use, and a HttpOnly cookie holds
//     the nonce, so only the browser that started the flow can finish it.
//  3. GitHub sends the browser to GET /api/v1/github/app-callback with a one-time `code` and the
//     state. The code is exchanged for the App's credentials, which go straight into the sealed
//     secret store. They are never printed, logged or put in a response.
//  4. Once an App exists, a second create is refused unless the request asks to replace it.
//
// Every step is audited in the owning org's chain; a refusal before an org is known goes to the
// system chain through the throttled failure path.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type SafeFetch, safeFetch } from "@longshore/net";
import { auditFailure } from "../audit/failures";
import type { Db } from "../db";
import {
  appendAudit,
  consumeManifestNonce,
  createManifestNonce,
  getGithubApp,
  getOrgBySlug,
} from "../db/repos";
import { hashToken } from "../ops/tokens";
import type { SecretStore } from "../secrets/store";
import { buildManifest, convertManifest, manifestPage, storeApp } from "./manifest";

export const MANIFEST_PATH = "/api/v1/instance/github-app/manifest";
export const MANIFEST_CALLBACK_PATH = "/api/v1/github/app-callback";
export const MANIFEST_COOKIE = "ls_manifest";
export const MANIFEST_TTL_MS = 15 * 60_000;
export const SECRET_MANIFEST_KEY = "github-app/manifest-state-key";
const COOKIE_PATH = "/api/v1/github";
/** Failed setup-token attempts allowed per minute, for the whole instance. */
export const SETUP_FAILURES_PER_MINUTE = 10;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,33}$/;
const GH_ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

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
}

export interface HostedManifestHandler {
  handle(req: Request): Promise<Response | undefined>;
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

export function createHostedManifestHandler(o: HostedManifestOptions): HostedManifestHandler {
  const hash = o.setupTokenSha256.trim().toLowerCase();
  if (!SHA256_HEX.test(hash)) {
    throw new Error("LONGSHORE_GITHUB_APP_SETUP_TOKEN_SHA256 must be 64 hex characters (a sha256)");
  }
  const base = o.publicUrl.trim().replace(/\/+$/, "");
  const u = new URL(base);
  const secure = u.protocol === "https:";
  const callback = `${base}${MANIFEST_CALLBACK_PATH}`;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const cookieAttrs = `Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const clearCookie = `${MANIFEST_COOKIE}=; Max-Age=0; ${cookieAttrs}`;
  let failWindow = 0;
  let failCount = 0;

  /** Setup-token attempts are bounded for the whole instance: the token is high entropy, this only stops noise. */
  const tooManyFailures = (): boolean => {
    const t = now();
    if (t - failWindow >= 60_000) {
      failWindow = t;
      failCount = 0;
    }
    return failCount >= SETUP_FAILURES_PER_MINUTE;
  };
  const noteFailure = (): void => {
    const t = now();
    if (t - failWindow >= 60_000) {
      failWindow = t;
      failCount = 0;
    }
    failCount += 1;
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
      typeof p.n !== "string" ||
      typeof p.e !== "number" ||
      typeof p.r !== "boolean"
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
    shell(
      200,
      "Create the Longshore GitHub App",
      `<p>Sends the App manifest to GitHub, where you approve it. The App's credentials are stored on this instance and never shown.</p>
<form method="post" action="${MANIFEST_PATH}" autocomplete="off">
<p><label>Setup token<br><input type="password" name="setup_token" required autocomplete="off" size="48"></label></p>
<p><label>Longshore org that will own the App (its slug)<br><input name="org" required pattern="[a-z0-9][a-z0-9-]{0,62}" size="24"></label></p>
<p><label>App name<br><input name="name" value="Longshore" maxlength="34" size="24"></label></p>
<p><label>Create it under this GitHub organization (blank for your own account)<br><input name="gh_org" maxlength="39" size="24"></label></p>
<p><label><input type="checkbox" name="rotate" value="1"> Replace the App this instance already has</label></p>
<button type="submit">Continue</button>
</form>`,
      { formAction: "'self'" },
    );

  const start = async (req: Request): Promise<Response> => {
    const form = await req.formData().catch(() => undefined);
    const field = (name: string): string => {
      const v = form?.get(name);
      return typeof v === "string" ? v.trim() : "";
    };
    const bearer = /^Bearer +(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    const token = bearer ?? field("setup_token");
    if (tooManyFailures()) return note(429, "Too many attempts", "Wait a minute and try again.");
    if (!token || !safeEqual(hashToken(token), hash)) {
      noteFailure();
      await auditFailure(
        o.db,
        {
          principalKind: "setup-token",
          principalId: "unknown",
          op: "github_app_manifest_start",
          outcome: "error:unauthenticated",
          source: "setup-token",
        },
        now,
      );
      return note(401, "Not authorised", "The setup token is missing or wrong.");
    }

    const slug = field("org");
    const name = field("name") || "Longshore";
    const ghOrg = field("gh_org");
    const rotate = field("rotate") === "1" || field("rotate") === "true";
    if (!ORG_SLUG.test(slug)) return note(400, "Bad request", "Give the org's slug.");
    if (!APP_NAME.test(name))
      return note(400, "Bad request", "The App name is 1 to 34 letters, digits, spaces, . _ -.");
    if (ghOrg !== "" && !GH_ORG.test(ghOrg))
      return note(400, "Bad request", "That is not a GitHub organization name.");
    const org = await getOrgBySlug(o.db, slug);
    if (!org)
      return note(404, "No such org", "Create the org first (the bootstrap org, or an operator).");

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

    const key = (await keyFor(org.id, true))!;
    const nonce = randomBytes(18).toString("base64url");
    const expiresAt = now() + MANIFEST_TTL_MS;
    const body = b64u(
      JSON.stringify({ o: org.id, n: nonce, e: expiresAt, r: rotate } satisfies StatePayload),
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
    const manifest = buildManifest({
      name,
      url: base,
      redirectUrl: callback,
      ...(o.claimFlow ? { claimFlow: true } : {}),
    });
    // The page is built by manifestPage (it posts the manifest to github.com); only its headers
    // differ here: no inline script, the form may go to GitHub only, and the binding cookie.
    return new Response(manifestPage(manifest, state, ghOrg || undefined), {
      status: 200,
      headers: headers("https://github.com", [
        `${MANIFEST_COOKIE}=${nonce}; Max-Age=${MANIFEST_TTL_MS / 1000}; ${cookieAttrs}`,
      ]),
    });
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
    if (!cookie || !safeEqual(cookie, st.n)) {
      return refuse(
        403,
        "Open the page from this instance and finish in the same browser. Start again.",
        "no_binding",
      );
    }
    const existing = await getGithubApp(o.db);
    if (existing && !st.r) {
      return refuse(409, "An App already exists. Start again and ask to replace it.", "app_exists");
    }
    if (existing && existing.orgId !== st.o) {
      return refuse(409, "The existing App belongs to another org.", "other_org");
    }
    // Consumed before the exchange, so a link is used once even if GitHub or the store fails.
    if (!(await consumeManifestNonce(o.db, st.n, now()))) {
      return refuse(400, "This link was already used or has expired. Start again.", "nonce_used");
    }
    try {
      const conv = await convertManifest(code, o.fetch ?? safeFetch, o.apiBase);
      const app = await storeApp(o.db, o.store, st.o, conv, {
        principal: { kind: "setup-token", id: "env" },
        replace: existing !== undefined,
      });
      if (app.replaced.length > 0) o.onReplaced?.();
      log(`github app ${app.slug} (id ${app.appId}) created through the hosted manifest flow`);
      return shell(
        200,
        "The GitHub App was created",
        `<p>The App <strong>${esc(app.slug)}</strong> was created and its credentials are stored on this instance. They are not shown.</p><p>Next, install it on your repositories: <a href="${esc(app.htmlUrl)}/installations/new" rel="noreferrer">${esc(app.htmlUrl)}/installations/new</a></p><p>Then remove <code>LONGSHORE_GITHUB_APP_SETUP_TOKEN_SHA256</code> from the instance's variables.</p>`,
        { cookies: [clearCookie] },
      );
    } catch (e) {
      // GitHub's reply is not logged: it can carry the credentials on a partial failure.
      await audit(st.o, "github_app_manifest_callback", "error:conversion_failed", {
        reason: e instanceof Error ? e.message.slice(0, 200) : "unknown",
      });
      log("github app manifest conversion failed");
      return note(
        502,
        "Could not create the App",
        "GitHub did not complete the manifest, or the credentials could not be stored. Start again.",
        [clearCookie],
      );
    }
  };

  return {
    async handle(req) {
      const url = new URL(req.url);
      if (url.pathname === MANIFEST_PATH) {
        if (req.method === "GET") return formPage();
        if (req.method === "POST") return start(req);
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
