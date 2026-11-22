import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotRepo } from "../src/run/repo-archive";

const tmp = mkdtempSync(join(tmpdir(), "tt-snap-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function run(cwd: string, ...argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`${argv.join(" ")} failed`);
  return out;
}

async function repo(): Promise<string> {
  const d = mkdtempSync(join(tmp, "repo-"));
  await run(d, "git", "init", "-q", "-b", "main");
  writeFileSync(join(d, "tracked.txt"), "tracked\n");
  writeFileSync(join(d, ".gitignore"), "ignored.txt\n");
  await run(d, "git", "add", "-A");
  await run(
    d,
    "git",
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "c1",
  );
  return d;
}

async function listing(tarball: Uint8Array): Promise<string[]> {
  const d = mkdtempSync(join(tmp, "x-"));
  writeFileSync(join(d, "a.tgz"), tarball);
  const out = await run(d, "tar", "tzf", "a.tgz");
  return out.split("\n").filter(Boolean);
}

describe("snapshotRepo", () => {
  test("delivers the committed tree and .git, not untracked or ignored files", async () => {
    const d = await repo();
    writeFileSync(join(d, "ignored.txt"), "secret\n");
    writeFileSync(join(d, "untracked.txt"), "u\n");
    const snap = await snapshotRepo(d);
    expect(snap.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.ref).toBe("refs/heads/main");
    expect(snap.dirty).toBe(false);
    expect(snap.headBranch).toBe("main");
    expect(snap.commitMessage).toBe("c1");
    expect(snap.actor).toBeTruthy();
    const files = await listing(snap.tarball);
    expect(files.some((f) => f.endsWith("tracked.txt"))).toBe(true);
    expect(files.some((f) => f.includes(".git/HEAD"))).toBe(true);
    expect(files.some((f) => f.endsWith("ignored.txt"))).toBe(false);
    expect(files.some((f) => f.endsWith("untracked.txt"))).toBe(false);
    expect(existsSync(join(d, "ignored.txt"))).toBe(true);
  });

  test("reports uncommitted changes to tracked files as dirty", async () => {
    const d = await repo();
    writeFileSync(join(d, "tracked.txt"), "changed\n");
    expect((await snapshotRepo(d)).dirty).toBe(true);
  });
});
