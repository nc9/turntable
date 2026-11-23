// Telling database errors apart, for both dialects.

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The SQLSTATE of a Postgres error, looking through `cause` (drivers wrap it). PGlite and
 * postgres.js put it in `code`; Bun's SQL client puts a generic code there and the SQLSTATE in
 * `errno`.
 */
export function sqlState(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    for (const key of ["code", "errno"] as const) {
      const v = (e as Record<string, unknown>)[key];
      if (typeof v === "string" && SQLSTATE.test(v)) return v;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A unique constraint was violated: SQLite says so in the message, Postgres by SQLSTATE 23505. */
export function isUniqueViolation(err: unknown): boolean {
  if (sqlState(err) === "23505") return true;
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (String((e as { message?: unknown }).message ?? e).includes("UNIQUE constraint failed"))
      return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
