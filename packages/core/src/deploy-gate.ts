// The public deploy gate: GET /api/v1/deploy-gate. It answers one question for CD ("may the
// instance restart now?") with one bit and a fixed reason, the same for every caller. It is
// unauthenticated, so it never carries an org, project, run or job id, name or count: a caller can
// learn only that some release work exists somewhere, which the instance operator already shows
// the world by deploying. The answer is cached for a few seconds and the route is rate limited per
// client address, so polling it cannot become a load or a timing probe.
import type { Db } from "./db";
import { releaseInFlight } from "./db/repos";
import { clientAddress, parseTrustedProxies, type TrustedProxies } from "./github/trusted-proxies";
import { processDrain } from "./scheduler/drain";

export const DEPLOY_GATE_PATH = "/api/v1/deploy-gate";

export type DeployGateBody = {
  safe: boolean;
  reason: "ok" | "release_in_flight" | "draining";
};

export type DeployGateOptions = {
  db: Db;
  now?: () => number;
  /** How long an answer is reused. Default and ceiling: 15 s. */
  cacheMs?: number;
  /** Requests one client address may make per window. Default 60 per minute. */
  maxPerWindow?: number;
  windowMs?: number;
  trustedProxies?: TrustedProxies;
  /** Whether a drain is on. Default: this process's drain state. */
  draining?: () => boolean;
};

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;
const MAX_CACHE_MS = 15_000;
const MAX_TRACKED = 10_000;

export function createDeployGate(o: DeployGateOptions): {
  handle(req: Request, peer?: string): Promise<Response | undefined>;
} {
  const now = o.now ?? Date.now;
  const cacheMs = Math.min(o.cacheMs ?? MAX_CACHE_MS, MAX_CACHE_MS);
  const max = o.maxPerWindow ?? 60;
  const windowMs = o.windowMs ?? 60_000;
  const trusted = o.trustedProxies ?? parseTrustedProxies(undefined);
  const draining = o.draining ?? (() => processDrain.draining);
  const hits = new Map<string, { count: number; resetAt: number }>();
  let cached: { at: number; inFlight: boolean } | undefined;
  let pending: Promise<boolean> | undefined;

  const throttled = (key: string): boolean => {
    const t = now();
    if (hits.size >= MAX_TRACKED) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      if (hits.size >= MAX_TRACKED) hits.clear();
    }
    const h = hits.get(key);
    if (!h || h.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return false;
    }
    h.count += 1;
    return h.count > max;
  };

  async function inFlight(): Promise<boolean> {
    if (cached && now() - cached.at < cacheMs && now() >= cached.at) return cached.inFlight;
    // One query serves every caller that arrives while it runs.
    pending ??= releaseInFlight(o.db, now())
      .then((v) => {
        cached = { at: now(), inFlight: v };
        return v;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }

  const body = (b: DeployGateBody, status = 200): Response =>
    Response.json(b, { status, headers: HEADERS });

  return {
    async handle(req, peer) {
      if (new URL(req.url).pathname !== DEPLOY_GATE_PATH) return undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: { ...HEADERS, allow: "GET, HEAD" },
        });
      }
      if (throttled(clientAddress(req.headers, peer, trusted))) {
        return Response.json(
          { error: "rate_limited" },
          {
            status: 429,
            headers: { ...HEADERS, "retry-after": String(Math.ceil(windowMs / 1000)) },
          },
        );
      }
      let busy: boolean;
      try {
        busy = await inFlight();
      } catch {
        // Fail closed: when the answer is unknown, a deploy waits.
        return body({ safe: false, reason: "release_in_flight" }, 503);
      }
      if (busy) return body({ safe: false, reason: "release_in_flight" });
      if (draining()) return body({ safe: false, reason: "draining" });
      return body({ safe: true, reason: "ok" });
    },
  };
}
