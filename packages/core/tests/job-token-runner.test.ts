import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  type Db,
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
  type Scope,
  setProjectChecksMode,
} from "../src/db";
import * as s from "../src/db/schema";
import { eq } from "drizzle-orm";
import { GithubClient, pollConfigSchema, pollRepo, type PollRepoConfig } from "../src/poll";
import { JobTokens, type TokenAuthority } from "../src/github/job-token";
import { createActRunner, Scheduler } from "../src/scheduler";
import { makeGithub } from "./github-stub";

const tmp = mkdtempSync(join(tmpdir(), "tt-job-token-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

// Built at run time: a literal in this shape trips secret scanners.
const TOKEN = ["ghs", "runner", "token", "value", "19ab77"].join("_");

/** A fake act that records its own arguments and the GITHUB_TOKEN it was given. */
const FAKE_ACT = String.raw`#!/bin/sh
ARGS="$*"
J=""; W=""
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; -W) W=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen"
printf '%s' "$ARGS" > "$R/seen/args-$J.txt"
printf '%s' "$GITHUB_TOKEN" > "$R/seen/env-$J.txt"
printf '{"jobID":"%s","level":"info","msg":"token is %s","raw_output":true,"stage":"Main","step":"s","stepID":["0"],"time":"t"}\n' "$J" "$GITHUB_TOKEN"
case "$J" in slow) sleep 3 ;; esac
printf '{"jobID":"%s","jobResult":"success","msg":"ok","time":"t"}\n' "$J"
`;

const CFG = (): PollRepoConfig =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        prBaseline: false,
        authors: ["octocat"],
      },
    ],
  }).repos[0] as PollRepoConfig;

let db: Db;
let scope: Required<Scope>;
let root: string;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  root = join(mkdtempSync(join(tmp, "root-")), "tt");
});

function authority(
  isPublic?: (o: string, r: string) => Promise<boolean>,
  grant: Record<string, string> = { metadata: "read", contents: "write" },
) {
  const calls = { minted: [] as unknown[], revoked: [] as string[], fail: false };
  const auth: TokenAuthority = {
    mintFresh: async (installationId, sc) => {
      if (calls.fail) throw new Error("minting failed: HTTP 500");
      calls.minted.push({ installationId, ...sc });
      return { token: TOKEN, expiresAt: Date.now() + 3_600_000 };
    },
    installationPermissions: async () => grant,
    revoke: async (t) => {
      calls.revoked.push(t);
      return true;
    },
  };
  return { calls, tokens: new JobTokens(auth, { isPublic }) };
}

async function setupRun(yaml: string, klass?: string) {
  const gh = makeGithub();
  gh.state.files.set("*", yaml);
  await pollRepo(
    {
      db,
      github: new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" }),
      provider: "fake",
    },
    CFG(),
  );
  const [run] = await listRuns(db, scope);
  // The repo is bound to an App installation.
  await db.orm.update(s.projectRepos).set({ installationId: "100" });
  // These cases are about a live project's token; a side-by-side one is read-only (job-token-shadow).
  await setProjectChecksMode(db, scope, "live");
  if (klass) {
    // An untrusted run starts only with an approval bound to its sha and workflow.
    const hash = createHash("sha256").update(yaml).digest("hex");
    await db.orm
      .update(s.runs)
      .set({
        trust: JSON.stringify({ class: klass, workflowHash: hash }),
        approval: JSON.stringify({ head_sha: run!.sha?.toLowerCase(), workflow_hash: hash }),
      })
      .where(eq(s.runs.id, run!.id));
  }
  const [job] = await listJobs(db, scope, run!.id);
  return { gh, run: run!, job: job! };
}

/** A provider whose egress probe answers with `code`: 125 is no tool in the image (unknown), 0 is blocked. */
function probing(code: number) {
  const p = world.provider();
  const start = p.exec.start.bind(p.exec);
  p.exec.start = (id, o) =>
    o.argv.includes("canary")
      ? start(id, { ...o, argv: ["sh", "-c", `exit ${code}`] })
      : start(id, o);
  return p;
}

async function schedule(
  gh: ReturnType<typeof makeGithub>,
  jobTokens: JobTokens,
  // A job holding a token is always probed, so the default provider answers "blocked".
  provider = probing(0),
  canary = false,
) {
  const d = mkdtempSync(join(tmp, "a-"));
  writeFileSync(join(d, "act"), FAKE_ACT, { mode: 0o755 });
  const bytes = await tarDirectory(d, ["act"]);
  const r = mkdtempSync(join(tmp, "r-"));
  writeFileSync(join(r, "README.md"), "hi\n");
  const tarball = await tarDirectory(r, ["README.md"]);
  return new Scheduler({
    db,
    providers: () => provider,
    runner: createActRunner({
      db,
      source: {
        checkout: async (run: { sha: string | null }) => ({
          tarball,
          readFile: (p: string) =>
            p === ".github/workflows/ci.yml"
              ? (gh.state.files.get(run.sha ?? "") ?? gh.state.files.get("*"))
              : undefined,
        }),
      },
      resolver: staticResolver({}),
      act: { bytes, sha256: sha256Hex(bytes) },
      planRoot: root,
      pollMs: 30,
      jobTokens,
      ...(canary ? { canary: true } : {}),
    }),
    globalCap: 1,
    perOrgCap: 1,
    leaseMs: 60_000,
    pollMs: 20,
  });
}

const logOf = async (jobId: string): Promise<string> => {
  const [att] = await listAttempts(db, scope, jobId);
  return Buffer.concat((await readLog(db, scope, att!.id)).map((c) => c.bytes)).toString();
};
const seen = (file: string): string => readFileSync(join(root, "seen", file), "utf8");

/** A job that needs a token: a write scope, which the fake installation grants. */
const NEEDS_TOKEN = "permissions:\n  issues: write\n";
const WRITE_GRANT = { metadata: "read", contents: "write", issues: "write" };

const WF = (perm = ""): string =>
  `name: t\non: push\n${perm}jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;

describe("a job's GitHub token, without the proxy", () => {
  test("a protected job gets its own token in the environment, scoped to its repository, and it is revoked after", async () => {
    const { gh, job } = await setupRun(WF(NEEDS_TOKEN));
    const { calls, tokens } = authority(undefined, WRITE_GRANT);
    const sched = await schedule(gh, tokens);
    await sched.tick();
    await sched.idle();
    expect(calls.minted).toEqual([
      {
        installationId: "100",
        repositories: ["web"],
        permissions: { metadata: "read", issues: "write" },
      },
    ]);
    // act is told to take GITHUB_TOKEN from its environment, and the token is not in its argv.
    expect(seen("args-build.txt")).toContain("-s GITHUB_TOKEN");
    expect(seen("args-build.txt")).not.toContain(TOKEN);
    expect(seen("env-build.txt")).toBe(TOKEN);
    // The log never shows it, and says what the token is.
    const log = await logOf(job.id);
    expect(log).not.toContain(TOKEN);
    expect(log).toContain("GITHUB_TOKEN for acme/web: metadata:read, issues:write");
    // Revoked when the job ended.
    expect(calls.revoked).toEqual([TOKEN]);
    // A live token is not handed to another controller (#761): its encoded forms could not be redacted.
    const [att] = await listAttempts(db, scope, job.id);
    expect(att!.adoptBlock).toBe("job token");
  });

  test("the workflow's permissions are honoured, capped by the installation's grant", async () => {
    const { gh } = await setupRun(WF("permissions:\n  contents: write\n  issues: write\n"));
    const { calls, tokens } = authority();
    const sched = await schedule(gh, tokens);
    await sched.tick();
    await sched.idle();
    // The fake installation has contents: write and no issues.
    expect(calls.minted[0]).toMatchObject({
      permissions: { metadata: "read", contents: "write" },
    });
  });

  test("a class that may not hold credentials gets no token at all without the proxy", async () => {
    for (const klass of ["trusted_pr", "untrusted_pr"]) {
      db = openDatabase(":memory:");
      scope = await ensureLocalTenant(db);
      root = join(mkdtempSync(join(tmp, "root-")), "tt");
      const { gh } = await setupRun(WF(), klass);
      const { calls, tokens } = authority();
      const sched = await schedule(gh, tokens);
      await sched.tick();
      await sched.idle();
      expect(calls.minted).toEqual([]);
      expect(seen("env-build.txt")).toBe("");
      expect(seen("args-build.txt")).not.toContain("GITHUB_TOKEN");
    }
  });

  test("a mint failure does not stop the job; its log says there is no token", async () => {
    const { gh, job } = await setupRun(WF(NEEDS_TOKEN));
    const { calls, tokens } = authority(undefined, WRITE_GRANT);
    calls.fail = true;
    const sched = await schedule(gh, tokens);
    await sched.tick();
    await sched.idle();
    expect(seen("env-build.txt")).toBe("");
    expect(await logOf(job.id)).toContain("GITHUB_TOKEN is not available");
    expect(calls.revoked).toEqual([]);
  });

  test("a cancelled job's token is revoked at once", async () => {
    const { gh, run } = await setupRun(
      "name: t\non: push\njobs:\n  slow:\n    runs-on: ubuntu-latest\n    steps:\n      - run: sleep 3\n".replace(
        "jobs:",
        `${NEEDS_TOKEN}jobs:`,
      ),
    );
    const { calls, tokens } = authority(undefined, WRITE_GRANT);
    const sched = await schedule(gh, tokens);
    await sched.tick();
    // Wait for the token to exist, then cancel the run's attempts.
    for (let i = 0; i < 100 && calls.minted.length === 0; i++) await Bun.sleep(20);
    expect(calls.minted).toHaveLength(1);
    const [job] = await listJobs(db, scope, run.id);
    const [att] = await listAttempts(db, scope, job!.id);
    sched.abort([att!.id]);
    await sched.idle();
    expect(calls.revoked).toEqual([TOKEN]);
  });
});

describe("a token only when it is needed", () => {
  test("a public repo's job that needs nothing beyond contents read gets none and says so", async () => {
    for (const klass of ["protected", "release"]) {
      db = openDatabase(":memory:");
      scope = await ensureLocalTenant(db);
      root = join(mkdtempSync(join(tmp, "root-")), "tt");
      const { gh, job } = await setupRun(WF(), klass);
      const { calls, tokens } = authority(async () => true);
      const sched = await schedule(gh, tokens);
      await sched.tick();
      await sched.idle();
      expect(calls.minted).toEqual([]);
      expect(seen("env-build.txt")).toBe("");
      expect(await logOf(job.id)).toContain(
        "GITHUB_TOKEN is not set (no token: acme/web is public",
      );
    }
  });

  test("a write permission on a public repo still gets one (protected)", async () => {
    const { gh } = await setupRun(WF("permissions:\n  issues: write\n"));
    const { calls, tokens } = authority(async () => true, {
      metadata: "read",
      contents: "write",
      issues: "write",
    });
    const sched = await schedule(gh, tokens);
    await sched.tick();
    await sched.idle();
    expect(calls.minted).toHaveLength(1);
  });

  const openEgress = async (runId: string): Promise<void> => {
    await db.orm
      .update(s.runs)
      .set({ plan: JSON.stringify({ egress: "open" }) })
      .where(eq(s.runs.id, runId));
  };

  test("a private repo's protected job with default or contents read permissions runs on open egress with no token", async () => {
    for (const perm of ["", "permissions:\n  contents: read\n"]) {
      db = openDatabase(":memory:");
      scope = await ensureLocalTenant(db);
      root = join(mkdtempSync(join(tmp, "root-")), "tt");
      const { gh, run, job } = await setupRun(WF(perm), "protected");
      await openEgress(run.id);
      const { calls, tokens } = authority(async () => false, WRITE_GRANT);
      const sched = await schedule(gh, tokens);
      await sched.tick();
      await sched.idle();
      expect(calls.minted).toEqual([]);
      expect(seen("env-build.txt")).toBe("");
      const [att] = await listAttempts(db, scope, job.id);
      expect(att?.state).toBe("success");
      expect(await logOf(job.id)).toContain(
        "GITHUB_TOKEN is not set (the private repository's tree was delivered by Turntable",
      );
    }
  });

  test("a private repo's job with a write scope is still refused on open egress, and the token is revoked", async () => {
    for (const scopeName of ["contents: write", "issues: write", "pull_requests: write"]) {
      db = openDatabase(":memory:");
      scope = await ensureLocalTenant(db);
      root = join(mkdtempSync(join(tmp, "root-")), "tt");
      const { gh, run, job } = await setupRun(WF(`permissions:\n  ${scopeName}\n`), "protected");
      await openEgress(run.id);
      const { calls, tokens } = authority(async () => false, {
        ...WRITE_GRANT,
        pull_requests: "write",
      });
      const sched = await schedule(gh, tokens);
      await sched.tick();
      await sched.idle();
      const [att] = await listAttempts(db, scope, job.id);
      expect(att?.state).toBe("infra_error");
      expect(att?.errorClass).toContain(
        "(a write permission, or a private repository), and a job with a token cannot run with open egress",
      );
      expect(calls.revoked).toEqual([TOKEN]);
    }
  });

  test("a private repo's job that checks out another repository is still refused on open egress, naming it", async () => {
    const wf =
      "name: t\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@" +
      "a".repeat(40) +
      "\n        with:\n          repository: acme/other-private\n";
    const { gh, run, job } = await setupRun(wf, "protected");
    await openEgress(run.id);
    const { calls, tokens } = authority(async () => false, WRITE_GRANT);
    const sched = await schedule(gh, tokens);
    await sched.tick();
    await sched.idle();
    const [att] = await listAttempts(db, scope, job.id);
    expect(att?.state).toBe("infra_error");
    expect(att?.errorClass).toContain("another repository (acme/other-private)");
    expect(calls.revoked).toEqual([TOKEN]);
  });

  test("a release job with a write scope on a private repo is unchanged: a token, refused on open egress", async () => {
    const { gh, run, job } = await setupRun(WF(NEEDS_TOKEN), "release");
    await openEgress(run.id);
    const { calls, tokens } = authority(async () => false, WRITE_GRANT);
    const sched = await schedule(gh, tokens);
    await sched.tick();
    await sched.idle();
    const [att] = await listAttempts(db, scope, job.id);
    expect(att?.state).toBe("infra_error");
    expect(calls.revoked).toEqual([TOKEN]);
  });

  test("a job that needs a token is refused on open egress, and the token is revoked at once", async () => {
    const { gh, run } = await setupRun(WF("permissions:\n  issues: write\n"));
    await db.orm
      .update(s.runs)
      .set({ plan: JSON.stringify({ egress: "open" }) })
      .where(eq(s.runs.id, run.id));
    const { calls, tokens } = authority(async () => true, {
      metadata: "read",
      contents: "write",
      issues: "write",
    });
    const sched = await schedule(gh, tokens);
    await sched.tick();
    await sched.idle();
    const [att] = await listAttempts(db, scope, (await listJobs(db, scope, run.id))[0]!.id);
    expect(att?.state).toBe("infra_error");
    expect(att?.errorClass).toContain("cannot run with open egress");
    expect(calls.revoked).toEqual([TOKEN]);
  });
});

describe("a job holding a token is secret-bearing", () => {
  const blindProvider = () => probing(125);

  test("with an unverifiable egress canary, a job that holds a token is refused, and the token is revoked", async () => {
    const { gh, run } = await setupRun(WF(NEEDS_TOKEN));
    const { calls, tokens } = authority(undefined, WRITE_GRANT);
    const sched = await schedule(gh, tokens, blindProvider(), true);
    await sched.tick();
    await sched.idle();
    const [att] = await listAttempts(db, scope, (await listJobs(db, scope, run.id))[0]!.id);
    expect(att?.state).toBe("infra_error");
    expect(att?.errorClass).toContain("could not verify isolation");
    expect(att?.errorClass).toContain("a job with secrets was not run");
    expect(calls.revoked).toEqual([TOKEN]);
  });

  test("a job with no token, on the same blind provider, still runs (with a notice)", async () => {
    const { gh, job } = await setupRun(WF());
    const { calls, tokens } = authority(async () => true);
    const sched = await schedule(gh, tokens, blindProvider(), true);
    await sched.tick();
    await sched.idle();
    expect(calls.minted).toEqual([]);
    const [att] = await listAttempts(db, scope, job.id);
    expect(att?.state).toBe("success");
    expect(await logOf(job.id)).toContain("egress canary could not run");
  });

  test("a verifiable canary lets the token job run", async () => {
    const { gh, run } = await setupRun(WF(NEEDS_TOKEN));
    const { calls, tokens } = authority(undefined, WRITE_GRANT);
    const sched = await schedule(gh, tokens, probing(0), true);
    await sched.tick();
    await sched.idle();
    const [att] = await listAttempts(db, scope, (await listJobs(db, scope, run.id))[0]!.id);
    expect(att?.state).toBe("success");
    expect(calls.minted).toHaveLength(1);
  });
});
