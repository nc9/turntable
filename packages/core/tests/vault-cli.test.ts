import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  chainedAudit,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  ensureInstance,
  openDatabase,
  recordTrustClass,
} from "../src/db";
import * as s from "../src/db/schema";
import { initMasterKey } from "../src/secrets/crypto";
import { secretCommand } from "../src/secrets/cli";

const tmp = mkdtempSync(join(tmpdir(), "ls-vault-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const SENTINEL = "s3ntinel-cli-value-31dd";

const capture = async <T>(f: () => Promise<T>): Promise<{ result: T; out: string }> => {
  const lines: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...x: unknown[]) => void lines.push(x.join(" "));
  console.error = (...x: unknown[]) => void lines.push(x.join(" "));
  try {
    return { result: await f(), out: lines.join("\n") };
  } finally {
    [console.log, console.error] = [log, err];
  }
};

test("longshore secret: value from a file, never from argv; list shows no value; audited", async () => {
  const dir = join(tmp, "data");
  const keyFile = join(tmp, "m.key");
  initMasterKey(keyFile);
  const db = openDatabase(join(dir, "longshore.db"));
  await ensureInstance(db);
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  const valueFile = join(tmp, "v.txt");
  writeFileSync(valueFile, `${SENTINEL}\n`);
  const base = ["--data-dir", dir, "--master-key-file", keyFile, "--org", "acme"];

  // no way to put a value on the command line
  const argv = await capture(() =>
    secretCommand(["set", ...base, "--name", "K", "--value", SENTINEL]),
  );
  expect(argv.result).toBe(2);
  expect(argv.out).not.toContain(SENTINEL);

  const set = await capture(() =>
    secretCommand([
      "set",
      ...base,
      "--name",
      "K",
      "--value-file",
      valueFile,
      "--destination",
      "api.example.com",
      "--project",
      "app",
    ]),
  );
  expect(set.result).toBe(0);
  const refused = await capture(() =>
    secretCommand([
      "set",
      ...base,
      "--name",
      "K2",
      "--value-file",
      valueFile,
      "--class",
      "untrusted_pr",
    ]),
  );
  expect(refused.result).toBe(1);
  expect(refused.out).toContain("untrusted_pr");

  const rot = await capture(() =>
    secretCommand([
      "rotate",
      ...base,
      "--project",
      "app",
      "--name",
      "K",
      "--value-file",
      valueFile,
      "--overlap-seconds",
      "30",
    ]),
  );
  expect(rot.result).toBe(0);
  const list = await capture(() => secretCommand(["list", ...base, "--project", "app"]));
  expect(list.out).toContain("K");
  expect(list.out).toContain("versions=v1(until");
  const del = await capture(() =>
    secretCommand(["delete", ...base, "--project", "app", "--name", "K"]),
  );
  expect(del.result).toBe(0);
  expect(
    (await capture(() => secretCommand(["delete", ...base, "--project", "app", "--name", "K"])))
      .result,
  ).toBe(1);

  const audit = (await chainedAudit(db, org.id, 0, 100)).filter((r) => r.op.endsWith("_secret"));
  expect(audit.map((r) => r.op)).toEqual(["set_secret", "rotate_secret", "delete_secret"]);
  const everything = JSON.stringify({
    audit,
    all: await db.orm.select().from(s.auditLog),
    out: [set, rot, list, del].map((x) => x.out),
  });
  expect(everything).not.toContain(SENTINEL);
  expect(readFileSync(valueFile, "utf8")).toContain(SENTINEL); // untouched
  db.close();
});

test("the scheduler's class record is write-once and fenced by the lease owner", async () => {
  const db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "o", name: "o" });
  const project = await createProject(db, { orgId: org.id }, { slug: "p", name: "p" });
  const scope = { orgId: org.id, projectId: project.id };
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "b", name: "b" }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "t" }))!;
  await db.orm
    .update(s.jobAttempts)
    .set({ state: "running", leaseOwner: "w1" })
    .where(eq(s.jobAttempts.id, attempt.id));
  expect(await recordTrustClass(db, scope, attempt.id, "someone-else", "protected")).toBe(false);
  expect(await recordTrustClass(db, scope, attempt.id, "w1", "untrusted_pr")).toBe(true);
  // never changed, never raised
  expect(await recordTrustClass(db, scope, attempt.id, "w1", "protected")).toBe(false);
  const [row] = await db.orm.select().from(s.jobAttempts).where(eq(s.jobAttempts.id, attempt.id));
  expect(row!.trustClass).toBe("untrusted_pr");
});
