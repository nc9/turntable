// Runs the core and ops suites against Postgres: the same `test:*` scripts as `bun run test`,
// with TURNTABLE_TEST_DB set so `openDatabase` gives each test a fresh Postgres database
// (`pglite` for an in-process one, or a postgres:// URL for a real server, as CI does).
//
//   TURNTABLE_TEST_DB=pglite bun run scripts/run-tests-pg.ts
//   TURNTABLE_TEST_DB=postgres://postgres@localhost:5432/postgres bun run scripts/run-tests-pg.ts
//
// Only suites that are plain group runs (`bun scripts/run-test-group.ts <group>`, files read from
// scripts/test-groups/<group>.txt) with files under packages/core/tests run here (the others
// need Docker, a binary or a service and have their own jobs). A few files are about SQLite
// itself or start a second process with its own database; they are listed below, with why.
// At most five files go to one `bun test` (each PGlite-backed process is memory-heavy).
import { parseGroupCall, readGroup, testScripts } from "./test-groups";

const SQLITE_ONLY = new Map<string, string>([
  ["db.test.ts", "reopens a SQLite file"],
  ["legacy-names.test.ts", "renames SQLite files and the SQLite migrations table"],
  ["migration-parity.test.ts", "compares the SQLite SQL files with the embedded module"],
  ["migration-rebuild.test.ts", "SQLite table-rebuild migrations"],
  ["events-quota-migration.test.ts", "applies the SQLite migrations to a bun:sqlite database"],
  ["migration-sequence-guard.test.ts", "applies the SQLite migrations to a bun:sqlite database"],
  ["migration-sha.test.ts", "applies the SQLite migrations to a bun:sqlite database"],
  ["migration-concurrent.test.ts", "opens one SQLite file from two connections"],
  ["tenancy-guard.test.ts", "reads the SQLite schema objects"],
  ["github-serve.test.ts", "starts a server process with its own database"],
  ["master-key-autoinit.test.ts", "starts a server process with its own database"],
  ["settings-boot.test.ts", "starts a server process with its own database"],
  ["instance-bootstrap-boot.test.ts", "starts a server process with its own database"],
]);

const url = process.env.TURNTABLE_TEST_DB;
if (!url) throw new Error("set TURNTABLE_TEST_DB to pglite or a postgres:// URL");

const suites: [string, string[]][] = [];
for (const [k, v] of Object.entries(testScripts())) {
  const call = parseGroupCall(v);
  if (!call || call.env.length > 0) continue; // env-gated: needs Docker or a binary
  const files = readGroup(call.group);
  if (files.some((f) => f.includes("packages/core/tests/"))) suites.push([k, files]);
}

const failed: string[] = [];
for (const [name, listed] of suites) {
  const files = listed
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
