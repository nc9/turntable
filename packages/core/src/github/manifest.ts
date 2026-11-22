// GitHub App manifest flow: `longshore github-app create` serves a loopback page whose form POSTs
// the App manifest to GitHub. GitHub redirects back to a loopback callback with a one-time code,
// which is exchanged for the App's credentials. Those go straight into the encrypted store and
// are never printed.
import { type SafeFetch, safeFetch } from "@longshore/net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db";
import { setGithubApp } from "../db/repos";
import type { SecretStore } from "../secrets/store";
import { SECRET_APP_ID, SECRET_CLIENT, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "./app-auth";
import { WEBHOOK_PATH } from "./webhook";

export interface ManifestOptions {
  name: string;
  /** Public base URL of this instance. */
  url: string;
  redirectUrl: string;
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
    public: false,
    default_permissions: {
      checks: "write",
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    },
    default_events: ["push", "pull_request", "check_run"],
  };
}

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The page with the form. `ghOrg` creates the App under an organization instead of a user. */
export function manifestPage(
  manifest: Record<string, unknown>,
  state: string,
  ghOrg?: string,
): string {
  const action = ghOrg
    ? `https://github.com/organizations/${encodeURIComponent(ghOrg)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create the Longshore GitHub App</title></head>
<body>
<h1>Create the Longshore GitHub App</h1>
<p>This sends the App manifest below to GitHub. You approve it there; GitHub then returns here.</p>
<form method="post" action="${escapeHtml(action)}?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Create the App on GitHub</button>
</form>
<pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre>
</body></html>
`;
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
    headers: { accept: "application/vnd.github+json", "user-agent": "longshore" },
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

/** Stores the App record and its four secrets. Nothing returned here contains a secret. */
export async function storeApp(
  db: Db,
  store: SecretStore,
  orgId: string,
  c: ManifestConversion,
): Promise<{ appId: string; slug: string; htmlUrl: string }> {
  await store.set(orgId, SECRET_APP_ID, String(c.id));
  await store.set(orgId, SECRET_PRIVATE_KEY, c.pem);
  await store.set(orgId, SECRET_WEBHOOK, c.webhook_secret);
  await store.set(orgId, SECRET_CLIENT, c.client_secret);
  await setGithubApp(
    db,
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
  return { appId: String(c.id), slug: c.slug, htmlUrl: c.html_url };
}

export interface ManifestFlowOptions {
  db: Db;
  store: SecretStore;
  /** The Longshore org that will own the App and its installations. */
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
  const html = (status: number, body: string): Response =>
    new Response(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com",
      },
    });

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
      const redirect = `http://127.0.0.1:${bound}/callback`;
      if (req.method === "GET" && url.pathname === "/") {
        return html(
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
          return html(
            400,
            "<p>Invalid or reused state. Start again with longshore github-app create.</p>",
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
          resolveDone(app);
          return html(
            200,
            `<p>The App <b>${escapeHtml(app.slug)}</b> was created and its credentials were stored. You can close this tab.</p>`,
          );
        } catch (e) {
          rejectDone(e);
          return html(500, "<p>Could not finish creating the App. See the terminal.</p>");
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
