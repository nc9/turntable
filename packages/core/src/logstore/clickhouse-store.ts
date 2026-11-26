// The `clickhouse` log store (#717): chunks in a MergeTree table, over ClickHouse's HTTP
// interface through the control plane's one outbound client (no driver dependency).
//
// Writes never block the caller or the event loop: `append` puts the chunk in a bounded in-memory
// queue and returns. A timer sends batches over HTTP (with a deadline per request). When the
// store is unreachable the queue grows up to a byte cap, and a chunk that does not fit is dropped
// and reported to `onDrop`, which marks the attempt's log incomplete. Reads see queued chunks too,
// so a live tail does not wait for a flush.
//
// Every DateTime64 column is DateTime64(3, 'UTC'); a test pins that.
import { safeFetch, type SafeFetch } from "@turntable/net";
import {
  assembleRange,
  type LogChunk,
  type LogGrepQuery,
  type LogGrepResult,
  type LogKey,
  type LogStore,
} from "./types";

export type ClickHouseOptions = {
  /** Base URL of the HTTP interface, for example `http://clickhouse.internal:8123`. */
  url: string;
  user?: string | undefined;
  password?: string | undefined;
  database?: string | undefined;
  table?: string | undefined;
  /** Rows older than this are removed by the table's TTL. Default 90. */
  retentionDays?: number | undefined;
  /** Most bytes held in memory while the store is slow or down. Default 64 MiB. */
  maxQueueBytes?: number | undefined;
  /** Largest batch sent in one insert. Default 4 MiB. */
  maxBatchBytes?: number | undefined;
  /** Wait before sending a small batch. Default 200 ms. */
  flushIntervalMs?: number | undefined;
  /** Deadline of one HTTP request. Default 10 s. */
  requestTimeoutMs?: number | undefined;
  /** First and largest wait after a failed send. Default 500 ms and 15 s. */
  backoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  /** A chunk that could not be queued (queue full): the log of that attempt is now incomplete. */
  onDrop?: ((key: LogKey, offset: number, bytes: number) => void) | undefined;
  /** Injectable for tests; defaults to the outbound client. */
  fetch?: SafeFetch | undefined;
  now?: (() => number) | undefined;
};

export class ClickHouseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickHouseError";
  }
}

type Entry = { key: LogKey; offset: number; bytes: Uint8Array; ms: number };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const attemptKey = (k: LogKey): string => `${k.orgId}\u0000${k.projectId}\u0000${k.attemptId}`;
const MAX_READ_BYTES = 128 * 1024 * 1024;

/** The DDL. Retention is an integer checked by the caller, so interpolating it is safe. */
export function createTableSql(table: string, retentionDays: number): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${table} (` +
    "org_id String, project_id String, attempt_id String, " +
    "offset UInt64, " +
    "bytes String CODEC(ZSTD), " +
    "received_at DateTime64(3, 'UTC')" +
    ") ENGINE = MergeTree " +
    "PARTITION BY toYYYYMM(received_at) " +
    "ORDER BY (org_id, project_id, attempt_id, offset) " +
    `TTL toDateTime(received_at, 'UTC') + INTERVAL ${retentionDays} DAY`
  );
}

export class ClickHouseLogStore implements LogStore {
  readonly kind = "clickhouse";
  readonly #base: string;
  readonly #o: ClickHouseOptions;
  readonly #table: string;
  readonly #retention: number;
  readonly #maxQueue: number;
  readonly #maxBatch: number;
  readonly #interval: number;
  readonly #timeout: number;
  readonly #fetch: SafeFetch;
  readonly #now: () => number;
  #queue: Entry[] = [];
  #queueBytes = 0;
  /** Queued and in-flight chunks by attempt then offset, so reads can include them. */
  #index = new Map<string, Map<number, Entry>>();
  #inflight: Entry[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> | undefined;
  #failures = 0;
  #retryAt = 0;
  #lastError: string | undefined;
  dropped = 0;

  constructor(o: ClickHouseOptions) {
    const u = new URL(o.url);
    if (u.username || u.password) {
      throw new ClickHouseError(
        "the ClickHouse URL must not carry credentials; use the user and password settings",
      );
    }
    this.#base = `${u.origin}${u.pathname.replace(/\/+$/, "")}/`;
    this.#o = o;
    this.#table = o.table ?? "log_chunks";
    if (!IDENT.test(this.#table)) throw new ClickHouseError("invalid ClickHouse table name");
    if (o.database !== undefined && !IDENT.test(o.database)) {
      throw new ClickHouseError("invalid ClickHouse database name");
    }
    this.#retention = o.retentionDays ?? 90;
    if (!Number.isInteger(this.#retention) || this.#retention < 1 || this.#retention > 36500) {
      throw new ClickHouseError("retentionDays must be a whole number from 1 to 36500");
    }
    this.#maxQueue = o.maxQueueBytes ?? 64 * 1024 * 1024;
    this.#maxBatch = o.maxBatchBytes ?? 4 * 1024 * 1024;
    this.#interval = o.flushIntervalMs ?? 200;
    this.#timeout = o.requestTimeoutMs ?? 10_000;
    this.#fetch = o.fetch ?? safeFetch;
    this.#now = o.now ?? Date.now;
  }

  /** Creates the table when missing and applies the retention. Call once at boot. */
  async ensureSchema(): Promise<void> {
    await this.#post(createTableSql(this.#table, this.#retention));
    await this.#post(
      `ALTER TABLE ${this.#table} MODIFY TTL toDateTime(received_at, 'UTC') + INTERVAL ${this.#retention} DAY`,
    );
  }

  /** Bytes waiting to be sent, and whether the last send failed. For the doctor and tests. */
  get queued(): { bytes: number; chunks: number; failing: boolean; lastError: string | undefined } {
    return {
      bytes: this.#queueBytes,
      chunks: this.#queue.length + this.#inflight.length,
      failing: this.#failures > 0,
      lastError: this.#lastError,
    };
  }

  // ---- writes ----

  append(key: LogKey, offset: number, bytes: Uint8Array): Promise<void> {
    const idx = this.#index.get(attemptKey(key));
    if (idx?.has(offset)) return Promise.resolve();
    if (this.#queueBytes + bytes.length > this.#maxQueue) {
      this.dropped += 1;
      try {
        this.#o.onDrop?.(key, offset, bytes.length);
      } catch {
        // a reporting failure must not fail the append
      }
      return Promise.resolve();
    }
    // Copy: the caller may reuse its buffer.
    const entry: Entry = { key, offset, bytes: Uint8Array.from(bytes), ms: this.#now() };
    this.#queue.push(entry);
    this.#queueBytes += bytes.length;
    const ak = attemptKey(key);
    let m = this.#index.get(ak);
    if (!m) this.#index.set(ak, (m = new Map()));
    m.set(offset, entry);
    this.#schedule(this.#queueBytes >= this.#maxBatch ? 0 : this.#interval);
    return Promise.resolve();
  }

  #schedule(delay: number): void {
    if (this.#timer !== undefined || this.#sending) return;
    const wait = Math.max(delay, this.#retryAt - this.#now(), 0);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#send().catch(() => {});
    }, wait);
    // A pending flush must not keep the process alive on its own.
    this.#timer.unref?.();
  }

  #send(): Promise<void> {
    if (this.#sending) return this.#sending;
    if (this.#queue.length === 0) return Promise.resolve();
    this.#sending = (async () => {
      try {
        while (this.#queue.length > 0) {
          const batch: Entry[] = [];
          let bytes = 0;
          while (this.#queue.length > 0 && (batch.length === 0 || bytes < this.#maxBatch)) {
            const e = this.#queue[0] as Entry;
            if (batch.length > 0 && bytes + e.bytes.length > this.#maxBatch) break;
            this.#queue.shift();
            batch.push(e);
            bytes += e.bytes.length;
          }
          this.#inflight = batch;
          try {
            await this.#insert(batch);
          } catch (err) {
            // Keep the batch at the head, in order, and back off.
            this.#queue.unshift(...batch);
            this.#inflight = [];
            this.#failures += 1;
            this.#lastError = err instanceof Error ? err.message : String(err);
            const base = this.#o.backoffMs ?? 500;
            const wait = Math.min(
              base * 2 ** Math.min(this.#failures - 1, 10),
              this.#o.maxBackoffMs ?? 15_000,
            );
            this.#retryAt = this.#now() + wait;
            throw err;
          }
          this.#inflight = [];
          this.#failures = 0;
          this.#lastError = undefined;
          this.#retryAt = 0;
          this.#queueBytes -= bytes;
          for (const e of batch) {
            const ak = attemptKey(e.key);
            const m = this.#index.get(ak);
            if (m?.get(e.offset) === e) {
              m.delete(e.offset);
              if (m.size === 0) this.#index.delete(ak);
            }
          }
        }
      } finally {
        this.#sending = undefined;
        if (this.#queue.length > 0) this.#schedule(this.#interval);
      }
    })();
    return this.#sending;
  }

  async #insert(batch: readonly Entry[]): Promise<void> {
    const body =
      batch
        .map((e) =>
          JSON.stringify({
            org_id: e.key.orgId,
            project_id: e.key.projectId,
            attempt_id: e.key.attemptId,
            offset: e.offset,
            b64: Buffer.from(e.bytes).toString("base64"),
            ms: e.ms,
          }),
        )
        .join("\n") + "\n";
    const query =
      `INSERT INTO ${this.#table} SELECT org_id, project_id, attempt_id, offset, base64Decode(b64), ` +
      "fromUnixTimestamp64Milli(ms, 'UTC') " +
      "FROM input('org_id String, project_id String, attempt_id String, offset UInt64, b64 String, ms Int64') " +
      "FORMAT JSONEachRow";
    await this.#post(body, { query, async_insert: "1", wait_for_async_insert: "1" });
  }

  /** Sends everything queued now, waiting for it. Throws while the store is unreachable. */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // A flush asked for explicitly does not wait out the backoff.
    this.#retryAt = 0;
    while (this.#queue.length > 0 || this.#sending) {
      await this.#send();
    }
  }

  // ---- HTTP ----

  async #post(
    body: string,
    params: Record<string, string> = {},
    maxBytes = 1024 * 1024,
  ): Promise<string> {
    const url = new URL(this.#base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (this.#o.database) url.searchParams.set("database", this.#o.database);
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
    if (this.#o.user) headers["x-clickhouse-user"] = this.#o.user;
    if (this.#o.password) headers["x-clickhouse-key"] = this.#o.password;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        timeoutMs: this.#timeout,
        maxBytes,
      });
    } catch (err) {
      throw new ClickHouseError(
        `ClickHouse request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new ClickHouseError(
        `ClickHouse answered ${res.status}: ${text.slice(0, 300).replace(/\s+/g, " ")}`,
      );
    }
    return text;
  }

  async #select(
    sql: string,
    params: Record<string, string | number>,
    maxBytes = 1024 * 1024,
  ): Promise<Record<string, string>[]> {
    const q: Record<string, string> = { max_execution_time: "20" };
    for (const [k, v] of Object.entries(params)) q[`param_${k}`] = String(v);
    const text = await this.#post(`${sql} FORMAT JSONEachRow`, q, maxBytes);
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, string>);
  }

  #where(key: LogKey): { sql: string; params: Record<string, string> } {
    return {
      sql: "org_id = {o:String} AND project_id = {p:String} AND attempt_id = {a:String}",
      params: { o: key.orgId, p: key.projectId, a: key.attemptId },
    };
  }

  // ---- reads ----

  #pendingOf(key: LogKey): Entry[] {
    return [...(this.#index.get(attemptKey(key))?.values() ?? [])];
  }

  /** Stored chunks and queued ones merged by offset; the stored copy wins (first write wins). */
  #merge(
    stored: LogChunk[],
    pending: readonly Entry[],
    pred: (c: LogChunk) => boolean,
  ): LogChunk[] {
    const have = new Set(stored.map((c) => c.offset));
    const out = [...stored];
    for (const e of pending) {
      if (have.has(e.offset)) continue;
      const c = { offset: e.offset, bytes: Buffer.from(e.bytes) };
      if (pred(c)) out.push(c);
    }
    return out.sort((a, b) => a.offset - b.offset);
  }

  async #chunks(key: LogKey, extra: string, params: Record<string, number>): Promise<LogChunk[]> {
    const w = this.#where(key);
    const rows = await this.#select(
      `SELECT offset, base64Encode(bytes) AS b FROM ${this.#table} WHERE ${w.sql}${extra} ` +
        "ORDER BY offset, received_at LIMIT 1 BY offset",
      { ...w.params, ...params },
      MAX_READ_BYTES,
    );
    return rows.map((r) => ({ offset: Number(r.offset), bytes: Buffer.from(r.b ?? "", "base64") }));
  }

  async read(key: LogKey, fromOffset = 0): Promise<LogChunk[]> {
    const stored = await this.#chunks(key, " AND offset >= {from:UInt64}", { from: fromOffset });
    return this.#merge(stored, this.#pendingOf(key), (c) => c.offset >= fromOffset);
  }

  async range(key: LogKey, from: number, to: number): Promise<Buffer> {
    if (to <= from) return Buffer.alloc(0);
    const stored = await this.#chunks(
      key,
      " AND offset < {to:UInt64} AND offset + length(bytes) > {from:UInt64}",
      { from, to },
    );
    const merged = this.#merge(
      stored,
      this.#pendingOf(key),
      (c) => c.offset < to && c.offset + c.bytes.length > from,
    );
    return assembleRange(merged, from, to);
  }

  async tail(key: LogKey, maxBytes: number): Promise<{ start: number; bytes: Buffer }> {
    const { size } = await this.stat(key);
    const start = Math.max(0, size - maxBytes);
    return { start, bytes: await this.range(key, start, size) };
  }

  async stat(key: LogKey): Promise<{ chunks: number; size: number }> {
    const w = this.#where(key);
    const [row] = await this.#select(
      `SELECT uniqExact(offset) AS c, max(offset + length(bytes)) AS s FROM ${this.#table} WHERE ${w.sql}`,
      w.params,
    );
    let chunks = Number(row?.c ?? 0);
    let size = Number(row?.s ?? 0);
    const have = new Set((await this.#knownOffsets(key)) ?? []);
    for (const e of this.#pendingOf(key)) {
      size = Math.max(size, e.offset + e.bytes.length);
      if (!have.has(e.offset)) chunks += 1;
    }
    return { chunks, size };
  }

  /** Offsets of this attempt that are both queued and already stored (an insert that raced a read). */
  async #knownOffsets(key: LogKey): Promise<number[] | undefined> {
    const pend = this.#pendingOf(key).map((e) => e.offset);
    if (pend.length === 0) return [];
    const w = this.#where(key);
    const rows = await this.#select(
      `SELECT DISTINCT offset FROM ${this.#table} WHERE ${w.sql} AND offset IN (${pend.map((n) => String(Math.trunc(n))).join(",")})`,
      w.params,
    );
    return rows.map((r) => Number(r.offset));
  }

  async grep(key: LogKey, q: LogGrepQuery): Promise<LogGrepResult> {
    const w = this.#where(key);
    const test = q.regex
      ? "match(bytes, {pat:String})"
      : q.ignoreCase
        ? "positionCaseInsensitiveUTF8(bytes, {pat:String}) > 0"
        : "position(bytes, {pat:String}) > 0";
    const pat = q.regex && q.ignoreCase ? `(?i)${q.pattern}` : q.pattern;
    const rows = await this.#select(
      `SELECT offset FROM ${this.#table} WHERE ${w.sql} AND offset >= {from:UInt64} AND ${test} ` +
        "GROUP BY offset ORDER BY offset LIMIT {lim:UInt32}",
      { ...w.params, from: q.from, pat, lim: q.limit },
    );
    const hits = rows.map((r) => Number(r.offset));
    if (hits.length >= q.limit) return { hits, next: (hits.at(-1) ?? 0) + 1 };
    return { hits, next: null };
  }

  async deleteAttempt(key: LogKey): Promise<void> {
    // Drop what is queued for it, wait for an insert already on the wire, then delete what is stored.
    const ak = attemptKey(key);
    const m = this.#index.get(ak);
    if (m) {
      const gone = new Set(m.values());
      this.#queue = this.#queue.filter((e) => {
        const drop = gone.has(e);
        if (drop) this.#queueBytes -= e.bytes.length;
        return !drop;
      });
      for (const e of [...m.values()]) if (!this.#inflight.includes(e)) m.delete(e.offset);
      if (m.size === 0) this.#index.delete(ak);
    }
    if (this.#sending) await this.#sending.catch(() => {});
    const w = this.#where(key);
    const q: Record<string, string> = { mutations_sync: "1" };
    for (const [k, v] of Object.entries(w.params)) q[`param_${k}`] = v;
    await this.#post(`ALTER TABLE ${this.#table} DELETE WHERE ${w.sql}`, q);
  }

  async orgBytes(orgId: string): Promise<number> {
    // A plain sum: a chunk inserted twice by a retried batch counts twice until a merge.
    const [row] = await this.#select(
      `SELECT sum(length(bytes)) AS n FROM ${this.#table} WHERE org_id = {o:String}`,
      { o: orgId },
    );
    return Number(row?.n ?? 0);
  }
}
