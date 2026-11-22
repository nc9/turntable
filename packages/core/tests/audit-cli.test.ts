import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { auditCommand } from "../src/audit/cli";
import { appendAudit, createOrg, ensureInstance, openDatabase, chainedAudit } from "../src/db";
import * as s from "../src/db/schema";
import { initMasterKey, loadMasterKey } from "../src/secrets/crypto";
import { SecretStore } from "../src/secrets/store";

const tmp = mkdtempSync(join(tmpdir(), "ls-audit-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await f();
  } finally {
    console.log = log;
  }
};

test("secret store writes audit by name, never by value", async () => {
  const db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "o", name: "o" });
  initMasterKey(join(tmp, "m0.key"));
  const store = new SecretStore(db, loadMasterKey(join(tmp, "m0.key")));
  await store.set(org.id, "deploy-token", "super-secret-value");
  await store.delete(org.id, "deploy-token");
  const rows = await chainedAudit(db, org.id, 0, 10);
  expect(rows.map((r) => r.op)).toEqual(["secret_set", "secret_delete"]);
  expect(JSON.stringify(rows)).not.toContain("super-secret-value");
  expect(rows[0]?.input).toContain("deploy-token");
});

test("longshore audit: checkpoint, verify, export, and tamper exit codes", async () => {
  const dir = join(tmp, "data");
  const keyFile = join(tmp, "m.key");
  initMasterKey(keyFile);
  const db = openDatabase(join(dir, "longshore.db"));
  await ensureInstance(db);
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  for (let i = 0; i < 4; i++) {
    await appendAudit(
      db,
      { orgId: org.id },
      {
        principalKind: "member",
        principalId: "m",
        op: "x",
        effect: "write",
        outcome: "ok",
        input: { i },
      },
    );
  }
  const base = ["--data-dir", dir, "--master-key-file", keyFile, "--org", "acme"];
  expect(await quiet(() => auditCommand(["checkpoint", ...base]))).toBe(0);
  expect(await quiet(() => auditCommand(["verify", ...base]))).toBe(0);

  const out = join(tmp, "export");
  expect(await quiet(() => auditCommand(["export", ...base, "--dir", out]))).toBe(0);
  expect(readdirSync(out).length).toBe(1);

  await db.orm
    .update(s.auditLog)
    .set({ outcome: "tampered" })
    .where(and(eq(s.auditLog.orgId, org.id), eq(s.auditLog.seq, 2)));
  expect(await quiet(() => auditCommand(["verify", ...base]))).toBe(1);
  expect(await quiet(() => auditCommand(["bogus"]))).toBe(2);
  db.close();
});
