// Outbound webhooks (#25). Events of an org (optionally one project, optionally some types) are
// POSTed to a URL the org's admin chose.
//
// Delivery guarantees: at least once per (endpoint, event). Fan-out moves an endpoint's cursor and
// inserts the delivery rows in one transaction, and a row is unique per endpoint and event, so a
// restart neither loses nor repeats an event. A failed delivery retries with backoff and is
// abandoned after a cap; order across retries is not guaranteed, so every body carries its cursor.
//
// Security: the request goes out through the SSRF-guarded client (private, loopback and metadata
// addresses refused, the address pinned, redirects never followed). It is signed with HMAC-SHA256
// over `<timestamp>.<body>`, so a captured request cannot be replayed with a fresh timestamp. The
// signing secret is per org, sealed in its own key domain under the org's key, and rotates with an
// overlap during which both versions sign.
import { createHmac, randomBytes } from "node:crypto";
import { type SafeFetch, safeFetch, blockedReason } from "@longshore/net";
import { isIP } from "node:net";
import type { Db } from "../db";
import {
  activeWebhookSecrets,
  addWebhookSecret,
  claimDueWebhookDeliveries,
  createOutboundEndpoint,
  fanOutOutboundEndpoint,
  getOrgById,
  listActiveOutboundEndpoints,
  onEventsAppended,
  projectSlugsFor,
  recordWebhookAttempt,
  type DueDelivery,
  type OutboundEndpoint,
} from "../db/repos";
import type { EventType } from "../db/schema";
import { open, seal } from "../secrets/crypto";

export const SIGNATURE_HEADER = "longshore-signature";
export const OVERLAP_MS = 24 * 3600 * 1000;
export const DISABLE_AFTER = 20;
/** Delay before attempt n+1, after attempt n failed. Eight attempts, about a day in all. */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const RESPONSE_KEPT = 512;

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

/**
 * An endpoint URL is https, has no credentials or fragment, and names a host (an IP literal only
 * if it is a public address). The address a name resolves to is checked again at connect time by
 * the guarded client, so this is the early, friendly refusal and not the only one.
 */
export function validateWebhookUrl(raw: string): string {
  if (raw.length > 2048) throw new WebhookUrlError("the URL is too long");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebhookUrlError("not a valid URL");
  }
  if (u.protocol !== "https:") throw new WebhookUrlError("the URL must be https");
  if (u.username !== "" || u.password !== "") {
    throw new WebhookUrlError("the URL must not carry credentials");
  }
  if (u.hash !== "") throw new WebhookUrlError("the URL must not have a fragment");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    throw new WebhookUrlError("the host is not a public address");
  }
  if (isIP(host) !== 0) {
    const why = blockedReason(host);
    if (why) throw new WebhookUrlError(`the host is not a public address (${why})`);
  }
  return u.toString();
}

export const generateWebhookSecret = (): string => `whsec_${randomBytes(32).toString("base64url")}`;

const aad = (orgId: string, version: number): Buffer =>
  Buffer.from(`longshore:webhook-secret:${orgId.length}:${orgId}:${version}`, "utf8");

/** The `Longshore-Signature` header: `t=<unix seconds>` and one `v1=<hex>` per signing secret. */
export function signWebhook(secrets: readonly string[], body: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  const parts = secrets.map(
    (secret) => `v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`,
  );
  return [`t=${t}`, ...parts].join(",");
}

/** For a receiver (and the tests): is `header` a valid signature of `body` under `secret`? */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  nowMs: number,
  toleranceMs = 5 * 60_000,
): boolean {
  const t = /(?:^|,)t=(\d+)/.exec(header)?.[1];
  if (!t || Math.abs(nowMs - Number(t) * 1000) > toleranceMs) return false;
  const want = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return header.split(",").some((p) => p === `v1=${want}`);
}

export interface WebhookServiceOptions {
  db: Db;
  masterKey: Buffer;
  fetch?: SafeFetch;
  now?: () => number;
  /** Consecutive failed attempts that disable an endpoint. Default 20. */
  disableAfter?: number;
  overlapMs?: number;
  /** Deliveries in flight at once. Default 8. */
  concurrency?: number;
  /** Ignore events newer than this (a database whose ids can commit out of order). */
  settleMs?: number;
  /** Jitter source, 0 to 1. */
  random?: () => number;
  log?: (message: string) => void;
}

export class WebhookService {
  readonly #o: WebhookServiceOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #off: (() => void) | undefined;
  #running = false;
  #again = false;

  get overlapMs(): number {
    return this.#o.overlapMs ?? OVERLAP_MS;
  }

  constructor(o: WebhookServiceOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  // ---- management (used by the ops) ----

  /**
   * Makes the org's first signing secret. Returns it (once) when this call created it, else
   * undefined: the org already has one, which only a rotation can show again.
   */
  async ensureSecret(orgId: string): Promise<string | undefined> {
    const now = this.#now();
    if ((await activeWebhookSecrets(this.#o.db, { orgId }, now)).length > 0) return undefined;
    return this.rotate(orgId);
  }

  /** A new secret version, shown to the caller once. The previous one keeps signing for the overlap. */
  async rotate(orgId: string): Promise<string> {
    const secret = generateWebhookSecret();
    await addWebhookSecret(
      this.#o.db,
      { orgId },
      (version) => seal(this.#o.masterKey, secret, aad(orgId, version), "webhook", orgId),
      this.#now(),
      this.#o.overlapMs ?? OVERLAP_MS,
    );
    return secret;
  }

  createEndpoint(
    scope: { orgId: string; projectId?: string },
    input: {
      url: string;
      description: string;
      eventTypes: readonly EventType[] | null;
      createdBy: string;
      fromStart: boolean;
    },
  ): Promise<OutboundEndpoint> {
    return createOutboundEndpoint(this.#o.db, scope, {
      ...input,
      url: validateWebhookUrl(input.url),
      now: this.#now(),
    });
  }

  async #signingSecrets(orgId: string): Promise<string[]> {
    const rows = await activeWebhookSecrets(this.#o.db, { orgId }, this.#now());
    return rows.map((r) =>
      open(this.#o.masterKey, r.sealed, aad(orgId, r.version), "webhook", orgId),
    );
  }

  // ---- fan-out and delivery ----

  /** Moves every active endpoint's cursor to the tip (at most `maxPages` pages each). */
  async fanOut(maxPages = 10): Promise<number> {
    let inserted = 0;
    for (const ep of await listActiveOutboundEndpoints(this.#o.db)) {
      for (let i = 0; i < maxPages; i++) {
        const r = await fanOutOutboundEndpoint(this.#o.db, ep.id, {
          page: 100,
          now: this.#now(),
          ...(this.#o.settleMs ? { settleMs: this.#o.settleMs } : {}),
        });
        inserted += r.inserted;
        if (r.scanned < 100) break;
      }
    }
    return inserted;
  }

  /** Sends what is due. Returns how many were attempted. */
  async deliverDue(limit = 50): Promise<number> {
    const due = await claimDueWebhookDeliveries(this.#o.db, {
      now: this.#now(),
      leaseMs: REQUEST_TIMEOUT_MS * 3,
      limit,
    });
    const width = this.#o.concurrency ?? 8;
    const slugs = new Map<string, string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const d = due[next++];
        if (!d) return;
        try {
          await this.#deliver(d, slugs);
        } catch (err) {
          // Never let one delivery stop the rest; the lease expires and it is tried again.
          this.#o.log?.(
            `webhook delivery ${d.delivery.id}: ${err instanceof Error ? err.message : "error"}`,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, due.length) }, worker));
    return due.length;
  }

  async #body(d: DueDelivery, slugs: Map<string, string>): Promise<string> {
    const { event, endpoint } = d;
    let org = slugs.get(endpoint.orgId);
    if (org === undefined) {
      org = (await getOrgById(this.#o.db, endpoint.orgId))?.slug ?? "";
      slugs.set(endpoint.orgId, org);
    }
    const project =
      event.projectId === null
        ? null
        : ((await projectSlugsFor(this.#o.db, endpoint.orgId, [event.projectId])).get(
            event.projectId,
          ) ?? null);
    return JSON.stringify({
      cursor: event.id,
      id: event.publicId,
      type: event.type,
      org,
      project,
      run_id: event.runId,
      job_id: event.jobId,
      attempt_id: event.attemptId,
      payload: JSON.parse(event.payload) as unknown,
      created_at: new Date(event.createdAt).toISOString(),
    });
  }

  async #deliver(d: DueDelivery, slugs: Map<string, string>): Promise<void> {
    const { delivery, endpoint } = d;
    const now = this.#now();
    const record = (r: Parameters<typeof recordWebhookAttempt>[2]) =>
      recordWebhookAttempt(this.#o.db, delivery, r, {
        now: this.#now(),
        disableAfter: this.#o.disableAfter ?? DISABLE_AFTER,
      });
    const retryAt = (): number | null => {
      const n = delivery.attempts + 1; // attempts made including this one
      if (n >= MAX_ATTEMPTS) return null;
      const base = BACKOFF_MS[n - 1] ?? BACKOFF_MS.at(-1)!;
      const jitter = 0.8 + 0.4 * (this.#o.random ?? Math.random)();
      return this.#now() + Math.round(base * jitter);
    };
    const failed = (status: number | null, error: string, response: string | null) =>
      record({ ok: false, status, error, response, retryAt: retryAt() });

    let secrets: string[];
    try {
      secrets = await this.#signingSecrets(endpoint.orgId);
    } catch {
      await failed(null, "the signing secret could not be opened", null);
      return;
    }
    if (secrets.length === 0) {
      await failed(null, "the org has no signing secret", null);
      return;
    }
    let url: string;
    try {
      url = validateWebhookUrl(endpoint.url);
    } catch (err) {
      await failed(null, err instanceof Error ? err.message : "bad URL", null);
      return;
    }
    const body = await this.#body(d, slugs);
    const doFetch = this.#o.fetch ?? safeFetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "Longshore-Webhook/1",
          "longshore-event": d.event.type,
          "longshore-delivery": delivery.id,
          "longshore-cursor": String(d.event.id),
          [SIGNATURE_HEADER]: signWebhook(secrets, body, now),
        },
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
      });
    } catch (err) {
      // The guard's reason ("refused: private address") is useful to the admin and holds no secret.
      await failed(null, err instanceof Error ? err.message : "request failed", null);
      return;
    }
    const text = await res.text().catch(() => "");
    const snippet = text.slice(0, RESPONSE_KEPT);
    if (res.status >= 200 && res.status < 300) {
      await record({ ok: true, status: res.status, response: snippet });
      return;
    }
    const redirect = res.status >= 300 && res.status < 400;
    await failed(
      res.status,
      redirect ? `redirects are not followed (HTTP ${res.status})` : `HTTP ${res.status}`,
      snippet,
    );
  }

  /** One pass: fan out, then send what is due. Passes never overlap; a request during one reruns it. */
  async tick(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      do {
        this.#again = false;
        await this.fanOut();
        await this.deliverDue();
      } while (this.#again);
    } finally {
      this.#running = false;
    }
  }

  /** Runs `tick` on a timer and whenever an event is appended in this process. */
  start(intervalMs = 2000): () => void {
    const run = () => void this.tick().catch((e) => this.#o.log?.(`webhooks: ${String(e)}`));
    this.#timer = setInterval(run, intervalMs);
    this.#off = onEventsAppended(run);
    run();
    return () => this.stop();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#off?.();
    this.#timer = undefined;
    this.#off = undefined;
  }
}
