import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
} from "../src/db";
import * as s from "../src/db/schema";
import { OidcIssuer } from "../src/oidc/issuer";
import { JobOidc } from "../src/oidc/job-delivery";
import { GithubClient, pollConfigSchema, pollRepo, type PollRepoConfig } from "../src/poll";
import { SecretsProxy, withSecretsProxy } from "../src/proxy";
import { createActRunner, Scheduler } from "../src/scheduler";
import type { AttemptRunner } from "../src/scheduler/types";
import { SecretVault } from "../src/secrets/vault";
import { makeGithub } from "./github-stub";

// The ID token variables at the runner: who is refused, and what the log says. The sandbox side
// (a real job behind the proxy) is covered by the Docker end-to-end tests.
const tmp = mkdtempSync(join(tmpdir(), "tt-job-oidc-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake act that records the OIDC variables it was given. */
const FAKE_ACT = String.raw`#!/bin/sh
J=""
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen"
printf '%s' "$ACTIONS_ID_TOKEN_REQUEST_URL" > "$R/seen/url-$J.txt"
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

const WF_ASKS =
  "name: t\non: push\npermissions:\n  id-token: write\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";

let db: Db;
let scope: Required<Scope>;
let root: string;
let master: Buffer;
let jobOidc: JobOidc;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  root = join(mkdtempSync(join(tmp, "root-")), "tt");
  master = randomBytes(32);
  jobOidc = new JobOidc({
    db,
    issuer: new OidcIssuer({ db, masterKey: master, baseUrl: "https://ci.example.test/oidc" }),
    masterKey: master,
  });
});

async function setupRun(yaml: string, klass: string, plan?: unknown) {
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
  const hash = createHash("sha256").update(yaml).digest("hex");
  await db.orm
    .update(s.runs)
    .set({
      trust: JSON.stringify({ class: klass, workflowHash: hash }),
      approval: JSON.stringify({ head_sha: run!.sha?.toLowerCase(), workflow_hash: hash }),
      ...(plan === undefined ? {} : { plan: JSON.stringify(plan) }),
    })
    .where(eq(s.runs.id, run!.id));
  const [job] = await listJobs(db, scope, run!.id);
  return { gh, run: run!, job: job! };
}

async function schedule(
  gh: ReturnType<typeof makeGithub>,
  wrap: (r: AttemptRunner) => AttemptRunner,
) {
  const d = mkdtempSync(join(tmp, "a-"));
  writeFileSync(join(d, "act"), FAKE_ACT, { mode: 0o755 });
  const bytes = await tarDirectory(d, ["act"]);
  const r = mkdtempSync(join(tmp, "r-"));
  writeFileSync(join(r, "README.md"), "hi\n");
  const tarball = await tarDirectory(r, ["README.md"]);
  const provider = world.provider();
  return new Scheduler({
    db,
    providers: () => provider,
    runner: wrap(
      createActRunner({
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
        jobOidc,
      }),
    ),
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

describe("a job that asked for an ID token, at the runner", () => {
  test("with no secrets proxy it gets no variables, and its log says why", async () => {
    const { gh, job } = await setupRun(WF_ASKS, "protected");
    const sched = await schedule(gh, (r) => r);
    await sched.tick();
    await sched.idle();
    expect(readFileSync(join(root, "seen", "url-build.txt"), "utf8")).toBe("");
    expect(await logOf(job.id)).toContain(
      "ACTIONS_ID_TOKEN_REQUEST_URL is not set (no secrets proxy is running",
    );
  });

  test("on open egress it is refused, not run", async () => {
    const { gh, run } = await setupRun(WF_ASKS, "protected", { egress: "open" });
    const proxy = await SecretsProxy.start({
      db,
      vault: new SecretVault({ db, masterKey: master }),
      bindHost: "127.0.0.1",
      upstream: async () => new Response("unused"),
      tunnel: async () => {
        throw new Error("unused");
      },
    });
    try {
      const sched = await schedule(gh, (r) =>
        withSecretsProxy(r, { proxy, oidc: (c, k) => jobOidc.proxyTarget(c, k) }),
      );
      await sched.tick();
      await sched.idle();
      const [att] = await listAttempts(db, scope, (await listJobs(db, scope, run.id))[0]!.id);
      expect(att?.state).toBe("infra_error");
      expect(att?.errorClass).toContain("cannot run with open egress");
      expect(proxy.active).toBe(0);
    } finally {
      await proxy.stop();
    }
  });

  test("an untrusted pull request that asked gets nothing and says why", async () => {
    const { gh, job } = await setupRun(WF_ASKS, "untrusted_pr");
    const sched = await schedule(gh, (r) => r);
    await sched.tick();
    await sched.idle();
    expect(readFileSync(join(root, "seen", "url-build.txt"), "utf8")).toBe("");
    expect(await logOf(job.id)).toContain("may not mint an identity token");
  });
});
