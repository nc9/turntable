// Reads the log store settings from the environment and builds the store.
import { ClickHouseLogStore, type ClickHouseOptions } from "./clickhouse-store";
import type { LogKey, LogStore } from "./types";

export type LogStoreKind = "db" | "clickhouse";

export type LogStoreConfig =
  | { kind: "db" }
  | { kind: "clickhouse"; options: Omit<ClickHouseOptions, "onDrop" | "fetch" | "now"> };

function intIn(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/** `TURNTABLE_LOG_STORE` is `db` (default) or `clickhouse`; the second needs `TURNTABLE_CLICKHOUSE_URL`. */
export function logStoreConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): LogStoreConfig {
  const kind = (env.TURNTABLE_LOG_STORE ?? "db").trim().toLowerCase();
  if (kind === "db" || kind === "") return { kind: "db" };
  if (kind !== "clickhouse") {
    throw new Error(`TURNTABLE_LOG_STORE must be "db" or "clickhouse", not "${kind}"`);
  }
  const url = env.TURNTABLE_CLICKHOUSE_URL?.trim();
  if (!url) throw new Error("TURNTABLE_LOG_STORE=clickhouse needs TURNTABLE_CLICKHOUSE_URL");
  const retentionDays = intIn(
    "TURNTABLE_LOG_RETENTION_DAYS",
    env.TURNTABLE_LOG_RETENTION_DAYS,
    1,
    36500,
  );
  const maxQueueMib = intIn("TURNTABLE_LOG_QUEUE_MIB", env.TURNTABLE_LOG_QUEUE_MIB, 1, 4096);
  return {
    kind: "clickhouse",
    options: {
      url,
      user: env.TURNTABLE_CLICKHOUSE_USER?.trim() || undefined,
      password: env.TURNTABLE_CLICKHOUSE_PASSWORD || undefined,
      database: env.TURNTABLE_CLICKHOUSE_DATABASE?.trim() || undefined,
      retentionDays,
      maxQueueBytes: maxQueueMib === undefined ? undefined : maxQueueMib * 1024 * 1024,
    },
  };
}

/** The days of logs `log_store_migrate` copies by default (`TURNTABLE_LOG_MIGRATE_DAYS`). */
export function migrateDaysFromEnv(env: Record<string, string | undefined> = process.env): number {
  return intIn("TURNTABLE_LOG_MIGRATE_DAYS", env.TURNTABLE_LOG_MIGRATE_DAYS, 1, 3650) ?? 14;
}

/** Builds and prepares the configured store; undefined for `db`. */
export async function openLogStore(
  cfg: LogStoreConfig,
  onDrop: (key: LogKey, offset: number, bytes: number) => void,
): Promise<LogStore | undefined> {
  if (cfg.kind === "db") return undefined;
  const store = new ClickHouseLogStore({ ...cfg.options, onDrop });
  await store.ensureSchema();
  return store;
}
