import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db } from "../src/db";
import { listAudit } from "../src/db/repos";
import { putSecretRecord } from "../src/db/repos";
import { seal, secretAad } from "../src/secrets/crypto";
import type { MasterKeys } from "../src/secrets/master-key";
import { retireMasterKeyFile } from "../src/secrets/retire-key-file";
import { rewrapMasterKey } from "../src/secrets/rewrap";
import { SecretStore } from "../src/secrets/store";
import { seedWorld, type Tenant } from "./ops-helpers";

const tmp = mkdtempSync(join(tmpdir(), "tt-retire-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

const VALUE = ["retire", "fixture", "value", "5521"].join("-");

describe("retiring the old master key file", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  let db: Db;
  let a: Tenant;
  let data: string;
  let keyFile: string;
  let anchorDir: string;
  let logs: string[];

  beforeEach(async () => {
    ({ db, a } = await seedWorld());
    data = fresh();
    keyFile = join(data, "master.key");
    writeFileSync(keyFile, oldKey, { mode: 0o600 });
    anchorDir = join(data, "audit-state");
    await new SecretStore(db, oldKey).set(a.orgId, "github/app/private-key", VALUE);
    logs = [];
  });

  const keys = (o: Partial<MasterKeys> = {}): MasterKeys => ({
    key: newKey,
    source: "env",
    previous: oldKey,
    ...o,
  });
  const rewrap = () =>
    rewrapMasterKey({ db, next: newKey, previous: oldKey, anchorDir, auditOrgId: a.orgId });
  const retire = (o: { path?: string; keys?: MasterKeys } = {}) =>
    retireMasterKeyFile({
      db,
      path: o.path ?? keyFile,
      dataDir: data,
      keys: o.keys ?? keys(),
      anchorDir,
      auditOrgId: a.orgId,
      log: (m) => logs.push(m),
    });
  const retired = async () =>
    (await listAudit(db, { orgId: a.orgId })).filter((e) => e.op === "master_key_file_retired");

  test("after a clean re-wrap the file is deleted and audited with the path, never a key", async () => {
    await rewrap();
    expect(await retire()).toEqual({ retired: true });
    expect(existsSync(keyFile)).toBe(false);
    const audit = await retired();
    expect(audit).toHaveLength(1);
    const text = JSON.stringify(audit[0]);
    expect(text).toContain("master.key");
    expect(text).not.toContain(oldKey.toString("base64"));
    expect(text).not.toContain(oldKey.toString("hex"));
  });

  test("a later boot with the file already gone logs once and audits nothing", async () => {
    await rewrap();
    await retire();
    logs = [];
    expect(await retire()).toEqual({ retired: false, reason: "gone" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("already gone");
    expect(await retired()).toHaveLength(1);
  });

  test("refused when the process runs on a key file (condition 1)", async () => {
    await rewrap();
    const r = await retire({ keys: keys({ source: "file", file: keyFile }) });
    expect(r).toEqual({ retired: false, reason: "refused", condition: 1 });
    expect(existsSync(keyFile)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("condition 1");
  });

  test("refused when a row does not open under the current key (condition 2)", async () => {
    // Not re-wrapped: the row is still under the old key.
    const r = await retire();
    expect(r).toMatchObject({ retired: false, reason: "refused", condition: 2 });
    expect(existsSync(keyFile)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("condition 2");
    expect(await retired()).toHaveLength(0);
  });

  test("a row sealed under a third key also refuses", async () => {
    await rewrap();
    const other = randomBytes(32);
    const name = "oidc/key/kid9";
    await putSecretRecord(
      db,
      { orgId: a.orgId },
      name,
      seal(other, VALUE, secretAad(a.orgId, name), "oidc", a.orgId),
    );
    expect(await retire()).toMatchObject({ condition: 2 });
    expect(existsSync(keyFile)).toBe(true);
  });

  test("refused with no previous key, or one that is not the file's key (condition 3)", async () => {
    await rewrap();
    expect(await retire({ keys: { key: newKey, source: "env" } })).toMatchObject({ condition: 3 });
    expect(await retire({ keys: keys({ previous: randomBytes(32) }) })).toMatchObject({
      condition: 3,
    });
    expect(existsSync(keyFile)).toBe(true);
    expect(logs.every((l) => l.includes("condition 3"))).toBe(true);
  });

  test("a file holding the CURRENT key is never deleted", async () => {
    await rewrap();
    writeFileSync(keyFile, newKey, { mode: 0o600 });
    expect(await retire()).toMatchObject({ condition: 3 });
    expect(existsSync(keyFile)).toBe(true);
  });

  test("refused for a symlink, even one to the right key (condition 4)", async () => {
    await rewrap();
    const real = join(fresh(), "elsewhere.key");
    writeFileSync(real, oldKey);
    const link = join(data, "link.key");
    symlinkSync(real, link);
    expect(await retire({ path: link })).toMatchObject({ condition: 4 });
    expect(existsSync(link)).toBe(true);
    expect(existsSync(real)).toBe(true);
    expect(logs[0]).toContain("symlink");
  });

  test("refused for a file outside the data directory, a path through a link, or a directory (condition 4)", async () => {
    await rewrap();
    const outside = join(fresh(), "master.key");
    writeFileSync(outside, oldKey);
    expect(await retire({ path: outside })).toMatchObject({ condition: 4 });
    expect(existsSync(outside)).toBe(true);
    // A directory inside the data dir that links out: the file resolves outside.
    symlinkSync(dirnameOf(outside), join(data, "dirlink"));
    expect(await retire({ path: join(data, "dirlink", "master.key") })).toMatchObject({
      condition: 4,
    });
    expect(existsSync(outside)).toBe(true);
    mkdirSync(join(data, "sub"));
    expect(await retire({ path: join(data, "sub") })).toMatchObject({ condition: 4 });
  });
});

const dirnameOf = (p: string): string => p.slice(0, p.lastIndexOf("/"));
