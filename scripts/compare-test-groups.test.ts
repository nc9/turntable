import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareToRef } from "./compare-test-groups";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: repo,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A temp repo with one commit holding the given package.json scripts and group files. */
function makeRepo(scripts: Record<string, string>, groups: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "cmp-groups-"));
  dirs.push(repo);
  git(repo, "init", "-q");
  mkdirSync(join(repo, "scripts", "test-groups"), { recursive: true });
  writeFile(repo, scripts);
  for (const [g, text] of Object.entries(groups))
    writeFileSync(join(repo, "scripts", "test-groups", `${g}.txt`), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

function writeFile(repo: string, scripts: Record<string, string>): void {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts }));
}

const grouped = { "test:a": "bun scripts/run-test-group.ts a" };

describe("compareToRef", () => {
  test("an unchanged tree is identical", async () => {
    const repo = makeRepo(grouped, { a: "x.test.ts\ny.test.ts\n" });
    expect((await compareToRef("HEAD", repo)).problems).toEqual([]);
  });

  test("the ref side comes from the ref, not the working tree", async () => {
    const repo = makeRepo(grouped, { a: "x.test.ts\ny.test.ts\n" });
    const file = join(repo, "scripts", "test-groups", "a.txt");
    writeFileSync(file, "x.test.ts\ny.test.ts\nz.test.ts\n");
    expect((await compareToRef("HEAD", repo)).problems).toEqual(["test:a: files differ (2 -> 3)"]);
    writeFileSync(file, "x.test.ts\n");
    expect((await compareToRef("HEAD", repo)).problems).toEqual(["test:a: files differ (2 -> 1)"]);
    writeFileSync(file, "y.test.ts\nx.test.ts\n");
    expect((await compareToRef("HEAD", repo)).problems).toEqual(["test:a: files differ (2 -> 2)"]);
  });

  test("a group file missing at the ref is an error naming the group", async () => {
    const repo = makeRepo(grouped, { a: "x.test.ts\n" });
    writeFile(repo, { ...grouped, "test:b": "bun scripts/run-test-group.ts b" });
    writeFileSync(join(repo, "scripts", "test-groups", "b.txt"), "q.test.ts\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add b");
    // package.json at HEAD~1 has no test:b, so only a ref listing b without its file errors.
    writeFile(repo, { "test:b": "bun scripts/run-test-group.ts b" });
    git(repo, "rm", "-q", "--cached", "scripts/test-groups/b.txt");
    git(repo, "commit", "-q", "-am", "list b without file");
    expect(compareToRef("HEAD", repo)).rejects.toThrow(
      "test group b: no scripts/test-groups/b.txt",
    );
  });

  test("an inline-form ref still resolves", async () => {
    const repo = makeRepo({ "test:a": "X=1 bun test x.test.ts y.test.ts" }, {});
    writeFile(repo, { "test:a": "X=1 bun scripts/run-test-group.ts a" });
    mkdirSync(join(repo, "scripts", "test-groups"), { recursive: true });
    writeFileSync(join(repo, "scripts", "test-groups", "a.txt"), "x.test.ts\ny.test.ts\n");
    expect((await compareToRef("HEAD", repo)).problems).toEqual([]);
    writeFileSync(join(repo, "scripts", "test-groups", "a.txt"), "y.test.ts\nx.test.ts\n");
    expect((await compareToRef("HEAD", repo)).problems).toEqual(["test:a: files differ (2 -> 2)"]);
  });
});
