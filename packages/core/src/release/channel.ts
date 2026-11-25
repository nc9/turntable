// The channel between the worker and the release lane. A publish job must reach the lane's
// release proxy, and only the lane can say who may: the worker asks, per attempt, and the lane
// answers with an endpoint and an attempt-scoped proxy credential. The publish credential never
// travels, not even to the proxy's client: it stays in the lane.
//
// Transport: a unix socket (default, mode 0600 in a 0700 directory), or TCP with mutual TLS for
// split hosts. Each request carries an HMAC under a key shared by the lane and the worker. The
// worker holds that key only as a request key: knowing it lets a process ask, never publish. The
// lane re-verifies everything itself before it registers anything (the attempt is running as the
// release class in the run's job, the lane signed the run, the pin, the tag, no freeze), and the
// facts that matter most come from the lane's own file, not from rows the worker can write.
import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
import { canonicalJson } from "../audit/chain";
import type { Db } from "../db";
import { getProject } from "../db/repos";
import * as s from "../db/schema";
import { LaneConfigError, type LaneConfig, type TargetFields } from "./config";
import type { ReleaseProxy } from "./proxy";

const VERSION = "longshore-release-channel/v1";
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_SKEW_MS = 60_000;
const MAX_BODY = 4096;
/** A config message may carry a lane secret (up to 16 KiB, so up to a few times that escaped). */
const MAX_CONFIG_BODY = 128 * 1024;

export type ChannelOp = "register" | "revoke" | "health" | "config";

/** What the config channel does: each is one change to the lane's own configuration (or a read). */
export const CONFIG_ACTIONS = [
  "snapshot",
  "pin_repo",
  "target_set",
  "target_delete",
  "secret_set",
] as const;
export type ConfigAction = (typeof CONFIG_ACTIONS)[number];

/** The MAC fields of a config message: the action and the canonical form of its arguments. */
export const configFields = (action: string, args: unknown): string[] => [
  action,
  canonicalJson(args),
];

/** The MAC of a request: HMAC-SHA256 over the version, the operation, the fields and the time. */
export function channelMac(
  key: Buffer | string,
  op: ChannelOp,
  fields: readonly string[],
  ts: number,
): string {
  return createHmac("sha256", key)
    .update([VERSION, op, ...fields, String(ts)].join("\n"))
    .digest("hex");
}

export const registerFields = (a: {
  orgId: string;
  projectId: string;
  runId: string;
  jobId: string;
  attemptId: string;
}): string[] => [a.orgId, a.projectId, a.runId, a.jobId, a.attemptId];

export type ChannelListen =
  | { unix: string }
  | {
      tcp: { host: string; port: number; tls: { cert: string; key: string; ca: string } };
    };

export interface ChannelOptions {
  db: Db;
  proxy: ReleaseProxy;
  /** The shared request key. */
  key: Buffer | string;
  listen: ChannelListen;
  /**
   * Lane configuration over the channel (#541), under its OWN request key: the worker's key lets
   * a process ask for a publish credential and nothing more, so it never opens this. Absent, the
   * config endpoint answers 404 and the instance's config ops are refused as "lane not configured".
   */
  config?: { key: Buffer | string; lane: LaneConfig } | undefined;
  /** How long a job's proxy credential lives. Default 2 hours. */
  ttlMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export interface RunningChannel {
  stop(): void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** True only for an attempt that is running, in this job, of this run, as the release class. */
async function attemptIsReleaseRunning(
  db: Db,
  a: { orgId: string; projectId: string; runId: string; jobId: string; attemptId: string },
): Promise<boolean> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ state: s.jobAttempts.state, klass: s.jobAttempts.trustClass })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        and(
          eq(s.jobAttempts.id, a.attemptId),
          eq(s.jobAttempts.orgId, a.orgId),
          eq(s.jobAttempts.projectId, a.projectId),
          eq(s.jobAttempts.jobId, a.jobId),
          eq(s.jobs.runId, a.runId),
          eq(s.jobs.orgId, a.orgId),
          eq(s.jobs.projectId, a.projectId),
        ),
      )
      .limit(1);
    return row?.state === "running" && row.klass === "release";
  });
}

/** Serves the channel. Every refusal says why in a short code; none says anything about the credential. */
export async function startChannel(o: ChannelOptions): Promise<RunningChannel> {
  const now = o.now ?? Date.now;
  const seen = new Map<string, number>();
  const fresh = (mac: string, at: number): boolean => {
    for (const [m, t] of seen) if (now() - t > 2 * MAX_SKEW_MS) seen.delete(m);
    if (seen.has(mac)) return false;
    seen.set(mac, at);
    return true;
  };
  const authentic = (op: ChannelOp, fields: string[], ts: number, mac: unknown): boolean => {
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > MAX_SKEW_MS) return false;
    const want = Buffer.from(channelMac(o.key, op, fields, ts), "hex");
    return timingSafeEqual(want, Buffer.from(mac, "hex"));
  };

  /** One config message: authentic under the config key, fresh, for a project of that org. */
  async function handleConfig(b: Record<string, unknown>, ts: number): Promise<Response> {
    const cfg = o.config!;
    const action = b.action;
    const args = b.args;
    if (
      typeof action !== "string" ||
      !(CONFIG_ACTIONS as readonly string[]).includes(action) ||
      args === null ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      return json(400, { ok: false, reason: "malformed" });
    const mac = b.mac;
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac) || !Number.isFinite(ts))
      return json(401, { ok: false, reason: "bad_mac" });
    if (
      Math.abs(now() - ts) > MAX_SKEW_MS ||
      !timingSafeEqual(
        Buffer.from(channelMac(cfg.key, "config", configFields(action, args), ts), "hex"),
        Buffer.from(mac, "hex"),
      )
    )
      return json(401, { ok: false, reason: "bad_mac" });
    if (!fresh(mac, now())) return json(401, { ok: false, reason: "replay" });
    const a = args as Record<string, unknown>;
    const orgId = typeof a.orgId === "string" && ID.test(a.orgId) ? a.orgId : undefined;
    const projectId =
      typeof a.projectId === "string" && ID.test(a.projectId) ? a.projectId : undefined;
    if (!orgId || !projectId) return json(400, { ok: false, reason: "malformed" });
    // The lane's own check: the project is the org's. A message cannot name another org's project.
    if (!(await getProject(o.db, { orgId }, projectId)))
      return json(404, { ok: false, reason: "no such project in that org" });
    // Every answer carries the config version after the change, read once the change is made.
    const done = (r: object): Response =>
      json(200, { ok: true, result: { ...r, config_version: cfg.lane.version } });
    try {
      switch (action as ConfigAction) {
        case "snapshot":
          return done(await cfg.lane.snapshot(orgId, projectId));
        case "pin_repo":
          return done({ repo: cfg.lane.pinRepo(orgId, projectId, String(a.repo ?? "")) });
        case "target_set": {
          const target = cfg.lane.setTarget(
            orgId,
            projectId,
            String(a.key ?? ""),
            (a.fields ?? {}) as TargetFields,
          );
          return done({ kind: target.kind });
        }
        case "target_delete":
          return done({ removed: cfg.lane.removeTarget(orgId, projectId, String(a.key ?? "")) });
        case "secret_set":
          return done(
            await cfg.lane.setSecret(
              orgId,
              projectId,
              String(a.name ?? ""),
              String(a.value ?? ""),
              String(a.actor ?? "").slice(0, 100),
            ),
          );
      }
    } catch (e) {
      // A refusal of the input says what is wrong with it; anything else is not described.
      if (e instanceof LaneConfigError) return json(422, { ok: false, reason: e.message });
      throw e;
    }
    return json(400, { ok: false, reason: "malformed" });
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (
      req.method !== "POST" ||
      (path !== "/v1/register" &&
        path !== "/v1/revoke" &&
        path !== "/v1/health" &&
        path !== "/v1/config")
    )
      return json(404, { ok: false, reason: "not_found" });
    if (path === "/v1/config" && !o.config) return json(404, { ok: false, reason: "not_found" });
    const raw = await req.text();
    if (raw.length > (path === "/v1/config" ? MAX_CONFIG_BODY : MAX_BODY))
      return json(413, { ok: false, reason: "too_large" });
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json(400, { ok: false, reason: "malformed" });
    }
    const str = (k: string): string | undefined =>
      typeof b[k] === "string" && ID.test(b[k] as string) ? (b[k] as string) : undefined;
    const ts = typeof b.ts === "number" ? b.ts : Number.NaN;
    if (path === "/v1/config") return handleConfig(b, ts);
    // A side-effect-free liveness and key check, for `turntable doctor`: it reads and changes nothing.
    if (path === "/v1/health") {
      if (!authentic("health", [], ts, b.mac)) return json(401, { ok: false, reason: "bad_mac" });
      return json(200, { ok: true });
    }
    if (path === "/v1/revoke") {
      const attemptId = str("attemptId");
      if (!attemptId) return json(400, { ok: false, reason: "malformed" });
      if (!authentic("revoke", [attemptId], ts, b.mac))
        return json(401, { ok: false, reason: "bad_mac" });
      o.proxy.release(attemptId);
      return json(200, { ok: true });
    }
    const orgId = str("orgId");
    const projectId = str("projectId");
    const runId = str("runId");
    const jobId = str("jobId");
    const attemptId = str("attemptId");
    if (!orgId || !projectId || !runId || !jobId || !attemptId)
      return json(400, { ok: false, reason: "malformed" });
    const ids = { orgId, projectId, runId, jobId, attemptId };
    if (!authentic("register", registerFields(ids), ts, b.mac))
      return json(401, { ok: false, reason: "bad_mac" });
    // A request seen before is not served again, whatever its content.
    if (!fresh(b.mac as string, now())) return json(401, { ok: false, reason: "replay" });
    // The lane's own checks, from the database and its own file; nothing the worker says counts.
    if (!(await attemptIsReleaseRunning(o.db, ids)))
      return json(403, { ok: false, reason: "attempt_not_release_running" });
    const r = await o.proxy.register({ ...ids, ttlMs: o.ttlMs ?? 2 * 3600 * 1000 });
    if (!r.ok) return json(403, { ok: false, reason: r.reason });
    return json(200, {
      ok: true,
      endpoint: r.listen,
      username: r.credential.username,
      password: r.credential.password,
      caPem: r.credential.caPem,
      expiresAt: r.credential.expiresAt,
    });
  }

  const wrapped = async (req: Request): Promise<Response> => {
    try {
      return await handle(req);
    } catch (e) {
      o.log?.(`release channel: ${String(e)}`);
      return json(500, { ok: false, reason: "internal" });
    }
  };

  if ("unix" in o.listen) {
    const path = o.listen.unix;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
    const server = Bun.serve({ unix: path, fetch: wrapped });
    chmodSync(path, 0o600);
    return {
      stop() {
        void server.stop(true);
        rmSync(path, { force: true });
      },
    };
  }
  const { host, port, tls } = o.listen.tcp;
  // Mutual TLS: a client without a certificate from the operator's CA is not served at all.
  const server = Bun.serve({
    hostname: host,
    port,
    tls: { cert: tls.cert, key: tls.key, ca: tls.ca, requestCert: true, rejectUnauthorized: true },
    fetch: wrapped,
  });
  return { stop: () => void server.stop(true) };
}
