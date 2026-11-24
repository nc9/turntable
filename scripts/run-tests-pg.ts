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
//
// TURNTABLE_PG_TEST_CONCURRENCY (integer 1 to 8, default 1) runs that many chunks at once. Each
// chunk's output is buffered and printed whole when it finishes, so logs stay readable. A real
// server is safe for this: each test schema is named with the process id (see openDatabase).
import { parsePgConcurrency } from "./pg-concurrency";
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

const concurrency = parsePgConcurrency(process.env.TURNTABLE_PG_TEST_CONCURRENCY);

type Chunk = { name: string; files: string[] };
const chunks: Chunk[] = [];
for (const [name, listed] of suites) {
  const files = listed
    .filter((f) => f.startsWith("packages/core/tests/"))
    .filter((f) => !SQLITE_ONLY.has(f.split("/").pop()!));
  for (let i = 0; i < files.length; i += 5) chunks.push({ name, files: files.slice(i, i + 5) });
}

const failed: string[] = [];
const timings: { label: string; seconds: number }[] = [];

async function runChunk({ name, files }: Chunk): Promise<void> {
  const label = `${name}: ${files.join(" ")}`;
  const start = performance.now();
  const p = Bun.spawn(["bun", "test", ...files], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const seconds = (performance.now() - start) / 1000;
  timings.push({ label, seconds });
  if (code !== 0) failed.push(label);
  // One write per chunk, so a chunk's lines (and its ::group:: blocks) are never interleaved.
  process.stdout.write(
    `\n== ${label}\n${out}${err}-- ${name} chunk took ${seconds.toFixed(1)}s${code !== 0 ? " (FAILED)" : ""}\n`,
  );
}

let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) await runChunk(chunks[next++]!);
  }),
);

console.log(`\nslowest chunks (of ${chunks.length}, concurrency ${concurrency}):`);
for (const t of timings.sort((a, b) => b.seconds - a.seconds).slice(0, 5)) {
  console.log(`  ${t.seconds.toFixed(1)}s  ${t.label}`);
}
if (failed.length > 0) {
  console.error(`\nfailed on Postgres:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nall ${suites.length} suites passed on Postgres`);
