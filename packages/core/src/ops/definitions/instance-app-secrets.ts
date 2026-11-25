// Rotating the GitHub App's webhook secret and private key without a shell (#586). Both are
// instance-administrator ops that also need a fresh passkey step-up (see ../step-up.ts), and
// neither value is ever returned, logged, evented or audited except where noted: the new webhook
// secret is in the response of ONE call, the private key is only ever uploaded.
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  countOpenChallenges,
  getGithubApp,
  insertChallenge,
  purgeExpiredChallenges,
} from "../../db/repos";
import { SECRET_PRIVATE_KEY, signAppJwt } from "../../github/app-auth";
import { sealRotatedWebhookSecret, WEB_OVERLAP_MAX_MS } from "../../github/rotation";
import { iso } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";
import {
  INSTANCE_STEP_UP_CHALLENGE_OP,
  INSTANCE_STEP_UP_OPS,
  inputTarget,
  STEP_UP_KIND,
  STEP_UP_TTL_MS,
  stepUpChallengeOf,
  stepUpHash,
  stepUpKeys,
  stepUpPrincipal,
} from "../step-up";

const MAX_OPEN_STEP_UPS = 10;
const fingerprint = (bytes: Buffer | string): string =>
  `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;

const rotateInput = z.object({
  overlap_minutes: z
    .int()
    .min(1)
    .max(WEB_OVERLAP_MAX_MS / 60_000)
    .default(60)
    .describe("How long the previous secret also verifies, in minutes (1 to 60, default 60)."),
});
const replaceInput = z.object({
  private_key: z.string().min(1).max(16_384).describe("The new private key, PEM."),
});

const SCHEMAS: Record<string, z.ZodObject> = {
  instance_rotate_webhook_secret: rotateInput,
  instance_replace_app_private_key: replaceInput,
};

export const instanceStepUpChallengeOp = defineOp({
  name: INSTANCE_STEP_UP_CHALLENGE_OP,
  summary: "Start a passkey step-up for one instance App-secret action (instance administrator).",
  description:
    "Needs the instance token AND the signed-in web session of a person with a passkey in the " +
    "operator org (the org that owns the GitHub App). Names an action " +
    "(instance_rotate_webhook_secret or instance_replace_app_private_key) and the exact `input` " +
    "it will be called with, and returns a single-use WebAuthn challenge bound to the action, a " +
    "hash of that input, the instance token and the session. The action then carries `step_up`. " +
    "Lasts 5 minutes. Changes nothing else. Not an MCP tool.",
  input: z.object({
    action: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()),
  }),
  output: z.object({
    step_up_id: z.string(),
    challenge: z.string().describe("base64url: the WebAuthn challenge to sign."),
    rp_id: z.string(),
    passkeys: z.array(z.object({ approver: z.string(), passkey_id: z.string() })),
    expires_at: z.string(),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/step-up" },
  mcp: false,
  // The challenge echoes nothing of the action input, but it is bulky and may hold the new key.
  logOmitFields: ["input"],
  async handler(ctx, i) {
    const s = ctx.instanceSession;
    if (!s || ctx.principal.kind !== "instance") {
      throw new OpError("forbidden", "step-up needs the instance token and a web session");
    }
    if (!ctx.webauthn)
      throw new OpError("unavailable", "WebAuthn is not configured on this server");
    const schema = SCHEMAS[i.action];
    if (!schema || !INSTANCE_STEP_UP_OPS.has(i.action)) {
      throw new OpError("invalid_input", `${i.action} does not take an instance step-up`);
    }
    const parsed = schema.safeParse(i.input);
    if (!parsed.success) {
      throw new OpError("invalid_input", "input does not match that action's schema");
    }
    const { keys, legacy } = await stepUpKeys(ctx.db, s.orgId, s.userId);
    if (keys.length === 0) {
      throw legacy > 0
        ? new OpError(
            "forbidden",
            "re-enrol your passkey: it has no GitHub account id (step_up_reenrol)",
            {
              reason: "step_up_reenrol",
            },
          )
        : new OpError(
            "forbidden",
            "no passkey of yours is enrolled in the operator org (step_up_required)",
            { reason: "step_up_required" },
          );
    }
    const now = ctx.now();
    const principal = stepUpPrincipal(s.userId, ctx.principal.id);
    await purgeExpiredChallenges(ctx.db, s.orgId, now);
    if ((await countOpenChallenges(ctx.db, s.orgId, principal, now)) >= MAX_OPEN_STEP_UPS) {
      throw new OpError("conflict", "too many open step-ups: use or wait out the others");
    }
    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = now + STEP_UP_TTL_MS;
    const hash = stepUpHash({
      orgId: s.orgId,
      sessionHash: s.sessionHash,
      userId: s.userId,
      action: i.action,
      target: inputTarget(parsed.data as Record<string, unknown>, undefined),
      nonce,
      expiresAt,
      instanceTokenId: ctx.principal.id,
    });
    await insertChallenge(ctx.db, s.orgId, {
      id: nonce,
      kind: STEP_UP_KIND,
      statementHash: hash,
      principal,
      expiresAt,
    });
    return {
      step_up_id: nonce,
      challenge: stepUpChallengeOf(hash),
      rp_id: ctx.webauthn.rpId,
      passkeys: keys.map((k) => ({ approver: k.id, passkey_id: k.credentialId })),
      expires_at: iso(expiresAt)!,
    };
  },
});

export const instanceRotateWebhookSecretOp = defineOp({
  name: "instance_rotate_webhook_secret",
  summary: "Rotate the GitHub App's webhook secret (instance administrator, passkey step-up).",
  description:
    "Generates a new webhook secret on the server, seals it under the current master key and " +
    "returns it ONCE, in this response only, for you to paste into the App's settings on GitHub. " +
    "The previous secret also verifies until `overlap_until` (default and at most 1 hour), then " +
    "only the new one does. Needs the instance token, the signed-in web session of a person " +
    "with a passkey in the operator org, and a fresh `step_up` for exactly this input " +
    "(`instance_step_up_challenge`). Audited by fingerprint, never the value. Not an MCP tool.",
  input: rotateInput,
  output: z.object({
    secret: z.string().describe("The new webhook secret. Shown once."),
    fingerprint: z.string(),
    overlap_until: z.string(),
    approved_by: z.string(),
  }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/github-app/webhook-secret/rotate" },
  mcp: false,
  oneTimeSecretFields: ["secret"],
  outsideTransaction: true,
  auditDetail: (o) => ({
    fingerprint: o.fingerprint,
    overlap_until: o.overlap_until,
    approved_by: o.approved_by,
  }),
  async handler(ctx, i) {
    if (!ctx.auditStore) throw new OpError("unavailable", "no master key: the secret store is off");
    if (!ctx.stepUp?.userId) throw new OpError("forbidden", "step_up_required");
    let r;
    try {
      r = await sealRotatedWebhookSecret(ctx.db, ctx.auditStore, {
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
      approved_by: ctx.stepUp.userId,
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
    "Needs the instance token, the signed-in web session of a person with a passkey in the " +
    "operator org, and a fresh `step_up` for exactly this input. Audited by key fingerprint " +
    "only. Over https or loopback only. Not an MCP tool.",
  input: replaceInput,
  output: z.object({ fingerprint: z.string(), app_id: z.string(), approved_by: z.string() }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/github-app/private-key" },
  mcp: false,
  secretInputFields: ["private_key"],
  outsideTransaction: true,
  auditDetail: (o) => ({ fingerprint: o.fingerprint, approved_by: o.approved_by }),
  async handler(ctx, i) {
    const store = ctx.auditStore;
    const auth = ctx.appAuth;
    if (!store || !auth) throw new OpError("unavailable", "no master key or GitHub App configured");
    if (!ctx.stepUp?.userId) throw new OpError("forbidden", "step_up_required");
    const app = await getGithubApp(ctx.db);
    if (!app) throw new OpError("unavailable", "no GitHub App is configured");
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
    await store.set(app.orgId, SECRET_PRIVATE_KEY, pem);
    auth.dropCached();
    return { fingerprint: fp, app_id: app.appId, approved_by: ctx.stepUp.userId };
  },
});
