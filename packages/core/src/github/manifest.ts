// GitHub App manifest flow: `turntable github-app create` serves a loopback page whose form POSTs
// the App manifest to GitHub. GitHub redirects back to a loopback callback with a one-time code,
// which is exchanged for the App's credentials. Those go straight into the encrypted store and
// are never printed.
import { type SafeFetch, safeFetch } from "@turntable/net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db";
import {
  appendAudit,
  getGithubApp,
  removeOtherGithubApps,
  retireAppInstallations,
  setGithubApp,
} from "../db/repos";
import { esc, pageHeaders, pageResponse, renderPage, servePageAsset } from "../pages/server-pages";
import type { SecretStore } from "../secrets/store";
import { SECRET_APP_ID, SECRET_CLIENT, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "./app-auth";
import { WEBHOOK_PATH } from "./webhook";

export interface ManifestOptions {
  name: string;
  /** Public base URL of this instance. */
  url: string;
  redirectUrl: string;
  /**
   * The hosted claim flow is on: GitHub sends the installer to our setup URL with a user
   * authorization code, which is how an org proves it owns the installation it claims.
   */
  claimFlow?: boolean;
}

/**
 * Least privilege: checks write (the only write, used later to report results); contents,
 * metadata and pull requests read. `installation` and `installation_repositories` events are sent
 * to every App without subscribing, so they are not listed (GitHub rejects unknown default_events).
 */
export function buildManifest(o: ManifestOptions): Record<string, unknown> {
  const base = o.url.replace(/\/+$/, "");
  return {
    name: o.name,
    url: base,
    hook_attributes: { url: `${base}${WEBHOOK_PATH}`, active: true },
    redirect_url: o.redirectUrl,
    // A private App installs only on its owner's account. The claim flow exists for other accounts
    // to install it, and an unclaimed installation is ignored, so it is public only then.
    public: o.claimFlow === true,
    default_permissions: {
      checks: "write",
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    },
    default_events: ["push", "pull_request", "check_run"],
    ...(o.claimFlow
      ? {
          setup_url: `${base}/api/v1/github/setup`,
          request_oauth_on_install: true,
          callback_urls: [`${base}/api/v1/github/setup`],
        }
      : {}),
  };
}

/** The page with the form. `ghOrg` creates the App under an organization instead of a user. */
export function manifestPage(
  manifest: Record<string, unknown>,
  state: string,
  ghOrg?: string,
): string {
  const action = ghOrg
    ? `https://github.com/organizations/${encodeURIComponent(ghOrg)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return renderPage({
    title: "Create the Turntable GitHub App",
    body: `<p>This sends the App manifest below to GitHub. You approve it there; GitHub then returns here.</p>
<form method="post" action="${esc(action)}?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button class="tt-button" type="submit">Create the App on GitHub</button>
</form>
<pre><code>${esc(JSON.stringify(manifest, null, 2))}</code></pre>`,
  });
}

export interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  owner: { login: string };
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
}

/** Exchanges the one-time code. No credentials are involved: the code is the proof. */
export async function convertManifest(
  code: string,
  fetchImpl: SafeFetch = safeFetch,
  apiBase = "https://api.github.com",
): Promise<ManifestConversion> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) throw new Error("malformed manifest code");
  const res = await fetchImpl(`${apiBase}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "turntable" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`manifest conversion failed: HTTP ${res.status}`);
  const j = (await res.json()) as Partial<ManifestConversion>;
  if (
    typeof j.id !== "number" ||
    !j.slug ||
    !j.name ||
    !j.owner?.login ||
    !j.html_url ||
    !j.client_id ||
    !j.client_secret ||
    !j.webhook_secret ||
    !j.pem
  ) {
    throw new Error("manifest conversion: incomplete response");
  }
  return j as ManifestConversion;
}

/** Why storeApp refused to write: an App is there that this call may not touch. */
export class AppStateError extends Error {
  readonly reason: "app_exists" | "other_org";
  constructor(reason: "app_exists" | "other_org") {
    super(
      reason === "app_exists" ? "an App already exists" : "the existing App belongs to another org",
    );
    this.reason = reason;
  }
}

/**
 * Stores the App record and its four secrets, in ONE transaction: concurrent writers cannot mix
 * one App's key with another's id, and a failure leaves what was there. Nothing returned here
 * contains a secret. `existing` is re-checked inside the transaction (the caller's earlier check
 * may be stale): "refuse" throws when any App exists; "replace" accepts none or one owned by the
 * same org, and drops it (and retires its installations). Omitted: no check (the local CLI).
 */
export async function storeApp(
  db: Db,
  store: SecretStore,
  orgId: string,
  c: ManifestConversion,
  o: {
    /** Who is recorded in the audit entry. Default: the local CLI. */
    principal?: { kind: string; id: string };
    existing?: "refuse" | "replace";
  } = {},
): Promise<{
  appId: string;
  slug: string;
  htmlUrl: string;
  replaced: string[];
  retired: { installations: number; repos: number };
}> {
  return db.transaction(async (tx) => {
    if (o.existing) {
      const there = await getGithubApp(tx);
      if (there && o.existing === "refuse") throw new AppStateError("app_exists");
      if (there && there.orgId !== orgId) throw new AppStateError("other_org");
    }
    // The store writes through the root handle, which joins this transaction.
    await store.set(orgId, SECRET_APP_ID, String(c.id));
    await store.set(orgId, SECRET_PRIVATE_KEY, c.pem);
    await store.set(orgId, SECRET_WEBHOOK, c.webhook_secret);
    await store.set(orgId, SECRET_CLIENT, c.client_secret);
    await setGithubApp(
      tx,
      { orgId },
      {
        appId: String(c.id),
        slug: c.slug,
        name: c.name,
        ownerLogin: c.owner.login,
        htmlUrl: c.html_url,
        clientId: c.client_id,
      },
    );
    const replaced =
      o.existing === "replace" ? await removeOtherGithubApps(tx, { orgId }, String(c.id)) : [];
    const retired = await retireAppInstallations(tx, replaced);
    await appendAudit(
      tx,
      { orgId },
      {
        principalKind: o.principal?.kind ?? "cli",
        principalId: o.principal?.id ?? "local",
        op: replaced.length > 0 ? "github_app_replace" : "github_app_create",
        effect: "write",
        outcome: "ok",
        input: {
          app_id: String(c.id),
          slug: c.slug,
          owner: c.owner.login,
          ...(replaced.length > 0
            ? {
                replaced_app_ids: replaced,
                retired_installations: retired.installations,
                unbound_repositories: retired.repos,
              }
            : {}),
        },
      },
    );
    return { appId: String(c.id), slug: c.slug, htmlUrl: c.html_url, replaced, retired };
  });
}

export interface ManifestFlowOptions {
  db: Db;
  store: SecretStore;
  /** The Turntable org that will own the App and its installations. */
  orgId: string;
  name: string;
  url: string;
  ghOrg?: string | undefined;
  /** Loopback port; 0 picks a free one. */
  port?: number;
  fetch?: SafeFetch;
  apiBase?: string;
}

export interface ManifestFlow {
  /** Open this in a browser. */
  pageUrl: string;
  /** Resolves with the created App (no secrets) after the callback, or rejects. */
  done: Promise<{ appId: string; slug: string; htmlUrl: string }>;
  stop(): void;
}

/** Serves the form and the callback on 127.0.0.1 until one callback succeeds (or fails). */
export function startManifestFlow(o: ManifestFlowOptions): ManifestFlow {
  const state = randomBytes(24).toString("hex");
  let resolveDone!: (v: { appId: string; slug: string; htmlUrl: string }) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<{ appId: string; slug: string; htmlUrl: string }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  let used = false;
  /** The form page carries its own document; the result pages are a title and a message. */
  const doc = (status: number, document: string): Response =>
    new Response(document, { status, headers: pageHeaders({ formAction: "https://github.com" }) });
  const note = (status: number, title: string, body: string): Response =>
    pageResponse({ status, title, body, formAction: "https://github.com" });

  let bound = 0;
  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // Only our own loopback origin: a page elsewhere cannot drive this through DNS rebinding.
      const host = req.headers.get("host") ?? "";
      if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) {
        return new Response("bad host", { status: 400 });
      }
      const asset = servePageAsset(req);
      if (asset) return asset;
      const redirect = `http://127.0.0.1:${bound}/callback`;
      if (req.method === "GET" && url.pathname === "/") {
        return doc(
          200,
          manifestPage(
            buildManifest({ name: o.name, url: o.url, redirectUrl: redirect }),
            state,
            o.ghOrg,
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/callback") {
        const given = Buffer.from(url.searchParams.get("state") ?? "");
        const want = Buffer.from(state);
        if (used || given.length !== want.length || !timingSafeEqual(given, want)) {
          return note(
            400,
            "Invalid link",
            "<p>Invalid or reused state. Start again with turntable github-app create.</p>",
          );
        }
        used = true;
        try {
          const conv = await convertManifest(
            url.searchParams.get("code") ?? "",
            o.fetch,
            o.apiBase,
          );
          const app = await storeApp(o.db, o.store, o.orgId, conv);
          resolveDone({ appId: app.appId, slug: app.slug, htmlUrl: app.htmlUrl });
          return note(
            200,
            "App created",
            `<p>The App <strong>${esc(app.slug)}</strong> was created and its credentials were stored. You can close this tab.</p>`,
          );
        } catch (e) {
          rejectDone(e);
          return note(
            500,
            "Could not create the App",
            "<p>Could not finish creating the App. See the terminal.</p>",
          );
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  bound = server.port as number;
  done.finally(() => setTimeout(() => void server.stop(true), 200)).catch(() => {});
  return {
    pageUrl: `http://127.0.0.1:${bound}/`,
    done,
    stop: () => void server.stop(true),
  };
}
