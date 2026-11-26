// Submodules (#685): a job that asks for `submodules: true|recursive` gets each gitlink's pinned
// commit, fetched by the control plane (depth 1, under the checkout's own caps and scan) and
// delivered under `.git/modules`, so the stub's offline `git submodule update --init --no-fetch`
// succeeds. Real git is the server (git-http-server.ts) and runs the stub's script.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkoutScript, readTarGz, workflowSubmodulesJobs } from "@turntable/act-runner";
import { resolveSubmodules } from "../src/run/submodules";
import { gitRepoSource } from "../src/scheduler";
import { CHECKOUT_COMMAND, serveGitRepo, type GitHttpServer } from "./git-http-server";

const base = mkdtempSync(join(tmpdir(), "ls-submod-"));
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
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

let n = 0;
interface Gitlink {
  path: string;
  sha: string;
}
/** A repository with one file, and gitlinks (with a `.gitmodules` naming each by url). */
function makeRepo(
  files: Record<string, string>,
  links: (Gitlink & { url: string; name?: string })[] = [],
): { dir: string; sha: string } {
  const dir = join(base, `repo${n++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  if (links.length > 0) {
    writeFileSync(
      join(dir, ".gitmodules"),
      links
        .map((l) => `[submodule "${l.name ?? l.path}"]\n\tpath = ${l.path}\n\turl = ${l.url}\n`)
        .join(""),
    );
  }
  git(dir, "add", "-A");
  for (const l of links)
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${l.sha},${l.path}`);
  git(dir, "commit", "-q", "-m", "one");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

const marker = (): string => `tt-marker-${crypto.randomUUID().replaceAll("-", "")}`;
const basic = (t: string): string =>
  `Basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`;

/** Writes a delivered tarball to a directory, as the sandbox does. */
function extract(tarball: Uint8Array): string {
  const dir = join(base, `src${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const e of readTarGz(tarball)) {
    const p = join(dir, e.path);
    if (e.type === "dir") mkdirSync(p, { recursive: true });
    else if (e.type === "file") {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.data);
      chmodSync(p, e.mode & 0o777 || 0o644);
    }
  }
  return dir;
}

/** Runs the stub's script over a delivered directory; returns the workspace. */
function stub(delivered: string, submodules: string): string {
  const ws = join(base, `ws${n++}`);
  mkdirSync(ws, { recursive: true });
  execFileSync("bash", ["-c", checkoutScript(delivered)], {
    env: {
      ...ENV,
      GITHUB_WORKSPACE: ws,
      TT_CHECKOUT_PATH: "",
      TT_REF: "",
      TT_FETCH_DEPTH: "1",
      TT_SUBMODULES: submodules,
    },
    stdio: "pipe",
  });
  return ws;
}

interface World {
  servers: Record<string, GitHttpServer>;
  minted: [string, string][];
  src: ReturnType<typeof gitRepoSource>;
  token: string;
  stop(): void;
}
/** Each repo by `owner/name` behind its own server; the control plane's clone URL maps to them. */
function world(
  repos: Record<string, string>,
  opts: { limits?: Record<string, number>; mintFails?: string[] } = {},
): World {
  const servers: Record<string, GitHttpServer> = {};
  for (const [name, dir] of Object.entries(repos)) servers[name] = serveGitRepo(dir);
  const minted: [string, string][] = [];
  const token = marker();
  const src = gitRepoSource({
    cloneUrl: (owner, repo) => {
      const s = servers[`${owner}/${repo}`];
      if (!s) throw new Error(`no test server for ${owner}/${repo}`);
      return s.url;
    },
    allowHosts: ["127.0.0.1"],
    command: CHECKOUT_COMMAND,
    ...(opts.limits ? { config: { limits: opts.limits } } : {}),
    installationToken: async (id, repo) => {
      if (opts.mintFails?.includes(repo)) throw new Error("repository not covered");
      minted.push([id, repo]);
      return token;
    },
  });
  return {
    servers,
    minted,
    src,
    token,
    stop: () => {
      for (const s of Object.values(servers)) s.stop();
    },
  };
}

const run = (sha: string): never => ({ sha }) as never;
const bound = { owner: "acme", repo: "web", installationId: "inst-1" };

describe("submodules: true", () => {
  test("delivers the pinned commit under .git/modules so the offline update succeeds", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir });
    try {
      const co = await w.src.checkout(run(web.sha), bound, { submodules: "true" });
      const delivered = extract(co.tarball);
      expect(existsSync(join(delivered, ".git/modules/deps/lib/HEAD"))).toBe(true);
      const ws = stub(delivered, "true");
      expect(git(ws, "submodule", "status").trim().startsWith(lib.sha)).toBe(true);
      expect(execFileSync("cat", [join(ws, "deps/lib/l.txt")], { encoding: "utf8" })).toBe("lib\n");
      // depth 1: the module's history is cut at its one commit
      expect(git(join(ws, "deps/lib"), "rev-parse", "HEAD")).toBe(lib.sha);
    } finally {
      w.stop();
    }
  });

  test("a same-owner module is fetched with a token minted for that one repository", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir });
    try {
      const co = await w.src.checkout(run(web.sha), bound, { submodules: "true" });
      expect(w.minted).toEqual([
        ["inst-1", "web"],
        ["inst-1", "lib"],
      ]);
      const libReqs = w.servers["acme/lib"]?.requests ?? [];
      expect(libReqs.length).toBeGreaterThan(0);
      for (const r of libReqs) expect(r.authorization).toBe(basic(w.token));
      expect(Buffer.from(co.tarball).includes(w.token)).toBe(false);
    } finally {
      w.stop();
    }
  });

  test("a relative url resolves against the repository, so it stays same-owner", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "../lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir });
    try {
      const co = await w.src.checkout(run(web.sha), bound, { submodules: "true" });
      stub(extract(co.tarball), "true");
      expect(w.minted.map((m) => m[1])).toEqual(["web", "lib"]);
    } finally {
      w.stop();
    }
  });

  test("another owner's public module is fetched anonymously, never with the installation token", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/other/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "other/lib": lib.dir });
    try {
      const co = await w.src.checkout(run(web.sha), bound, { submodules: "true" });
      stub(extract(co.tarball), "true");
      expect(w.minted).toEqual([["inst-1", "web"]]);
      for (const r of w.servers["other/lib"]?.requests ?? []) expect(r.authorization).toBeNull();
    } finally {
      w.stop();
    }
  });

  test("a same-owner module the installation cannot mint for is tried anonymously, and says why it failed", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir }, { mintFails: ["lib"] });
    try {
      await w.src.checkout(run(web.sha), bound, { submodules: "true" });
      for (const r of w.servers["acme/lib"]?.requests ?? []) expect(r.authorization).toBeNull();
    } finally {
      w.stop();
    }
  });

  test("a module's refusal names the module and no token reaches the message", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir }, { mintFails: ["lib"] });
    w.servers["acme/lib"]?.stop();
    const refusing = serveGitRepo(lib.dir, { requireAuth: { status: 404 } });
    try {
      const src = gitRepoSource({
        cloneUrl: (_o, repo) =>
          repo === "lib" ? refusing.url : (w.servers["acme/web"] as GitHttpServer).url,
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
        installationToken: async (_i, repo) => {
          if (repo === "lib") throw new Error("not covered");
          return w.token;
        },
      });
      const err = await src.checkout(run(web.sha), bound, { submodules: "true" }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toContain("deps/lib");
      expect(String(err.message)).not.toContain(w.token);
    } finally {
      refusing.stop();
      w.stop();
    }
  });
});

describe("submodules: recursive", () => {
  test("true leaves a module's own modules empty; recursive delivers them", async () => {
    const inner = makeRepo({ "i.txt": "inner\n" });
    const lib = makeRepo({ "l.txt": "lib\n" }, [
      { path: "vendor/inner", sha: inner.sha, url: "https://github.com/acme/inner.git" },
    ]);
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir, "acme/inner": inner.dir });
    try {
      const flat = await w.src.checkout(run(web.sha), bound, { submodules: "true" });
      expect(w.servers["acme/inner"]?.requests.length).toBe(0);
      const ws1 = stub(extract(flat.tarball), "true");
      expect(existsSync(join(ws1, "deps/lib/l.txt"))).toBe(true);
      expect(existsSync(join(ws1, "deps/lib/vendor/inner/i.txt"))).toBe(false);

      const deep = await w.src.checkout(run(web.sha), bound, { submodules: "recursive" });
      const ws2 = stub(extract(deep.tarball), "recursive");
      expect(existsSync(join(ws2, "deps/lib/vendor/inner/i.txt"))).toBe(true);
      expect(w.minted.map((m) => m[1])).toContain("inner");
    } finally {
      w.stop();
    }
  });
});

describe("submodules: false (the default)", () => {
  test("fetches nothing extra and delivers no modules", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir });
    try {
      for (const opts of [undefined, { submodules: undefined }]) {
        const co = await w.src.checkout(run(web.sha), bound, opts);
        expect(readTarGz(co.tarball).some((e) => e.path.startsWith(".git/modules"))).toBe(false);
      }
      expect(w.servers["acme/lib"]?.requests.length).toBe(0);
      expect(w.minted.map((m) => m[1])).toEqual(["web", "web"]);
    } finally {
      w.stop();
    }
  });
});

describe("a missing pinned commit", () => {
  test("fails the checkout, naming the submodule path", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: "1".repeat(40), url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir });
    try {
      const err = await w.src.checkout(run(web.sha), bound, { submodules: "true" }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toContain("deps/lib");
    } finally {
      w.stop();
    }
  });
});

describe("the checkout limits are one budget", () => {
  test("a module's files count against the repository's maxEntries", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "deps/lib", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    // web: .gitmodules, a.txt, deps, deps/lib = 4 entries; lib adds one more
    const ok = world({ "acme/web": web.dir, "acme/lib": lib.dir }, { limits: { maxEntries: 5 } });
    const over = world({ "acme/web": web.dir, "acme/lib": lib.dir }, { limits: { maxEntries: 4 } });
    try {
      await ok.src.checkout(run(web.sha), bound, { submodules: "true" });
      const err = await over.src
        .checkout(run(web.sha), bound, { submodules: "true" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/too many files/);
      // without submodules the same limit is enough
      await over.src.checkout(run(web.sha), bound);
    } finally {
      ok.stop();
      over.stop();
    }
  });

  test("more modules than maxSubmodules is refused", async () => {
    const lib = makeRepo({ "l.txt": "lib\n" });
    const web = makeRepo({ "a.txt": "a\n" }, [
      { path: "d/one", sha: lib.sha, url: "https://github.com/acme/lib.git" },
      { path: "d/two", sha: lib.sha, url: "https://github.com/acme/lib.git" },
    ]);
    const w = world({ "acme/web": web.dir, "acme/lib": lib.dir }, { limits: { maxSubmodules: 1 } });
    try {
      const err = await w.src.checkout(run(web.sha), bound, { submodules: "true" }).catch((e) => e);
      expect(String(err.message)).toMatch(/more than 1 submodule/);
    } finally {
      w.stop();
    }
  });
});

describe("a hostile .gitmodules", () => {
  const sha = "a".repeat(40);
  const resolve = (gitmodules: string, path = "deps/lib"): unknown =>
    resolveSubmodules({
      gitmodules,
      gitlinks: [{ path, sha }],
      baseUrl: "https://github.com/acme/web",
      maxSubmodules: 64,
    });
  const mod = (o: { name?: string; path?: string; url?: string }): string =>
    `[submodule "${o.name ?? "deps/lib"}"]\n\tpath = ${o.path ?? "deps/lib"}\n\turl = ${o.url ?? "https://github.com/acme/lib.git"}\n`;

  test("a plain module resolves", () => {
    expect(resolve(mod({}))).toEqual([
      { name: "deps/lib", path: "deps/lib", sha, owner: "acme", repo: "lib" },
    ]);
  });

  const bad: [string, string, RegExp][] = [
    ["a path with ..", mod({ path: "../escape" }), /path/],
    ["an absolute path", mod({ path: "/etc/x" }), /path/],
    ["a backslash path", mod({ path: "a\\b" }), /\.gitmodules/],
    ["a name with ..", mod({ name: "../../x" }), /name/],
    ["an absolute name", mod({ name: "/x" }), /name/],
    ["a .git name", mod({ name: "a/.git/b" }), /name/],
    ["an option-like url", mod({ url: "--upload-pack=touch /tmp/x" }), /url/],
    ["an option-like url with a prefix", mod({ url: "-oProxyCommand=x" }), /url/],
    ["an ssh url", mod({ url: "ssh://git@github.com/acme/lib.git" }), /https/],
    ["an scp-style url", mod({ url: "git@github.com:acme/lib.git" }), /https/],
    ["an http url", mod({ url: "http://github.com/acme/lib.git" }), /https/],
    ["a file url", mod({ url: "file:///etc" }), /https/],
    ["another host", mod({ url: "https://evil.example/acme/lib.git" }), /github\.com/],
    ["a credential in the url", mod({ url: "https://u:p@github.com/acme/lib.git" }), /credential/],
    ["a port", mod({ url: "https://github.com:8443/acme/lib.git" }), /github\.com/],
    ["a deep url path", mod({ url: "https://github.com/acme/lib/x.git" }), /owner\/name/],
    ["a relative url that leaves the host", mod({ url: "../../../x" }), /url/],
    ["no url", `[submodule "deps/lib"]\n\tpath = deps/lib\n`, /url/],
  ];
  for (const [what, text, re] of bad)
    test(`refuses ${what}`, () => {
      expect(() => resolve(text)).toThrow(re);
    });

  test("refuses a gitlink with no .gitmodules entry, and no .gitmodules at all", () => {
    expect(() => resolve(mod({ path: "other", name: "other" }))).toThrow(/deps\/lib/);
    expect(() => resolve("")).toThrow(/deps\/lib/);
  });

  test("refuses syntax it cannot read exactly", () => {
    expect(() => resolve(`${mod({})}\turl = https://github.com/acme/x.git # c\n`)).toThrow();
    expect(() =>
      resolve(`[submodule "deps/lib"]\n\tpath = deps/lib\n\turl = https://github.com/a/b \\\n`),
    ).toThrow();
  });

  test("refuses overlapping module directories", () => {
    expect(() =>
      resolveSubmodules({
        gitmodules: mod({}) + mod({ name: "deps/lib/x", path: "deps/lib2" }),
        gitlinks: [
          { path: "deps/lib", sha },
          { path: "deps/lib2", sha },
        ],
        baseUrl: "https://github.com/acme/web",
        maxSubmodules: 64,
      }),
    ).toThrow(/overlap/);
  });
});

describe("which jobs ask for submodules", () => {
  const wf = (w: string): string =>
    `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${w}\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
  test("reads the checkout step's input", () => {
    expect(workflowSubmodulesJobs(wf(""))).toEqual({ a: undefined, b: undefined });
    expect(workflowSubmodulesJobs(wf("        with: { submodules: false }"))["a"]).toBeUndefined();
    expect(workflowSubmodulesJobs(wf("        with: { submodules: true }"))["a"]).toBe("true");
    expect(workflowSubmodulesJobs(wf("        with: { submodules: recursive }"))["a"]).toBe(
      "recursive",
    );
    expect(workflowSubmodulesJobs(wf("        with: { submodules: '${{ inputs.x }}' }"))["a"]).toBe(
      "recursive",
    );
  });
});
