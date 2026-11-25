import { type SafeFetch, safeFetch } from "@turntable/net";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db";
import { appendAudit, getGithubApp, setPreviousSecretExpiry } from "../db/repos";
import type { SecretStore as SecretSeal } from "../secrets/store";
import type { AppAuth } from "./app-auth";
import { SECRET_WEBHOOK, SECRET_WEBHOOK_PREVIOUS } from "./app-auth";

export const DEFAULT_OVERLAP_MS = 24 * 3_600_000;

/** The longest overlap the web and REST rotation allows, and its default. */
export const WEB_OVERLAP_MAX_MS = 3_600_000;

/**
 * Seals a new webhook secret under the current master key and keeps the old one as `previous`
 * until `now + overlapMs`. Returns the new secret (the caller decides who sees it). It does not
 * touch GitHub. A second rotation inside the window replaces `previous` with the secret it
 * rotates away from, so at most two secrets ever verify; an expired `previous` is simply
 * overwritten here, and the webhook handler ignores it from `previousSecretExpiresAt` on.
 */
export async function sealRotatedWebhookSecret(
  db: Db,
  store: SecretSeal,
  opts: { overlapMs: number; now?: () => number },
): Promise<{ secret: string; overlapUntil: number; orgId: string; appId: string; old: string }> {
  const app = await getGithubApp(db);
  if (!app) throw new Error("no GitHub App is configured");
  const old = await store.get(app.orgId, SECRET_WEBHOOK);
  if (!old) throw new Error("the current webhook secret is missing from the secret store");
  const until = (opts.now ?? Date.now)() + opts.overlapMs;
  const fresh = randomBytes(32).toString("hex");
  await store.set(app.orgId, SECRET_WEBHOOK_PREVIOUS, old);
  await setPreviousSecretExpiry(db, app.appId, until);
  await store.set(app.orgId, SECRET_WEBHOOK, fresh);
  return { secret: fresh, overlapUntil: until, orgId: app.orgId, appId: app.appId, old };
}

/**
 * Rotates the webhook secret with an overlap window. The old secret becomes `previous` and keeps
 * verifying until the window ends; the new one is pushed to GitHub (PATCH /app/hook/config). If
 * GitHub refuses, local state is restored. The secret is never printed.
 */
export async function rotateWebhookSecret(
  db: Db,
  store: SecretSeal,
  auth: AppAuth,
  opts: {
    overlapMs?: number;
    now?: () => number;
    fetch?: SafeFetch;
    /** Append the CLI audit row (default). The op path is audited by the dispatcher instead. */
    audit?: boolean;
  } = {},
): Promise<{ overlapUntil: number; fingerprint: string }> {
  const {
    secret: fresh,
    overlapUntil: until,
    orgId,
    appId,
    old,
  } = await sealRotatedWebhookSecret(db, store, {
    overlapMs: opts.overlapMs ?? DEFAULT_OVERLAP_MS,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const app = { orgId, appId };
  try {
    const res = await (opts.fetch ?? safeFetch)(`${auth.apiBase}/app/hook/config`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${await auth.appJwt()}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "turntable",
      },
      body: JSON.stringify({ secret: fresh }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GitHub refused the new webhook secret: HTTP ${res.status}`);
  } catch (e) {
    await store.set(app.orgId, SECRET_WEBHOOK, old);
    await setPreviousSecretExpiry(db, app.appId, null);
    throw e;
  }
  if (opts.audit !== false) {
    await appendAudit(
      db,
      { orgId: app.orgId },
      {
        principalKind: "cli",
        principalId: "local",
        op: "github_webhook_secret_rotate",
        effect: "write",
        outcome: "ok",
        input: { app_id: app.appId, overlap_until: until },
      },
    );
  }
  const fingerprint = `SHA256:${createHash("sha256").update(fresh).digest("base64").replace(/=+$/, "")}`;
  return { overlapUntil: until, fingerprint };
}
