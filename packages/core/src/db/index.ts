import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "./migrate";
import { migrations } from "./migrations.generated";
import * as schema from "./schema";

/**
 * Database handle. Callers depend on this shape, not on bun:sqlite, so a Postgres
 * implementation can be added behind `openDatabase` later.
 */
export type Db = {
  orm: ReturnType<typeof drizzle<typeof schema>>;
  close(): void;
};

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA busy_timeout = 5000");
  applyMigrations(sqlite, migrations);
  return { orm: drizzle(sqlite, { schema }), close: () => sqlite.close() };
}

/** Creates the single instance row on first boot; returns its id. */
export function ensureInstance(db: Db): string {
  const existing = db.orm.select().from(schema.instance).limit(1).get();
  if (existing) return existing.id;
  const id = randomUUID();
  db.orm.insert(schema.instance).values({ id }).run();
  return id;
}

export { schema };
export * from "./repos";
