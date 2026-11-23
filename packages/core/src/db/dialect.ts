// Which SQL dialect this process runs, decided once, before any schema or repo module loads.
//
// Postgres when a database URL is given: `--database-url postgres://...` (or `=`), or
// TURNTABLE_DATABASE_URL. The test harness sets TURNTABLE_TEST_DB (`pglite`, or a postgres URL)
// to run the same suites against Postgres. Anything else is SQLite. It reads process.argv and the
// environment at import, so it needs no wiring from the entry point.

const URL_RE = /^postgres(ql)?:\/\//i;

function fromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--database-url") return argv[i + 1];
    if (a.startsWith("--database-url=")) return a.slice("--database-url=".length);
  }
  return undefined;
}

/** The Postgres URL the process was asked to use, or undefined. */
export function databaseUrl(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const url = fromArgv(argv) ?? env.TURNTABLE_DATABASE_URL?.trim();
  return url && URL_RE.test(url) ? url : undefined;
}

/** `pglite` or a postgres URL when the tests are to run on Postgres. */
export function testDb(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env.TURNTABLE_TEST_DB?.trim();
  return v === "pglite" || (v && URL_RE.test(v)) ? v : undefined;
}

export const DIALECT: "sqlite" | "pg" = databaseUrl() || testDb() ? "pg" : "sqlite";
