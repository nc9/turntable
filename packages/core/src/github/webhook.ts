// Inbound GitHub webhooks: authenticate, bound, persist, then act.
//
//  1. Size: Content-Length over the cap is refused before reading; the body is also counted as
//     it streams, so a missing or lying header cannot bypass the cap.
//  2. Signature: HMAC-SHA256 over the RAW bytes, constant-time compare, against the current
//     secret and, during a rotation overlap, the previous one. Checked before any parsing.
//  3. The delivery GUID is stored BEFORE the 202. A GUID seen before is acknowledged and not run
//     again (replay or GitHub redelivery).
//  4. Handlers re-fetch facts from the API (see installations.ts) and are idempotent.
//  5. Events nobody handles are stored as ignored and acknowledged.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readCapped } from "@longshore/net";
import { auditAggregate, auditFailure } from "../audit/failures";
import type { Db } from "../db";
import {
  finishDelivery,
  getDelivery,
  getGithubApp,
  listUnfinishedDeliveries,
  purgeDeliveries,
  recordDelivery,
} from "../db/repos";
import type { SecretStore } from "../secrets/store";
import type { GithubFacts } from "./api";
import { SECRET_WEBHOOK, SECRET_WEBHOOK_PREVIOUS } from "./app-auth";
import { syncInstallation } from "./installations";

export const WEBHOOK_PATH = "/api/v1/webhooks/github";
/** GitHub's maximum webhook payload. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const RETENTION_MS = 30 * 86_400_000;
const HANDLED = new Set(["installation", "installation_repositories"]);
const GUID = /^[A-Za-z0-9-]{8,100}$/;

export interface WebhookOptions {
  db: Db;
  store: SecretStore;
  facts: GithubFacts;
  now?: () => number;
  /** Failed signatures allowed per client per window before answering 429. Default 30 per minute. */
  maxFailures?: number;
  failureWindowMs?: number;
  /**
   * Trust the right-most X-Forwarded-For hop as the client address. Only set this when the
   * server sits behind a proxy you control that appends the real peer. Otherwise every
   * request shares one key, which is safe because a valid signature is never rate limited.
   */
  trustForwardedFor?: boolean;
  log?: (line: string) => void;
}

export interface WebhookHandler {
  handle(req: Request): Promise<Response | undefined>;
  /** Resolves when every delivery being processed has finished (tests, shutdown). */
  drain(): Promise<void>;
  /** Re-runs deliveries stored but never finished, for example after a crash. */
  retryUnfinished(): Promise<number>;
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });

/** Constant-time check of `sha256=<hex>` against the HMAC of the raw body. */
export function signatureMatches(secret: string, raw: Uint8Array, header: string | null): boolean {
  const m = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1] as string, "hex");
  const want = createHmac("sha256", secret).update(raw).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

const readBody = (req: Request): Promise<Uint8Array | "too-large"> =>
  readCapped(req.body, MAX_BODY_BYTES, Number(req.headers.get("content-length")));

export function createWebhookHandler(o: WebhookOptions): WebhookHandler {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const maxFailures = o.maxFailures ?? 30;
  const windowMs = o.failureWindowMs ?? 60_000;
  const failures = new Map<string, { count: number; resetAt: number }>();
  const inflight = new Set<Promise<void>>();
  let sinceLastPurge = 0;

  const MAX_TRACKED = 10_000;
  const clientKey = (req: Request): string => {
    if (!o.trustForwardedFor) return "all";
    const hops = (req.headers.get("x-forwarded-for") ?? "").split(",");
    return hops[hops.length - 1]?.trim() || "unknown";
  };

  const limited = (key: string): boolean => {
    const f = failures.get(key);
    if (!f) return false;
    if (f.resetAt <= now()) {
      failures.delete(key);
      return false;
    }
    return f.count >= maxFailures;
  };
  const noteFailure = (key: string): void => {
    if (failures.size >= MAX_TRACKED) {
      for (const [k, v] of failures) if (v.resetAt <= now()) failures.delete(k);
      if (failures.size >= MAX_TRACKED) failures.clear();
    }
    const f = failures.get(key);
    if (!f || f.resetAt <= now()) failures.set(key, { count: 1, resetAt: now() + windowMs });
    else f.count += 1;
  };

  async function processDelivery(id: string): Promise<void> {
    const d = await getDelivery(o.db, id);
    if (!d || d.status !== "received") return;
    try {
      const payload = JSON.parse(d.payload ?? "{}") as { installation?: { id?: number | string } };
      const installationId = d.installationId ?? String(payload.installation?.id ?? "");
      if (!installationId) {
        await finishDelivery(o.db, id, "failed", "payload names no installation");
        return;
      }
      // The payload only says WHICH installation to look at; everything else is re-fetched.
      const r = await syncInstallation(o.db, o.facts, installationId);
      const note =
        r.conflicts.length > 0
          ? `left alone (bound elsewhere): ${r.conflicts.join(", ")}`
          : undefined;
      await finishDelivery(o.db, id, "processed", note);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`github webhook ${id}: ${msg}`);
      await finishDelivery(o.db, id, "failed", msg);
    }
  }

  const track = (id: string): void => {
    const p = processDelivery(id).finally(() => inflight.delete(p));
    inflight.add(p);
  };

  return {
    async handle(req) {
      const url = new URL(req.url);
      if (url.pathname !== WEBHOOK_PATH) return undefined;
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const key = clientKey(req);
      // A client that keeps failing is refused before its body is read. A correctly signed
      // request is never refused by the limiter: attackers cannot lock out GitHub's deliveries.
      const throttled = limited(key);

      const app = await getGithubApp(o.db);
      if (!app) return json(503, { error: "no GitHub App is configured" });

      const raw = await readBody(req);
      if (raw === "too-large") return json(413, { error: "payload too large" });

      // Authenticate BEFORE parsing anything.
      const header = req.headers.get("x-hub-signature-256");
      const secrets: string[] = [];
      const current = await o.store.get(app.orgId, SECRET_WEBHOOK);
      if (current) secrets.push(current);
      if (app.previousSecretExpiresAt !== null && app.previousSecretExpiresAt > now()) {
        const prev = await o.store.get(app.orgId, SECRET_WEBHOOK_PREVIOUS);
        if (prev) secrets.push(prev);
      }
      if (!secrets.some((s) => signatureMatches(s, raw, header))) {
        noteFailure(key);
        // A client the limiter already refuses is counted in aggregate; others get an entry
        // (throttled per client address).
        if (throttled) await auditAggregate(o.db, app.orgId, "github_webhook_throttled");
        else {
          await auditFailure(o.db, {
            orgId: app.orgId,
            principalKind: "webhook",
            principalId: key,
            source: key,
            kind: "bad_signature",
            op: "github_webhook",
            outcome: "error:bad_signature",
            detail: { event: req.headers.get("x-github-event") ?? null },
          });
        }
        return throttled
          ? json(429, { error: "too many invalid requests" })
          : json(401, { error: "invalid signature" });
      }

      const delivery = req.headers.get("x-github-delivery") ?? "";
      const event = req.headers.get("x-github-event") ?? "";
      if (!GUID.test(delivery))
        return json(400, { error: "missing or malformed X-GitHub-Delivery" });
      if (!/^[a-z_]{1,64}$/.test(event))
        return json(400, { error: "missing or malformed X-GitHub-Event" });
      let payload: { action?: unknown; installation?: { id?: unknown } };
      try {
        payload = JSON.parse(new TextDecoder().decode(raw)) as typeof payload;
      } catch {
        return json(400, { error: "body is not JSON" });
      }
      const handled = HANDLED.has(event);
      const action = typeof payload.action === "string" ? payload.action : undefined;
      const instId = payload.installation?.id;

      const stored = await recordDelivery(o.db, {
        id: delivery,
        orgId: app.orgId,
        event,
        action,
        installationId:
          typeof instId === "number" || typeof instId === "string" ? String(instId) : undefined,
        payload: handled ? new TextDecoder().decode(raw) : undefined,
        status: handled ? "received" : "ignored",
      });
      if (stored === "duplicate") return json(202, { status: "duplicate" });

      sinceLastPurge += 1;
      if (sinceLastPurge >= 100) {
        sinceLastPurge = 0;
        void purgeDeliveries(o.db, now() - RETENTION_MS);
      }
      if (handled) track(delivery);
      return json(202, { status: handled ? "accepted" : "ignored" });
    },

    async drain() {
      while (inflight.size > 0) await Promise.allSettled(inflight);
    },

    async retryUnfinished() {
      const rows = await listUnfinishedDeliveries(o.db);
      for (const r of rows) track(r.id);
      await this.drain();
      return rows.length;
    },
  };
}
