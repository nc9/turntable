// Runs every `test:*` suite script in package.json, one after another (a suite is a handful of
// explicit test files; running them in parallel or as a bare `bun test` exhausts memory).
// A new suite is just a new `test:<name>` script: nothing else lists it, so pull requests that
// add suites stop colliding on one shared line.
//
// Left out because they need Docker, a compiled binary or a live service, and have their own CI
// jobs: the suites named in GATED. (`test:golden` is the release golden path: it is slower and
// runs as its own CI job.)
// `test:pg-only` holds the PGlite-heavy files (one in-process Postgres each): they run in the
// postgres job through `pg:test`, not in this SQLite aggregate.
const GATED = new Set([
  "test:docker",
  "test:act-e2e",
  "test:run-e2e",
  "test:golden",
  "test:vault-e2e",
  "test:pg-only",
]);

const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  scripts: Record<string, string>;
};
const suites = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:") && !GATED.has(k));
if (suites.length === 0) throw new Error("no test:* suites found");

const proc = Bun.spawn(["bun", "run", "--sequential", ...suites], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
