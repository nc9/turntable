import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactsCommand, parseSource } from "../src/artifacts/cli";
import { createAttempt, createJob, createRun, type Db, recordArtifact } from "../src/db";
import { startServer } from "../src/server";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let server: ReturnType<typeof startServer>;
let dir: string;
let base: string;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  server = startServer({ port: 0, host: "127.0.0.1", db });
  base = `http://127.0.0.1:${server.port}`;
  dir = mkdtempSync(join(tmpdir(), "ls-art-"));
});
afterEach(async () => {
  await server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function runOf(klass: string, sha: string) {
  const run = await createRun(db, a.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: sha.padEnd(40, "0"),
    repo: "acme/web",
    trust: JSON.stringify({
      class: klass,
      reasons: [],
      facts: {},
      workflowHash: "h",
      decidedAt: 1,
    }),
  });
  const job = (await createJob(db, a.scope, { runId: run.id, jobKey: "j", name: "j" }))!;
  const att = (await createAttempt(db, a.scope, { jobId: job.id, provider: "test" }))!;
  await db.run(async (h) => {
    const { eq } = await import("drizzle-orm");
    const s = await import("../src/db/schema");
    await h.orm
      .update(s.jobAttempts)
      .set({ trustClass: klass })
      .where(eq(s.jobAttempts.id, att.id));
  });
  return { run, attemptId: att.id };
}
async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (m: string) => void out.push(String(m));
  console.error = (m: string) => void err.push(String(m));
  try {
    return { code: await artifactsCommand(args), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}
const tokenFile = async () => {
  const f = join(dir, "t.token");
  writeFileSync(f, (await mintToken(db, { orgId: a.orgId }, "reader")).secret);
  chmodSync(f, 0o600);
  return f;
};

test("sources are <run id>:<name>, and a name may contain a colon", () => {
  expect(parseSource("run1:bin")).toEqual({ run_id: "run1", name: "bin" });
  expect(parseSource("run1:a:b")).toEqual({ run_id: "run1", name: "a:b" });
  for (const bad of ["", "run1", ":x", "run1:"]) expect(() => parseSource(bad), bad).toThrow();
});

test("list shows provenance; check denies a lower class for a release consumer, exit 3", async () => {
  const low = await runOf("untrusted_pr", "1");
  await recordArtifact(db, a.scope, {
    runId: low.run.id,
    attemptId: low.attemptId,
    name: "pr-build",
    sha256: "a".repeat(64),
    size: 7,
  });
  const rel = await runOf("release", "2");
  const f = await tokenFile();
  const common = ["--url", base, "--org", a.slug, "--project", a.projectSlug, "--token-file", f];
  const list = await run(["list", ...common, "--run", low.run.id]);
  expect(list.code).toBe(0);
  expect(list.out).toContain("pr-build");
  expect(list.out).toContain("class untrusted_pr");
  expect(list.out).toContain("a".repeat(64));
  expect(list.out).toContain("(reported)");

  const src = `${low.run.id}:pr-build`;
  const denied = await run([
    "check",
    ...common,
    "--consumer",
    rel.run.id,
    "--source",
    src,
    "--quarantine",
    src,
  ]);
  expect(denied.code).toBe(3);
  expect(denied.out).toContain("deny");
  expect(denied.out).toContain("a release build consumes nothing below the release class");
  // A protected consumer gets quarantine when it asks, deny when it does not.
  const prot = await runOf("protected", "3");
  const asked = await run([
    "check",
    ...common,
    "--consumer",
    prot.run.id,
    "--source",
    src,
    "--quarantine",
    src,
    "--json",
  ]);
  expect(asked.code).toBe(0);
  expect(JSON.parse(asked.out).results[0].decision).toBe("quarantine");
  const not = await run(["check", ...common, "--consumer", prot.run.id, "--source", src]);
  expect(not.code).toBe(3);
});

test("arguments are checked first, and plain http to a remote host is refused", async () => {
  const f = await tokenFile();
  const c = ["--org", a.slug, "--project", a.projectSlug, "--token-file", f];
  expect((await run(["list", "--url", base, ...c])).err).toContain("--run is required");
  expect((await run(["check", "--url", base, ...c])).err).toContain("--consumer");
  expect((await run(["nope"])).code).toBe(2);
  expect((await run(["list", "--url", "http://example.com", ...c, "--run", "x"])).err).toContain(
    "plain http",
  );
});
