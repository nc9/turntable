// The migration-hash diff guard: appends pass; an edit or a removal of an existing entry fails
// unless the same tag is newly named in EDITED_IN_PLACE in the same diff.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkRepo,
  diffProblems,
  EDITED_PATH,
  editedTags,
  parseShas,
  SHAS_PATH,
} from "./check-migration-shas-diff";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

/** The golden file in the current format: a list of { tag, sha256 } records per dialect. */
const shas = (sqlite: Record<string, string>, pg: Record<string, string> = {}): string =>
  JSON.stringify({
    "//": "note",
    sqlite: Object.entries(sqlite).map(([tag, sha256]) => ({ tag, sha256 })),
    pg: Object.entries(pg).map(([tag, sha256]) => ({ tag, sha256 })),
  });
/** The old format: a map from tag to sha (still readable, for a base that predates the list). */
const oldShas = (sqlite: Record<string, string>, pg: Record<string, string> = {}): string =>
  JSON.stringify({ "//": "note", sqlite, pg });
const edited = (...tags: string[]): string =>
  `import type { Migration } from "./migrate";\n\nexport const EDITED_IN_PLACE: Record<string, { shas: string[]; reason: string }> = {\n${tags
    .map((t) => `  "${t}": {\n    shas: ["x"],\n    reason: "why",\n  },\n`)
    .join("")}};\n\nexport function other() {}\n`;

describe("parsing", () => {
  test("the shas file: dialect maps only, the note ignored", () => {
    expect(parseShas(shas({ "0000_a": A }, { "0000_p": B }))).toEqual({
      sqlite: { "0000_a": A },
      pg: { "0000_p": B },
    });
  });
  test("EDITED_IN_PLACE tags are the keys of that object, nothing else in the file", () => {
    expect(editedTags(edited("0033_x", "0040_y"))).toEqual(new Set(["0033_x", "0040_y"]));
    expect(editedTags(edited())).toEqual(new Set());
    expect(editedTags("export const nothing = 1;\n")).toEqual(new Set());
    // a tag-like key outside the object is not counted
    expect(editedTags(`${edited("0033_x")}\nconst z = {\n  "0099_not": { a: 1 },\n};\n`)).toEqual(
      new Set(["0033_x"]),
    );
  });
});

describe("the old map format", () => {
  test("is read as well, and a base in the old format compares with a head in the list format", () => {
    expect(parseShas(oldShas({ "0000_a": A }, { "0000_p": B }))).toEqual(
      parseShas(shas({ "0000_a": A }, { "0000_p": B })),
    );
    const base = parseShas(oldShas({ "0000_a": A, "0001_b": B }));
    const append = parseShas(shas({ "0000_a": A, "0001_b": B, "0002_c": D }));
    const edit = parseShas(shas({ "0000_a": A, "0001_b": D }));
    expect(diffProblems(base, append, new Set(), new Set())).toEqual([]);
    expect(diffProblems(base, edit, new Set(), new Set())).toHaveLength(1);
  });
  test("malformed records are ignored, never throw", () => {
    const text = JSON.stringify({
      sqlite: [{ tag: "0000_a" }, null, { tag: 1, sha256: A }, { tag: "0001_b", sha256: B }],
    });
    expect(parseShas(text)).toEqual({ sqlite: { "0001_b": B } });
  });
});

describe("the comparison", () => {
  const base = { sqlite: { "0000_a": A, "0001_b": B }, pg: { "0000_p": C } };
  const none = new Set<string>();
  test("an append passes", () => {
    const head = { sqlite: { ...base.sqlite, "0002_c": D }, pg: { ...base.pg, "0001_q": D } };
    expect(diffProblems(base, head, none, none)).toEqual([]);
    expect(diffProblems(base, base, none, none)).toEqual([]);
  });
  test("an edit of an existing entry fails, in either dialect", () => {
    const sqlite = { sqlite: { ...base.sqlite, "0001_b": D }, pg: base.pg };
    expect(diffProblems(base, sqlite, none, none)).toEqual([
      `sqlite 0001_b: the hash changed (${B.slice(0, 12)} -> ${D.slice(0, 12)})`,
    ]);
    const pg = { sqlite: base.sqlite, pg: { "0000_p": D } };
    expect(diffProblems(base, pg, none, none)[0]).toContain("pg 0000_p");
  });
  test("a removal fails", () => {
    const head = { sqlite: { "0000_a": A }, pg: base.pg };
    expect(diffProblems(base, head, none, none)).toEqual(["sqlite 0001_b: the entry was removed"]);
  });
  test("an edit passes when the same tag is newly in EDITED_IN_PLACE; another tag does not excuse it", () => {
    const head = { sqlite: { ...base.sqlite, "0001_b": D }, pg: base.pg };
    expect(diffProblems(base, head, none, new Set(["0001_b"]))).toEqual([]);
    expect(diffProblems(base, head, none, new Set(["0000_a"]))).toHaveLength(1);
  });
  test("a tag that was ALREADY in EDITED_IN_PLACE in the base is not a fresh excuse", () => {
    const head = { sqlite: { ...base.sqlite, "0001_b": D }, pg: base.pg };
    const already = new Set(["0001_b"]);
    expect(diffProblems(base, head, already, already)).toHaveLength(1);
  });
  test("a removal is excused the same way", () => {
    const head = { sqlite: { "0000_a": A }, pg: base.pg };
    expect(diffProblems(base, head, none, new Set(["0001_b"]))).toEqual([]);
  });
});

describe("against a real git base", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd,
      encoding: "utf8",
    });
  function repo(files: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), "ls-shas-"));
    roots.push(d);
    git(d, "init", "-q", "-b", "main");
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(d, p)), { recursive: true });
      writeFileSync(join(d, p), t);
    }
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "base");
    return d;
  }
  const put = (d: string, p: string, t: string): void => writeFileSync(join(d, p), t);
  const run = (d: string, base = "HEAD") => checkRepo({ repo: d, base });

  const files = {
    [SHAS_PATH]: shas({ "0000_a": A, "0001_b": B }, { "0000_p": C }),
    [EDITED_PATH]: edited(),
  };

  test("an append passes; an edit fails; an edit plus EDITED_IN_PLACE passes; a removal fails", async () => {
    const d = repo(files);
    put(d, SHAS_PATH, shas({ "0000_a": A, "0001_b": B, "0002_c": D }, { "0000_p": C }));
    expect((await run(d)).problems).toEqual([]);
    put(d, SHAS_PATH, shas({ "0000_a": D, "0001_b": B }, { "0000_p": C }));
    expect((await run(d)).problems).toHaveLength(1);
    put(d, EDITED_PATH, edited("0000_a"));
    expect((await run(d)).problems).toEqual([]);
    put(d, EDITED_PATH, edited());
    put(d, SHAS_PATH, shas({ "0000_a": A }, { "0000_p": C }));
    expect((await run(d)).problems).toEqual(["sqlite 0001_b: the entry was removed"]);
  });

  test("a base in the old map format against a head in the list format: an append passes, an edit fails", async () => {
    const d = repo({ [SHAS_PATH]: oldShas({ "0000_a": A, "0001_b": B }), [EDITED_PATH]: edited() });
    put(d, SHAS_PATH, shas({ "0000_a": A, "0001_b": B, "0002_c": D }));
    expect((await run(d)).problems).toEqual([]);
    put(d, SHAS_PATH, shas({ "0000_a": D, "0001_b": B }));
    expect((await run(d)).problems).toHaveLength(1);
  });

  test("a base without the file has nothing to protect; a ref that is not there is an error", async () => {
    const d = repo({ "README.md": "x" });
    mkdirSync(join(d, dirname(SHAS_PATH)), { recursive: true });
    put(d, SHAS_PATH, shas({ "0000_a": A }));
    expect(await run(d)).toEqual({ problems: [], skipped: true });
    await expect(run(d, "no-such-ref")).rejects.toThrow(/not in this checkout/);
  });

  test("the script exits 1 on an edit and 0 on an append", () => {
    const d = repo(files);
    const script = join(import.meta.dir, "check-migration-shas-diff.ts");
    const exec = (): number => {
      const r = Bun.spawnSync(["bun", "run", script, "--base", "HEAD", "--repo", d], {
        stderr: "pipe",
        stdout: "pipe",
      });
      return r.exitCode ?? -1;
    };
    put(d, SHAS_PATH, shas({ "0000_a": A, "0001_b": B, "0002_c": D }, { "0000_p": C }));
    expect(exec()).toBe(0);
    put(d, SHAS_PATH, shas({ "0000_a": D, "0001_b": B }, { "0000_p": C }));
    expect(exec()).toBe(1);
  });

  test("the base can come from raw.githubusercontent.com when git does not have it", async () => {
    const d = repo({ "README.md": "x" });
    mkdirSync(join(d, dirname(SHAS_PATH)), { recursive: true });
    put(d, SHAS_PATH, shas({ "0000_a": D }));
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(u);
      return new Response(u.endsWith("migration-shas.json") ? shas({ "0000_a": A }) : edited(), {
        status: 200,
      });
    }) as never;
    const r = await checkRepo({
      repo: d,
      base: "origin/gone",
      remote: { repo: "acme/web", sha: "a".repeat(40) },
      fetchFn,
    });
    expect(r.problems).toHaveLength(1);
    expect(urls[0]).toBe(
      `https://raw.githubusercontent.com/acme/web/${"a".repeat(40)}/${SHAS_PATH}`,
    );
  });
});
