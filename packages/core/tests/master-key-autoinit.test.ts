import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemOrgId } from "../src/audit/failures";
import { openDatabase } from "../src/db";
import { listAudit } from "../src/db/repos";
import { autoInitMasterKey, autoInitRequested } from "../src/secrets/autoinit";

const MAIN = join(import.meta.dir, "../src/main.ts");
const AUTOINIT = join(import.meta.dir, "../src/secrets/autoinit.ts");
const tmp = mkdtempSync(join(tmpdir(), "ls-keyinit-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): { dir: string; data: string; key: string } => {
  const dir = join(tmp, `t${n++}`);
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  return { dir, data, key: join(data, "master.key") };
};

describe("autoInitMasterKey", () => {
  test("creates a 32-byte 0600 file, logs the path and never the key, leaves no temp file", () => {
    const { data, key } = fresh();
    const logs: string[] = [];
    expect(autoInitMasterKey(key, data, (m) => logs.push(m))).toBe("created");
    const bytes = readFileSync(key);
    expect(bytes.length).toBe(32);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain(key);
    expect(logs.join("\n")).not.toContain(bytes.toString("hex"));
    expect(logs.join("\n")).not.toContain(bytes.toString("base64"));
    expect(readdirSync(data)).toEqual(["master.key"]);
  });

  test("an existing file is used as it is: never overwritten, never touched", () => {
    const { data, key } = fresh();
    writeFileSync(key, Buffer.alloc(32, 7), { mode: 0o600 });
    const before = statSync(key).mtimeMs;
    expect(autoInitMasterKey(key, data)).toBe("exists");
    expect([...readFileSync(key)]).toEqual(Array.from({ length: 32 }, () => 7));
    expect(statSync(key).mtimeMs).toBe(before);
    // Even a file of the wrong size is left for loadMasterKey to refuse; it is not replaced.
    const odd = join(data, "odd.key");
    writeFileSync(odd, "short", { mode: 0o600 });
    expect(autoInitMasterKey(odd, data)).toBe("exists");
    expect(readFileSync(odd, "utf8")).toBe("short");
  });

  test("a directory other users can read is tightened when we own it", () => {
    const { data, key } = fresh();
    chmodSync(data, 0o755);
    const logs: string[] = [];
    expect(autoInitMasterKey(key, data, (m) => logs.push(m))).toBe("created");
    expect(statSync(data).mode & 0o007).toBe(0);
    expect(logs.some((l) => l.includes("tightened"))).toBe(true);
  });

  test("a missing key directory is created private", () => {
    const { dir } = fresh();
    const key = join(dir, "keys", "m.key");
    expect(autoInitMasterKey(key, join(dir, "data"))).toBe("created");
    expect(statSync(join(dir, "keys")).mode & 0o077).toBe(0);
  });

  test("replicas starting together: exactly one creates it and all see the same whole file", async () => {
    const { data, key } = fresh();
    const script = join(tmp, "race.ts");
    writeFileSync(
      script,
      `import { autoInitMasterKey } from ${JSON.stringify(AUTOINIT)};
       import { readFileSync } from "node:fs";
       const r = autoInitMasterKey(${JSON.stringify(key)}, ${JSON.stringify(data)});
       console.log(r + " " + readFileSync(${JSON.stringify(key)}).toString("hex"));`,
    );
    const outs = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const p = Bun.spawn(["bun", "run", script], { stdout: "pipe", stderr: "pipe" });
        const [o, c] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        expect(c).toBe(0);
        return o.trim().split(" ") as [string, string];
      }),
    );
    expect(outs.filter(([r]) => r === "created")).toHaveLength(1);
    expect(new Set(outs.map(([, hex]) => hex)).size).toBe(1);
    expect(outs[0]![1]).toHaveLength(64);
    expect(readdirSync(data)).toEqual(["master.key"]);
  });

  test("the opt-in is the variable or the flag, and nothing else", () => {
    expect(autoInitRequested({}, undefined)).toBe(false);
    expect(autoInitRequested({ TURNTABLE_MASTER_KEY_AUTOINIT: "0" }, false)).toBe(false);
    expect(autoInitRequested({ TURNTABLE_MASTER_KEY_AUTOINIT: "true" }, false)).toBe(false);
    expect(autoInitRequested({ TURNTABLE_MASTER_KEY_AUTOINIT: "1" }, false)).toBe(true);
    expect(autoInitRequested({}, true)).toBe(true);
  });
});

/** Starts the real server, waits until it listens, then stops it. */
async function boot(
  args: string[],
  env: Record<string, string>,
): Promise<{ listening: boolean; code: number | null; out: string }> {
  const p = Bun.spawn(["bun", "run", MAIN, "serve", "--port", "0", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: tmp, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const read = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) out += new TextDecoder().decode(c);
  };
  void read(p.stdout);
  void read(p.stderr);
  const deadline = Date.now() + 15_000;
  let listening = false;
  while (Date.now() < deadline) {
    if (/listening on http/.test(out)) {
      listening = true;
      break;
    }
    if (p.exitCode !== null) break;
    await Bun.sleep(50);
  }
  const code = p.exitCode;
  p.kill();
  await p.exited;
  return { listening, code, out };
}

describe("serve with a missing master key file", () => {
  test("without the opt-in it fails as before and creates nothing", async () => {
    const { data, key } = fresh();
    const r = await boot(["--data-dir", data], { TURNTABLE_MASTER_KEY_FILE: key });
    expect(r.listening).toBe(false);
    expect(r.out).toContain("master key file not found");
    expect(existsSync(key)).toBe(false);
  });

  test("with the opt-in it creates the key once, audits it in the system org, and the key is the one used", async () => {
    const { data, key } = fresh();
    const r = await boot(["--data-dir", data], {
      TURNTABLE_MASTER_KEY_FILE: key,
      TURNTABLE_MASTER_KEY_AUTOINIT: "1",
    });
    expect(r.listening).toBe(true);
    const bytes = readFileSync(key);
    expect(bytes.length).toBe(32);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(r.out).toContain(key);
    expect(r.out).not.toContain(bytes.toString("hex"));
    const db = openDatabase(join(data, "turntable.db"));
    const rows = await listAudit(db, { orgId: await systemOrgId(db) });
    expect(rows.filter((a) => a.op === "master_key_created")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(bytes.toString("hex"));
    db.close();
    // A second boot with the flag still on uses the same file and audits nothing more.
    const again = await boot(["--data-dir", data], {
      TURNTABLE_MASTER_KEY_FILE: key,
      TURNTABLE_MASTER_KEY_AUTOINIT: "1",
    });
    expect(again.listening).toBe(true);
    expect(readFileSync(key).equals(bytes)).toBe(true);
    const db2 = openDatabase(join(data, "turntable.db"));
    expect(
      (await listAudit(db2, { orgId: await systemOrgId(db2) })).filter(
        (a) => a.op === "master_key_created",
      ),
    ).toHaveLength(1);
    db2.close();
  });

  test("the flag works like the variable, and an existing key is never replaced", async () => {
    const { data, key } = fresh();
    writeFileSync(key, Buffer.alloc(32, 9), { mode: 0o600 });
    const r = await boot(["--data-dir", data, "--init-master-key"], {
      TURNTABLE_MASTER_KEY_FILE: key,
    });
    expect(r.listening).toBe(true);
    expect([...readFileSync(key)]).toEqual(Array.from({ length: 32 }, () => 9));
  });

  test("the opt-in without a key path is an error", async () => {
    const { data } = fresh();
    const r = await boot(["--data-dir", data], { TURNTABLE_MASTER_KEY_AUTOINIT: "1" });
    expect(r.listening).toBe(false);
    expect(r.out).toContain("needs TURNTABLE_MASTER_KEY_FILE");
  });
});
