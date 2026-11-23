import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstance, ensureLocalTenant, getOrgBySlug, openDatabase } from "../src/db";
import { keysCommand } from "../src/github/cli";
import { SecretStore } from "../src/secrets/store";

const tmp = mkdtempSync(join(tmpdir(), "tt-reseal-env-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEYS = [
  "TURNTABLE_MASTER_KEY",
  "TURNTABLE_MASTER_KEY_FILE",
  "TURNTABLE_MASTER_KEY_PREVIOUS",
  "TURNTABLE_MASTER_KEY_PREVIOUS_FILE",
];
const saved: Record<string, string | undefined> = {};
let errs: string[] = [];
const realErr = console.error;
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  errs = [];
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
});
afterEach(() => {
  console.error = realErr;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

let n = 0;
const rnd = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

async function setup(key: Buffer): Promise<string> {
  const data = join(tmp, `d${n++}`);
  mkdirSync(data, { recursive: true });
  const db = openDatabase(join(data, "turntable.db"));
  try {
    await ensureInstance(db);
    await ensureLocalTenant(db);
    const org = await getOrgBySlug(db, "local");
    await new SecretStore(db, key).set(org!.id, "demo/value", "v");
  } finally {
    db.close();
  }
  return data;
}

describe("keys reseal with the master key from the environment", () => {
  test("TURNTABLE_MASTER_KEY reseals, is deleted from the environment and never printed", async () => {
    const key = rnd();
    const data = await setup(key);
    process.env.TURNTABLE_MASTER_KEY = key.toString("base64");
    await keysCommand(["reseal", "--org", "local", "--data-dir", data]);
    expect(errs.join("\n")).toContain("resealed org local");
    expect(process.env.TURNTABLE_MASTER_KEY).toBeUndefined();
    expect(errs.join("\n")).not.toContain(key.toString("base64"));
    expect(errs.join("\n")).not.toContain(key.toString("hex"));
  });

  test("a previous key is accepted, scrubbed, and not echoed", async () => {
    const key = rnd();
    const prev = rnd();
    const data = await setup(key);
    process.env.TURNTABLE_MASTER_KEY = key.toString("hex");
    process.env.TURNTABLE_MASTER_KEY_PREVIOUS = prev.toString("hex");
    await keysCommand(["reseal", "--org", "local", "--data-dir", data]);
    expect(process.env.TURNTABLE_MASTER_KEY_PREVIOUS).toBeUndefined();
    const out = errs.join("\n");
    expect(out).toContain("previous master key is set");
    expect(out).not.toContain(prev.toString("hex"));
    expect(out).not.toContain(key.toString("hex"));
  });

  test("the key from TURNTABLE_MASTER_KEY_FILE still works", async () => {
    const key = rnd();
    const data = await setup(key);
    const file = join(tmp, `k${n++}.key`);
    writeFileSync(file, key, { mode: 0o600 });
    process.env.TURNTABLE_MASTER_KEY_FILE = file;
    await keysCommand(["reseal", "--org", "local", "--data-dir", data]);
    expect(errs.join("\n")).toContain("resealed org local");
  });

  test("the variable together with a file is refused, without echoing the value", async () => {
    const key = rnd();
    const data = await setup(key);
    const file = join(tmp, `k${n++}.key`);
    writeFileSync(file, key, { mode: 0o600 });
    for (const via of ["env", "flag"]) {
      process.env.TURNTABLE_MASTER_KEY = key.toString("base64");
      if (via === "env") process.env.TURNTABLE_MASTER_KEY_FILE = file;
      const args = ["reseal", "--org", "local", "--data-dir", data];
      if (via === "flag") args.push("--file", file);
      const err = await keysCommand(args).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toContain("use one");
      expect(err?.message).not.toContain(key.toString("base64"));
      expect(process.env.TURNTABLE_MASTER_KEY).toBeUndefined();
      delete process.env.TURNTABLE_MASTER_KEY_FILE;
    }
    expect(errs.join("\n")).not.toContain("resealed");
  });

  test("a malformed value is refused without echoing it", async () => {
    const data = await setup(rnd());
    const bad = "not-a-key-" + "x".repeat(12);
    process.env.TURNTABLE_MASTER_KEY = bad;
    const err = await keysCommand(["reseal", "--org", "local", "--data-dir", data]).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toContain("TURNTABLE_MASTER_KEY must be");
    expect(err?.message).not.toContain(bad);
  });
});
