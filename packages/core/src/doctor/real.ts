// The real environment for doctor: the filesystem, a read-only database handle, the configured
// provider and the release channel.
import { sql, type SQL } from "drizzle-orm";
import {
  closeSync,
  openSync,
  readSync,
  accessSync,
  constants,
  statSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { controlPost, type ControlTarget } from "@turntable/net";
import { DIALECT } from "../db/dialect";
import { embeddedMigrationTags, openReadOnly } from "../db/read-only";
import { loadMasterKey } from "../secrets/crypto";
import { releaseKeyLocation } from "../roles";
import { AuditAnchor } from "../audit/anchor";
import { auditStateDir, type MasterKeys, parseMasterKeyValue } from "../secrets/master-key";
import { createProvider } from "../scheduler/providers";
import { resolveProviderConfig } from "../serve-config";
import { channelMac } from "../release/channel";
import { laneConfigClientFromEnv } from "../release/channel-client";
import { MISSING_DATABASE } from "./checks";
import type {
  ChannelProbe,
  DoctorCheck,
  DoctorFs,
  DoctorInputs,
  ForwardedSnapshot,
  DbReader,
} from "./types";

export function realFs(): DoctorFs {
  return {
    stat(path) {
      try {
        const s = statSync(path);
        return {
          uid: s.uid,
          gid: s.gid,
          mode: s.mode & 0o777,
          size: s.size,
          isDirectory: s.isDirectory(),
        };
      } catch {
        return undefined;
      }
    },
    writable(path) {
      try {
        accessSync(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    read(path, maxBytes) {
      try {
        const fd = openSync(path, "r");
        try {
          const buf = Buffer.alloc(maxBytes);
          const n = readSync(fd, buf, 0, maxBytes, 0);
          return buf.subarray(0, n);
        } finally {
          closeSync(fd);
        }
      } catch {
        return undefined;
      }
    },
    list(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
}

/**
 * The server's own handle, as a reader: it can run queries and nothing else. It goes through the
 * ORM, so it is the same code on SQLite and Postgres.
 */
export function readerOf(db: { orm: unknown }): DbReader {
  const orm = db.orm as {
    all?(q: SQL): Record<string, unknown>[];
    execute?(q: SQL): Promise<Record<string, unknown>[] | { rows: Record<string, unknown>[] }>;
  };
  const all = async (q: SQL): Promise<Record<string, unknown>[]> => {
    if (DIALECT === "pg") {
      const r = await orm.execute!(q);
      return Array.isArray(r) ? r : r.rows;
    }
    return orm.all!(q);
  };
  return {
    all,
    async hasTable(name) {
      const rows =
        DIALECT === "pg"
          ? await all(
              sql`SELECT 1 AS found FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ${name}`,
            )
          : await all(
              sql`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ${name}`,
            );
      return rows.length > 0;
    },
  };
}

/** The provider as the server would build it, asked only to diagnose itself. */
export function providerChecks(
  env: Record<string, string | undefined>,
  o: { provider?: string | undefined; providerConfig?: string | undefined; hosted: boolean },
): () => Promise<DoctorCheck[]> {
  return async () => {
    const name = o.provider ?? env.TURNTABLE_PROVIDER?.trim() ?? "docker";
    const area = "provider";
    let provider;
    try {
      const cfg = resolveProviderConfig(
        o.providerConfig ?? env.TURNTABLE_PROVIDER_CONFIG?.trim() ?? undefined,
        env,
      );
      provider = createProvider(name, cfg, { hosted: o.hosted });
    } catch (e) {
      return [
        {
          id: `${name}.config`,
          area,
          status: "fail",
          summary: `the ${name} provider config is not usable`,
          detail: String(e instanceof Error ? e.message : e).slice(0, 200),
          fix: "Fix the provider config (--provider-config, TURNTABLE_PROVIDER_CONFIG or TURNTABLE_PROVIDER_CONFIG_JSON).",
        },
      ];
    }
    if (provider.diagnose) {
      try {
        return (await provider.diagnose()).map((c) => ({ ...c, area }));
      } catch (e) {
        return [
          {
            id: `${name}.diagnose`,
            area,
            status: "fail",
            summary: `${name} could not be checked`,
            detail: String(e).slice(0, 160),
            fix: "Check the provider's credentials and network.",
          },
        ];
      }
    }
    try {
      await provider.healthcheck();
      return [
        {
          id: `${name}.health`,
          area,
          status: "pass",
          summary: `the ${name} provider answers its health check`,
        },
      ];
    } catch (e) {
      return [
        {
          id: `${name}.health`,
          area,
          status: "fail",
          summary: `the ${name} provider is not usable`,
          detail: String(e instanceof Error ? e.message : e).slice(0, 160),
          fix:
            name === "docker"
              ? "Start the Docker daemon and make sure this user may use its socket."
              : "Check the provider's configuration and credentials.",
        },
      ];
    }
  };
}

/** Asks the release lane something harmless that proves the socket and the key: an idempotent revoke. */
export function channelProbe(
  env: Record<string, string | undefined>,
): (() => Promise<ChannelProbe>) | undefined {
  const keyFile = env.TURNTABLE_PUBLISH_CHANNEL_KEY_FILE?.trim();
  if (!keyFile) return undefined;
  return async () => {
    let key: string;
    try {
      key = (await Bun.file(keyFile).text()).trim();
    } catch {
      return { ok: false, reason: "the key file cannot be read" };
    }
    let target: ControlTarget;
    const url = env.TURNTABLE_PUBLISH_CHANNEL_URL?.trim();
    try {
      if (url) {
        const need = (n: string): string => {
          const f = env[n]?.trim();
          if (!f) throw new Error(`${n} is not set`);
          return readFileSync(f, "utf8");
        };
        target = {
          url,
          tls: {
            cert: need("TURNTABLE_PUBLISH_CHANNEL_TLS_CERT_FILE"),
            key: need("TURNTABLE_PUBLISH_CHANNEL_TLS_KEY_FILE"),
            ca: need("TURNTABLE_PUBLISH_CHANNEL_TLS_CA_FILE"),
          },
        };
      } else {
        const sock = env.TURNTABLE_PUBLISH_CHANNEL_SOCKET?.trim();
        if (!sock)
          return { ok: false, reason: "neither TURNTABLE_PUBLISH_CHANNEL_SOCKET nor _URL is set" };
        target = { unix: sock };
      }
    } catch (e) {
      return {
        ok: false,
        reason: "the channel configuration is incomplete",
        detail: String(e instanceof Error ? e.message : e).slice(0, 120),
      };
    }
    const ts = Date.now();
    try {
      const r = await controlPost(
        target,
        "/v1/health",
        { ts, mac: channelMac(key, "health", [], ts) },
        { timeoutMs: 5000 },
      );
      if (r.status === 200) return { ok: true };
      if (r.status === 401)
        return {
          ok: false,
          reason:
            "the lane rejected the request key (the two key files differ, or the clocks are more than a minute apart)",
        };
      return { ok: false, reason: `the lane answered HTTP ${r.status}` };
    } catch {
      return { ok: false, reason: "the lane is not reachable at the configured socket or address" };
    }
  };
}

const LANE_VARS = [
  "TURNTABLE_PUBLISH_CHANNEL_KEY_FILE",
  "TURNTABLE_PUBLISH_CHANNEL_SOCKET",
  "TURNTABLE_PUBLISH_CHANNEL_URL",
  "TURNTABLE_PUBLISH_CONFIG_KEY_FILE",
] as const;

/** A release lane is expected when any variable that points this process at one is set. */
export const releaseLaneExpected = (env: Record<string, string | undefined>): boolean =>
  LANE_VARS.some((n) => Boolean(env[n]?.trim()));

/**
 * Asks the lane's config channel a read that changes nothing (the public key of a key that does
 * not exist): an answer, even a refusal of the input, proves the address and the config key.
 */
export function configChannelProbe(
  env: Record<string, string | undefined>,
): (() => Promise<ChannelProbe>) | undefined {
  if (!env.TURNTABLE_PUBLISH_CONFIG_KEY_FILE?.trim()) return undefined;
  return async () => {
    let client;
    try {
      client = laneConfigClientFromEnv(env);
    } catch (e) {
      return {
        ok: false,
        reason: "the config channel configuration is incomplete",
        detail: String(e instanceof Error ? e.message : e).slice(0, 120),
      };
    }
    if (!client) return { ok: false, reason: "TURNTABLE_PUBLISH_CONFIG_KEY_FILE is not set" };
    const r = await client.call("key_public", { orgId: "doctor-probe", name: "doctor-probe" });
    if (r.ok || r.kind === "invalid") return { ok: true };
    return { ok: false, reason: r.reason };
  };
}

export interface RealOptions {
  env: Record<string, string | undefined>;
  dataDir: string;
  hosted: boolean;
  provider?: string | undefined;
  providerConfig?: string | undefined;
  observed?: ForwardedSnapshot | undefined;
  /** An already open handle (the server's own); else the database file is opened read-only. */
  db?: DbReader | undefined;
  /** The keys the server took at boot (TURNTABLE_MASTER_KEY is deleted from its environment). */
  masterKeys?: MasterKeys | undefined;
  /** See `DoctorInputs.humanApprovalGaps`; only the server, which has the settings layers, sets it. */
  humanApprovalGaps?: (() => Promise<number>) | undefined;
  /** See `DoctorInputs.humanAnyKeyPolicy`; only the server sets it. */
  humanAnyKeyPolicy?: (() => Promise<number>) | undefined;
}

export function realInputs(o: RealOptions): { inputs: DoctorInputs; close(): void } {
  const dir = resolve(o.dataDir);
  let reader = o.db;
  let openError: string | undefined;
  let close = (): void => {};
  if (!reader) {
    const path = join(dir, "turntable.db");
    if (DIALECT !== "pg" && !existsSync(path)) {
      openError = MISSING_DATABASE;
    } else {
      try {
        const handle = openReadOnly(path);
        reader = readerOf(handle);
        close = handle.close;
      } catch (e) {
        openError = String(e instanceof Error ? e.message : e);
      }
    }
  }
  const keyFile = o.env.TURNTABLE_MASTER_KEY_FILE?.trim();
  const envKey = o.env.TURNTABLE_MASTER_KEY?.trim();
  return {
    inputs: {
      env: o.env,
      dataDir: dir,
      hosted: o.hosted,
      fs: realFs(),
      proc: { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 },
      db: reader,
      openError,
      expectedMigrations: embeddedMigrationTags(),
      humanApprovalGaps: o.humanApprovalGaps,
      humanAnyKeyPolicy: o.humanAnyKeyPolicy,
      masterKeyEnv: o.masterKeys ? o.masterKeys.source === "env" : Boolean(envKey),
      masterKey: () => {
        if (o.masterKeys) return o.masterKeys.key;
        try {
          if (envKey) return parseMasterKeyValue("TURNTABLE_MASTER_KEY", envKey);
          return keyFile ? loadMasterKey(keyFile) : undefined;
        } catch {
          return undefined;
        }
      },
      releaseKey: releaseKeyLocation(o.env),
      auditStateDir:
        o.masterKeys || keyFile || envKey
          ? auditStateDir(o.masterKeys ?? (keyFile ? { file: keyFile } : undefined), dir, o.env)
          : undefined,
      unreadableAnchors: () => {
        try {
          const key =
            o.masterKeys?.key ??
            (envKey
              ? parseMasterKeyValue("TURNTABLE_MASTER_KEY", envKey)
              : keyFile
                ? loadMasterKey(keyFile)
                : undefined);
          if (!key) return [];
          const anchorDir = auditStateDir(
            o.masterKeys ?? (keyFile ? { file: keyFile } : undefined),
            dir,
            o.env,
          );
          return new AuditAnchor(anchorDir, key).unreadable();
        } catch {
          return [];
        }
      },
      providerChecks: providerChecks(o.env, {
        provider: o.provider,
        providerConfig: o.providerConfig,
        hosted: o.hosted,
      }),
      channel: channelProbe(o.env),
      releaseLaneExpected: releaseLaneExpected(o.env),
      configChannel: configChannelProbe(o.env),
      observed: o.observed,
      now: Date.now,
    },
    close,
  };
}
