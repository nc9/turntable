// The worker's side of the release channel: asks the lane for a publish job's proxy credential,
// and gives the job that instead of the worker's own proxy. The worker holds the request key
// only. What comes back is an endpoint and an attempt-scoped proxy credential, never a publish
// credential.
import { readFileSync } from "node:fs";
import { controlPost, type ControlTarget } from "@turntable/net";
import type { AttemptCredential } from "@turntable/proxy";
import type { ProxyEndpoint } from "@turntable/provider-sdk";
import { parseTrust } from "../db/repos/approve";
import type { ProxyAccess } from "../proxy";
import type { AttemptContext, AttemptOutcome, AttemptRunner } from "../scheduler/types";
import { channelMac, configFields, registerFields, type ConfigAction } from "./channel";

export type ChannelRegister = { ok: true; access: ProxyAccess } | { ok: false; reason: string };

export interface ChannelClient {
  register(a: {
    orgId: string;
    projectId: string;
    runId: string;
    jobId: string;
    attemptId: string;
  }): Promise<ChannelRegister>;
  revoke(attemptId: string): Promise<void>;
}

export function createChannelClient(o: {
  target: ControlTarget;
  key: Buffer | string;
  now?: () => number;
}): ChannelClient {
  const now = o.now ?? Date.now;
  return {
    async register(a) {
      const ts = now();
      let res;
      try {
        res = await controlPost(o.target, "/v1/register", {
          ...a,
          ts,
          mac: channelMac(o.key, "register", registerFields(a), ts),
        });
      } catch {
        return { ok: false, reason: "channel_unreachable" };
      }
      const b = res.json as
        | {
            ok?: boolean;
            reason?: string;
            endpoint?: ProxyEndpoint;
            username?: string;
            password?: string;
            caPem?: string;
            expiresAt?: number;
          }
        | undefined;
      if (res.status !== 200 || !b?.ok || !b.endpoint || !b.username || !b.password || !b.caPem)
        return { ok: false, reason: b?.reason ?? `http_${res.status}` };
      const { endpoint, username, password, caPem } = b;
      const credential: AttemptCredential = {
        username,
        password,
        caPem,
        expiresAt: b.expiresAt ?? 0,
        proxyUrl: (host, port) => `http://${username}:${password}@${host}:${port}`,
      };
      return {
        ok: true,
        access: {
          listen: endpoint,
          credential,
          // The job holds publish rights through this proxy: it must run with no other route.
          vaultRules: true,
          setGithubToken: () => {},
          setOidcMinter: () => {},
        },
      };
    },
    async revoke(attemptId) {
      const ts = now();
      try {
        await controlPost(o.target, "/v1/revoke", {
          attemptId,
          ts,
          mac: channelMac(o.key, "revoke", [attemptId], ts),
        });
      } catch {
        // the lane's own TTL ends it
      }
    },
  };
}

/**
 * Wraps a runner: an attempt of a release-class run asks the lane for a release-proxy credential.
 * When the lane grants one (it signed this run's release, the tag still stands, no freeze) the job
 * runs behind the release proxy, replacing the worker's own proxy for that job. When it does not,
 * or cannot be reached, the job runs as before and can publish nothing. Revoked in a finally and
 * the moment the attempt is aborted.
 */
export function withReleaseChannel(
  runner: AttemptRunner,
  o: { client: ChannelClient },
): AttemptRunner {
  return async (ctx: AttemptContext): Promise<AttemptOutcome> => {
    if (parseTrust(ctx.run)?.class !== "release" || ctx.resume) return runner(ctx);
    const r = await o.client.register({
      orgId: ctx.scope.orgId,
      projectId: ctx.scope.projectId,
      runId: ctx.run.id,
      jobId: ctx.job.id,
      attemptId: ctx.attempt.id,
    });
    if (!r.ok) return runner(ctx);
    const revoke = (): void => void o.client.revoke(ctx.attempt.id);
    ctx.signal.addEventListener("abort", revoke, { once: true });
    try {
      return await runner({ ...ctx, proxy: r.access });
    } finally {
      ctx.signal.removeEventListener("abort", revoke);
      await o.client.revoke(ctx.attempt.id);
    }
  };
}

export type LaneConfigReply =
  | { ok: true; result: unknown }
  | { ok: false; reason: string; kind: "unreachable" | "refused" | "invalid" };

/**
 * The main process's side of the lane's config channel (#541): one signed message per change to the
 * lane's own configuration. It holds the config key, a different key from the worker's request key.
 */
export interface LaneConfigClient {
  call(action: ConfigAction, args: Record<string, unknown>): Promise<LaneConfigReply>;
}

export function createLaneConfigClient(o: {
  target: ControlTarget;
  key: Buffer | string;
  now?: () => number;
}): LaneConfigClient {
  const now = o.now ?? Date.now;
  return {
    async call(action, rawArgs) {
      // What is MACed is what the lane will parse: the arguments after a JSON round trip.
      const args = JSON.parse(JSON.stringify(rawArgs)) as Record<string, unknown>;
      const ts = now();
      let res;
      try {
        res = await controlPost(o.target, "/v1/config", {
          action,
          args,
          ts,
          mac: channelMac(o.key, "config", configFields(action, args), ts),
        });
      } catch {
        return { ok: false, reason: "the release lane could not be reached", kind: "unreachable" };
      }
      const b = res.json as { ok?: boolean; reason?: string; result?: unknown } | undefined;
      if (res.status === 200 && b?.ok) return { ok: true, result: b.result };
      // 422: the lane refused the input and says why. Anything else is a refusal of the channel.
      return res.status === 422 && b?.reason
        ? { ok: false, reason: b.reason, kind: "invalid" }
        : { ok: false, reason: b?.reason ?? `http_${res.status}`, kind: "refused" };
    },
  };
}

/**
 * The lane's config client from the main process's environment, or undefined when it is not set
 * up (no config key): then the instance's release config ops are refused. The channel is the one
 * the worker uses (`TURNTABLE_PUBLISH_CHANNEL_SOCKET` or `_URL` with its TLS files).
 */
export function laneConfigClientFromEnv(
  env: Record<string, string | undefined>,
): LaneConfigClient | undefined {
  const keyFile = env.TURNTABLE_PUBLISH_CONFIG_KEY_FILE?.trim();
  if (!keyFile) return undefined;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`TURNTABLE_PUBLISH_CONFIG_KEY_FILE needs ${name}`);
    return v;
  };
  const url = env.TURNTABLE_PUBLISH_CHANNEL_URL?.trim();
  return createLaneConfigClient({
    key: readFileSync(keyFile, "utf8").trim(),
    target: url
      ? {
          url,
          tls: {
            cert: readFileSync(need("TURNTABLE_PUBLISH_CHANNEL_TLS_CERT_FILE"), "utf8"),
            key: readFileSync(need("TURNTABLE_PUBLISH_CHANNEL_TLS_KEY_FILE"), "utf8"),
            ca: readFileSync(need("TURNTABLE_PUBLISH_CHANNEL_TLS_CA_FILE"), "utf8"),
          },
        }
      : { unix: need("TURNTABLE_PUBLISH_CHANNEL_SOCKET") },
  });
}
