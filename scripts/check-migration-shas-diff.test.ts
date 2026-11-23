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
  mergeFirstParent,
  parseShas,
  resolveBase,
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

describe("the base of a pull request run is the merge commit's own first parent", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const write = (d: string, p: string, text: string): void => {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), text);
  };

  /**
   * The race: main is C0 (no golden file) when the PR's merge ref M is built (parents: C0, P);
   * then #304 lands on main (C1 adds the file). The run checks out M, so HEAD has no file, while
   * the moving tip of main already has it.
   */
  function race(): { d: string; c0: string; c1: string; m: string } {
    const d = mkdtempSync(join(tmpdir(), "ls-shas-merge-"));
    roots.push(d);
    git(d, "init", "-q", "-b", "main");
    write(d, "README.md", "base\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "c0");
    const c0 = git(d, "rev-parse", "HEAD");
    git(d, "checkout", "-q", "-b", "pr");
    write(d, "feature.txt", "pr\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "p");
    git(d, "checkout", "-q", "main");
    git(d, "merge", "-q", "--no-ff", "-m", "merge ref", "pr"); // M: parents C0, P
    const m = git(d, "rev-parse", "HEAD");
    // main moved on: C1 (not part of M) adds the golden file
    git(d, "checkout", "-q", "-b", "tip", c0);
    write(d, SHAS_PATH, shas({ "0000_a": A, "0001_b": B }));
    write(d, EDITED_PATH, edited());
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "c1: the golden file lands");
    const c1 = git(d, "rev-parse", "HEAD");
    git(d, "checkout", "-q", "--detach", m); // the run's checkout: the merge commit
    return { d, c0, c1, m };
  }

  test("a merge commit's first parent is found; a plain commit has none", () => {
    const { d, c0, c1 } = race();
    expect(mergeFirstParent(d)).toBe(c0);
    expect(mergeFirstParent(d, c1)).toBeUndefined();
  });

  test("auto resolves to the first parent, else the event's base sha, else it is an error", () => {
    const { d, c0, c1 } = race();
    expect(resolveBase(d, "auto", "f".repeat(40))).toBe(c0);
    git(d, "checkout", "-q", "--detach", c1); // not a merge commit
    expect(resolveBase(d, "auto", "f".repeat(40))).toBe("f".repeat(40));
    expect(() => resolveBase(d, "auto")).toThrow(/not a merge commit/);
    expect(resolveBase(d, "origin/main", "f".repeat(40))).toBe("origin/main"); // used as given
  });

  test("the race passes: the first parent lacks the file although the moving tip has it", async () => {
    const { d, c0 } = race();
    const r = await checkRepo({ repo: d, base: resolveBase(d, "auto") });
    expect(r).toEqual({ problems: [], skipped: true });
    expect(c0).toBe(mergeFirstParent(d));
  });

  test("the same race with the moving tip as base, the old behaviour, reads as a removal (and no longer crashes)", async () => {
    const { d, c1 } = race();
    const r = await checkRepo({ repo: d, base: c1 });
    expect(r.skipped).toBe(false);
    expect(r.problems).toEqual([
      "sqlite 0000_a: the entry was removed",
      "sqlite 0001_b: the entry was removed",
    ]);
  });

  test("the script with --base auto exits 0 in the race, and 1 when the PR really deletes the file", () => {
    const { d } = race();
    const script = join(import.meta.dir, "check-migration-shas-diff.ts");
    const exec = (): number =>
      Bun.spawnSync(["bun", "run", script, "--base", "auto", "--repo", d], {
        stderr: "pipe",
        stdout: "pipe",
      }).exitCode ?? -1;
    expect(exec()).toBe(0);
    // a real deletion: the first parent HAS the file and the merge result does not
    const e = mkdtempSync(join(tmpdir(), "ls-shas-del-"));
    roots.push(e);
    git(e, "init", "-q", "-b", "main");
    write(e, SHAS_PATH, shas({ "0000_a": A }));
    write(e, EDITED_PATH, edited());
    git(e, "add", "-A");
    git(e, "commit", "-q", "-m", "base");
    git(e, "checkout", "-q", "-b", "pr");
    git(e, "rm", "-q", SHAS_PATH);
    git(e, "commit", "-q", "-m", "pr deletes it");
    git(e, "checkout", "-q", "main");
    write(e, "other.txt", "x\n");
    git(e, "add", "-A");
    git(e, "commit", "-q", "-m", "main moves");
    git(e, "merge", "-q", "--no-ff", "-m", "merge ref", "pr");
    const del = Bun.spawnSync(["bun", "run", script, "--base", "auto", "--repo", e], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(del.exitCode).toBe(1);
    expect(del.stderr.toString()).toContain("the entry was removed");
  });

  /** A PR merge commit whose base already HAS the golden file: C0 (A, B) <- M (parents C0, P). */
  function withFile(headShas: Record<string, string>): {
    d: string;
    c0: string;
    m: string;
  } {
    const d = mkdtempSync(join(tmpdir(), "ls-shas-file-"));
    roots.push(d);
    git(d, "init", "-q", "-b", "main");
    write(d, SHAS_PATH, shas({ "0000_a": A, "0001_b": B }));
    write(d, EDITED_PATH, edited());
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "c0");
    const c0 = git(d, "rev-parse", "HEAD");
    git(d, "checkout", "-q", "-b", "pr");
    write(d, SHAS_PATH, shas(headShas));
    write(d, "feature.txt", "pr\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "p");
    git(d, "checkout", "-q", "main");
    git(d, "merge", "-q", "--no-ff", "-X", "theirs", "-m", "merge ref", "pr");
    return { d, c0, m: git(d, "rev-parse", "HEAD") };
  }

  test("main gains entries after the merge ref was built: it passes, against the first parent", async () => {
    const { d, c0, m } = withFile({ "0000_a": A, "0001_b": B });
    // main moves on after M: a new migration's entry lands (not part of M)
    git(d, "checkout", "-q", "-b", "tip", c0);
    write(d, SHAS_PATH, shas({ "0000_a": A, "0001_b": B, "0002_c": C }));
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "main appends 0002_c");
    const tip = git(d, "rev-parse", "HEAD");
    git(d, "checkout", "-q", "--detach", m);
    expect((await checkRepo({ repo: d, base: resolveBase(d, "auto") })).problems).toEqual([]);
    // the moving tip as base would call it a removal: the false failure this guards against
    expect((await checkRepo({ repo: d, base: tip })).problems).toEqual([
      "sqlite 0002_c: the entry was removed",
    ]);
  });

  test("a real edit or removal relative to the first parent fails; an append passes", async () => {
    const edit = withFile({ "0000_a": D, "0001_b": B });
    const e = await checkRepo({ repo: edit.d, base: resolveBase(edit.d, "auto") });
    expect(e.problems).toHaveLength(1);
    expect(e.problems[0]).toContain("sqlite 0000_a: the hash changed");
    const removal = withFile({ "0000_a": A });
    expect(
      (await checkRepo({ repo: removal.d, base: resolveBase(removal.d, "auto") })).problems,
    ).toEqual(["sqlite 0001_b: the entry was removed"]);
    const append = withFile({ "0000_a": A, "0001_b": B, "0002_c": C });
    expect(
      (await checkRepo({ repo: append.d, base: resolveBase(append.d, "auto") })).problems,
    ).toEqual([]);
  });

  test("an older base (the event's base sha) never fails just because it is older: the head's extra entries are appends", async () => {
    const { d, c0 } = withFile({ "0000_a": A, "0001_b": B, "0002_c": C });
    git(d, "checkout", "-q", "--detach", "pr"); // a head that is NOT a merge commit
    expect(resolveBase(d, "auto", c0)).toBe(c0);
    expect((await checkRepo({ repo: d, base: c0 })).problems).toEqual([]);
  });

  test("a depth-1 checkout of the merge commit still resolves and fetches its first parent by sha", async () => {
    const { d, c0, m } = withFile({ "0000_a": A, "0001_b": B });
    const shallow = mkdtempSync(join(tmpdir(), "ls-shas-shallow-"));
    roots.push(shallow);
    git(d, "config", "uploadpack.allowAnySHA1InWant", "true");
    git(shallow, "init", "-q", "-b", "x");
    git(shallow, "remote", "add", "origin", `file://${d}`);
    git(shallow, "fetch", "-q", "--no-tags", "--depth=1", "origin", m);
    git(shallow, "checkout", "-q", "--detach", "FETCH_HEAD");
    // the merge commit names its parents, but the shallow checkout does not have them
    expect(mergeFirstParent(shallow)).toBe(c0);
    expect(() => git(shallow, "cat-file", "-e", `${c0}^{commit}`)).toThrow();
    const script = join(import.meta.dir, "check-migration-shas-diff.ts");
    const r = Bun.spawnSync(["bun", "run", script, "--base", "auto", "--repo", shallow], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    // the first parent was fetched by its sha (exactly that commit, not the history)
    expect(git(shallow, "cat-file", "-t", c0)).toBe("commit");
  });
});
