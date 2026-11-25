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
import { readCapped } from "@turntable/net";
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
import { clientAddress, parseTrustedProxies, type TrustedProxies } from "./trusted-proxies";

export const WEBHOOK_PATH = "/api/v1/webhooks/github";
/** GitHub's maximum webhook payload. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const RETENTION_MS = 30 * 86_400_000;
const HANDLED = new Set(["installation", "installation_repositories"]);
/**
 * Events that only wake the poller for the repo they name. A webhook never creates a run and never
 * records the event's `sender`: runs come only from poll ingest, which sets a PR run's `actor` to
 * the PR author the trust decision judged. `approver_is_author` (#408) compares the approver with
 * that `actor` alone. If a webhook path ever creates runs or records `sender` (a pusher can differ
 * from the PR author on `synchronize`), that check must compare against both (#416), and the guard
 * in tests/github-webhook.test.ts fails until it is revisited.
 */
const WAKE = new Set(["push", "pull_request", "merge_group"]);
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
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
   * The proxies in front of the server that you control (TURNTABLE_TRUSTED_PROXIES). The forwarded
   * chain is believed only through them; otherwise the limiter keys on the socket peer, so a
   * spoofed header gains nothing. A valid signature is never rate limited either way.
   */
  trustedProxies?: TrustedProxies;
  /**
   * Hosted multi-tenant mode: an installation nobody has claimed is not mapped to the App's own
   * org (see installations.ts and the claim flow).
   */
  claimMode?: boolean;
  /**
   * A push or pull request event named this repository. Only the NAME is taken from the payload,
   * to wake the poller for a repo it is already configured for; the poll re-fetches every fact
   * from the API and applies the trust decision as for any run. An unconfigured repo is ignored.
   */
  onRepoEvent?: (repo: string, event: string) => void;
  log?: (line: string) => void;
}

export interface WebhookHandler {
  /** `peer` is the socket's remote address, used to key the failure limiter. */
  handle(req: Request, peer?: string): Promise<Response | undefined>;
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
  const trusted = o.trustedProxies ?? parseTrustedProxies(undefined);
  const clientKey = (req: Request, peer: string | undefined): string =>
    clientAddress(req.headers, peer, trusted);

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
      const r = await syncInstallation(o.db, o.facts, installationId, {
        claimMode: o.claimMode === true,
      });
      if (r.outcome === "unclaimed") {
        await finishDelivery(o.db, id, "ignored", "installation not claimed by any org");
        return;
      }
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
    async handle(req, peer) {
      const url = new URL(req.url);
      if (url.pathname !== WEBHOOK_PATH) return undefined;
      if (req.method !== "POST") return json(405, { error: "method not allowed" });
      const key = clientKey(req, peer);
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
      let payload: {
        action?: unknown;
        installation?: { id?: unknown };
        repository?: { full_name?: unknown };
      };
      try {
        payload = JSON.parse(new TextDecoder().decode(raw)) as typeof payload;
      } catch {
        return json(400, { error: "body is not JSON" });
      }
      const action = typeof payload.action === "string" ? payload.action : undefined;
      // A rename or transfer re-syncs the installation, so its binding follows the repo by id.
      const handled =
        HANDLED.has(event) ||
        (event === "repository" && (action === "renamed" || action === "transferred"));
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
      const repo = payload.repository?.full_name;
      if (WAKE.has(event) && typeof repo === "string" && REPO_NAME.test(repo)) {
        try {
          o.onRepoEvent?.(repo, event);
        } catch (e) {
          log(
            `github webhook ${delivery}: wake failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
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
