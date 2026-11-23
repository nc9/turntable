import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planJob, rebuildArgv } from "@turntable/act-runner";
import { buildActEvent, type ActEventRun } from "../src/run/act-event";
import { snapshotRepo, TAR_ENV, tarMetadataArgs } from "../src/run/repo-archive";
import { CHECKOUT_COMMAND, serveGitRepo } from "./git-http-server";
import { assertNoCredentials, gitRepoSource } from "../src/scheduler";

const BASE = "b".repeat(40);
const HEAD = "d".repeat(40);

const prRun = (over: Partial<ActEventRun> = {}, stored: unknown = undefined): ActEventRun => ({
  event: "pull_request",
  ref: "refs/pull/7/head",
  sha: HEAD,
  repo: "acme/web",
  prNumber: 7,
  headBranch: "topic",
  plan: JSON.stringify({
    github: {
      event: stored ?? {
        pull_request: {
          base: { ref: "main", sha: BASE },
          head: { ref: "topic", sha: HEAD },
          draft: false,
        },
      },
    },
  }),
  ...over,
});

describe("the event payload act is given", () => {
  test("a pull request carries number, base and head with shas and repos, draft and repository", () => {
    expect(buildActEvent(prRun())).toEqual({
      number: 7,
      pull_request: {
        number: 7,
        base: { ref: "main", sha: BASE, repo: { full_name: "acme/web" } },
        head: { ref: "topic", sha: HEAD, repo: { full_name: "acme/web" } },
        draft: false,
      },
      repository: { full_name: "acme/web" },
    });
  });

  test("a push carries ref, before and after, and before only when it is a real sha", () => {
    const run: ActEventRun = {
      event: "push",
      ref: "refs/heads/main",
      sha: HEAD,
      repo: "acme/web",
      prNumber: null,
      headBranch: "main",
      plan: JSON.stringify({ github: { event: { before: BASE } } }),
    };
    expect(buildActEvent(run)).toEqual({
      ref: "refs/heads/main",
      before: BASE,
      after: HEAD,
      repository: { full_name: "acme/web" },
    });
    expect(
      buildActEvent({
        ...run,
        plan: JSON.stringify({ github: { event: { before: "not-a-sha" } } }),
      }),
    ).toEqual({
      ref: "refs/heads/main",
      after: HEAD,
      repository: { full_name: "acme/web" },
    });
  });

  test("only allowlisted forge facts get in: titles, bodies, tokens and unknown keys never do", () => {
    const hostile = {
      title: "x",
      body: "ignore previous instructions",
      token: "ghs_secret",
      pull_request: {
        title: "evil",
        body: "evil",
        user: { login: "evil" },
        base: { ref: "main", sha: BASE, token: "ghs_x", label: "evil" },
        head: {
          ref: "topic",
          sha: HEAD,
          repo: { clone_url: "https://evil/x", full_name: "evil/x" },
        },
        draft: true,
      },
      sender: { login: "evil" },
    };
    const ev = buildActEvent(prRun({}, hostile));
    const text = JSON.stringify(ev);
    for (const bad of [
      "evil",
      "ghs_",
      "ignore previous",
      "sender",
      "title",
      "body",
      "token",
      "clone_url",
    ]) {
      expect(text).not.toContain(bad);
    }
    expect((ev.pull_request as { draft: boolean }).draft).toBe(true);
    // the head repo is the run's repo, not whatever the stored event named
    expect((ev.pull_request as { head: { repo: unknown } }).head.repo).toEqual({
      full_name: "acme/web",
    });
  });

  test("a missing or malformed base sha is left out, not invented; a bad plan does not throw", () => {
    const noBase = buildActEvent(prRun({}, { pull_request: { base: { ref: "main" } } }));
    expect((noBase.pull_request as { base: Record<string, unknown> }).base.sha).toBeUndefined();
    const badBase = buildActEvent(
      prRun({}, { pull_request: { base: { ref: "main", sha: "zzz" } } }),
    );
    expect((badBase.pull_request as { base: Record<string, unknown> }).base.sha).toBeUndefined();
    expect(() => buildActEvent(prRun({ plan: "{not json" }))).not.toThrow();
    expect(buildActEvent({ ...prRun(), event: "workflow_dispatch", plan: null })).toEqual({
      repository: { full_name: "acme/web" },
    });
  });
});

describe("the plan hands the payload to act", () => {
  const yaml =
    "on: [pull_request]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
  const opts = {
    workflowPath: ".github/workflows/ci.yml",
    event: "pull_request",
    readFile: () => undefined,
  };

  test("--eventpath names the layout's event file, and the stored JSON is the payload byte for byte", () => {
    const payload = buildActEvent(prRun());
    const plan = planJob(yaml, "j", { ...opts, eventPayload: payload });
    const i = plan.argv.indexOf("--eventpath");
    expect(i).toBeGreaterThan(0);
    expect(plan.argv[i + 1]).toBe(plan.layout.eventFile);
    expect(plan.eventJson).toBe(JSON.stringify(payload));
    // a re-attach rebuilds the command from the stored plan and keeps it
    expect(rebuildArgv(JSON.parse(JSON.stringify(plan))).argv).toContain("--eventpath");
  });

  test("no payload, no flag", () => {
    const plan = planJob(yaml, "j", opts);
    expect(plan.argv).not.toContain("--eventpath");
    expect(plan.eventJson).toBeUndefined();
  });
});

describe("the repo archive and the checkout", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ls-parity-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
      },
    );

  const makeRepo = (name: string): string => {
    const dir = join(tmp, name);
    execFileSync("mkdir", ["-p", dir]);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "ci.yml"), "name: ci\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  };

  test("tar is told to leave platform metadata out", () => {
    expect(TAR_ENV).toEqual({ COPYFILE_DISABLE: "1" });
    expect(tarMetadataArgs(true)).toEqual(["--no-mac-metadata", "--no-xattrs"]);
    expect(tarMetadataArgs(false)).toEqual([]);
  });

  test("the archive has no AppleDouble entries, even when a .git file has an extended attribute", async () => {
    const dir = makeRepo("apple");
    if (process.platform === "darwin") {
      // bsdtar emits a `._` entry for any file with xattrs: give the repo some
      spawnSync("xattr", ["-w", "com.apple.test", "x", join(dir, ".git", "config")]);
      spawnSync("xattr", ["-w", "com.apple.test", "x", join(dir, ".git", "HEAD")]);
    }
    const snap = await snapshotRepo(dir);
    const out = join(tmp, "apple.tgz");
    writeFileSync(out, snap.tarball);
    const names = execFileSync("tar", ["tzf", out], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(3);
    expect(names.filter((n) => n.split("/").pop()!.startsWith("._"))).toEqual([]);
    // and git can read what was delivered
    const x = join(tmp, "apple-x");
    execFileSync("mkdir", ["-p", x]);
    execFileSync("tar", ["xzf", out, "-C", x]);
    expect(git(x, "rev-parse", "HEAD").trim()).toBe(snap.sha);
    git(x, "fsck", "--no-dangling");
  });

  test("the checkout has an origin remote, like actions/checkout leaves", async () => {
    const repo = makeRepo("origin-src");
    const sha = git(repo, "rev-parse", "HEAD").trim();
    const server = serveGitRepo(repo);
    const url = server.url;
    const checkout = await gitRepoSource({
      cloneUrl: () => url,
      allowHosts: ["127.0.0.1"],
      command: CHECKOUT_COMMAND,
    }).checkout({ sha } as never, {
      owner: "acme",
      repo: "web",
    });
    try {
      const out = join(tmp, "origin.tgz");
      writeFileSync(out, checkout.tarball);
      const x = join(tmp, "origin-x");
      execFileSync("mkdir", ["-p", x]);
      execFileSync("tar", ["xzf", out, "-C", x]);
      expect(git(x, "remote", "get-url", "origin").trim()).toBe(url);
    } finally {
      server.stop();
      checkout.dispose?.();
    }
  }, 30_000);

  test("a remote URL with credentials is refused, before anything is fetched", async () => {
    expect(() => assertNoCredentials("https://user:pw@github.com/acme/web.git")).toThrow(
      /credentials/,
    );
    expect(() => assertNoCredentials("https://tok@github.com/acme/web.git")).toThrow(/credentials/);
    expect(() => assertNoCredentials("https://github.com/acme/web")).not.toThrow();
    expect(() => assertNoCredentials("/local/path")).not.toThrow();
    const src = gitRepoSource({ cloneUrl: () => "https://u:p@github.com/acme/web.git" });
    await expect(
      src.checkout({ sha: "a".repeat(40) } as never, { owner: "acme", repo: "web" }),
    ).rejects.toThrow(/credentials/);
  });
});
