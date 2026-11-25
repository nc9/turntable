// Rotating the GitHub App's webhook secret and private key without a shell (#586). A signed-in
// owner of the operator org does it with a fresh passkey step-up (see ../step-up.ts). Neither
// value is returned, logged, evented or audited except the new webhook secret, which is in the
// response of ONE call; the private key is only ever uploaded.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import { getGithubApp, type GithubApp } from "../../db/repos";
import { SECRET_PRIVATE_KEY, signAppJwt } from "../../github/app-auth";
import { sealRotatedWebhookSecret, WEB_OVERLAP_MAX_MS } from "../../github/rotation";
import { iso } from "../common";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";

const fingerprint = (bytes: Buffer | string): string =>
  `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;

export const rotateInput = z.object({
  overlap_minutes: z
    .int()
    .min(1)
    .max(WEB_OVERLAP_MAX_MS / 60_000)
    .default(60)
    .describe("How long the previous secret also verifies, in minutes (1 to 60, default 60)."),
});
export const replaceInput = z.object({
  private_key: z.string().min(1).max(16_384).describe("The new private key, PEM."),
});

/**
 * Only a signed-in OWNER of the operator org (the org that owns the GitHub App), with the fresh
 * passkey step-up the dispatcher already verified for exactly this input. A `tti_` token, an org
 * token, a non-owner member and an owner of any other org are all refused.
 */
async function requireOperatorOwner(ctx: OpContext): Promise<GithubApp> {
  const p = ctx.principal;
  if (p.kind !== "session" || p.role !== "owner") {
    throw new OpError("forbidden", "only a signed-in owner of the operator org may do this");
  }
  if (ctx.stepUp?.action === undefined) {
    throw new OpError("forbidden", "a passkey step-up is required (step_up_required)", {
      reason: "step_up_required",
    });
  }
  const app = await getGithubApp(ctx.db);
  if (!app) throw new OpError("unavailable", "no GitHub App is configured");
  if (app.orgId !== ctx.scope.orgId) {
    throw new OpError("forbidden", "only an owner of the org that owns the GitHub App may do this");
  }
  return app;
}

export const instanceRotateWebhookSecretOp = defineOp({
  name: "instance_rotate_webhook_secret",
  summary: "Rotate the GitHub App's webhook secret (instance administrator, passkey step-up).",
  description:
    "Generates a new webhook secret on the server, seals it under the current master key and " +
    "returns it ONCE, in this response only, for you to paste into the App's settings on GitHub. " +
    "The previous secret also verifies until `overlap_until` (default and at most 1 hour), then " +
    "only the new one does. Only a signed-in web session of an OWNER of the operator org (the org " +
    "that owns the GitHub App) may call it, with a fresh passkey `step_up` for exactly this input " +
    "(`session_step_up_challenge`); a `tti_` token, an org token and any other org are refused. " +
    "Audited by fingerprint, never the value. Not an MCP tool.",
  input: rotateInput,
  output: z.object({
    secret: z.string().describe("The new webhook secret. Shown once."),
    fingerprint: z.string(),
    overlap_until: z.string(),
  }),
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/app-secrets/webhook-secret/rotate" },
  mcp: false,
  oneTimeSecretFields: ["secret"],
  auditDetail: (o) => ({
    fingerprint: o.fingerprint,
    overlap_until: o.overlap_until,
  }),
  async handler(ctx, i) {
    if (!ctx.auditStore) throw new OpError("unavailable", "no master key: the secret store is off");
    await requireOperatorOwner(ctx);
    let r;
    try {
      // Runs in the dispatcher's transaction: the store is rebound to it, so the two seals, the
      // expiry and the audit row commit together or not at all.
      r = await sealRotatedWebhookSecret(ctx.db, ctx.auditStore.withDb(ctx.db), {
        overlapMs: i.overlap_minutes * 60_000,
        now: ctx.now,
      });
    } catch (e) {
      throw new OpError("unavailable", e instanceof Error ? e.message : "rotation failed");
    }
    return {
      secret: r.secret,
      fingerprint: fingerprint(r.secret),
      overlap_until: iso(r.overlapUntil)!,
    };
  },
});

export const instanceReplaceAppPrivateKeyOp = defineOp({
  name: "instance_replace_app_private_key",
  summary: "Replace the GitHub App's private key (instance administrator, passkey step-up).",
  description:
    "Uploads a new private key (PEM) for the SAME App. Before the swap the instance signs an App " +
    "JWT with it and calls `GET /app` on GitHub: the App id must match the configured App, else " +
    "the call is refused and the old key stays. The key is sealed under the current master key " +
    "and is never returned. Afterwards, delete the old key in the App's settings on GitHub. " +
    "Only a signed-in web session of an OWNER of the operator org (the org that owns the GitHub " +
    "App) may call it, with a fresh passkey `step_up` for exactly this input; a `tti_` token, an " +
    "org token and any other org are refused. Audited by key fingerprint only. Over https or " +
    "loopback only. Not an MCP tool.",
  input: replaceInput,
  output: z.object({ fingerprint: z.string(), app_id: z.string() }),
  effect: "write",
  auth: { type: "token", minRole: "owner" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/app-secrets/private-key" },
  mcp: false,
  secretInputFields: ["private_key"],
  outsideTransaction: true,
  auditDetail: (o) => ({ fingerprint: o.fingerprint }),
  async handler(ctx, i) {
    const store = ctx.auditStore;
    const auth = ctx.appAuth;
    if (!store || !auth) throw new OpError("unavailable", "no master key or GitHub App configured");
    const app = await requireOperatorOwner(ctx);
    const pem = i.private_key;
    let fp: string;
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== "rsa") throw new Error("not rsa");
      fp = fingerprint(createPublicKey(key).export({ type: "spki", format: "der" }));
    } catch {
      throw new OpError("invalid_input", "that is not an RSA private key in PEM form");
    }
    let status: number;
    let body: { id?: unknown } = {};
    try {
      const res = await auth.fetcher(`${auth.apiBase}/app`, {
        headers: {
          authorization: `Bearer ${signAppJwt(app.appId, pem, ctx.now())}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "turntable",
        },
        signal: AbortSignal.timeout(30_000),
      });
      status = res.status;
      if (res.ok) body = (await res.json()) as { id?: unknown };
    } catch {
      throw new OpError(
        "unavailable",
        "could not reach GitHub to verify the key: the old key stays",
      );
    }
    if (status < 200 || status >= 300) {
      throw new OpError(
        "invalid_input",
        `GitHub did not accept that key (HTTP ${status}): the old key stays`,
      );
    }
    if (String(body.id ?? "") !== app.appId) {
      throw new OpError("invalid_input", "that key belongs to another App: the old key stays");
    }
    // One transaction for the seal; the dispatcher audits right after.
    await ctx.db.transaction(async (tx) => {
      await store.withDb(tx).set(app.orgId, SECRET_PRIVATE_KEY, pem);
    });
    auth.dropCached();
    return { fingerprint: fp, app_id: app.appId };
  },
});
