// Booting with the settings layers (#321): the binary starts from an empty directory with no
// config file, and a bad config stops it naming the key and the file. Starts server processes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../src/main.ts");
const tmp = mkdtempSync(join(tmpdir(), "tt-settings-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** Runs `turntable serve` in a fresh empty directory with a minimal environment. */
async function boot(
  args: string[],
  env: Record<string, string> = {},
  files: Record<string, string> = {},
): Promise<{ code: number | null; out: string; listening: boolean }> {
  const dir = join(tmp, `d${n++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const p = Bun.spawn(
    [process.execPath, MAIN, "serve", "--port", "0", "--data-dir", "data", ...args],
    {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let out = "";
  const reads = [p.stdout, p.stderr].map(async (s) => {
    for await (const chunk of s) {
      out += new TextDecoder().decode(chunk);
      if (out.includes("listening on")) p.kill();
    }
  });
  const timer = setTimeout(() => p.kill(), 20_000);
  const code = await p.exited;
  clearTimeout(timer);
  await Promise.all(reads);
  return { code, out, listening: out.includes("listening on") };
}

describe("boot with the settings layers", () => {
  test("an empty directory with no config file boots", async () => {
    const r = await boot([]);
    expect(r.listening).toBe(true);
  }, 30_000);

  test("a valid turntable.toml boots, from --config and from TURNTABLE_CONFIG", async () => {
    const files = { "turntable.toml": "[backup]\nkeep = 3\n" };
    expect((await boot(["--config", "turntable.toml"], {}, files)).listening).toBe(true);
    expect((await boot([], { TURNTABLE_CONFIG: "turntable.toml" }, files)).listening).toBe(true);
  }, 60_000);

  test("an unknown key stops the boot naming the key and the file", async () => {
    const r = await boot(
      ["--config", "turntable.toml"],
      {},
      {
        "turntable.toml": "[backup]\nkeeep = 3\n",
      },
    );
    expect(r.listening).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("turntable.toml: unknown setting backup.keeep");
  }, 30_000);

  test("a bad value stops the boot naming the key, the setting and the file", async () => {
    const r = await boot(
      [],
      { TURNTABLE_CONFIG: "turntable.toml" },
      {
        "turntable.toml": "[backup]\nkeep = 0\n",
      },
    );
    expect(r.listening).toBe(false);
    expect(r.out).toContain("turntable.toml: backup.keep (setting backup_keep)");
  }, 30_000);

  test("a bad environment value stops the boot naming the variable", async () => {
    const r = await boot([], { TURNTABLE_BACKUP_KEEP: "lots" });
    expect(r.listening).toBe(false);
    expect(r.out).toContain("TURNTABLE_BACKUP_KEEP (setting backup_keep)");
  }, 30_000);

  test("a named config file that is not there is an error, not the defaults", async () => {
    const r = await boot(["--config", "missing.toml"]);
    expect(r.listening).toBe(false);
    expect(r.out).toContain("missing.toml: cannot read the config file");
  }, 30_000);
});
