// The real environment for doctor: the filesystem, a read-only SQLite handle, the configured
// provider and the release channel.
import { Database } from "bun:sqlite";
import {
  closeSync,
  openSync,
  readSync,
  accessSync,
  constants,
  statSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { controlPost, type ControlTarget } from "@longshore/net";
import { migrations } from "../db/migrations.generated";
import { loadMasterKey } from "../secrets/crypto";
import { createProvider } from "../scheduler/providers";
import { resolveProviderConfig } from "../serve-config";
import { channelMac } from "../release/channel";
import { MISSING_DATABASE } from "./checks";
import type {
  ChannelProbe,
  DoctorCheck,
  DoctorFs,
  DoctorInputs,
  ForwardedSnapshot,
  SqliteReader,
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
  };
}

/** A SQLite handle for reading: one that can write is never handed to a check. */
export function readOnlyReader(db: Database): SqliteReader {
  return { all: (sql, ...params) => db.query(sql).all(...params) as Record<string, unknown>[] };
}

/** The server's own handle, as a reader: it can run queries and nothing else. */
export function readerOf(db: { orm: unknown }): SqliteReader {
  return readOnlyReader((db.orm as { $client: Database }).$client);
}

/** The provider as the server would build it, asked only to diagnose itself. */
export function providerChecks(
  env: Record<string, string | undefined>,
  o: { provider?: string | undefined; providerConfig?: string | undefined; hosted: boolean },
): () => Promise<DoctorCheck[]> {
  return async () => {
    const name = o.provider ?? env.LONGSHORE_PROVIDER?.trim() ?? "docker";
    const area = "provider";
    let provider;
    try {
      const cfg = resolveProviderConfig(
        o.providerConfig ?? env.LONGSHORE_PROVIDER_CONFIG?.trim() ?? undefined,
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
          fix: "Fix the provider config (--provider-config, LONGSHORE_PROVIDER_CONFIG or LONGSHORE_PROVIDER_CONFIG_JSON).",
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
  const keyFile = env.LONGSHORE_PUBLISH_CHANNEL_KEY_FILE?.trim();
  if (!keyFile) return undefined;
  return async () => {
    let key: string;
    try {
      key = (await Bun.file(keyFile).text()).trim();
    } catch {
      return { ok: false, reason: "the key file cannot be read" };
    }
    let target: ControlTarget;
    const url = env.LONGSHORE_PUBLISH_CHANNEL_URL?.trim();
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
            cert: need("LONGSHORE_PUBLISH_CHANNEL_TLS_CERT_FILE"),
            key: need("LONGSHORE_PUBLISH_CHANNEL_TLS_KEY_FILE"),
            ca: need("LONGSHORE_PUBLISH_CHANNEL_TLS_CA_FILE"),
          },
        };
      } else {
        const sock = env.LONGSHORE_PUBLISH_CHANNEL_SOCKET?.trim();
        if (!sock)
          return { ok: false, reason: "neither LONGSHORE_PUBLISH_CHANNEL_SOCKET nor _URL is set" };
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

export interface RealOptions {
  env: Record<string, string | undefined>;
  dataDir: string;
  hosted: boolean;
  provider?: string | undefined;
  providerConfig?: string | undefined;
  observed?: ForwardedSnapshot | undefined;
  /** An already open handle (the server's own); else the database file is opened read-only. */
  sqlite?: SqliteReader | undefined;
}

export function realInputs(o: RealOptions): { inputs: DoctorInputs; close(): void } {
  const dir = resolve(o.dataDir);
  let sqlite = o.sqlite;
  let openError: string | undefined;
  let handle: Database | undefined;
  if (!sqlite) {
    const path = join(dir, "longshore.db");
    if (!existsSync(path)) {
      openError = MISSING_DATABASE;
    } else {
      try {
        handle = new Database(path, { readonly: true, strict: true });
        sqlite = readOnlyReader(handle);
      } catch (e) {
        openError = String(e instanceof Error ? e.message : e);
      }
    }
  }
  const keyFile = o.env.LONGSHORE_MASTER_KEY_FILE?.trim();
  return {
    inputs: {
      env: o.env,
      dataDir: dir,
      hosted: o.hosted,
      fs: realFs(),
      proc: { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 },
      sqlite,
      openError,
      expectedMigrations: migrations.map((m) => m.tag),
      masterKey: () => {
        if (!keyFile) return undefined;
        try {
          return loadMasterKey(keyFile);
        } catch {
          return undefined;
        }
      },
      providerChecks: providerChecks(o.env, {
        provider: o.provider,
        providerConfig: o.providerConfig,
        hosted: o.hosted,
      }),
      channel: channelProbe(o.env),
      observed: o.observed,
      now: Date.now,
    },
    close: () => handle?.close(),
  };
}
