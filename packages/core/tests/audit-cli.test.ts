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

test("turntable audit: checkpoint, verify, export, and tamper exit codes", async () => {
  const dir = join(tmp, "data");
  const keyFile = join(tmp, "m.key");
  initMasterKey(keyFile);
  const db = openDatabase(join(dir, "turntable.db"));
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
  // nothing is signed, and no key is made, until the operator sets the org up
  expect(await quiet(() => auditCommand(["checkpoint", ...base]))).toBe(0);
  expect(
    await quiet(() =>
      auditCommand(["export-key", ...base, "--out", join(tmp, "nokey.json")]).catch(() => 3),
    ),
  ).toBe(3);
  const pub = join(tmp, "acme.pub.json");
  expect(await quiet(() => auditCommand(["init-key", ...base, "--out", pub]))).toBe(0);
  expect(
    await quiet(() => auditCommand(["init-key", ...base, "--out", join(tmp, "again.json")])),
  ).toBe(1);
  expect(await quiet(() => auditCommand(["checkpoint", ...base]))).toBe(0);

  const out = join(tmp, "export");
  expect(await quiet(() => auditCommand(["export", ...base, "--dir", out]))).toBe(0);
  expect(readdirSync(out).length).toBe(1);

  // anchors kept off the server: the pinned key and the exported checkpoints
  const exported = join(out, readdirSync(out)[0]!);
  const anchored = ["--pubkey", pub, "--anchor", exported];
  const lines: string[] = [];
  const log = console.log;
  console.log = (...m: unknown[]) => lines.push(m.join(" "));
  const okCode = await auditCommand(["verify", ...base, ...anchored]);
  const looseCode = await auditCommand(["verify", ...base]);
  console.log = log;
  expect(okCode).toBe(0);
  expect(lines[0]).toContain("key pinned, checkpoints anchored");
  // the key was made after the first entries, so without the pinned key verify fails
  expect(looseCode).toBe(1);
  expect(lines.join("\n")).toContain("--pubkey");
  // the key file is never overwritten
  await expect(auditCommand(["export-key", ...base, "--out", pub])).rejects.toThrow();

  await db.orm
    .update(s.auditLog)
    .set({ outcome: "tampered" })
    .where(and(eq(s.auditLog.orgId, org.id), eq(s.auditLog.seq, 2)));
  expect(await quiet(() => auditCommand(["verify", ...base]))).toBe(1);
  expect(await quiet(() => auditCommand(["verify", ...base, ...anchored]))).toBe(1);
  expect(await quiet(() => auditCommand(["bogus"]))).toBe(2);
  db.close();
});
