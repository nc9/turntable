import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One row per installation. Placeholder table that proves the migration pipeline. */
export const instance = sqliteTable("instance", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
