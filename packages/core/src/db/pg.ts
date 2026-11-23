// The Postgres implementation of `Db` (see index.ts for the contract and the SQLite one).
//
// Drivers, neither with a native dependency, so `bun build --compile` still produces one file for
// every target:
//  - a URL uses Bun's built-in SQL client through drizzle's bun-sql driver;
//  - `pglite` (tests only) is PGlite, Postgres compiled to WASM, loaded by name at runtime so it
//    is never bundled into the binary.
//
// What differs from SQLite, and why the same repos work on both:
//  - there is no gate. Postgres is concurrent, so `run` just runs, with the same async-context
//    handle that lets a root `db` called inside a transaction join it;
//  - a root transaction is SERIALIZABLE and is retried on a serialization failure (40001) or a
//    deadlock (40P01). That is the general answer to the read-then-write patterns the repos use
//    (claiming an attempt, appending to the audit chain, "create if absent"): what SQLite got
//    from one exclusive connection, Postgres gets from the isolation level, across processes as
//    well as within one. A transaction function may therefore run more than once, so it must do
//    database work only; `afterCommit` hooks run once, after the commit that succeeded;
//  - a nested `tx.transaction` is a savepoint (drizzle issues SAVEPOINT);
//  - migrations run in one transaction under an advisory lock, so replicas starting together
//    apply them once;
//  - `openDatabase` is synchronous, so the connection and the migrations are an async `ready`
//    that every call awaits first.
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { drizzle as drizzleBunSql } from "drizzle-orm/bun-sql";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { sqlState } from "./errors";
import { migrateLegacyPgMigrationsTable } from "./legacy-names";
import type { Db, Orm } from "./index";
import { migrations } from "./migrations.pg.generated";
import type { Migration } from "./migrate";
import * as pgSchema from "./schema.pg";

const require_ = createRequire(import.meta.url);

type PgOrm = PgDatabase<never, typeof pgSchema>;

/** Serialization failure and deadlock: the transaction can simply be run again. */
const RETRY_CODES = new Set(["40001", "40P01"]);
/** Colliding transactions commit one per round, so this only bounds a pathological storm. */
const MAX_ATTEMPTS = 30;

/** Runs tasks of the same key one at a time, in order; different keys do not wait for each other. */
class KeyedQueue {
  readonly #tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}

const ended = () => new Error("transaction handle used after it ended");

/** A key for pg_advisory_xact_lock that only this program uses. */
const MIGRATION_LOCK = 0x4c53_4d47; // "LSMG"

/**
 * Applies pending migrations in order inside one transaction, holding an advisory lock so two
 * processes booting together do not both run them. Postgres DDL is transactional, so a failed
 * migration leaves nothing behind.
 */
export async function applyPgMigrations(orm: PgOrm, list: Migration[]): Promise<string[]> {
  const applied: string[] = [];
  await orm.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await migrateLegacyPgMigrationsTable(tx);
    await tx.execute(
      sql`create table if not exists __turntable_migrations (tag text primary key, applied_at bigint not null)`,
    );
    const rows = (await tx.execute(sql`select tag from __turntable_migrations`)) as unknown as
      { tag: string }[] | { rows: { tag: string }[] };
    const done = new Set((Array.isArray(rows) ? rows : rows.rows).map((r) => r.tag));
    for (const m of list.toSorted((a, b) => a.when - b.when)) {
      if (done.has(m.tag)) continue;
      for (const statement of m.statements) await tx.execute(sql.raw(statement));
      await tx.execute(
        sql`insert into __turntable_migrations (tag, applied_at) values (${m.tag}, ${Date.now()})`,
      );
      applied.push(m.tag);
    }
  });
  return applied;
}

/**
 * `schema` (tests): the handle lives in its own schema of a real server, through the connection's
 * search_path, so several databases can be open at once, each as isolated as a SQLite `:memory:`.
 */
export type PgTarget = { url: string; schema?: string } | { pglite: true; isolated?: true };

/** One shared in-process PGlite per process (tests): reset between databases, see `reset`. */
let sharedPglite: { client: { close(): Promise<void> }; orm: PgOrm } | undefined;

function connect(target: PgTarget): { orm: PgOrm; close: () => Promise<void> } {
  if ("url" in target) {
    const orm = target.schema
      ? drizzleBunSql({
          connection: {
            url: target.url,
            // a test database is small and short-lived: few connections, closed when idle
            max: 4,
            idleTimeout: 1,
            connection: { search_path: target.schema },
          },
          schema: pgSchema,
        })
      : drizzleBunSql(target.url, { schema: pgSchema });
    return {
      orm: orm as unknown as PgOrm,
      close: async () => void (await orm.$client.close()),
    };
  }
  // `isolated` (tests that need several databases open at once): a PGlite of its own, not the shared one.
  if (target.isolated || !sharedPglite) {
    // Loaded by a computed name: tests only, and the compiled binary must not bundle the WASM.
    const lib = "@electric-sql/pglite";
    const drv = "drizzle-orm/pglite";
    const { PGlite } = require_(lib) as { PGlite: new () => { close(): Promise<void> } };
    const { drizzle } = require_(drv) as {
      drizzle: (c: unknown, o: unknown) => PgOrm;
    };
    const client = new PGlite();
    const made = { client, orm: drizzle(client, { schema: pgSchema }) };
    if (target.isolated) return { orm: made.orm, close: async () => void (await client.close()) };
    sharedPglite = made;
  }
  return { orm: sharedPglite!.orm, close: async () => {} };
}

/**
 * Empties the schema (the default `public`, or the handle's own): a fresh database for the next
 * test. One transaction under an advisory lock, and idempotent, so two opens at once cannot
 * interleave their drops.
 */
async function reset(orm: PgOrm, schema = "public"): Promise<void> {
  const name = sql.identifier(schema);
  await orm.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK + 1})`);
    await tx.execute(sql`drop schema if exists ${name} cascade`);
    await tx.execute(sql`create schema ${name}`);
  });
}

export function openPostgres(target: PgTarget, opts: { fresh?: boolean } = {}): Db {
  const { orm, close } = connect(target);
  const active = new AsyncLocalStorage<Db>();
  const ready = (async () => {
    if (opts.fresh) await reset(orm, "schema" in target ? target.schema : undefined);
    await applyPgMigrations(orm, migrations);
  })();
  // A failed boot is reported by whoever awaits it; this stops it also being an unhandled rejection.
  ready.catch(() => {});

  const txHandle = (tx: PgOrm, hooks: (() => void)[]): { db: Db; end: () => void } => {
    let open = true;
    const db: Db = {
      orm: tx as unknown as Orm,
      run: (fn) => (open ? active.run(db, () => fn(db)) : Promise.reject(ended())),
      transaction: async (fn) => {
        if (!open) throw ended();
        const mark = hooks.length;
        try {
          // drizzle issues SAVEPOINT for a transaction inside a transaction.
          return await tx.transaction(async (sp) => {
            const inner = txHandle(sp as unknown as PgOrm, hooks);
            try {
              return await active.run(inner.db, () => fn(inner.db));
            } finally {
              inner.end();
            }
          });
        } catch (err) {
          hooks.length = mark; // hooks queued inside a rolled-back savepoint never fire
          throw err;
        }
      },
      afterCommit: (fn) => {
        if (open) hooks.push(fn);
      },
      close: () => {},
    };
    return { db, end: () => void (open = false) };
  };

  // The handle of a repo call outside a transaction. As on SQLite, starting a transaction from
  // inside a repo call is refused: it is how a call ends up holding a connection while it waits
  // for a second one, and the repos are written so it never needs to.
  const held: Db = {
    orm: orm as unknown as Orm,
    run: (fn) => active.run(held, () => fn(held)),
    transaction: () =>
      Promise.reject(new Error("cannot start a transaction inside a repo call (shared gate held)")),
    afterCommit: (fn) => fn(),
    close: () => {},
  };

  const keyed = new KeyedQueue();

  const root: Db = {
    orm: orm as unknown as Orm,
    run: async (fn) => {
      const ctx = active.getStore();
      if (ctx) return ctx.run(fn);
      await ready;
      return active.run(held, () => fn(held));
    },
    transaction: async (fn, opts) => {
      const ctx = active.getStore();
      if (ctx) return ctx.transaction(fn);
      await ready;
      // Same-key root transactions of this process queue here, before any connection is taken,
      // so a long queue never starves the pool of the connection its head needs.
      return opts?.lock === undefined ? runRoot(fn) : keyed.run(opts.lock, () => runRoot(fn));
    },
    afterCommit: (fn) => {
      const ctx = active.getStore();
      if (ctx) ctx.afterCommit(fn);
      else fn();
    },
    close: () => {
      void close();
    },
  };

  async function runRoot<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    {
      for (let attempt = 1; ; attempt++) {
        const hooks: (() => void)[] = [];
        try {
          const out = await orm.transaction(
            async (tx) => {
              const h = txHandle(tx as unknown as PgOrm, hooks);
              try {
                return await active.run(h.db, () => fn(h.db));
              } finally {
                h.end();
              }
            },
            { isolationLevel: "serializable" },
          );
          for (const hook of hooks.splice(0)) {
            try {
              hook();
            } catch (err) {
              console.error("turntable: afterCommit hook failed", err);
            }
          }
          return out;
        } catch (err) {
          const code = sqlState(err);
          if (code !== undefined && RETRY_CODES.has(code) && attempt < MAX_ATTEMPTS) {
            // Back off a little, with jitter, so two colliding transactions do not collide again.
            await Bun.sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
            continue;
          }
          throw err;
        }
      }
    }
  }

  return root;
}
