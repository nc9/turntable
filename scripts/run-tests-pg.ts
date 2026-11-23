// Runs the core and ops suites against Postgres: the same `test:*` scripts as `bun run test`,
// with LONGSHORE_TEST_DB set so `openDatabase` gives each test a fresh Postgres database
// (`pglite` for an in-process one, or a postgres:// URL for a real server, as CI does).
//
//   LONGSHORE_TEST_DB=pglite bun run scripts/run-tests-pg.ts
//   LONGSHORE_TEST_DB=postgres://postgres@localhost:5432/postgres bun run scripts/run-tests-pg.ts
//
// Only suites that are plain `bun test <files under packages/core/tests>` run here (the others
// need Docker, a binary or a service and have their own jobs). A few files are about SQLite
// itself or start a second process with its own database; they are listed below, with why.
// At most five files go to one `bun test` (each PGlite-backed process is memory-heavy).
const SQLITE_ONLY = new Map<string, string>([
  ["db.test.ts", "reopens a SQLite file"],
  ["legacy-names.test.ts", "renames SQLite files and the SQLite migrations table"],
  ["migration-parity.test.ts", "compares the SQLite SQL files with the embedded module"],
  ["migration-rebuild.test.ts", "SQLite table-rebuild migrations"],
  ["events-quota-migration.test.ts", "applies the SQLite migrations to a bun:sqlite database"],
  ["migration-sequence-guard.test.ts", "applies the SQLite migrations to a bun:sqlite database"],
  ["tenancy-guard.test.ts", "reads the SQLite schema objects"],
  ["github-serve.test.ts", "starts a server process with its own database"],
  ["master-key-autoinit.test.ts", "starts a server process with its own database"],
]);

const url = process.env.LONGSHORE_TEST_DB;
if (!url) throw new Error("set LONGSHORE_TEST_DB to pglite or a postgres:// URL");

const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  scripts: Record<string, string>;
};
const suites = Object.entries(pkg.scripts).filter(([k, v]) => {
  if (!k.startsWith("test:")) return false;
  if (/^[A-Z_]+=/.test(v)) return false; // env-gated: needs Docker or a binary
  return v.startsWith("bun test ") && v.includes("packages/core/tests/");
});

const failed: string[] = [];
for (const [name, cmd] of suites) {
  const files = cmd
    .slice("bun test ".length)
    .split(/\s+/)
    .filter((f) => f.startsWith("packages/core/tests/"))
    .filter((f) => !SQLITE_ONLY.has(f.split("/").pop()!));
  for (let i = 0; i < files.length; i += 5) {
    const chunk = files.slice(i, i + 5);
    console.log(`\n== ${name}: ${chunk.join(" ")}`);
    const p = Bun.spawn(["bun", "test", ...chunk], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    if ((await p.exited) !== 0) failed.push(`${name}: ${chunk.join(" ")}`);
  }
}
if (failed.length > 0) {
  console.error(`\nfailed on Postgres:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nall ${suites.length} suites passed on Postgres`);
