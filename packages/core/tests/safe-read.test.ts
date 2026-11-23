import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKOUT_COMMAND, serveGitRepo } from "./git-http-server";
import { gitRepoSource } from "../src/scheduler";
import {
  assertRepoRelative,
  makeSafeReader,
  MAX_REPO_FILE_BYTES,
  UnsafePathError,
} from "../src/run/safe-read";

const base = mkdtempSync(join(tmpdir(), "tt-safe-read-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A checkout dir and a sibling "host" dir with a secret the checkout must never expose. */
function fixture() {
  const root = mkdtempSync(join(base, "case-"));
  const checkout = join(root, "checkout");
  const host = join(root, "host");
  mkdirSync(join(checkout, ".github/actions/x"), { recursive: true });
  mkdirSync(host);
  // built at runtime so no secret-shaped literal is committed
  const secret = `host-secret-${crypto.randomUUID()}`;
  writeFileSync(join(host, "token"), secret);
  writeFileSync(join(checkout, "ok.yml"), "name: ok\n");
  writeFileSync(join(checkout, ".github/actions/x/action.yml"), "runs:\n  using: composite\n");
  return { root, checkout, host, secret, read: makeSafeReader(checkout) };
}

describe("safe repo reader", () => {
  test("reads ordinary files, reports missing ones as undefined, ignores directories", () => {
    const { read, checkout } = fixture();
    expect(read("ok.yml")).toBe("name: ok\n");
    expect(read(".github/actions/x/action.yml")).toContain("composite");
    expect(read("./ok.yml")).toBe("name: ok\n");
    expect(read("nope.yml")).toBeUndefined();
    expect(read("no/such/dir/x.yml")).toBeUndefined();
    expect(read(".github")).toBeUndefined(); // a directory is not a file
    writeFileSync(join(checkout, "file"), "x");
    expect(read("file/inside")).toBeUndefined(); // ENOTDIR
  });

  test("`..`, absolute paths and odd characters are refused before anything is joined", () => {
    const { read, host } = fixture();
    const bad = [
      "../host/token",
      "../../etc/hosts",
      "a/../../host/token",
      "a/../ok.yml", // even a `..` that stays inside: there is no reason for it
      "./../host/token",
      `${host}/token`,
      "/etc/hosts",
      "C:/Windows/win.ini",
      "..\\host\\token",
      "a\\b",
      "x\0y",
      "",
    ];
    for (const p of bad) {
      expect(() => read(p), JSON.stringify(p)).toThrow(UnsafePathError);
      expect(() => assertRepoRelative(p)).toThrow(UnsafePathError);
    }
  });

  test("a symlink is refused, whatever it points at, and the target's content never comes back", () => {
    const { read, checkout, host, secret } = fixture();
    // to a file outside the checkout
    symlinkSync(join(host, "token"), join(checkout, ".github/actions/x/action.yaml"));
    // to a system file
    symlinkSync("/etc/hosts", join(checkout, "hosts.yml"));
    // to a file INSIDE the checkout: also refused (documented policy: no symlinks at all)
    symlinkSync("ok.yml", join(checkout, "alias.yml"));
    // a dangling link
    symlinkSync("does-not-exist", join(checkout, "dangling.yml"));
    for (const p of [".github/actions/x/action.yaml", "hosts.yml", "alias.yml", "dangling.yml"]) {
      let got: string | undefined;
      expect(() => (got = read(p)), p).toThrow(/symlink/);
      expect(got).toBeUndefined();
    }
    expect(() => read("alias.yml")).toThrow(UnsafePathError);
    // the ordinary file next to them still reads
    expect(read("ok.yml")).toBe("name: ok\n");
    void secret;
  });

  test("a symlinked directory cannot lead out of the checkout; one that stays inside is fine", () => {
    const { read, checkout, host, secret } = fixture();
    symlinkSync(host, join(checkout, "linked-out"));
    expect(() => read("linked-out/token")).toThrow(/outside the checkout/);
    mkdirSync(join(checkout, "real"));
    writeFileSync(join(checkout, "real/in.yml"), "a: 1\n");
    symlinkSync("real", join(checkout, "linked-in"));
    expect(read("linked-in/in.yml")).toBe("a: 1\n");
    void secret;
  });

  test("files over the size cap are refused; at the cap they read", () => {
    const { read, checkout } = fixture();
    writeFileSync(join(checkout, "big.yml"), "x".repeat(MAX_REPO_FILE_BYTES + 1));
    expect(() => read("big.yml")).toThrow(/larger than/);
    writeFileSync(join(checkout, "edge.yml"), "x".repeat(MAX_REPO_FILE_BYTES));
    expect(read("edge.yml")?.length).toBe(MAX_REPO_FILE_BYTES);
  });

  test("the cap is configurable", () => {
    const { checkout } = fixture();
    const small = makeSafeReader(checkout, { maxBytes: 4 });
    expect(() => small("ok.yml")).toThrow(/larger than 4 bytes/);
  });
});

describe("a hostile repo through the real checkout path", () => {
  async function sh(cwd: string, ...argv: string[]): Promise<void> {
    const p = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    const code = await p.exited;
    if (code !== 0) throw new Error(`${argv.join(" ")}: ${await new Response(p.stderr).text()}`);
  }

  test("a committed symlink named action.yml to a host file is never read", async () => {
    const root = mkdtempSync(join(base, "git-"));
    const repo = join(root, "repo");
    const host = join(root, "host");
    mkdirSync(join(repo, ".github/actions/evil"), { recursive: true });
    mkdirSync(host);
    const secret = `token-file-${crypto.randomUUID()}`;
    const tokenFile = join(host, "github-token");
    writeFileSync(tokenFile, secret);
    writeFileSync(join(repo, "ci.yml"), "name: ci\n");
    symlinkSync(tokenFile, join(repo, ".github/actions/evil/action.yml"));
    await sh(repo, "git", "init", "-q", "-b", "main");
    await sh(repo, "git", "add", "-A");
    await sh(repo, "git", "commit", "-q", "-m", "hostile");
    const sha = await (async () => {
      const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" });
      return (await new Response(p.stdout).text()).trim();
    })();

    const server = serveGitRepo(repo);
    const source = gitRepoSource({
      cloneUrl: () => server.url,
      allowHosts: ["127.0.0.1"],
      command: CHECKOUT_COMMAND,
    });
    const checkout = await source.checkout({ sha } as never, { owner: "acme", repo: "web" });
    try {
      expect(checkout.readFile("ci.yml")).toBe("name: ci\n");
      let leaked: string | undefined;
      expect(() => (leaked = checkout.readFile(".github/actions/evil/action.yml"))).toThrow(
        UnsafePathError,
      );
      expect(leaked).toBeUndefined();
      expect(() => checkout.readFile("../../../../etc/hosts")).toThrow(UnsafePathError);
    } finally {
      server.stop();
      checkout.dispose?.();
    }
  }, 30_000);
});
