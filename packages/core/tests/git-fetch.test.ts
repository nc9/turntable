// The in-process git fetch (run/git-fetch.ts): real git is the SERVER here (a test helper puts
// `git upload-pack` behind HTTP) and the judge of the output; the code under test runs no binary.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTarGz } from "@longshore/act-runner";
import { createHttpClient, type SafeFetch } from "@longshore/net";
import {
  clean,
  DEFAULT_FETCH_LIMITS,
  fetchCommit,
  GitFetchError,
  materialize,
  oidOf,
} from "../src/run/git-fetch";
import { gitRepoSource } from "../src/scheduler";
import { performCheckout } from "../src/run/checkout";
import { CHECKOUT_COMMAND, serveGitRepo } from "./git-http-server";

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
    const src = gitRepoSource({
      cloneUrl: () => server.url,
      allowHosts: ["127.0.0.1"],
      command: CHECKOUT_COMMAND,
    });
    const co = await src.checkout({ sha } as never, { owner: "acme", repo: "web" });
    try {
      const x = extract(co.tarball);
      // git's own checks: the object store is sound, HEAD is the commit, and a checkout from it is clean
      expect(git(x, "rev-parse", "HEAD").trim()).toBe(sha);
      git(x, "fsck", "--full", "--no-dangling");
      expect(git(x, "log", "--format=%H|%s").trim()).toBe(`${sha}|second commit: the subject line`);
      expect(git(x, "remote", "get-url", "origin").trim()).toBe(server.url);
      expect(readFileSync(join(x, ".git/shallow"), "utf8").trim()).toBe(sha);
      // the delivered index is real: with the checkout DROPPED and nothing re-run, git sees a clean tree
      expect(git(x, "status", "--porcelain").trim()).toBe("");
      expect(git(x, "diff", "--stat").trim()).toBe("");
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
      const out = join(base, `replay${n++}.tgz`);
      const r = await performCheckout({
        owner: "acme",
        repo: "web",
        sha,
        url: "https://example.test/acme/web.git",
        out,
        fetch: replay,
        allowHosts: ["example.test"],
      });
      expect(r.tarballBytes).toBeGreaterThan(1000);
      expect(
        readTarGz(new Uint8Array(readFileSync(out))).some((e) => e.path.endsWith(".git/HEAD")),
      ).toBe(true);
      rmSync(r.dir, { recursive: true, force: true });
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

/** A repository whose root tree is built from raw entries (git plumbing, no safety checks). */
function hostileTree(
  entries: { mode: string; name: string; blob?: string; sub?: string; raw?: Buffer }[],
): {
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
  const tree = (rows: { mode: string; name: string; oid: string; raw?: Buffer }[]): string => {
    const parts: Buffer[] = [];
    for (const r of rows)
      parts.push(
        Buffer.from(`${r.mode} `),
        r.raw ?? Buffer.from(r.name),
        Buffer.from("\0"),
        Buffer.from(r.oid, "hex"),
      );
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
    ...(e.raw ? { raw: e.raw } : {}),
    oid: e.sub ? tree([{ mode: "100644", name: "inner", oid: hash("x") }]) : hash(e.blob ?? "data"),
  }));
  const root = tree(rows);
  const sha = execFileSync("git", ["commit-tree", root, "-m", "hostile"], {
    cwd: dir,
    env: ENV,
    encoding: "utf8",
  }).trim();
  return { dir, sha };
}

describe("a hostile tree is refused before anything is written outside the directory", () => {
  const hostile = hostileTree;

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

  test("names that a normalising or ignoring filesystem treats as one are refused: NFD against NFC, ignorable characters, trailing dots", async () => {
    // a symlink first, then a directory whose name is the same file on HFS+/APFS or NTFS
    const nfd = "e\u0301"; // e + combining acute: sorts BEFORE the NFC form, so the symlink must be the NFD one
    const nfc = "\u00e9";
    await refuse(
      [
        { mode: "120000", name: nfd, blob: "/tmp" },
        { mode: "40000", name: nfc, sub: "1" },
      ],
      /through a symlink/,
    );
    await refuse(
      [
        { mode: "120000", name: "ab", blob: "/tmp" },
        { mode: "40000", name: "a\u200cb", sub: "1" }, // a zero-width non-joiner HFS+ ignores
      ],
      /through a symlink/,
    );
    await refuse(
      [
        { mode: "120000", name: "x", blob: "/tmp" },
        { mode: "40000", name: "x.", sub: "1" }, // NTFS drops the trailing dot
      ],
      /through a symlink/,
    );
    // the same folding applies to a FILE named like the symlink
    await refuse(
      [
        { mode: "120000", name: "Q", blob: "/tmp" },
        { mode: "100644", name: "q" },
      ],
      /through a symlink/,
    );
  });

  test("whatever the names say, a parent that is a symlink ON DISK when a write comes is refused: the real guard", async () => {
    const { dir, sha } = hostile([{ mode: "40000", name: "d", sub: "1" }]);
    const s = serveGitRepo(dir);
    const out = join(base, `swap${n++}`);
    const outside = join(base, `outside${n++}`);
    mkdirSync(out);
    mkdirSync(outside);
    try {
      const c = await fetchCommit({ url: s.url, sha, fetch: s.fetch });
      expect(() =>
        materialize(
          out,
          c,
          s.url,
          {},
          {
            beforeWrite: (path) => {
              // just before d/inner is written, d (made a moment ago) becomes a link to somewhere else
              if (path === "d/inner") {
                rmSync(join(out, "d"), { recursive: true });
                symlinkSync(outside, join(out, "d"));
              }
            },
          },
        ),
      ).toThrow(/through a symlink/);
      expect(readdirSync(outside)).toEqual([]); // nothing was written through it
    } finally {
      s.stop();
    }
  });

  test("two paths that collide on the disk are an error, not an overwrite", async () => {
    // a file written where something already is: simulated by creating it before the walk reaches it
    const { dir, sha } = hostile([{ mode: "100644", name: "f" }]);
    const s = serveGitRepo(dir);
    const out = join(base, `collide${n++}`);
    mkdirSync(out);
    try {
      const c = await fetchCommit({ url: s.url, sha, fetch: s.fetch });
      expect(() =>
        materialize(
          out,
          c,
          s.url,
          {},
          { beforeWrite: () => writeFileSync(join(out, "f"), "already here") },
        ),
      ).toThrow(/same name on this filesystem/);
      expect(readFileSync(join(out, "f"), "utf8")).toBe("already here");
    } finally {
      s.stop();
    }
  });

  test("a leading byte-order mark in a name is kept, not silently dropped, and a symlink target is written as the bytes it is", async () => {
    const out = join(base, `bom${n++}`);
    mkdirSync(out);
    // in git's order: ln, plain, then the BOM name (its first byte is 0xEF)
    const { dir, sha } = hostile([
      { mode: "120000", name: "ln", blob: "/x" },
      { mode: "100644", name: "plain" },
      { mode: "100644", name: "\ufeffb" },
    ]);
    const s = serveGitRepo(dir);
    try {
      const c = await fetchCommit({ url: s.url, sha, fetch: s.fetch });
      materialize(out, c, s.url);
      expect(readdirSync(out)).toContain("\ufeffb");
      expect(readdirSync(out)).not.toContain("b");
    } finally {
      s.stop();
    }
    // a symlink whose target is not valid UTF-8: its blob is raw bytes
    const rawTarget = Buffer.from([0x2f, 0xff, 0xfe, 0x41]);
    const { dir: d2 } = hostile([{ mode: "100644", name: "seed" }]);
    const rawBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: d2,
      env: ENV,
      input: rawTarget,
    })
      .toString()
      .trim();
    const treeOid = execFileSync(
      "git",
      ["hash-object", "-w", "-t", "tree", "--literally", "--stdin"],
      {
        cwd: d2,
        env: ENV,
        input: Buffer.concat([Buffer.from("120000 raw\0"), Buffer.from(rawBlob, "hex")]),
      },
    )
      .toString()
      .trim();
    const sha2 = execFileSync("git", ["commit-tree", treeOid, "-m", "raw"], {
      cwd: d2,
      env: ENV,
      encoding: "utf8",
    }).trim();
    const s2 = serveGitRepo(d2);
    const out2 = join(base, `raw${n++}`);
    mkdirSync(out2);
    try {
      const c2 = await fetchCommit({ url: s2.url, sha: sha2, fetch: s2.fetch });
      materialize(out2, c2, s2.url);
      expect(readlinkSync(join(out2, "raw"), { encoding: "buffer" })).toEqual(rawTarget);
    } finally {
      s2.stop();
    }
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

describe("more hostile trees and commits", () => {
  const withRepo = async (
    entries: Parameters<typeof hostileTree>[0],
    f: (
      c: Awaited<ReturnType<typeof fetchCommit>>,
      s: ReturnType<typeof serveGitRepo>,
    ) => void | Promise<void>,
  ): Promise<void> => {
    const { dir, sha } = hostileTree(entries);
    const s = serveGitRepo(dir);
    try {
      await f(await fetchCommit({ url: s.url, sha, fetch: s.fetch }), s);
    } finally {
      s.stop();
    }
  };
  const mk = (): string => {
    const out = join(base, `h${n++}`);
    mkdirSync(out);
    return out;
  };

  test("every spelling of .git a filesystem might fold to it is refused: NTFS dots and spaces, 8.3 names, streams, HFS-ignorable characters", async () => {
    for (const name of [
      ".git ",
      ".git.",
      ".git. .",
      ".GiT",
      "git~1",
      "GIT~1",
      ".g\u200cit",
      ".\u200egit",
      ".git::$INDEX_ALLOCATION",
      ".git:stream",
    ]) {
      await withRepo([{ mode: "100644", name }], (c, s) => {
        expect(() => materialize(mk(), c, s.url), JSON.stringify(name)).toThrow(/unsafe path name/);
      });
    }
    // and a symlink may not be any spelling of .gitmodules
    for (const name of [
      ".gitmodules",
      ".GITMODULES",
      ".gitmodules ",
      "gitmod~1",
      ".gitmodules::$DATA",
    ]) {
      await withRepo([{ mode: "120000", name, blob: "/etc/passwd" }], (c, s) => {
        expect(() => materialize(mk(), c, s.url), name).toThrow(/gitmodules/);
      });
    }
    // an ordinary name that merely contains .git is fine
    await withRepo(
      [
        { mode: "100644", name: ".gitignore" },
        { mode: "100644", name: "x.git" },
      ],
      (c, s) => {
        expect(() => materialize(mk(), c, s.url)).not.toThrow();
      },
    );
  });

  test("a tree must be unique, in git's order and valid UTF-8", async () => {
    await withRepo(
      [
        { mode: "100644", name: "a" },
        { mode: "100644", name: "a" },
      ],
      (c, s) => {
        expect(() => materialize(mk(), c, s.url)).toThrow(/same name twice/);
      },
    );
    await withRepo(
      [
        { mode: "100644", name: "b" },
        { mode: "100644", name: "a" },
      ],
      (c, s) => {
        expect(() => materialize(mk(), c, s.url)).toThrow(/not in git's order/);
      },
    );
    // a directory sorts as if its name ended in a slash: `a.b` (file) comes before `a` (directory) ...
    await withRepo(
      [
        { mode: "100644", name: "a.b" },
        { mode: "40000", name: "a", sub: "1" },
      ],
      (c, s) => {
        expect(() => materialize(mk(), c, s.url)).not.toThrow();
      },
    );
    // ... and the other order is refused
    await withRepo(
      [
        { mode: "40000", name: "a", sub: "1" },
        { mode: "100644", name: "a.b" },
      ],
      (c, s) => {
        expect(() => materialize(mk(), c, s.url)).toThrow(/not in git's order/);
      },
    );
    await withRepo(
      [{ mode: "100644", name: "bad", raw: Buffer.from([0x62, 0xff, 0xfe]) }],
      (c, s) => {
        expect(() => materialize(mk(), c, s.url)).toThrow(/UTF-8/);
      },
    );
  });

  test("a tree object over its size cap is refused, and the entry count is checked inside the loop", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(3, "0")}`);
    await withRepo(
      names.map((name) => ({ mode: "100644", name })),
      (c, s) => {
        expect(() => materialize(mk(), c, s.url, { maxTreeBytes: 100 })).toThrow(
          /tree object is too large/,
        );
        expect(() => materialize(mk(), c, s.url, { maxEntries: 3 })).toThrow(/too many files/);
      },
    );
  });

  test("an unreachable object in the pack is not written, and the object map is released afterwards", async () => {
    await withRepo([{ mode: "100644", name: "f" }], (c, s) => {
      const junk = new TextEncoder().encode("unreachable junk");
      const oid = oidOf("blob", junk);
      c.objects.set(oid, { type: "blob", data: junk });
      const out = mk();
      materialize(out, c, s.url);
      expect(() => statSync(join(out, ".git/objects", oid.slice(0, 2), oid.slice(2)))).toThrow();
      expect(c.objects.size).toBe(0);
      git(out, "fsck", "--full", "--no-dangling");
    });
  });

  test("a commit header is anchored: tree first, then parents, then author; a tree line in the message is not read", async () => {
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const who = "author a <a@x> 1 +0000\ncommitter a <a@x> 1 +0000\n";
    const pkt = (s: string): Uint8Array =>
      new TextEncoder().encode(`${(s.length + 4).toString(16).padStart(4, "0")}${s}`);
    /** A server that answers any fetch with a pack of the empty tree and this commit text. */
    const serving = (commit: string): { sha: string; fetch: SafeFetch } => {
      const body = new TextEncoder().encode(commit);
      const sha = oidOf("commit", body);
      const pack = packOf([
        { header: sizeAndType(1, body.length), body },
        { header: sizeAndType(2, 0), body: new Uint8Array() },
      ]);
      return {
        sha,
        fetch: async (_u, init) => {
          if (init?.method !== "POST")
            return new Response(
              new Uint8Array([
                ...pkt("version 2\n"),
                ...pkt("fetch\n"),
                ...new TextEncoder().encode("0000"),
              ]),
            );
          const data = new Uint8Array(pack.length + 1);
          data[0] = 1;
          data.set(pack, 1);
          const len = (data.length + 4).toString(16).padStart(4, "0");
          return new Response(
            new Uint8Array([
              ...pkt("packfile\n"),
              ...new TextEncoder().encode(len),
              ...data,
              ...new TextEncoder().encode("0000"),
            ]),
          );
        },
      };
    };
    const good = serving(
      `tree ${EMPTY_TREE}\n${who}\nsubject\n\ntree ${"f".repeat(40)}\nparent ${"e".repeat(40)}\n`,
    );
    const c = await fetchCommit({
      url: "https://x.test/a/b.git",
      sha: good.sha,
      fetch: good.fetch,
    });
    expect(c.tree).toBe(EMPTY_TREE);
    expect(c.parents).toEqual([]);
    expect(c.subject).toBe("subject");
    const withParent = serving(
      `tree ${EMPTY_TREE}\nparent ${"1".repeat(40)}\nparent ${"2".repeat(40)}\n${who}\nm\n`,
    );
    expect(
      (
        await fetchCommit({
          url: "https://x.test/a/b.git",
          sha: withParent.sha,
          fetch: withParent.fetch,
        })
      ).parents,
    ).toEqual(["1".repeat(40), "2".repeat(40)]);
    for (const bad of [
      `parent ${"1".repeat(40)}\ntree ${EMPTY_TREE}\n${who}\nm\n`, // parent before tree
      `tree ${EMPTY_TREE}\n\nm\n`, // no author
      `${who}tree ${EMPTY_TREE}\n\nm\n`, // tree not first
      `tree ${EMPTY_TREE}\nparent short\n${who}\nm\n`,
    ]) {
      const s = serving(bad);
      await expect(
        fetchCommit({ url: "https://x.test/a/b.git", sha: s.sha, fetch: s.fetch }),
      ).rejects.toThrow(/header is malformed/);
    }
  });

  test("a pkt-line length must be four hex digits; text from the other side is cleaned and shortened in errors", async () => {
    const adv =
      (body: string): SafeFetch =>
      async () =>
        new Response(body, { status: 200 });
    for (const bad of ["0x1f0000", "zzzz", "+01f", "00 1"])
      await expect(
        fetchCommit({ url: "https://x.test/a/b.git", sha: "a".repeat(40), fetch: adv(bad) }),
      ).rejects.toThrow(/pkt-line/);
    expect(clean("a\u0000b\u001b[31m\u202ec\n".repeat(1))).toBe("a b [31m c");
    expect(clean("x".repeat(500)).length).toBe(123);
    // a server's refusal text: control characters gone, length bounded
    const evil = `${"E".repeat(400)}\u001b[2J\u0007`;
    const body = (() => {
      const pkt = (s: string): string => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
      return `${pkt("version 2\n")}${pkt("fetch\n")}0000`;
    })();
    const calls: string[] = [];
    const stub: SafeFetch = async (_u, init) => {
      calls.push(init?.method ?? "GET");
      if (init?.method !== "POST") return new Response(body, { status: 200 });
      const pkt = (s: string): string => `${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
      return new Response(`${pkt("packfile\n")}${pkt(`\u0003${evil}`)}0000`, { status: 200 });
    };
    const err = await fetchCommit({
      url: "https://x.test/a/b.git",
      sha: "a".repeat(40),
      fetch: stub,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GitFetchError);
    const msg = (err as Error).message;
    expect(msg.length).toBeLessThan(160);
    expect(msg).not.toContain("\u001b");
    expect(msg).not.toContain("\u0007");
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

// ---- a hostile pack and a hostile server ----

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { readPack } from "../src/run/git-fetch";

const sizeAndType = (type: number, size: number): number[] => {
  const out: number[] = [];
  let b = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(b);
  return out;
};
const ofsBytes = (distance: number): number[] => {
  const out = [distance & 0x7f];
  let d = Math.floor(distance / 128);
  while (d > 0) {
    d -= 1;
    out.unshift(0x80 | (d & 0x7f));
    d = Math.floor(d / 128);
  }
  return out;
};
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
};
type PackItem = { header: number[]; body: Uint8Array };
/** A pack from raw items, with a correct trailer, so only the property under test is wrong. */
const packOf = (items: PackItem[], count = items.length): Uint8Array => {
  const head = Buffer.alloc(12);
  head.write("PACK", 0);
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(count, 8);
  const body = Buffer.concat(
    items.flatMap((i) => [Buffer.from(i.header), Buffer.from(deflateSync(i.body))]),
  );
  const all = Buffer.concat([head, body]);
  return new Uint8Array(Buffer.concat([all, createHash("sha1").update(all).digest()]));
};
const blob = (data: Uint8Array, declared = data.length): PackItem => ({
  header: sizeAndType(3, declared),
  body: data,
});
/** A delta whose result is `size` bytes made of one copy of the whole base. */
const copyDelta = (baseLen: number, size: number): Uint8Array => {
  const ops: number[] = [...varint(baseLen), ...varint(size)];
  let left = size;
  while (left > 0) {
    const n = Math.min(left, baseLen, 0xffffff);
    ops.push(0x80 | 0x10 | 0x20 | 0x40, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff);
    left -= n;
  }
  return new Uint8Array(ops);
};
const ofsDelta = (distance: number, delta: Uint8Array): PackItem => ({
  header: [...sizeAndType(6, delta.length), ...ofsBytes(distance)],
  body: delta,
});
const deflatedLen = (b: Uint8Array): number => deflateSync(b).length;

describe("a hostile pack is bounded before it is acted on", () => {
  const small = { ...DEFAULT_FETCH_LIMITS };

  test("a zlib bomb: a stream that inflates past its declared size is cut, a declared size over the cap is refused unread", () => {
    const bomb = new Uint8Array(20_000_000); // 20 MB of zeros: a few KB compressed
    expect(deflatedLen(bomb)).toBeLessThan(40_000);
    expect(() => readPack(packOf([blob(bomb, 10)]), small)).toThrow(GitFetchError);
    const t0 = Date.now();
    expect(() => readPack(packOf([blob(new Uint8Array(10), 2 ** 40)]), small)).toThrow(/too large/);
    expect(Date.now() - t0).toBeLessThan(1000);
    // honestly declared but over the per-object cap
    expect(() => readPack(packOf([blob(bomb)]), { ...small, maxObjectBytes: 1_000_000 })).toThrow(
      /too large/,
    );
  });

  test("the total unpacked size is one budget across objects, deltas included", () => {
    const one = new Uint8Array(400).fill(7);
    expect(() =>
      readPack(packOf([blob(one), blob(one.map((x) => x + 1)), blob(one.map((x) => x + 2))]), {
        ...small,
        maxInflatedBytes: 1000,
      }),
    ).toThrow(/too large when unpacked/);
    // amplification: a 1 MiB base and many tiny deltas that each expand back to 1 MiB
    const base = new Uint8Array(1024 * 1024).fill(9);
    const items: PackItem[] = [blob(base)];
    for (let i = 0; i < 40; i += 1) {
      const d = copyDelta(base.length, base.length);
      const baseHeader = items[0]!.header.length;
      const dist = baseHeader + deflatedLen(base);
      // every delta points at the base: its distance grows by the deltas packed in between
      const between = items
        .slice(1)
        .reduce((n, it) => n + it.header.length + deflatedLen(it.body), 0);
      items.push(ofsDelta(dist + between, d));
    }
    expect(() => readPack(packOf(items), { ...small, maxInflatedBytes: 5 * 1024 * 1024 })).toThrow(
      /too large|more than the pack may unpack to/,
    );
  });

  test("a delta that declares a huge result is refused before anything is allocated", () => {
    const base = new Uint8Array(10).fill(1);
    const d = new Uint8Array([...varint(10), ...varint(5_000_000_000), 0x90, 10]);
    const dist = blobHeaderLen(base) + deflatedLen(base);
    const t0 = Date.now();
    expect(() => readPack(packOf([blob(base), ofsDelta(dist, d)]), small)).toThrow(
      /too large|more than the pack may unpack to/,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  const blobHeaderLen = (b: Uint8Array): number => sizeAndType(3, b.length).length;

  test("a delta declaring 4 GiB from a tiny base is refused fast, with no large allocation", () => {
    const base = new Uint8Array(10).fill(1);
    const d = new Uint8Array([...varint(10), ...varint(4 * 1024 ** 3), 0x90, 10]);
    const dist = blobHeaderLen(base) + deflatedLen(base);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = Date.now();
    expect(() => readPack(packOf([blob(base), ofsDelta(dist, d)]), small)).toThrow(
      /more than the pack may unpack to|too large/,
    );
    expect(Date.now() - t0).toBeLessThan(500);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(50 * 1024 * 1024);
    // what is LEFT of the budget bounds it too, not only the per-object cap: 100 bytes of room, a 1 KB result
    const r = new Uint8Array([...varint(10), ...varint(1000), 0x90, 10]);
    expect(() =>
      readPack(packOf([blob(base), ofsDelta(dist, r)]), { ...small, maxInflatedBytes: 100 }),
    ).toThrow(/more than the pack may unpack to|too large/);
  });

  test("a chain of deltas that each double their base is refused at the budget, not at memory", () => {
    // base 1 KiB; each delta is the previous object twice (two copy ops): 2 KiB, 4 KiB, ...
    const base = new Uint8Array(1024).fill(5);
    const items: PackItem[] = [blob(base)];
    const starts = [12];
    let at = 12 + blobHeaderLen(base) + deflatedLen(base);
    let size = base.length;
    for (let i = 0; i < 40; i += 1) {
      const copy = [0x80 | 0x10 | 0x20 | 0x40, 0, 0, 0];
      const half = [size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff];
      const ops = new Uint8Array([
        ...varint(size),
        ...varint(size * 2),
        copy[0]!,
        ...half,
        copy[0]!,
        ...half,
      ]);
      // 0x80|0x10|0x20|0x40 = copy with 3 size bytes and no offset bytes (offset 0)
      const it = ofsDelta(at - starts.at(-1)!, ops);
      starts.push(at);
      at += it.header.length + deflatedLen(ops);
      items.push(it);
      size *= 2;
    }
    const t0 = Date.now();
    expect(() => readPack(packOf(items), { ...small, maxInflatedBytes: 1024 * 1024 })).toThrow(
      /more than the pack may unpack to|too large/,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    // and with the default budget the chain still stops: 2^30 bytes of base-times-doubling is over it
    expect(() => readPack(packOf(items), small)).toThrow(GitFetchError);
  });

  test("a copy longer than the base, or than the output left, is refused", () => {
    const base = new Uint8Array(10).fill(1);
    const dist = blobHeaderLen(base) + deflatedLen(base);
    const overBase = new Uint8Array([
      ...varint(10),
      ...varint(100),
      0x80 | 0x10 | 0x20,
      0,
      100 & 0xff,
      0,
    ]);
    expect(() => readPack(packOf([blob(base), ofsDelta(dist, overBase)]), small)).toThrow(
      /copies out of range/,
    );
    const overOut = new Uint8Array([...varint(10), ...varint(5), 0x80 | 0x10, 10]);
    expect(() => readPack(packOf([blob(base), ofsDelta(dist, overOut)]), small)).toThrow(
      /copies out of range/,
    );
  });

  test("a delta chain is depth-limited, and a shorter one is fine", () => {
    const build = (n: number): Uint8Array => {
      const base = new TextEncoder().encode("0123456789");
      const items: PackItem[] = [blob(base)];
      const offsets = [12];
      let at = 12 + blobHeaderLen(base) + deflatedLen(base);
      for (let i = 0; i < n; i += 1) {
        const d = copyDelta(10, 10);
        const it = ofsDelta(at - offsets.at(-1)!, d);
        offsets.push(at);
        at += it.header.length + deflatedLen(d);
        items.push(it);
      }
      return packOf(items);
    };
    expect(() => readPack(build(600), small)).toThrow(/chain is too long/);
    expect(readPack(build(100), small).size).toBe(1); // every link rebuilds the same 10 bytes
  });

  test("an offset delta may only point at an earlier object: itself, before the first, or a missing one is refused", () => {
    const base = new Uint8Array(10).fill(3);
    const d = copyDelta(10, 10);
    const first = 12;
    const second = first + blobHeaderLen(base) + deflatedLen(base);
    // distance 0: the delta itself
    expect(() => readPack(packOf([blob(base), ofsDelta(0, d)]), small)).toThrow(/outside the pack/);
    // distance past the start of the pack
    expect(() => readPack(packOf([blob(base), ofsDelta(second + 5, d)]), small)).toThrow(
      /outside the pack/,
    );
    // into the middle of an object (no object starts there)
    expect(() => readPack(packOf([blob(base), ofsDelta(second - first - 1, d)]), small)).toThrow(
      /outside the pack/,
    );
    // the valid one resolves
    expect(readPack(packOf([blob(base), ofsDelta(second - first, d)]), small).size).toBe(1);
  });

  test("the object count is checked before anything is allocated for it, and a count that lies is an error", () => {
    const head = Buffer.alloc(12);
    head.write("PACK", 0);
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(0xffffffff, 8);
    // a header claiming four billion objects, with a correct trailer and nothing else
    const lying = new Uint8Array(
      Buffer.concat([head, Buffer.alloc(20), createHash("sha1").update(head).digest()]).subarray(
        0,
        32,
      ),
    );
    const t0 = Date.now();
    expect(() => readPack(lying, small)).toThrow(/too many objects/);
    expect(Date.now() - t0).toBeLessThan(500);
    // three declared, one present
    expect(() => readPack(packOf([blob(new Uint8Array(5).fill(1))], 3), small)).toThrow(
      GitFetchError,
    );
  });

  test("the wall clock covers parsing: a deadline in the past stops it between objects", () => {
    const items = Array.from({ length: 20 }, (_, i) => blob(new Uint8Array(50).fill(i)));
    expect(() => readPack(packOf(items), small, Date.now() - 1)).toThrow(/took too long/);
  });
});

describe("a hostile server", () => {
  test("every request is bounded: a time budget and a response size cap are passed down", async () => {
    const { dir, sha } = makeRepo();
    const s = serveGitRepo(dir);
    const seen: {
      maxBytes?: number | undefined;
      timeoutMs?: number | undefined;
      redirect?: string | undefined;
    }[] = [];
    const spy: SafeFetch = async (input, init) => {
      seen.push({ maxBytes: init?.maxBytes, timeoutMs: init?.timeoutMs, redirect: init?.redirect });
      return s.fetch(input, init);
    };
    try {
      await fetchCommit({
        url: s.url,
        sha,
        fetch: spy,
        limits: { maxPackBytes: 5 * 1024 * 1024, timeoutMs: 60_000 },
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]!.maxBytes).toBe(1024 * 1024); // the advertisement
      expect(seen[1]!.maxBytes).toBe(6 * 1024 * 1024); // the pack, plus the framing
      expect(seen.every((x) => x.timeoutMs! > 0 && x.timeoutMs! <= 60_000)).toBe(true);
      // the fetch itself never follows a redirect; the advertisement only manually
      expect(seen.map((x) => x.redirect)).toEqual(["manual", "error"]);
    } finally {
      s.stop();
    }
  });

  test("the real guarded client stops a response that is larger than the cap", async () => {
    const big = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(new Uint8Array(3 * 1024 * 1024), {
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
        }),
    });
    try {
      const f = createHttpClient({ allowHosts: ["127.0.0.1"] }).fetch;
      await expect(
        fetchCommit({ url: `http://127.0.0.1:${big.port}/a/b.git`, sha: "a".repeat(40), fetch: f }),
      ).rejects.toThrow(/larger than/);
    } finally {
      void big.stop(true);
    }
  });

  test("the whole fetch has a wall clock: a server that stalls is given up on", async () => {
    const slow: SafeFetch = async () => {
      await Bun.sleep(60);
      return new Response("", { status: 200 });
    };
    await expect(
      fetchCommit({
        url: "https://x.test/a/b.git",
        sha: "a".repeat(40),
        fetch: slow,
        limits: { timeoutMs: 30 },
      }),
    ).rejects.toThrow(/took too long/);
  });

  test("a redirect to another host is refused; one within the same origin (a moved repository) is followed", async () => {
    const { dir, sha } = makeRepo();
    const other = serveGitRepo(dir); // a second origin that WOULD answer
    const away = serveGitRepo(dir, {
      redirectTo: other.url.replace(/\.git$/, ".git/info/refs?service=git-upload-pack"),
    });
    const moved = serveGitRepo(dir, { movedFrom: "/old/name.git" });
    try {
      await expect(fetchCommit({ url: away.url, sha, fetch: away.fetch })).rejects.toThrow(
        /another host/,
      );
      expect(other.requests).toHaveLength(0); // never contacted
      const c = await fetchCommit({
        url: `${moved.url.replace(/\/acme\/web\.git$/, "")}/old/name.git`,
        sha,
        fetch: moved.fetch,
      });
      expect(c.sha).toBe(sha);
      // the pack request went to where the redirect ended
      expect(moved.requests.find((r) => r.method === "POST")!.path).toBe(
        "/acme/web.git/git-upload-pack",
      );
    } finally {
      other.stop();
      away.stop();
      moved.stop();
    }
  });

  test("a redirect on the fetch request itself is refused", async () => {
    const { dir, sha } = makeRepo();
    const s = serveGitRepo(dir, { postRedirect: true });
    try {
      await expect(fetchCommit({ url: s.url, sha, fetch: s.fetch })).rejects.toThrow();
    } finally {
      s.stop();
    }
  });
});
