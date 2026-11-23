import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutScript, checkoutStubAction } from "../src/checkout-stub";

const tmp = mkdtempSync(join(tmpdir(), "tt-checkout-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: tmp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

async function sh(cwd: string, script: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(["bash", "-c", script], {
    cwd,
    env: { ...GIT_ENV, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

let n = 0;
/** A delivered repo: three commits on main, a branch `dev`, a tag `v1`, and a merge. */
async function delivered(): Promise<{ dir: string; shas: string[] }> {
  const dir = join(tmp, `repo-${++n}`);
  mkdirSync(dir, { recursive: true });
  const r = await sh(
    dir,
    `git init -q -b main && git config gc.auto 0 && git config maintenance.auto false && 
     echo one > a.txt && git add -A && git commit -qm one && git tag v1 &&
     echo two > a.txt && git commit -qam two &&
     git checkout -q -b dev && echo dev > d.txt && git add -A && git commit -qm dev &&
     git checkout -q main && echo three > a.txt && git commit -qam three &&
     git rev-list main | tr '\\n' ' '`,
  );
  if (r.code !== 0) throw new Error(r.err);
  return { dir, shas: r.out.split(" ") };
}

/** Runs the stub's script the way act would: inputs as env, a fresh workspace. */
async function checkout(
  repo: string,
  inputs: { path?: string; ref?: string; depth?: string; submodules?: string } = {},
) {
  const ws = join(tmp, `ws-${++n}`);
  mkdirSync(ws, { recursive: true });
  const script = join(tmp, `stub-${n}.sh`);
  writeFileSync(script, checkoutScript(repo));
  const r = await sh(ws, `bash ${script}`, {
    GITHUB_WORKSPACE: ws,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/app",
    TT_CHECKOUT_PATH: inputs.path ?? "",
    TT_REF: inputs.ref ?? "",
    TT_FETCH_DEPTH: inputs.depth ?? "1",
    TT_SUBMODULES: inputs.submodules ?? "false",
  });
  return { ws, ...r };
}

const head = (ws: string): Promise<{ out: string }> => sh(ws, "git rev-parse HEAD");
const count = async (ws: string): Promise<number> =>
  Number((await sh(ws, "git rev-list --count HEAD")).out);

describe("checkout stub inputs", () => {
  test("the action declares the inputs and passes them to the script as env", () => {
    const y = checkoutStubAction("/tmp/tt-act/repo");
    for (const i of ["ref", "path", "fetch-depth", "submodules"]) expect(y).toContain(`${i}:`);
    for (const e of ["TT_REF", "TT_FETCH_DEPTH", "TT_SUBMODULES", "TT_CHECKOUT_PATH"]) {
      expect(y).toContain(e);
    }
  });

  test("with no inputs: the delivered tip, a shallow depth of 1, files in the workspace", async () => {
    const { dir, shas } = await delivered();
    const r = await checkout(dir);
    expect(r.code).toBe(0);
    expect((await head(r.ws)).out).toBe(shas[0]!);
    expect(readFileSync(join(r.ws, "a.txt"), "utf8")).toBe("three\n");
    expect(await count(r.ws)).toBe(1);
  });

  test("fetch-depth: 0 is the full history, N is N generations, and a merge is cut per parent", async () => {
    const { dir } = await delivered();
    expect(await count((await checkout(dir, { depth: "0" })).ws)).toBe(3);
    expect(await count((await checkout(dir, { depth: "2" })).ws)).toBe(2);
    expect(await count((await checkout(dir, { depth: "3" })).ws)).toBe(3);
    expect(await count((await checkout(dir, { depth: "50" })).ws)).toBe(3);
    // A merge: both parents are one generation away.
    const m = await sh(dir, "git merge -q --no-ff -m merge dev && git rev-list --count HEAD");
    expect(m.code).toBe(0);
    const total = Number(m.out);
    const d2 = await checkout(dir, { depth: "2" });
    expect(await count(d2.ws)).toBe(3); // the merge and both of its parents
    expect(await count((await checkout(dir, { depth: "0" })).ws)).toBe(total);
  });

  test("ref: a branch, a tag, a sha and a short-hand all resolve inside the delivered repo", async () => {
    const { dir, shas } = await delivered();
    const dev = (await sh(dir, "git rev-parse dev")).out;
    const v1 = (await sh(dir, "git rev-parse v1")).out;
    const byBranch = await checkout(dir, { ref: "dev" });
    expect(byBranch.code).toBe(0);
    expect((await head(byBranch.ws)).out).toBe(dev);
    expect((await sh(byBranch.ws, "git rev-parse --abbrev-ref HEAD")).out).toBe("dev");
    expect(existsSync(join(byBranch.ws, "d.txt"))).toBe(true);
    const full = await checkout(dir, { ref: "refs/heads/dev" });
    expect((await head(full.ws)).out).toBe(dev);
    const byTag = await checkout(dir, { ref: "v1" });
    expect((await head(byTag.ws)).out).toBe(v1);
    expect(readFileSync(join(byTag.ws, "a.txt"), "utf8")).toBe("one\n");
    const bySha = await checkout(dir, { ref: shas[1]!, depth: "0" });
    expect((await head(bySha.ws)).out).toBe(shas[1]!);
    expect((await sh(bySha.ws, "git rev-parse --abbrev-ref HEAD")).out).toBe("HEAD");
  });

  test("a ref that was not delivered is an error naming it; nothing is fetched", async () => {
    const { dir } = await delivered();
    const r = await checkout(dir, { ref: "feature/never-delivered" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("feature/never-delivered is not in the delivered repository");
    expect((await checkout(dir, { ref: "f".repeat(40) })).code).not.toBe(0);
  });

  test("path: the repo lands under it; a path that leaves the workspace is refused", async () => {
    const { dir, shas } = await delivered();
    const r = await checkout(dir, { path: "src/app" });
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.ws, "src/app/a.txt"), "utf8")).toBe("three\n");
    expect((await head(join(r.ws, "src/app"))).out).toBe(shas[0]!);
    expect(existsSync(join(r.ws, "a.txt"))).toBe(false);
    for (const bad of ["../escape", "/abs", "a/../../b", ".."]) {
      const x = await checkout(dir, { path: bad });
      expect(x.code).not.toBe(0);
      expect(x.err).toContain("must stay inside the workspace");
    }
  });

  test("bad fetch-depth and submodules values are refused", async () => {
    const { dir } = await delivered();
    expect((await checkout(dir, { depth: "-1" })).code).not.toBe(0);
    expect((await checkout(dir, { depth: "deep" })).code).not.toBe(0);
    expect((await checkout(dir, { submodules: "maybe" })).code).not.toBe(0);
  });

  test("the remote is the repository's own address, not where it was delivered from", async () => {
    const { dir } = await delivered();
    await sh(dir, "git remote add origin /somewhere/private/path");
    const r = await checkout(dir);
    expect((await sh(r.ws, "git remote get-url origin")).out).toBe("https://github.com/acme/app");
  });
});

describe("submodules, from the delivered repository only", () => {
  async function withSubmodule(): Promise<string> {
    const sub = join(tmp, `sub-${++n}`);
    mkdirSync(sub);
    await sh(
      sub,
      "git init -q -b main && git config gc.auto 0 && git config maintenance.auto false && echo inner > inner.txt && git add -A && git commit -qm inner",
    );
    const dir = join(tmp, `super-${++n}`);
    mkdirSync(dir);
    const r = await sh(
      dir,
      `git init -q -b main && git config gc.auto 0 && git config maintenance.auto false && echo top > top.txt && git add -A && git commit -qm top &&
       git -c protocol.file.allow=always submodule add -q ${sub} vendor/lib && git commit -qm sub`,
    );
    if (r.code !== 0) throw new Error(r.err);
    return dir;
  }

  test("submodules: true checks the delivered module out, with no network", async () => {
    const dir = await withSubmodule();
    const plain = await checkout(dir);
    expect(plain.code).toBe(0);
    expect(existsSync(join(plain.ws, "vendor/lib/inner.txt"))).toBe(false);
    const withSub = await checkout(dir, { submodules: "true" });
    expect(withSub.err).toBe("");
    expect(withSub.code).toBe(0);
    expect(readFileSync(join(withSub.ws, "vendor/lib/inner.txt"), "utf8")).toBe("inner\n");
    const rec = await checkout(dir, { submodules: "recursive" });
    expect(rec.code).toBe(0);
  });

  test("a module that was not delivered is an error, and its address is never contacted", async () => {
    const dir = await withSubmodule();
    rmSync(join(dir, ".git/modules"), { recursive: true, force: true });
    const r = await checkout(dir, { submodules: "true" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not delivered");
  });
});
