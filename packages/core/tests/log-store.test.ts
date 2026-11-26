// The log store (#717): one contract run against the database store and the ClickHouse store
// (a test double of its HTTP interface; set TT_CLICKHOUSE_TEST_URL to run it on a real server),
// the outage behaviour, and the migration.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendLog,
  attemptsWithCuts,
  listCuts,
  listNotices,
  logSize,
  openDatabase,
  readLog,
  deleteProjectCascade,
  claimNextAttempt,
  createAttempt,
  createJob,
  createRun,
  quotaUsage,
  readLogRange,
  setOrgQuotas,
  resetAttemptOutput,
} from "../src/db";
import { ClickHouseLogStore, createTableSql } from "../src/logstore/clickhouse-store";
import { DbLogStore } from "../src/logstore/db-store";
import { migrateLogs } from "../src/logstore/migrate";
import { createDropReporter, LOG_STORE_CUT_REASON } from "../src/logstore/outage";
import { setLogStore } from "../src/logstore/registry";
import { logStoreConfigFromEnv } from "../src/logstore/config";
import type { LogKey, LogStore } from "../src/logstore/types";
import { fakeClickHouse } from "./clickhouse-fake";
import { seedTenant, type Tenant } from "./ops-helpers";

afterEach(() => setLogStore(undefined));

const enc = (s: string) => new TextEncoder().encode(s);

type Backend = { name: string; make(): Promise<{ store: LogStore; key: LogKey; other: LogKey }> };

const backends: Backend[] = [
  {
    name: "db",
    async make() {
      const db = openDatabase(":memory:");
      const a = await seedTenant(db, "org-a");
      const b = await seedTenant(db, "org-b");
      return { store: new DbLogStore(db), key: keyOf(a), other: keyOf(b) };
    },
  },
  {
    name: "clickhouse",
    async make() {
      const url = process.env.TT_CLICKHOUSE_TEST_URL;
      const fake = fakeClickHouse();
      const store = new ClickHouseLogStore({
        url: url ?? "http://clickhouse.test:8123",
        ...(url ? { table: `t_${Date.now().toString(36)}` } : { fetch: fake.fetch }),
        flushIntervalMs: 5,
      });
      await store.ensureSchema();
      return {
        store,
        key: { orgId: "o1", projectId: "p1", attemptId: "a1" },
        other: { orgId: "o2", projectId: "p2", attemptId: "a2" },
      };
    },
  },
];

function keyOf(t: Tenant): LogKey {
  return { orgId: t.orgId, projectId: t.projectId, attemptId: t.attemptId };
}

for (const b of backends) {
  describe(`log store contract: ${b.name}`, () => {
    async function seeded() {
      const x = await b.make();
      await x.store.append(x.key, 0, enc("alpha line\nbeta Line\n"));
      await x.store.append(x.key, 21, enc("gamma\nERROR delta\n"));
      await x.store.append(x.key, 39, enc("epsilon\n"));
      await x.store.flush();
      return x;
    }

    test("append and read: chunks in order, from an offset", async () => {
      const { store, key } = await seeded();
      expect((await store.read(key)).map((c) => [c.offset, c.bytes.toString()])).toEqual([
        [0, "alpha line\nbeta Line\n"],
        [21, "gamma\nERROR delta\n"],
        [39, "epsilon\n"],
      ]);
      expect((await store.read(key, 21)).map((c) => c.offset)).toEqual([21, 39]);
    });

    test("a second write at the same offset is ignored", async () => {
      const { store, key } = await seeded();
      await store.append(key, 21, enc("OVERWRITE\n"));
      await store.flush();
      expect((await store.read(key, 21))[0]?.bytes.toString()).toBe("gamma\nERROR delta\n");
      expect((await store.stat(key)).chunks).toBe(3);
    });

    const FULL = "alpha line\nbeta Line\ngamma\nERROR delta\nepsilon\n";

    test("range cuts across chunks and tolerates a gap", async () => {
      const { store, key } = await seeded();
      expect((await store.range(key, 15, 27)).toString()).toBe(FULL.slice(15, 27));
      expect((await store.range(key, 0, 1000)).toString()).toBe(FULL);
      expect((await store.range(key, 5, 5)).length).toBe(0);
      await store.append(key, 100, enc("late\n"));
      await store.flush();
      expect((await store.range(key, 36, 104)).toString()).toBe(FULL.slice(36) + "late");
    });

    test("tail returns the last bytes and where they start", async () => {
      const { store, key } = await seeded();
      const t = await store.tail(key, 10);
      expect(t.start).toBe(37);
      expect(t.bytes.toString()).toBe(FULL.slice(37));
      const all = await store.tail(key, 10_000);
      expect(all.start).toBe(0);
      expect(all.bytes.toString()).toBe(FULL);
    });

    test("stat counts chunks and ends at the highest byte", async () => {
      const { store, key } = await seeded();
      expect(await store.stat(key)).toEqual({ chunks: 3, size: 47 });
    });

    test("grep finds chunks, case-insensitively, with a cursor", async () => {
      const { store, key } = await seeded();
      const q = { pattern: "line", regex: false, ignoreCase: true, from: 0, limit: 10 };
      expect(await store.grep(key, q)).toEqual({ hits: [0], next: null });
      expect((await store.grep(key, { ...q, ignoreCase: false })).hits).toEqual([0]);
      expect((await store.grep(key, { ...q, pattern: "error", ignoreCase: false })).hits).toEqual(
        [],
      );
      const e = { ...q, pattern: "e", ignoreCase: false };
      const first = await store.grep(key, { ...e, limit: 1 });
      expect(first.hits).toEqual([0]);
      expect(first.next).not.toBeNull();
      const second = await store.grep(key, { ...e, limit: 1, from: first.next! });
      expect(second.hits).toEqual([21]);
      const re = await store.grep(key, {
        ...q,
        pattern: "^ERROR d",
        regex: true,
        ignoreCase: false,
      });
      expect(re.hits.length).toBeLessThanOrEqual(1);
    });

    test("every call is scoped: another tenant sees nothing and deletes nothing", async () => {
      const { store, key, other } = await seeded();
      expect(await store.read(other)).toEqual([]);
      expect(await store.stat(other)).toEqual({ chunks: 0, size: 0 });
      expect(
        (
          await store.grep(other, {
            pattern: "a",
            regex: false,
            ignoreCase: false,
            from: 0,
            limit: 5,
          })
        ).hits,
      ).toEqual([]);
      await store.deleteAttempt(other);
      expect((await store.stat(key)).chunks).toBe(3);
      expect(await store.orgBytes(other.orgId)).toBe(0);
    });

    test("deleteAttempt removes the log and orgBytes follows", async () => {
      const { store, key } = await seeded();
      expect(await store.orgBytes(key.orgId)).toBe(47);
      await store.deleteAttempt(key);
      expect(await store.read(key)).toEqual([]);
      expect(await store.orgBytes(key.orgId)).toBe(0);
      await store.append(key, 0, enc("fresh\n"));
      await store.flush();
      expect((await store.read(key)).map((c) => c.bytes.toString())).toEqual(["fresh\n"]);
    });
  });
}

describe("parity: the same operations give the same answers on both stores", () => {
  test("read, range, tail, stat, grep agree", async () => {
    const [d, c] = await Promise.all(backends.map((b) => b.make()));
    const out: unknown[][] = [];
    for (const x of [d!, c!]) {
      await x.store.append(x.key, 0, enc("one\ntwo\n"));
      await x.store.append(x.key, 8, enc("Three\nfour\n"));
      await x.store.append(x.key, 19, enc("five\n"));
      await x.store.flush();
      const g = { pattern: "THREE", regex: false, ignoreCase: true, from: 0, limit: 10 };
      out.push([
        (await x.store.read(x.key, 8)).map((k) => [k.offset, k.bytes.toString()]),
        (await x.store.range(x.key, 3, 21)).toString(),
        (await x.store.tail(x.key, 7)).bytes.toString(),
        await x.store.stat(x.key),
        await x.store.grep(x.key, g),
        await x.store.grep(x.key, { ...g, pattern: "o", ignoreCase: false, limit: 1 }),
      ]);
    }
    expect(out[0]).toEqual(out[1]!);
  });
});

describe("the repos use the configured store", () => {
  test("appendLog, readLog, logSize and readLogRange go to the store, not log_chunks", async () => {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-a");
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({
      url: "http://ch.test:8123",
      fetch: fake.fetch,
      flushIntervalMs: 5,
    });
    setLogStore(store);
    expect(await appendLog(db, t.scope, t.attemptId, 0, enc("hello\n"))).toBe(true);
    // Visible before the flush: a live tail does not wait for the batch.
    expect(await logSize(db, t.scope, t.attemptId)).toBe(6);
    expect((await readLogRange(db, t.scope, t.attemptId, 1, 4)).toString()).toBe("ell");
    await store.flush();
    expect(fake.rows.length).toBe(1);
    setLogStore(undefined);
    expect(await readLog(db, t.scope, t.attemptId)).toEqual([]);
    setLogStore(store);
    // Another org's scope reads nothing, even with the attempt id.
    const o = await seedTenant(db, "org-b");
    expect(await logSize(db, o.scope, t.attemptId)).toBe(0);
    // A reset clears the store.
    expect(await resetAttemptOutput(db, t.scope, t.attemptId, "nobody")).toBe(false);
  });
});

describe("the ClickHouse wire", () => {
  test("DDL: every DateTime64 column is DateTime64(3, 'UTC')", () => {
    const sources = [
      createTableSql("log_chunks", 90),
      readFileSync(join(import.meta.dir, "../src/logstore/clickhouse-store.ts"), "utf8"),
      readFileSync(join(import.meta.dir, "../../../docs/log-store.mdx"), "utf8"),
    ];
    for (const s of sources) {
      const all = s.match(/DateTime64\([^)]*\)/g) ?? [];
      for (const m of all) expect(m).toBe("DateTime64(3, 'UTC')");
    }
    expect(createTableSql("log_chunks", 90)).toContain("received_at DateTime64(3, 'UTC')");
    expect(createTableSql("log_chunks", 90)).toContain(
      "TTL toDateTime(received_at, 'UTC') + INTERVAL 90 DAY",
    );
    expect(createTableSql("log_chunks", 7)).toContain("PARTITION BY toYYYYMM(received_at)");
    expect(createTableSql("log_chunks", 7)).toContain(
      "ORDER BY (org_id, project_id, attempt_id, offset)",
    );
  });

  test("ids reach the server as bound parameters, credentials as headers", async () => {
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({
      url: "http://ch.test:8123/",
      user: "svc",
      password: "pw-value",
      fetch: fake.fetch,
    });
    const evil = { orgId: "o'; DROP TABLE x; --", projectId: "p", attemptId: "a" };
    await store.stat(evil);
    const req = fake.requests.at(-1)!;
    expect(req.body).not.toContain("DROP TABLE");
    expect(req.url.searchParams.get("param_o")).toBe(evil.orgId);
    expect(req.headers["x-clickhouse-user"]).toBe("svc");
    expect(req.headers["x-clickhouse-key"]).toBe("pw-value");
    expect(req.url.toString()).not.toContain("pw-value");
    expect(() => new ClickHouseLogStore({ url: "http://u:p@ch.test:8123" })).toThrow();
    expect(() => new ClickHouseLogStore({ url: "http://ch.test", table: "x; drop" })).toThrow();
    expect(() => new ClickHouseLogStore({ url: "http://ch.test", retentionDays: 0 })).toThrow();
  });

  test("settings: db by default, clickhouse needs a URL, bad values stop the boot", () => {
    expect(logStoreConfigFromEnv({})).toEqual({ kind: "db" });
    expect(() => logStoreConfigFromEnv({ TURNTABLE_LOG_STORE: "clickhouse" })).toThrow(/URL/);
    expect(() => logStoreConfigFromEnv({ TURNTABLE_LOG_STORE: "s3" })).toThrow();
    expect(() =>
      logStoreConfigFromEnv({
        TURNTABLE_LOG_STORE: "clickhouse",
        TURNTABLE_CLICKHOUSE_URL: "http://h",
        TURNTABLE_LOG_RETENTION_DAYS: "0",
      }),
    ).toThrow();
    const c = logStoreConfigFromEnv({
      TURNTABLE_LOG_STORE: "clickhouse",
      TURNTABLE_CLICKHOUSE_URL: "http://h",
      TURNTABLE_LOG_RETENTION_DAYS: "30",
    });
    expect(c.kind === "clickhouse" && c.options.retentionDays).toBe(30);
  });

  test("appends batch into few inserts", async () => {
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: fake.fetch,
      flushIntervalMs: 20,
    });
    const key = { orgId: "o", projectId: "p", attemptId: "a" };
    for (let i = 0; i < 50; i++) await store.append(key, i * 4, enc("abc\n"));
    await store.flush();
    expect(fake.rows.length).toBe(50);
    expect(fake.inserts).toBeLessThanOrEqual(2);
  });
});

describe("store outage", () => {
  /** Largest gap between two ticks of a 5 ms timer while `work` runs. */
  async function maxLag(work: () => Promise<void>): Promise<number> {
    let last = performance.now();
    let worst = 0;
    const t = setInterval(() => {
      const n = performance.now();
      worst = Math.max(worst, n - last - 5);
      last = n;
    }, 5);
    await work();
    await Bun.sleep(30);
    clearInterval(t);
    return worst;
  }

  test("an unreachable store never stalls the loop; overflow drops are reported", async () => {
    const fake = fakeClickHouse();
    fake.hang = true;
    const drops: [LogKey, number, number][] = [];
    const store = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: fake.fetch,
      requestTimeoutMs: 50,
      maxQueueBytes: 256 * 1024,
      flushIntervalMs: 1,
      backoffMs: 5,
      onDrop: (k, o, n) => drops.push([k, o, n]),
    });
    const key = { orgId: "o", projectId: "p", attemptId: "a" };
    const chunk = new Uint8Array(1024).fill(97);
    const lag = await maxLag(async () => {
      for (let i = 0; i < 2000; i++) {
        await store.append(key, i * 1024, chunk);
        if (i % 100 === 0) await Bun.sleep(1);
      }
    });
    expect(lag).toBeLessThan(150);
    expect(drops.length).toBeGreaterThan(0);
    expect(store.queued.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(store.dropped).toBe(drops.length);
    // Queued chunks stay readable from memory even with the store down? Reads need the store.
    await expect(store.stat(key)).rejects.toThrow();
    // It recovers when the store comes back: what was queued is delivered.
    await Bun.sleep(80);
    fake.hang = false;
    // A request already in flight when the store came back may still time out: flush joins it.
    await store.flush().catch(() => {});
    await store.flush();
    expect(fake.rows.length).toBe(2000 - drops.length);
    expect(store.queued.failing).toBe(false);
  });

  test("dropped chunks mark the log incomplete: a cut with a reason and one notice", async () => {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-a");
    const fake = fakeClickHouse();
    fake.down = new Error("connect ECONNREFUSED");
    const errs: string[] = [];
    const reporter = createDropReporter(db, {
      delayMs: 5,
      onError: (e) => errs.push((e as Error).stack ?? ""),
    });
    const store = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: fake.fetch,
      maxQueueBytes: 4096,
      flushIntervalMs: 1,
      backoffMs: 5,
      onDrop: (k, o, n) => reporter.report(k, o, n),
    });
    setLogStore(store);
    expect(await attemptsWithCuts(db, t.scope, [t.attemptId])).toEqual(new Set());
    const chunk = new Uint8Array(1024).fill(98);
    for (let i = 0; i < 10; i++) await appendLog(db, t.scope, t.attemptId, i * 1024, chunk);
    await reporter.settled();
    expect(await attemptsWithCuts(db, t.scope, [t.attemptId])).toEqual(new Set([t.attemptId]));
    const cuts = await listCuts(db, t.scope, t.attemptId);
    expect(cuts.length).toBe(1);
    expect(cuts[0]?.reason).toBe(LOG_STORE_CUT_REASON);
    expect(cuts[0]?.atOffset).toBe(4096);
    expect(cuts[0]?.omittedBytes).toBe(6 * 1024);
    expect((await listNotices(db, t.scope, t.attemptId)).length).toBe(1);
    // The write path itself still answered at once for every call above, with the store down.
    fake.down = undefined;
    await store.flush();
    expect(fake.rows.length).toBe(4);
  });
});

describe("log_store_migrate", () => {
  async function world() {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-a");
    for (let i = 0; i < 5; i++) await appendLog(db, t.scope, t.attemptId, i * 6, enc(`row ${i}\n`));
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: fake.fetch,
      flushIntervalMs: 1,
    });
    return { db, t, fake, store };
  }

  test("copies, verifies counts, and a second run changes nothing", async () => {
    const { db, t, fake, store } = await world();
    const now = Date.now();
    const first = await migrateLogs(db, store, { days: 14, now });
    expect(first).toMatchObject({
      attempts: 1,
      copied: 1,
      skipped: 0,
      chunks: 5,
      bytes: 30,
      verified: 1,
      mismatches: [],
    });
    expect(fake.rows.length).toBe(5);
    const second = await migrateLogs(db, store, { days: 14, now });
    expect(second).toMatchObject({
      attempts: 1,
      copied: 0,
      skipped: 1,
      chunks: 0,
      verified: 1,
      mismatches: [],
    });
    expect(fake.rows.length).toBe(5);
    expect(
      await store.stat({ orgId: t.orgId, projectId: t.projectId, attemptId: t.attemptId }),
    ).toEqual({ chunks: 5, size: 30 });
  });

  test("a partly copied attempt is completed without duplicates", async () => {
    const { db, t, fake, store } = await world();
    await store.append(
      { orgId: t.orgId, projectId: t.projectId, attemptId: t.attemptId },
      0,
      enc("row 0\n"),
    );
    await store.flush();
    const r = await migrateLogs(db, store, { days: 14, now: Date.now() });
    expect(r).toMatchObject({ copied: 1, verified: 1, mismatches: [] });
    expect(
      (await store.read({ orgId: t.orgId, projectId: t.projectId, attemptId: t.attemptId })).length,
    ).toBe(5);
    expect(fake.rows.length).toBe(5);
  });

  test("a store that loses a chunk is reported as a mismatch", async () => {
    const { db, fake, store } = await world();
    const orig = fake.fetch;
    let n = 0;
    fake.fetch = async (i, init) => {
      const url = new URL(String(i));
      const r = await orig(i, init);
      if (url.searchParams.get("query")?.startsWith("INSERT") && n++ === 0) fake.rows.pop();
      return r;
    };
    const st = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: (i, init) => fake.fetch(i, init),
      flushIntervalMs: 1,
    });
    const r = await migrateLogs(db, st, { days: 14, now: Date.now() });
    expect(r.verified).toBe(0);
    expect(r.mismatches.length).toBe(1);
    void store;
  });

  test("attempts older than the window are not copied", async () => {
    const { db, store } = await world();
    const r = await migrateLogs(db, store, { days: 1, now: Date.now() + 3 * 86_400_000 });
    expect(r.attempts).toBe(0);
  });
});

describe("review fixes (#719)", () => {
  function hungWorld() {
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: fake.fetch,
      requestTimeoutMs: 400,
      flushIntervalMs: 1,
    });
    return { fake, store };
  }

  test("log reads wait on the store outside the database gate", async () => {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-a");
    const { fake, store } = hungWorld();
    setLogStore(store);
    fake.hang = true;
    const reads = [
      readLog(db, t.scope, t.attemptId),
      logSize(db, t.scope, t.attemptId),
      readLogRange(db, t.scope, t.attemptId, 0, 10),
    ].map((p) => p.catch(() => undefined));
    await Bun.sleep(20);
    const t0 = performance.now();
    await db.transaction(async (tx) => {
      await listCuts(tx, t.scope, t.attemptId);
    });
    expect(performance.now() - t0).toBeLessThan(150);
    await Promise.all(reads);
  });

  test("quota usage in the claim path does not wait on the store and fails open", async () => {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-quota");
    const { fake, store } = hungWorld();
    setLogStore(store);
    fake.hang = true;
    const t0 = performance.now();
    const u = await quotaUsage(db, t.orgId, Date.now(), { maxLogBytes: 1000 }, { noWait: true });
    expect(performance.now() - t0).toBeLessThan(150);
    expect(u.logBytes).toBe(0);
    await Bun.sleep(450);
  });

  test("claims proceed while the store is down, with a log-bytes limit set", async () => {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-claim");
    await setOrgQuotas(db, t.orgId, { maxLogBytes: 1000 }, "test", Date.now());
    const { fake, store } = hungWorld();
    setLogStore(store);
    fake.hang = true;
    const run = await createRun(db, t.scope, {
      workflowPath: "w.yml",
      event: "push",
      ref: "main",
      sha: "b".repeat(40),
    });
    const job = (await createJob(db, t.scope, { runId: run.id, jobKey: "j", name: "j" }))!;
    await createAttempt(db, t.scope, { jobId: job.id, provider: "fake" });
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) {
      await claimNextAttempt(db, {
        owner: "w",
        leaseMs: 1000,
        now: Date.now(),
        globalCap: 100,
        perOrgCap: 100,
      });
    }
    expect(performance.now() - t0).toBeLessThan(150);
    await Bun.sleep(450);
  });

  test("deleting a project removes its logs from the external store", async () => {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-del");
    const { fake, store } = hungWorld();
    setLogStore(store);
    await appendLog(db, t.scope, t.attemptId, 0, enc("keep me not\n"));
    await store.flush();
    expect(fake.rows.length).toBe(1);
    expect(await deleteProjectCascade(db, { orgId: t.orgId }, t.projectId)).toBe(true);
    // The store is cleared after the commit, in the background.
    for (let i = 0; i < 100 && fake.rows.length > 0; i++) await Bun.sleep(5);
    expect(fake.rows.length).toBe(0);
    expect(await store.orgBytes(t.orgId)).toBe(0);
  });

  test("deleting a project inside an op transaction does not hold the write lock on the store", async () => {
    const db = openDatabase(":memory:");
    const t = await seedTenant(db, "org-lock");
    const { fake, store } = hungWorld();
    setLogStore(store);
    await appendLog(db, t.scope, t.attemptId, 0, enc("x\n"));
    await store.flush();
    fake.hang = true;
    const t0 = performance.now();
    await db.transaction(async (tx) => {
      expect(await deleteProjectCascade(tx, { orgId: t.orgId }, t.projectId)).toBe(true);
    });
    expect(performance.now() - t0).toBeLessThan(150);
    await Bun.sleep(450);
  });

  test("a chunk deleted while its insert fails is neither read nor blocks a replay", async () => {
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: fake.fetch,
      flushIntervalMs: 1,
      backoffMs: 1,
      requestTimeoutMs: 100,
    });
    const key = { orgId: "o", projectId: "p", attemptId: "a" };
    fake.hang = true;
    await store.append(key, 0, enc("old\n"));
    await Bun.sleep(30); // the insert is on the wire
    const del = store.deleteAttempt(key).catch(() => {});
    await del; // the insert timed out; the delete then hung too
    fake.hang = false;
    await store.append(key, 0, enc("new\n"));
    await store.flush();
    const got = await store.read(key);
    expect(Buffer.concat(got.map((c) => c.bytes)).toString()).toBe("new\n");
  });

  test("orgBytes counts a chunk once when a retried batch inserted it twice", async () => {
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({ url: "http://ch.test", fetch: fake.fetch });
    const key = { orgId: "o", projectId: "p", attemptId: "a" };
    await store.append(key, 0, enc("abcd"));
    await store.flush();
    fake.rows.push({ ...(fake.rows[0] as (typeof fake.rows)[number]), seq: 99 });
    expect(fake.rows.length).toBe(2);
    expect(await store.orgBytes("o")).toBe(4);
  });

  test("a chunk deleted while on the wire is not sent again after a failed send", async () => {
    const fake = fakeClickHouse();
    const store = new ClickHouseLogStore({
      url: "http://ch.test",
      fetch: fake.fetch,
      flushIntervalMs: 1,
      backoffMs: 1,
    });
    const key = { orgId: "o", projectId: "p", attemptId: "a" };
    fake.down = new Error("down");
    await store.append(key, 0, enc("x\n"));
    await Bun.sleep(30);
    await store.deleteAttempt(key).catch(() => {});
    fake.down = undefined;
    await store.flush().catch(() => {});
    await store.flush();
    expect(fake.rows.length).toBe(0);
  });

  test("the retention is applied at boot only when it changed", async () => {
    const fake = fakeClickHouse();
    const mk = (days: number) =>
      new ClickHouseLogStore({ url: "http://ch.test", fetch: fake.fetch, retentionDays: days });
    await mk(30).ensureSchema();
    const alters = () => fake.statements.filter((s) => s.includes("MODIFY TTL")).length;
    expect(alters()).toBe(0);
    await mk(30).ensureSchema();
    expect(alters()).toBe(0);
    await mk(60).ensureSchema();
    expect(alters()).toBe(1);
  });
});
