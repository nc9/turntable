import { Database } from "bun:sqlite";
import { describeSqlite, instrumentSlowSql, slowSqlMsFromEnv } from "./slow-sql";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { Gate } from "./gate";
import { BUSY_TIMEOUT_MS, enableWal } from "./sqlite-wal";
import { migrateLegacyDbFiles } from "./legacy-names";
import { applyMigrations } from "./migrate";
import { migrations } from "./migrations.generated";
import { databaseUrl, DIALECT, testDb } from "./dialect";
import { openPostgres } from "./pg";
import * as schema from "./schema";

/** The drizzle handle for the active dialect. Postgres will widen or replace this alias. */
export type Orm = BunSQLiteDatabase<typeof schema>;

/**
 * Database handle. Callers depend on this shape, not on bun:sqlite, so a Postgres
 * implementation can be added behind `openDatabase` later.
 *
 * Repos query with `await orm.select()...` (no `.get()`, `.all()` or `.run()`, which only the
 * sync SQLite driver has) and wrap each public function in `db.run`. Rules:
 *
 * - `run(fn)` executes one repo call. On SQLite it holds a shared gate so a transaction cannot
 *   start mid-call and swallow its statements; Postgres can just call `fn`. Inside `fn`, use
 *   the handle it receives for nested repo calls. Starting a transaction from inside `run` throws
 *   (it would deadlock on the shared gate this call holds).
 * - `transaction(fn)` runs `fn` atomically and awaits it. `fn` gets a `tx` handle and must use
 *   only `tx` for database work. Throwing rolls back. A nested `tx.transaction` is a savepoint.
 * - On SQLite there is one connection, so transactions are exclusive: they wait for in-flight
 *   repo calls and block new ones until done. Keep `fn` short and do no network I/O inside it.
 *   Calling the root `db` from inside `fn` is safe: an AsyncLocalStorage context tracks the
 *   active handle, so root `run` joins the transaction and root `transaction` becomes a
 *   savepoint. (Work detached from `fn`'s async context, e.g. a pre-existing promise, does not
 *   join and waits for the transaction to finish.)
 * - drizzle's own `orm.transaction` is NOT async-safe on bun-sqlite (it commits when the
 *   callback returns a promise, before it settles). Never use it; use `db.transaction`.
 */
export type Db = {
  orm: Orm;
  run<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /**
   * `opts.lock` names a hot key (an org's audit chain, say). On Postgres, root transactions that
   * name the same key in this process run one after another instead of colliding and retrying,
   * which only costs a wait; other keys are unaffected, and across processes the SERIALIZABLE
   * retry still decides. SQLite's transactions are already exclusive, so it ignores the key.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>, opts?: { lock?: string }): Promise<T>;
  /**
   * Runs `fn` once the outermost transaction commits, and never if it rolls back (a rolled-back
   * savepoint drops the hooks queued inside it). Outside a transaction it runs at once. Use it
   * for wake-ups that must not fire before the data is visible.
   */
  afterCommit(fn: () => void): void;
  close(): void;
};

const ended = () => new Error("transaction handle used after it ended");

/**
 * Opens the database. A `postgres://` URL (or, when set, the process's `--database-url` /
 * TURNTABLE_DATABASE_URL) selects Postgres; anything else is a SQLite file path or `:memory:`.
 * The test harness can send `:memory:` to Postgres too (TURNTABLE_TEST_DB), so the same suites
 * run on both. The dialect of the schema modules was fixed at import (dialect.ts), so a URL is
 * only valid in a process that started as Postgres.
 */
const testPaths = new Map<string, string>();
let testSchemas = 0;
const schemasToDrop = new Map<string, string[]>();

/** Best effort: drop the test schemas when the process is done, so a dev server is not littered. */
function scheduleSchemaCleanup(url: string, schema: string): void {
  if (schemasToDrop.size === 0) {
    process.on("beforeExit", async () => {
      for (const [u, list] of schemasToDrop) {
        schemasToDrop.delete(u);
        try {
          const { SQL } = await import("bun");
          const c = new SQL(u);
          for (const s of list) await c.unsafe(`drop schema if exists "${s}" cascade`);
          await c.close();
        } catch {
          // the server may be gone already
        }
      }
    });
  }
  const list = schemasToDrop.get(url) ?? [];
  list.push(schema);
  schemasToDrop.set(url, list);
}

export function openDatabase(path: string): Db {
  if (/^postgres(ql)?:\/\//i.test(path)) {
    if (DIALECT !== "pg") {
      throw new Error(
        "this process started on SQLite; start it with --database-url to use Postgres",
      );
    }
    return openPostgres({ url: path });
  }
  if (DIALECT === "pg") {
    const t = testDb();
    // In the test harness `:memory:` is a fresh Postgres database, and so is the first open of a
    // file path; opening the same path again is the same database, as it is for a file (CLI
    // tests open one beside the test's own handle). On a real server each is its own schema, so
    // several can be open at once; PGlite is one connection, so there it is one database that
    // each fresh open empties.
    if (t) {
      const fresh = path === ":memory:" || !testPaths.has(path);
      let schema = path === ":memory:" ? undefined : testPaths.get(path);
      if (schema === undefined) {
        schema = `lstest_${process.pid}_${++testSchemas}`;
        if (path !== ":memory:") testPaths.set(path, schema);
        if (t !== "pglite") scheduleSchemaCleanup(t, schema);
      }
      return openPostgres(
        t === "pglite"
          ? {
              pglite: true,
              ...(process.env.TURNTABLE_TEST_PGLITE_ISOLATED === "1"
                ? { isolated: true as const }
                : {}),
            }
          : { url: t, schema },
        { fresh },
      );
    }
    const url = databaseUrl();
    if (url) return openPostgres({ url });
    throw new Error("the process runs on Postgres but no database was configured");
  }
  migrateLegacyDbFiles(path);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path, { create: true, strict: true });
  // Diagnostics (#693): log any synchronous statement slower than TURNTABLE_SLOW_SQL_MS.
  const slowMs = slowSqlMsFromEnv();
  if (slowMs !== undefined) {
    instrumentSlowSql(sqlite, slowMs);
    if (path !== ":memory:") console.error(describeSqlite(sqlite, path));
  }
  // First, before anything that takes a lock, so every later statement waits for another
  // connection's lock instead of failing at once (the CLI runs next to a server, or next to a
  // test's own handle).
  sqlite.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  enableWal(sqlite);
  sqlite.run("PRAGMA foreign_keys = ON");
  applyMigrations(sqlite, migrations);
  const orm = drizzle(sqlite, { schema });
  const gate = new Gate();
  /** Handle of the innermost active transaction or repo call in this async context. */
  const active = new AsyncLocalStorage<Db>();

  const txHandle = (depth: number, hooks: (() => void)[]): { tx: Db; end: () => void } => {
    let open = true;
    let savepoints = 0;
    const tx: Db = {
      orm,
      run: (fn) => (open ? active.run(tx, () => fn(tx)) : Promise.reject(ended())),
      transaction: async (fn) => {
        if (!open) throw ended();
        const name = `tt_sp_${depth}_${++savepoints}`;
        const inner = txHandle(depth + 1, hooks);
        const mark = hooks.length;
        sqlite.run(`SAVEPOINT ${name}`);
        try {
          const out = await active.run(inner.tx, () => fn(inner.tx));
          sqlite.run(`RELEASE ${name}`);
          return out;
        } catch (err) {
          sqlite.run(`ROLLBACK TO ${name}`);
          sqlite.run(`RELEASE ${name}`);
          hooks.length = mark; // hooks queued inside a rolled-back savepoint never fire
          throw err;
        } finally {
          inner.end();
        }
      },
      afterCommit: (fn) => {
        if (open) hooks.push(fn);
      },
      close: () => {},
    };
    return { tx, end: () => void (open = false) };
  };

  // Handle given to a repo call that already holds the shared gate: nested repo calls reuse
  // the hold (re-acquiring could deadlock behind a queued transaction).
  const held: Db = {
    orm,
    run: (fn) => active.run(held, () => fn(held)),
    transaction: () =>
      Promise.reject(new Error("cannot start a transaction inside a repo call (shared gate held)")),
    afterCommit: (fn) => fn(), // statements outside a transaction are already committed
    close: () => {},
  };

  return {
    orm,
    run: async (fn) => {
      const ctx = active.getStore();
      if (ctx) return ctx.run(fn); // inside a transaction or repo call: join it
      const release = await gate.shared();
      try {
        return await active.run(held, () => fn(held));
      } finally {
        release();
      }
    },
    transaction: async (fn) => {
      const ctx = active.getStore();
      if (ctx) return ctx.transaction(fn); // savepoint inside a transaction; throws inside run
      const release = await gate.exclusive();
      const hooks: (() => void)[] = [];
      const { tx, end } = txHandle(0, hooks);
      try {
        sqlite.run("BEGIN IMMEDIATE");
        try {
          const out = await active.run(tx, () => fn(tx));
          sqlite.run("COMMIT");
          for (const hook of hooks.splice(0)) {
            try {
              hook();
            } catch (err) {
              console.error("turntable: afterCommit hook failed", err);
            }
          }
          return out;
        } catch (err) {
          if (sqlite.inTransaction) sqlite.run("ROLLBACK");
          throw err;
        }
      } finally {
        end();
        release();
      }
    },
    afterCommit: (fn) => {
      const ctx = active.getStore();
      if (ctx) ctx.afterCommit(fn);
      else fn();
    },
    close: () => sqlite.close(),
  };
}

/** Creates the single instance row on first boot; returns its id. */
export function ensureInstance(db: Db): Promise<string> {
  // A transaction: two processes booting together must not both insert (serializable on Postgres).
  return db.transaction(async ({ orm }) => {
    const [existing] = await orm.select().from(schema.instance).limit(1);
    if (existing) return existing.id;
    const id = randomUUID();
    await orm.insert(schema.instance).values({ id });
    return id;
  });
}

export { schema };
export * from "./abort-bus";
export * from "./repos";
