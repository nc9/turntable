import { type SafeFetch, safeFetch } from "@turntable/net";
import { randomBytes } from "node:crypto";
import type { Db } from "../db";
import { appendAudit, getGithubApp, setPreviousSecretExpiry } from "../db/repos";
import type { SecretStore as SecretSeal } from "../secrets/store";
import type { AppAuth } from "./app-auth";
import { SECRET_WEBHOOK, SECRET_WEBHOOK_PREVIOUS } from "./app-auth";

export const DEFAULT_OVERLAP_MS = 24 * 3_600_000;

/**
 * Rotates the webhook secret with an overlap window. The old secret becomes `previous` and keeps
 * verifying until the window ends; the new one is pushed to GitHub (PATCH /app/hook/config). If
 * GitHub refuses, local state is restored. The secret is never printed.
 */
export async function rotateWebhookSecret(
  db: Db,
  store: SecretSeal,
  auth: AppAuth,
  opts: { overlapMs?: number; now?: () => number; fetch?: SafeFetch } = {},
): Promise<{ overlapUntil: number }> {
  const app = await getGithubApp(db);
  if (!app) throw new Error("no GitHub App is configured");
  const old = await store.get(app.orgId, SECRET_WEBHOOK);
  if (!old) throw new Error("the current webhook secret is missing from the secret store");
  const until = (opts.now ?? Date.now)() + (opts.overlapMs ?? DEFAULT_OVERLAP_MS);
  const fresh = randomBytes(32).toString("hex");

  await store.set(app.orgId, SECRET_WEBHOOK_PREVIOUS, old);
  await setPreviousSecretExpiry(db, app.appId, until);
  await store.set(app.orgId, SECRET_WEBHOOK, fresh);
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
  return { overlapUntil: until };
}
