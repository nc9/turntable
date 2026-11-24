// A hosted shadow, end to end against a fake GitHub: the org claims its installation, a signed
// webhook arrives, the poller is woken for that repo, the run is created through the trust
// decision, the worker runs it (a stand-in for act in a fake sandbox), and a neutral
// `shadow / <job>` check run is posted. Nothing here touches the network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { type CheckRunBody, type CheckRunsApi } from "../src/checks/client";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import {
  createOrg,
  getInstallation,
  listAttempts,
  listJobs,
  listProjects,
  listRuns,
  parseTrust,
  setProjectChecksMode,
} from "../src/db";
import {
  CLAIM_COOKIE,
  CLAIM_PATH,
  InstallationClaims,
  createClaimHandler,
} from "../src/github/claim";
import { WEBHOOK_PATH, createWebhookHandler } from "../src/github/webhook";
import { Poller } from "../src/poll/poller";
import { pollConfigSchema } from "../src/poll/config";
import { createActRunner, Scheduler } from "../src/scheduler";
import {
  WEBHOOK_SECRET,
  fakeFacts,
  fakeUserVerifier,
  inst,
  ownerOf100,
  repo,
  setup,
  sign,
} from "./github-helpers";
import { SHA, makeGithub } from "./github-stub";

/** Polls `cond` every 50 ms until it holds or `ms` pass (default 20 s). Returns whether it held. */
async function until(cond: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(50);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "ls-hosted-e2e-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

const FAKE_ACT = String.raw`#!/bin/sh
J=""
while [ $# -gt 0 ]; do case "$1" in -j) J=$2; shift;; esac; shift; done
ev() { printf '{"jobID":"%s","level":"info","msg":"%s","step":"%s","stepid":["--setup-job"],"time":"t"%s}\n' "$1" "$2" "$3" "$4"; }
ev "$J" "Run" "Set up job" ""
ev "$J" "ok" "Set up job" ',"stepResult":"success"'
printf '{"jobID":"%s","jobResult":"success","msg":"ok","time":"t"}\n' "$J"
`;

const WORKFLOW = `name: ci
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

describe("hosted shadow, end to end", () => {
  test("claim, webhook, poll, trust decision, run, neutral shadow check", async () => {
    // --- the instance: an App owned by org acme, a hosted tenant that will claim an installation
    const s = await setup();
    const db = s.db;
    const tenant = await createOrg(db, { slug: "tenant-b", name: "Tenant B" });
    const facts = fakeFacts();
    facts.installations.set("100", inst("100"));
    facts.repos.set("100", [repo("1", "web")]);
    const claims = new InstallationClaims({ db, store: s.store });
    const user = fakeUserVerifier(new Map([["c", ownerOf100]]));
    const claimHandler = createClaimHandler({ claims, facts: facts.facts, user, log: () => {} });

    // --- step 1: the tenant claims the installation; the repo becomes a project of THAT org
    const { url } = await claims.start(tenant.id, "token:operator");
    const state = new URL(url, "http://x").searchParams.get("state")!;
    const nonce = JSON.parse(Buffer.from(state.split(".")[1]!, "base64url").toString()).n as string;
    const claimed = await claimHandler.handle(
      new Request(
        `http://x${CLAIM_PATH}?installation_id=100&setup_action=install&code=c&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${CLAIM_COOKIE}=${nonce}` } },
      ),
    );
    expect(claimed?.status).toBe(200);
    expect((await getInstallation(db, "100"))?.orgId).toBe(tenant.id);
    const [project] = await listProjects(db, { orgId: tenant.id });
    expect(project?.slug).toBe("web");
    const scope = { orgId: tenant.id, projectId: project!.id };
    await setProjectChecksMode(db, scope, "shadow");

    // --- a fake GitHub: the repo's CI workflow, a push, and a pull request nobody vouches for
    const gh = makeGithub("acme/web");
    gh.state.files.set("*", WORKFLOW);
    gh.state.head = { sha: SHA("a"), message: "feat: first", login: "octocat" };

    // --- the worker, with a stand-in for act, and a reporter that posts to a fake check API
    const posted = new Map<string, CheckRunBody>();
    const calls: { op: string; sha?: string | undefined; name?: string | undefined }[] = [];
    let nextId = 500;
    const api: CheckRunsApi = {
      async create(_t, _repo, body) {
        const id = String(nextId++);
        posted.set(id, { ...body });
        calls.push({ op: "create", sha: body.head_sha, name: body.name });
        return id;
      },
      async update(_t, _repo, id, body) {
        posted.set(id, { ...posted.get(id), ...body });
        calls.push({ op: "update" });
      },
      async findByExternalId() {
        return undefined;
      },
    };
    const minter: TokenMinter = { mint: async () => ({ token: "installation-token" }) };
    const reporter = new CheckReporter({
      db,
      auth: minter,
      api,
      publicUrl: "https://ci.example.com",
      sleep: async () => {},
    });

    const actDir = mkdtempSync(join(tmp, "a-"));
    writeFileSync(join(actDir, "act"), FAKE_ACT, { mode: 0o755 });
    const actBytes = await tarDirectory(actDir, ["act"]);
    const repoDir = mkdtempSync(join(tmp, "r-"));
    writeFileSync(join(repoDir, "README.md"), "hi\n");
    const tarball = await tarDirectory(repoDir, ["README.md"]);
    const sched = new Scheduler({
      db,
      providers: () => world.provider(),
      runner: createActRunner({
        db,
        source: {
          checkout: async () => ({
            tarball,
            readFile: (p: string) => (p === ".github/workflows/ci.yml" ? WORKFLOW : undefined),
          }),
        },
        resolver: staticResolver({}),
        act: { bytes: actBytes, sha256: sha256Hex(actBytes) },
        planRoot: join(mkdtempSync(join(tmp, "root-")), "tt"),
        pollMs: 30,
      }),
      globalCap: 1,
      perOrgCap: 1,
      leaseMs: 60_000,
      pollMs: 20,
      observer: reporter,
    });

    // --- the poller, woken by the webhook handler
    const config = pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        {
          repo: "acme/web",
          org: "tenant-b",
          project: "web",
          workflow: ".github/workflows/ci.yml",
          defaultBranch: "main",
          intervalSeconds: 3600,
          prMode: "approval",
          prBaseline: false,
        },
      ],
    });
    const poller = new Poller({
      db,
      config,
      fetch: gh.fetch as never,
      log: () => {},
      onQueued: () => sched.nudge(),
    });
    const webhooks = createWebhookHandler({
      db,
      store: s.store,
      facts: facts.facts,
      claimMode: true,
      log: () => {},
      onRepoEvent: (r) => void poller.nudge(r),
    });
    poller.start();
    // the first poll: the push at sha a (waited for, not slept: Postgres commits more slowly)
    await until(async () => (await listRuns(db, scope)).some((r) => r.sha === SHA("a")));

    // --- new commits land on GitHub, and GitHub says so, signed
    gh.state.head = { sha: SHA("b"), message: "feat: second", login: "octocat" };
    gh.state.pulls = [{ number: 9, user: "stranger", headSha: SHA("d"), baseRef: "main" }];
    // a same-repo PR by someone who is not a collaborator: its permission lookup is a 404
    const body = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/web" } });
    const res = await webhooks.handle(
      new Request(`http://x${WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "x-github-event": "push",
          "x-github-delivery": crypto.randomUUID(),
          "x-hub-signature-256": sign(WEBHOOK_SECRET, body),
        },
        body,
      }),
      "140.82.112.1",
    );
    expect(res?.status).toBe(202);

    // the nudge polls the repo again (not sooner than the minimum gap), through the trust decision
    // Both runs come from the same poll but are separate commits: wait for the push run AND the
    // pull request run, each by its own condition, with one deadline.
    let runs = await listRuns(db, scope);
    await until(async () => {
      runs = await listRuns(db, scope);
      return (
        runs.some((r) => r.sha === SHA("b") && r.event === "push") &&
        runs.some((r) => r.event === "pull_request")
      );
    });
    poller.stop();
    const push = runs.find((r) => r.sha === SHA("b") && r.event === "push");
    const pr = runs.find((r) => r.event === "pull_request");
    expect(push).toBeDefined();
    expect(parseTrust(push!)?.class).toBe("protected");
    expect(pr).toBeDefined();
    expect(parseTrust(pr!)?.class).toBe("untrusted_pr"); // nobody vouched for the author
    expect(pr!.status).toBe("awaiting_approval"); // so it is held, not run

    // --- the worker runs what is allowed to run
    for (let i = 0; i < 40; i++) {
      const started = await sched.tick();
      await sched.idle();
      if (started === 0) break;
    }
    await reporter.idle();
    const [pushJob] = await listJobs(db, scope, push!.id);
    expect(pushJob?.state).toBe("success");
    expect(await listAttempts(db, scope, pushJob!.id)).not.toEqual([]);
    const prJobs = await listJobs(db, scope, pr!.id);
    expect(prJobs.every((j) => j.state !== "success" && j.state !== "running")).toBe(true);

    // --- the check runs: neutral, named shadow / <job>, for the commits that ran; none for the held PR
    const created = calls.filter((c) => c.op === "create");
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) expect(c.name).toBe("shadow / build");
    expect(created.some((c) => c.sha === SHA("b"))).toBe(true);
    expect(created.some((c) => c.sha === SHA("d"))).toBe(false);
    const final = [...posted.values()].filter((b) => b.head_sha === SHA("b")).at(-1);
    expect(final?.status).toBe("completed");
    expect(final?.conclusion).toBe("neutral");
  }, 60_000);
});
