// The few SQL spellings that differ between the dialects, for the raw fragments the repos write
// by hand. Everything else in the repos goes through the query builder and needs no help.
import { sql, type SQL } from "drizzle-orm";
import { DIALECT } from "./dialect";

/** The smaller of two values: SQLite's two-argument `min`, Postgres's `least`. */
export const leastOf = (a: SQL, b: SQL): SQL =>
  DIALECT === "pg" ? sql`least(${a}, ${b})` : sql`min(${a}, ${b})`;

/** The larger of two values: SQLite's two-argument `max`, Postgres's `greatest`. */
export const greatestOf = (a: SQL, b: SQL): SQL =>
  DIALECT === "pg" ? sql`greatest(${a}, ${b})` : sql`max(${a}, ${b})`;

/**
 * A number the database must treat as a 64-bit integer (epoch milliseconds). A bare parameter has
 * no type for Postgres to infer inside an expression; the cast is valid on both.
 */
export const asBigint = (n: number): SQL => sql`cast(${n} as bigint)`;
