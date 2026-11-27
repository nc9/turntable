import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  type Db,
  ensureLocalTenant,
  getJob,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
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

// What a fresh attempt records as its adopt block (#761), through createActRunner: the secrets
// proxy and an artifact credential block a hand-off, an ordinary job does not.
const tmp = mkdtempSync(join(tmpdir(), "tt-adopt-block-"));
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

const WF_PLAIN =
  "name: t\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
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
  extra?: Partial<Parameters<typeof createActRunner>[0]>,
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
        ...(extra ?? {}),
      }),
    ),
    globalCap: 1,
    perOrgCap: 1,
    leaseMs: 60_000,
    pollMs: 20,
  });
}

const artifacts = () => ({ resultsUrl: "https://ci.example.test/", token: "t", release: () => {} });

async function blockOf(jobId: string): Promise<string | null | undefined> {
  const [att] = await listAttempts(db, scope, jobId);
  return att?.adoptBlock;
}

describe("a fresh attempt records why it cannot be handed off", () => {
  test("a job behind the secrets proxy records `secrets proxy`", async () => {
    const { gh, job } = await setupRun(WF_ASKS, "protected");
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
      expect(await blockOf(job.id)).toBe("secrets proxy");
    } finally {
      await proxy.stop();
    }
  });

  test("a job with an upload-artifact step records `artifact credential`", async () => {
    const { gh, job } = await setupRun(WF_PLAIN, "protected", { egress: "open" });
    // The plan a workflow with an upload-artifact step stores (its action refs cannot be
    // resolved offline, so the stored plan is set directly).
    const planned = JSON.parse((await getJob(db, scope, job.id))!.planned!) as Record<
      string,
      unknown
    >;
    delete planned.artifactAccess;
    await db.orm
      .update(s.jobs)
      .set({ planned: JSON.stringify({ ...planned, artifactUpload: true }) })
      .where(eq(s.jobs.id, job.id));
    const sched = await schedule(gh, (r) => r, { artifacts });
    await sched.tick();
    await sched.idle();
    expect(await blockOf(job.id)).toBe("artifact credential");
  });

  test("an ordinary open-egress job gets no artifact credential and stays adoptable", async () => {
    const { gh, job } = await setupRun(WF_PLAIN, "protected", { egress: "open" });
    const sched = await schedule(gh, (r) => r, { artifacts });
    await sched.tick();
    await sched.idle();
    expect(await blockOf(job.id)).toBeNull();
  });
});
