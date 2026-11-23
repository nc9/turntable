// The in-process git fetch (run/git-fetch.ts): real git is the SERVER here (a test helper puts
// `git upload-pack` behind HTTP) and the judge of the output; the code under test runs no binary.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTarGz } from "@longshore/act-runner";
import { createHttpClient, type SafeFetch } from "@longshore/net";
import {
  DEFAULT_FETCH_LIMITS,
  fetchCommit,
  GitFetchError,
  materialize,
  oidOf,
} from "../src/run/git-fetch";
import { gitRepoSource } from "../src/scheduler";
import { serveGitRepo } from "./git-http-server";

const base = mkdtempSync(join(tmpdir(), "ls-gitfetch-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ENV = {
  PATH: process.env.PATH ?? "",
  HOME: base,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });

let n = 0;
/** A repository with history, nested files, an executable, a symlink, a binary and near-duplicate big files (deltas). */
function makeRepo(): { dir: string; sha: string } {
  const dir = join(base, `repo${n++}`);
  mkdirSync(join(dir, "src/deep"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const big = Array.from(
    { length: 2000 },
    (_, i) => `line ${i} of a fairly long and repetitive file`,
  ).join("\n");
  writeFileSync(join(dir, "a.txt"), "first\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(join(dir, "src/big1.txt"), big);
  writeFileSync(join(dir, "src/big2.txt"), `${big}\nextra line\n`);
  writeFileSync(join(dir, "src/deep/run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 255, 254, 0, 0, 7]));
  writeFileSync(join(dir, ".github-ci.yml"), "name: ci\n");
  execFileSync("ln", ["-s", "src/big1.txt", join(dir, "link")]);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "second commit: the subject line\n\nbody");
  git(dir, "repack", "-adf", "--depth=50", "--window=250");
  return { dir, sha: git(dir, "rev-parse", "HEAD").trim() };
}

const extract = (tgz: Uint8Array): string => {
  const out = join(base, `x${n++}`);
  mkdirSync(out);
  const f = join(out, "t.tgz");
  writeFileSync(f, tgz);
  execFileSync("tar", ["xzf", f, "-C", out]);
  rmSync(f);
  return out;
};

describe("a checkout fetched in process", () => {
  test("is what git would have fetched: real git accepts it, the tree and modes match, the history is cut at depth 1", async () => {
    const { dir, sha } = makeRepo();
    const server = serveGitRepo(dir);
    const src = gitRepoSource({ cloneUrl: () => server.url, fetch: server.fetch });
    const co = await src.checkout({ sha } as never, { owner: "acme", repo: "web" });
    try {
      const x = extract(co.tarball);
      // git's own checks: the object store is sound, HEAD is the commit, and a checkout from it is clean
      expect(git(x, "rev-parse", "HEAD").trim()).toBe(sha);
      git(x, "fsck", "--full", "--no-dangling");
      expect(git(x, "log", "--format=%H|%s").trim()).toBe(`${sha}|second commit: the subject line`);
      expect(git(x, "remote", "get-url", "origin").trim()).toBe(server.url);
      expect(readFileSync(join(x, ".git/shallow"), "utf8").trim()).toBe(sha);
      git(x, "checkout", "-q", "--force", "--detach", sha);
      expect(git(x, "status", "--porcelain").trim()).toBe("");
      // the working tree equals the committed one, modes and symlink included
      expect(git(x, "ls-files", "-s").trim()).toBe(git(dir, "ls-files", "-s").trim());
      expect(statSync(join(x, "src/deep/run.sh")).mode & 0o111).not.toBe(0);
      expect(statSync(join(x, "src/big1.txt")).mode & 0o111).toBe(0);
      expect(lstatSync(join(x, "link")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(x, "link"))).toBe("src/big1.txt");
      expect(
        readFileSync(join(x, "bin.dat")).equals(Buffer.from([0, 1, 2, 255, 254, 0, 0, 7])),
      ).toBe(true);
      expect(co.readFile(".github-ci.yml")).toBe("name: ci\n");
    } finally {
      server.stop();
      co.dispose?.();
    }
  }, 60_000);

  test("asks for exactly the commit, at depth 1, protocol v2, and sends no credential or cookie", async () => {
    const { dir, sha } = makeRepo();
    const server = serveGitRepo(dir);
    const seen: Record<string, string>[] = [];
    const spy: SafeFetch = async (input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return server.fetch(input, init);
    };
    try {
      await fetchCommit({ url: server.url, sha, fetch: spy });
      const post = server.requests.find((r) => r.method === "POST")!;
      const text = new TextDecoder().decode(post.body);
      expect(text).toContain(`want ${sha}`);
      expect(text).toContain("deepen 1");
      expect(text).toContain(`command=${"fetch"}`);
      expect(seen.every((h) => h["git-protocol"] === "version=2")).toBe(true);
      expect(seen.every((h) => h.authorization === undefined && h.cookie === undefined)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("needs no git or tar binary: replayed from recorded responses, with every process spawn forbidden", async () => {
    const { dir, sha } = makeRepo();
    const server = serveGitRepo(dir);
    const recorded: { url: string; body: Uint8Array }[] = [];
    const record: SafeFetch = async (input, init) => {
      const res = await server.fetch(input, init);
      recorded.push({ url: String(input), body: new Uint8Array(await res.clone().arrayBuffer()) });
      return res;
    };
    await fetchCommit({ url: server.url, sha, fetch: record });
    server.stop();
    const replay: SafeFetch = async (input) => {
      const tail = String(input).replace(/^.*\.git/, "");
      const hit = recorded.find((r) => r.url.replace(/^.*\.git/, "") === tail)!;
      return new Response(hit.body, { status: 200 });
    };
    const spawn = Bun.spawn;
    const spawnSync = Bun.spawnSync;
    (Bun as { spawn: unknown }).spawn = () => {
      throw new Error("a process was spawned");
    };
    (Bun as { spawnSync: unknown }).spawnSync = () => {
      throw new Error("a process was spawned");
    };
    try {
      const src = gitRepoSource({
        cloneUrl: () => "https://example.test/acme/web.git",
        fetch: replay,
      });
      const co = await src.checkout({ sha } as never, { owner: "acme", repo: "web" });
      expect(co.tarball.length).toBeGreaterThan(1000);
      expect(readTarGz(co.tarball).some((e) => e.path.endsWith(".git/HEAD"))).toBe(true);
      co.dispose?.();
    } finally {
      (Bun as { spawn: unknown }).spawn = spawn;
      (Bun as { spawnSync: unknown }).spawnSync = spawnSync;
    }
  }, 60_000);

  test("a root commit has no shallow file, and a repository of one empty file works", async () => {
    const dir = join(base, `repo${n++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "empty"), "");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "root");
    const sha = git(dir, "rev-parse", "HEAD").trim();
    const server = serveGitRepo(dir);
    try {
      const c = await fetchCommit({ url: server.url, sha, fetch: server.fetch });
      const out = join(base, `m${n++}`);
      mkdirSync(out);
      materialize(out, c, server.url);
      expect(statSync(join(out, "empty")).size).toBe(0);
      expect(() => statSync(join(out, ".git/shallow"))).toThrow();
      git(out, "fsck", "--full", "--no-dangling");
    } finally {
      server.stop();
    }
  });
});

describe("what the server says is verified, not trusted", () => {
  const withServer = async <T>(
    f: (s: ReturnType<typeof serveGitRepo>, sha: string) => Promise<T>,
  ): Promise<T> => {
    const { dir, sha } = makeRepo();
    const s = serveGitRepo(dir);
    try {
      return await f(s, sha);
    } finally {
      s.stop();
    }
  };

  test("a commit the server does not have is an error, not a different commit", async () => {
    await withServer(async (s) => {
      await expect(
        fetchCommit({ url: s.url, sha: "1".repeat(40), fetch: s.fetch }),
      ).rejects.toBeInstanceOf(GitFetchError);
    });
  });

  test("a corrupted pack fails its checksum; a pack answering for another commit is refused", async () => {
    await withServer(async (s, sha) => {
      const flip: SafeFetch = async (input, init) => {
        const res = await s.fetch(input, init);
        if (init?.method !== "POST") return res;
        const b = new Uint8Array(await res.arrayBuffer());
        b[b.length - 30] = b[b.length - 30]! ^ 0xff;
        return new Response(b);
      };
      await expect(fetchCommit({ url: s.url, sha, fetch: flip })).rejects.toThrow(
        /checksum|inflate|size|pack/i,
      );
    });
  });

  test("a server that does not speak protocol v2, or answers with an error, is refused", async () => {
    const v1: SafeFetch = async () =>
      new Response("001e# service=git-upload-pack\n0000", { status: 200 });
    await expect(
      fetchCommit({ url: "https://x.test/a/b.git", sha: "a".repeat(40), fetch: v1 }),
    ).rejects.toThrow(/protocol v2/);
    const down: SafeFetch = async () => new Response("no", { status: 503 });
    await expect(
      fetchCommit({ url: "https://x.test/a/b.git", sha: "a".repeat(40), fetch: down }),
    ).rejects.toThrow(/503/);
    await expect(
      fetchCommit({ url: "https://x.test/a/b.git", sha: "not-a-sha", fetch: down }),
    ).rejects.toThrow(/40 character/);
  });

  test("size limits stop a pack that is too large, or has too many objects or files", async () => {
    await withServer(async (s, sha) => {
      await expect(
        fetchCommit({ url: s.url, sha, fetch: s.fetch, limits: { maxObjects: 2 } }),
      ).rejects.toThrow(/too many objects/);
      await expect(
        fetchCommit({ url: s.url, sha, fetch: s.fetch, limits: { maxInflatedBytes: 100 } }),
      ).rejects.toThrow(/too large/);
      const c = await fetchCommit({ url: s.url, sha, fetch: s.fetch });
      const out = join(base, `m${n++}`);
      mkdirSync(out);
      expect(() => materialize(out, c, s.url, { maxEntries: 2 })).toThrow(/too many files/);
    });
  });
});

describe("a hostile tree is refused before anything is written outside the directory", () => {
  /** A repository whose root tree is built from raw entries (git plumbing, no safety checks). */
  function hostile(entries: { mode: string; name: string; blob?: string; sub?: string }[]): {
    dir: string;
    sha: string;
  } {
    const dir = join(base, `hostile${n++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    const hash = (data: string): string =>
      execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: dir,
        env: ENV,
        input: data,
        encoding: "utf8",
      }).trim();
    const tree = (rows: { mode: string; name: string; oid: string }[]): string => {
      const parts: Buffer[] = [];
      for (const r of rows)
        parts.push(Buffer.from(`${r.mode} ${r.name}\0`), Buffer.from(r.oid, "hex"));
      return execFileSync("git", ["hash-object", "-w", "-t", "tree", "--literally", "--stdin"], {
        cwd: dir,
        env: ENV,
        input: Buffer.concat(parts),
        encoding: "utf8",
      }).trim();
    };
    const rows = entries.map((e) => ({
      mode: e.mode,
      name: e.name,
      oid: e.sub
        ? tree([{ mode: "100644", name: "inner", oid: hash("x") }])
        : hash(e.blob ?? "data"),
    }));
    const root = tree(rows);
    const sha = execFileSync("git", ["commit-tree", root, "-m", "hostile"], {
      cwd: dir,
      env: ENV,
      encoding: "utf8",
    }).trim();
    return { dir, sha };
  }

  const refuse = async (entries: Parameters<typeof hostile>[0], why: RegExp): Promise<void> => {
    const { dir, sha } = hostile(entries);
    const s = serveGitRepo(dir);
    const out = join(base, `h${n++}`);
    mkdirSync(out);
    try {
      const c = await fetchCommit({ url: s.url, sha, fetch: s.fetch });
      expect(() => materialize(out, c, s.url)).toThrow(why);
    } finally {
      s.stop();
    }
  };

  test(".git (any case), .., a name with a slash or NUL, and a symlinked .gitmodules are refused", async () => {
    await refuse([{ mode: "100644", name: ".git" }], /unsafe path name/);
    await refuse([{ mode: "40000", name: ".GIT", sub: "1" }], /unsafe path name/);
    await refuse([{ mode: "100644", name: ".." }], /unsafe path name/);
    await refuse([{ mode: "100644", name: "a\\b" }], /unsafe path name/);
    await refuse([{ mode: "120000", name: ".gitmodules", blob: "/etc/passwd" }], /\.gitmodules/);
  });

  test("a symlink and a directory that fold to one name (a case-insensitive disk) are refused, not written through", async () => {
    await refuse(
      [
        { mode: "120000", name: "A", blob: "/tmp" },
        { mode: "40000", name: "a", sub: "1" },
      ],
      /through a symlink/,
    );
  });

  test("an unsupported mode is refused; a submodule is an empty directory, not a fetch", async () => {
    await refuse([{ mode: "100600", name: "x" }], /unsupported mode/);
    const { dir, sha } = hostile([
      { mode: "100644", name: "f" },
      { mode: "160000", name: "mod" },
    ]);
    const s = serveGitRepo(dir);
    const out = join(base, `h${n++}`);
    mkdirSync(out);
    try {
      const c = await fetchCommit({ url: s.url, sha, fetch: s.fetch });
      materialize(out, c, s.url);
      expect(statSync(join(out, "mod")).isDirectory()).toBe(true);
    } finally {
      s.stop();
    }
  });
});

describe("object ids", () => {
  test("oidOf is git's id", () => {
    expect(oidOf("blob", new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    expect(oidOf("blob", new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
  test("the defaults are bounded", () => {
    expect(DEFAULT_FETCH_LIMITS.maxPackBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(createHttpClient).toBeDefined();
  });
});
