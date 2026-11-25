// Private repositories (#576): the parent mints a one-repository `contents: read` installation
// token and hands it to the checkout child on stdin; the child sends it only to the repository's
// own origin and path. Real git is the server (git-http-server.ts); the App is a fake.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
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
import { INFRA_KINDS, isRetryableInfra } from "@turntable/act-runner";
import { performCheckout } from "../src/run/checkout";
import { CheckoutAuthError, runCheckoutChild } from "../src/run/checkout-child";
import { fetchCommit, GitAuthError, GitFetchError } from "../src/run/git-fetch";
import { parseTokenMessage, scrubToken, tokenMessage } from "../src/run/scrub-token";
import { CHECKOUT_PERMISSIONS, gitRepoSource } from "../src/scheduler";
import { CHECKOUT_COMMAND, serveGitRepo } from "./git-http-server";

const base = mkdtempSync(join(tmpdir(), "ls-cotoken-"));
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
function makeRepo(): { dir: string; sha: string } {
  const dir = join(base, `repo${n++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return { dir, sha: git(dir, "rev-parse", "HEAD").trim() };
}

// Built at run time and not shaped like any real token.
const marker = (): string => `tt-marker-${crypto.randomUUID().replaceAll("-", "")}`;
const basic = (t: string): string =>
  `Basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`;

/** Every file under a directory, as bytes joined (and gunzipped when it is a gzip). */
function everything(dir: string): Buffer {
  const parts: Buffer[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(readFileSync(p));
    }
  };
  walk(dir);
  return Buffer.concat(parts);
}

describe("a private repository", () => {
  test("is fetched with the token in an Authorization header, and the token is written nowhere", async () => {
    const { dir, sha } = makeRepo();
    const token = marker();
    const server = serveGitRepo(dir, { requireAuth: { status: 401, expect: basic(token) } });
    const minted: unknown[] = [];
    const logs: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const src = gitRepoSource({
        cloneUrl: () => server.url,
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
        installationToken: async (id, repo) => {
          minted.push([id, repo, CHECKOUT_PERMISSIONS]);
          return token;
        },
      });
      const co = await src.checkout({ sha } as never, {
        owner: "acme",
        repo: "web",
        installationId: "inst-1",
      });
      expect(minted).toEqual([["inst-1", "web", { contents: "read" }]]);
      expect(server.requests.length).toBeGreaterThanOrEqual(2);
      for (const r of server.requests) expect(r.authorization).toBe(basic(token));
      // the delivered tarball, raw and unpacked, holds no token
      expect(Buffer.from(co.tarball).includes(token)).toBe(false);
      expect(Buffer.from(gunzipSafe(co.tarball)).includes(token)).toBe(false);
      expect(
        Buffer.from(gunzipSafe(co.tarball)).includes(Buffer.from(token).toString("base64")),
      ).toBe(false);
      expect(logs.join("\n")).not.toContain(token);
    } finally {
      console.warn = orig;
      server.stop();
    }
  });

  test("performCheckout with a token leaves it out of .git/config, the tree and the tarball", async () => {
    const { dir, sha } = makeRepo();
    const token = marker();
    const server = serveGitRepo(dir);
    const out = join(base, `o${n++}.tgz`);
    const into = join(base, `into${n++}`);
    try {
      await performCheckout({
        owner: "acme",
        repo: "web",
        sha,
        url: server.url,
        dir: into,
        out,
        allowHosts: ["127.0.0.1"],
        fetch: server.fetch,
        token,
      });
      expect(server.requests[0]?.authorization).toBe(basic(token));
      const config = readFileSync(join(into, ".git/config"), "utf8");
      expect(config).not.toContain(token);
      const all = everything(into);
      expect(all.includes(token)).toBe(false);
      expect(all.includes(Buffer.from(`x-access-token:${token}`).toString("base64"))).toBe(false);
      const tar = readFileSync(out);
      expect(tar.includes(token)).toBe(false);
      expect(Buffer.from(gunzipSafe(tar)).includes(token)).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("the child gets the token on stdin only: not in its argv, not in its environment", async () => {
    const { dir, sha } = makeRepo();
    const token = marker();
    const server = serveGitRepo(dir);
    const seen: { argv: string[]; env: Record<string, string | undefined>; stdin: unknown }[] = [];
    const spy = ((argv: string[], opts: { env: Record<string, string>; stdin: unknown }) => {
      seen.push({ argv: [...argv], env: { ...opts.env }, stdin: opts.stdin });
      return (Bun.spawn as (...a: unknown[]) => unknown)(argv, opts);
    }) as unknown as typeof Bun.spawn;
    try {
      const o = join(base, `o${n++}.tgz`);
      const d = join(base, `d${n++}`);
      const res = await runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha,
        url: server.url,
        dir: d,
        out: o,
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
        token,
        spawn: spy,
      });
      expect(res.sha).toBe(sha);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.stdin).toBe("pipe");
      expect(seen[0]?.argv).toContain("--token-stdin");
      expect(seen[0]?.argv.join("\n")).not.toContain(token);
      expect(Object.values(seen[0]?.env ?? {}).join("\n")).not.toContain(token);
      expect(server.requests[0]?.authorization).toBe(basic(token));
    } finally {
      server.stop();
    }
  });

  test("a public repository sends no Authorization header and no stdin message", async () => {
    const { dir, sha } = makeRepo();
    const server = serveGitRepo(dir);
    let minted = 0;
    let stdin: unknown;
    try {
      const src = gitRepoSource({
        cloneUrl: () => server.url,
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
        installationToken: async () => {
          minted += 1;
          return "unused";
        },
      });
      await src.checkout({ sha } as never, { owner: "acme", repo: "web" });
      expect(minted).toBe(0);
      expect(server.requests.length).toBeGreaterThanOrEqual(2);
      for (const r of server.requests) expect(r.authorization).toBeNull();
      const o = join(base, `o${n++}.tgz`);
      const spy = ((argv: string[], opts: { stdin: unknown }) => {
        stdin = opts.stdin;
        expect(argv).not.toContain("--token-stdin");
        return (Bun.spawn as (...a: unknown[]) => unknown)(argv, opts);
      }) as unknown as typeof Bun.spawn;
      await runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha,
        url: server.url,
        dir: join(base, `d${n++}`),
        out: o,
        allowHosts: ["127.0.0.1"],
        command: CHECKOUT_COMMAND,
        spawn: spy,
      });
      expect(stdin).toBe("ignore");
    } finally {
      server.stop();
    }
  });

  test("a redirect while a token is held is refused, and nothing is sent to the other origin", async () => {
    const { dir } = makeRepo();
    const other = serveGitRepo(dir);
    const token = marker();
    const server = serveGitRepo(dir, {
      redirectTo: other.url.replace(/\.git$/, ".git/info/refs?service=git-upload-pack"),
    });
    try {
      const err = await fetchCommit({
        url: server.url,
        sha: "a".repeat(40),
        fetch: server.fetch,
        token,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitFetchError);
      expect((err as Error).message).toContain("refusing to follow");
      expect((err as Error).message).not.toContain(token);
      expect(other.requests).toHaveLength(0);
    } finally {
      server.stop();
      other.stop();
    }
  });

  test("a same-origin redirect to another path is refused too while a token is held", async () => {
    const { dir } = makeRepo();
    const token = marker();
    const server = serveGitRepo(dir, { movedFrom: "/acme/old.git" });
    try {
      const err = await fetchCommit({
        url: server.url.replace("/acme/web.git", "/acme/old.git"),
        sha: "a".repeat(40),
        fetch: server.fetch,
        token,
      }).catch((e: unknown) => e);
      expect((err as Error).message).toContain("refusing to follow");
      expect(server.requests).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  for (const status of [401, 403]) {
    test(`HTTP ${status} is a refused checkout, with or without a token`, async () => {
      const { dir, sha } = makeRepo();
      const token = marker();
      const server = serveGitRepo(dir, { requireAuth: { status, expect: "never" } });
      try {
        for (const t of [token, undefined]) {
          const err = await runCheckoutChild({
            owner: "acme",
            repo: "web",
            sha,
            url: server.url,
            dir: join(base, `d${n++}`),
            out: join(base, `o${n++}.tgz`),
            allowHosts: ["127.0.0.1"],
            command: CHECKOUT_COMMAND,
            token: t,
          }).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(CheckoutAuthError);
          expect((err as CheckoutAuthError).status).toBe(status);
          expect((err as Error).message).toBe(
            `the checkout was refused by GitHub (HTTP ${status}): check that the Turntable CI App installation can read this repository`,
          );
          expect((err as Error).message).not.toContain(token);
        }
      } finally {
        server.stop();
      }
    });
  }

  test("a 404 is a refused checkout only when a token was sent", async () => {
    const { dir, sha } = makeRepo();
    const server = serveGitRepo(dir, { requireAuth: { status: 404, expect: "never" } });
    const run = (token?: string) =>
      fetchCommit({ url: server.url, sha, fetch: server.fetch, ...(token ? { token } : {}) }).catch(
        (e: unknown) => e,
      );
    try {
      expect(await run(marker())).toBeInstanceOf(GitAuthError);
      const anon = await run();
      expect(anon).toBeInstanceOf(GitFetchError);
      expect(anon).not.toBeInstanceOf(GitAuthError);
    } finally {
      server.stop();
    }
  });
});

describe("the token scrub", () => {
  test("removes the token and its Basic forms from any text", () => {
    const t = marker();
    const text = `bad ${t} and ${basic(t)} and ${Buffer.from(`x-access-token:${t}`).toString("base64")}`;
    const out = scrubToken(text, t);
    expect(out).not.toContain(t);
    expect(out).not.toContain(Buffer.from(`x-access-token:${t}`).toString("base64"));
    expect(scrubToken("nothing here", t)).toBe("nothing here");
    expect(scrubToken(text, undefined)).toBe(text);
  });

  test("the stdin message round-trips; empty and anonymous mean no token; junk is refused", () => {
    const t = marker();
    expect(parseTokenMessage(tokenMessage(t))).toBe(t);
    expect(parseTokenMessage("")).toBeUndefined();
    expect(parseTokenMessage('{"anonymous":true}\n')).toBeUndefined();
    expect(() => parseTokenMessage("not json")).toThrow();
    expect(() => parseTokenMessage('{"token":"has space"}')).toThrow();
  });

  test("a child failure line is scrubbed even if the token appears in it", async () => {
    const t = marker();
    const stub = join(base, "leaky.ts");
    writeFileSync(stub, `console.error("fetch-source failed: boom ${t}"); process.exit(1);`);
    const err = await runCheckoutChild({
      owner: "acme",
      repo: "web",
      sha: "a".repeat(40),
      dir: join(base, "dl"),
      out: join(base, "ol.tgz"),
      command: [process.execPath, stub],
      token: t,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("boom");
    expect((err as Error).message).not.toContain(t);
  });
});

describe("the infra kind", () => {
  test("checkout_auth_failed is not transient and never retried, for any trust class", () => {
    expect(INFRA_KINDS.checkout_auth_failed.transient).toBe(false);
    for (const c of ["protected", "release", "trusted_pr", "untrusted_pr", null])
      expect(isRetryableInfra("checkout_auth_failed", c)).toBe(false);
    expect(isRetryableInfra("sandbox_create_failed", "protected")).toBe(true);
  });
});

function gunzipSafe(b: Uint8Array): Uint8Array {
  return gunzipSync(b);
}
