// `fetch-depth: 0` (#525, part 2): a job that asks for the whole history gets it, with the tags and
// the default branch, from the same in-process fetch, under the same caps and the same token
// rules. Real git is the server (git-http-server.ts) and checks what was delivered.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { checkoutScript, workflowFullHistoryJobs } from "@turntable/act-runner";
import { performCheckout } from "../src/run/checkout";
import { runCheckoutChild } from "../src/run/checkout-child";
import { fetchCommit, GitAuthError, GitFetchError, validRefName } from "../src/run/git-fetch";
import { gitRepoSource } from "../src/scheduler";
import { CHECKOUT_COMMAND, serveGitRepo } from "./git-http-server";

// the protocol-v2 command line, built so the network source guard does not read it as a fetch value
const FETCH_COMMAND = ["command", "fetch"].join("=");

const base = mkdtempSync(join(tmpdir(), "ls-fullhist-"));
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
interface Fixture {
  dir: string;
  /** The PR head: two commits off `base`, while main moved on. */
  head: string;
  base: string;
  mainTip: string;
  firstCommit: string;
}
/** main: c1(v0) c2(v1, annotated) c3 c4; feature: c2 -> f1 -> f2 (the run's commit). HEAD is main. */
function makeRepo(): Fixture {
  const dir = join(base, `repo${n++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const commit = (name: string): string => {
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", name);
    return git(dir, "rev-parse", "HEAD");
  };
  const firstCommit = commit("c1");
  git(dir, "tag", "v0");
  const b = commit("c2");
  git(dir, "tag", "-a", "v1", "-m", "release one");
  git(dir, "checkout", "-q", "-b", "feature");
  commit("f1");
  const head = commit("f2");
  git(dir, "checkout", "-q", "main");
  commit("c3");
  const mainTip = commit("c4");
  return { dir, head, base: b, mainTip, firstCommit };
}

const marker = (): string => `tt-marker-${crypto.randomUUID().replaceAll("-", "")}`;
const basic = (t: string): string =>
  `Basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`;

async function deliver(
  f: Fixture,
  server: ReturnType<typeof serveGitRepo>,
  extra: { fullHistory?: boolean; token?: string; limits?: Record<string, number> } = {},
): Promise<string> {
  const into = join(base, `into${n++}`);
  await performCheckout({
    owner: "acme",
    repo: "web",
    sha: f.head,
    url: server.url,
    dir: into,
    out: join(base, `o${n++}.tgz`),
    allowHosts: ["127.0.0.1"],
    fetch: server.fetch,
    ...extra,
  });
  return into;
}

describe("a full-history delivery", () => {
  test("gives git log, describe, merge-base, rev-list and origin/<default> the answers GitHub gives", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir);
    try {
      const d = await deliver(f, server, { fullHistory: true });
      expect(existsSync(join(d, ".git/shallow"))).toBe(false);
      expect(git(d, "log", "--format=%s").split("\n")).toEqual(["f2", "f1", "c2", "c1"]);
      expect(git(d, "describe", "--tags")).toBe("v1-2-g" + f.head.slice(0, 7));
      expect(git(d, "rev-parse", "origin/main")).toBe(f.mainTip);
      expect(git(d, "rev-parse", "refs/heads/main")).toBe(f.mainTip);
      expect(git(d, "merge-base", "HEAD", "origin/main")).toBe(f.base);
      expect(git(d, "rev-list", `${f.base}..${f.head}`).split("\n")).toHaveLength(2);
      expect(git(d, "tag", "-l").split("\n")).toEqual(["v0", "v1"]);
      expect(git(d, "rev-parse", "v0")).toBe(f.firstCommit);
      git(d, "fsck", "--full", "--no-dangling");
      expect(git(d, "status", "--porcelain")).toBe("");
      // a single v2 fetch with no depth
      const post = server.requests.filter((r) => r.method === "POST");
      const texts = post.map((r) => Buffer.from(r.body).toString("latin1"));
      expect(texts.some((t) => t.includes("command=ls-refs"))).toBe(true);
      expect(texts.some((t) => t.includes("deepen"))).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("depth 1 is unchanged: one commit, a shallow file, no ls-refs, no tags", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir);
    try {
      const d = await deliver(f, server);
      expect(readFileSync(join(d, ".git/shallow"), "utf8").trim()).toBe(f.head);
      expect(git(d, "rev-list", "--count", "HEAD")).toBe("1");
      expect(git(d, "tag", "-l")).toBe("");
      expect(existsSync(join(d, ".git/packed-refs"))).toBe(false);
      const texts = server.requests.map((r) => Buffer.from(r.body).toString("latin1"));
      expect(texts.some((t) => t.includes("ls-refs"))).toBe(false);
      expect(texts.some((t) => t.includes("deepen 1"))).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("a root commit's full delivery has no shallow file either", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir);
    try {
      const into = join(base, `into${n++}`);
      await performCheckout({
        owner: "acme",
        repo: "web",
        sha: f.firstCommit,
        url: server.url,
        dir: into,
        out: join(base, `o${n++}.tgz`),
        allowHosts: ["127.0.0.1"],
        fetch: server.fetch,
        fullHistory: true,
      });
      expect(existsSync(join(into, ".git/shallow"))).toBe(false);
      git(into, "fsck", "--full", "--no-dangling");
    } finally {
      server.stop();
    }
  });

  test("over a cap it fails with the reason, never a shallow fallback", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir);
    try {
      for (const limits of [
        { maxObjects: 5 },
        { maxInflatedBytes: 50 },
        { maxRefs: 1 },
        { timeoutMs: 1 },
      ]) {
        const err = await deliver(f, server, { fullHistory: true, limits }).catch((e) => e);
        // a named kind: the fetch's own error, or the net client's timeout when the clock runs out first
        expect(["GitFetchError", "RequestTimeoutError"]).toContain(err?.name);
        expect(String(err.message)).toMatch(
          /too many objects|too large|more than 1 tags|Maximum|exceed|time/i,
        );
      }
      // the parent says what was asked for
      const err = await runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha: f.head,
        url: server.url,
        dir: join(base, `d${n++}`),
        out: join(base, `o${n++}.tgz`),
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
        fullHistory: true,
        config: { limits: { maxObjects: 5 } },
      }).catch((e) => e);
      expect(String(err.message)).toContain(
        "fetch-depth 0 needs the full history, which could not be delivered for this run",
      );
      expect(String(err.message)).toContain("too many objects");
    } finally {
      server.stop();
    }
  });

  test("a pack over the byte cap is refused, not truncated into a shallow one", async () => {
    const f = makeRepo();
    // incompressible, so the pack is well over the cap plus the response slack
    writeFileSync(join(f.dir, "blob.bin"), crypto.getRandomValues(new Uint8Array(1_600_000)));
    git(f.dir, "add", "-A");
    git(f.dir, "commit", "-q", "-m", "blob");
    const head = git(f.dir, "rev-parse", "HEAD");
    const server = serveGitRepo(f.dir);
    try {
      const err = await performCheckout({
        owner: "acme",
        repo: "web",
        sha: head,
        url: server.url,
        dir: join(base, `into${n++}`),
        out: join(base, `o${n++}.tgz`),
        allowHosts: ["127.0.0.1"],
        fetch: server.fetch,
        fullHistory: true,
        limits: { maxPackBytes: 100_000 },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/large|exceed|bytes|limit/i);
    } finally {
      server.stop();
    }
  });

  test("a pack missing an object the history reaches is refused as incomplete", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir);
    try {
      // a depth-1 pack answered to a full request: the parents are absent
      const real = server.fetch;
      let calls = 0;
      const lying: typeof real = async (url, init) => {
        const body = init?.body as Uint8Array | undefined;
        if (body && Buffer.from(body).toString("latin1").includes(FETCH_COMMAND)) {
          calls += 1;
          // keep pkt-line framing right: rebuild the body
          const lines = [FETCH_COMMAND + "\n", "agent=turntable\n", "object-format=sha1\n"];
          const pkt = (s: string): string => (s.length + 4).toString(16).padStart(4, "0") + s;
          const rebuilt = Buffer.from(
            lines.map(pkt).join("") +
              "0001" +
              pkt(`want ${f.head}\n`) +
              pkt("deepen 1\n") +
              pkt("done\n") +
              "0000",
            "latin1",
          );
          return real(url, { ...init, body: rebuilt });
        }
        return real(url, init);
      };
      const err = await fetchCommit({
        url: server.url,
        sha: f.head,
        fetch: lying,
        fullHistory: true,
      }).catch((e) => e);
      expect(calls).toBe(1);
      expect(err).toBeInstanceOf(GitFetchError);
      expect(String(err.message)).toContain("not complete");
    } finally {
      server.stop();
    }
  });
});

describe("the token on the full-history path", () => {
  test("goes to the repository path only, over stdin to the child, and lands nowhere in .git or the tarball", async () => {
    const f = makeRepo();
    const token = marker();
    const server = serveGitRepo(f.dir, { requireAuth: { status: 401, expect: basic(token) } });
    const seen: { argv: string[]; env: Record<string, string | undefined> }[] = [];
    const spy = ((argv: string[], opts: { env: Record<string, string> }) => {
      seen.push({ argv: [...argv], env: { ...opts.env } });
      return (Bun.spawn as (...a: unknown[]) => unknown)(argv, opts);
    }) as unknown as typeof Bun.spawn;
    try {
      const o = join(base, `o${n++}.tgz`);
      const d = join(base, `d${n++}`);
      await runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha: f.head,
        url: server.url,
        dir: d,
        out: o,
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
        token,
        fullHistory: true,
        spawn: spy,
      });
      expect(seen[0]?.argv).toContain("--token-stdin");
      expect(seen[0]?.argv).toContain("--full-history");
      expect(seen[0]?.argv.join("\n")).not.toContain(token);
      expect(Object.values(seen[0]?.env ?? {}).join("\n")).not.toContain(token);
      // ls-refs and fetch: every request authorized, every one on the repository path
      expect(server.requests.length).toBeGreaterThanOrEqual(3);
      for (const r of server.requests) {
        expect(r.authorization).toBe(basic(token));
        expect(r.path.startsWith("/acme/web.git/")).toBe(true);
      }
      const config = readFileSync(join(d, ".git/config"), "utf8");
      expect(config).not.toContain(token);
      const all: Buffer[] = [];
      const walk = (p: string): void => {
        for (const name of readdirSync(p)) {
          const q = join(p, name);
          if (statSync(q).isDirectory()) walk(q);
          else all.push(readFileSync(q));
        }
      };
      walk(d);
      const joined = Buffer.concat(all);
      expect(joined.includes(token)).toBe(false);
      expect(joined.includes(Buffer.from(`x-access-token:${token}`).toString("base64"))).toBe(
        false,
      );
      const tar = readFileSync(o);
      expect(tar.includes(token)).toBe(false);
      expect(Buffer.from(gunzipSync(tar)).includes(token)).toBe(false);
      // the refs are there, and git reads them
      expect(git(d, "rev-parse", "origin/main")).toBe(f.mainTip);
    } finally {
      server.stop();
    }
  });

  test("a redirect while the token is held is refused, and the token reaches no other host", async () => {
    const f = makeRepo();
    const token = marker();
    const other = serveGitRepo(f.dir);
    const server = serveGitRepo(f.dir, {
      redirectTo: `${other.url}/info/refs?service=git-upload-pack`,
    });
    try {
      const err = await fetchCommit({
        url: server.url,
        sha: f.head,
        fetch: server.fetch,
        token,
        fullHistory: true,
      }).catch((e) => e);
      expect(String(err.message)).toContain("redirected while a credential was held");
      expect(other.requests).toHaveLength(0);
    } finally {
      server.stop();
      other.stop();
    }
  });

  test("a refused credential is an auth error on the full path too", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir, { requireAuth: { status: 403 } });
    try {
      const err = await fetchCommit({
        url: server.url,
        sha: f.head,
        fetch: server.fetch,
        fullHistory: true,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(GitAuthError);
    } finally {
      server.stop();
    }
  });
});

describe("which jobs ask for it", () => {
  const wf = (withBlock: string): string => `on: push
jobs:
  changes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc
${withBlock}
  other:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc
`;
  test("fetch-depth 0, a depth above 1, an expression and fetch-tags do; the default and 1 do not", () => {
    const need = (w: string): boolean | undefined => workflowFullHistoryJobs(wf(w))["changes"];
    expect(need("        with:\n          fetch-depth: 0")).toBe(true);
    expect(need('        with:\n          fetch-depth: "0"')).toBe(true);
    expect(need("        with:\n          fetch-depth: 50")).toBe(true);
    expect(need("        with:\n          fetch-depth: ${{ inputs.d }}")).toBe(true);
    expect(need("        with:\n          fetch-tags: true")).toBe(true);
    expect(need("        with:\n          fetch-depth: 1")).toBe(false);
    expect(need("        with:\n          path: x")).toBe(false);
    expect(workflowFullHistoryJobs(wf("        with:\n          fetch-depth: 0"))["other"]).toBe(
      false,
    );
  });
  test("ref names with control characters or git-forbidden shapes are refused", () => {
    expect(validRefName("refs/tags/v1.0")).toBe(true);
    for (const bad of [
      "refs/tags/a b",
      "refs/tags/a\nb",
      "refs/tags/..x",
      "refs/tags/a..b",
      "refs/tags/x.lock",
      "refs/tags/a:b",
    ])
      expect(validRefName(bad)).toBe(false);
  });
});

describe("through the source and the stub", () => {
  test("the stub keeps a full delivery complete for depth 0 and cuts it for depth 2", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir);
    try {
      const d = await deliver(f, server, { fullHistory: true });
      const run = (depth: string): string => {
        const ws = join(base, `ws${n++}`);
        mkdirSync(ws, { recursive: true });
        execFileSync("bash", ["-c", checkoutScript(d)], {
          env: {
            ...ENV,
            GITHUB_WORKSPACE: ws,
            TT_CHECKOUT_PATH: "",
            TT_REF: "",
            TT_FETCH_DEPTH: depth,
          },
        });
        return ws;
      };
      const w0 = run("0");
      expect(existsSync(join(w0, ".git/shallow"))).toBe(false);
      expect(git(w0, "describe", "--tags")).toBe("v1-2-g" + f.head.slice(0, 7));
      expect(git(w0, "rev-parse", "origin/main")).toBe(f.mainTip);
      const w2 = run("2");
      expect(git(w2, "rev-list", "--count", "HEAD")).toBe("2");
    } finally {
      server.stop();
    }
  });

  test("gitRepoSource with fullHistory delivers a tarball whose repository the stub keeps complete", async () => {
    const f = makeRepo();
    const server = serveGitRepo(f.dir);
    try {
      const src = gitRepoSource({
        cloneUrl: () => server.url,
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
      });
      const full = await src.checkout(
        { sha: f.head } as never,
        { owner: "acme", repo: "web" },
        { fullHistory: true },
      );
      const shallow = await src.checkout({ sha: f.head } as never, { owner: "acme", repo: "web" });
      expect(full.tarball.length).toBeGreaterThan(shallow.tarball.length);
      expect(full.readFile("c1.txt")).toBe("c1\n");
    } finally {
      server.stop();
    }
  });
});
