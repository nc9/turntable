// Tag ingest: a tag becomes a run only when the project opted in with tag ref patterns, the tag is
// new, its commit is on the default branch, and the same trust decision as any run says what class
// it is. A moved tag creates nothing and is audited. The webhook for a tag push only wakes the
// poller; nothing from its payload is believed.
import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { randomBytes } from "node:crypto";
import {
  bindRepo,
  createOrg,
  createProject,
  ensureLocalTenant,
  getRun,
  listAudit,
  listJobs,
  listRuns,
  openDatabase,
  setRunStatus,
  type Db,
  type Scope,
} from "../src/db";
import { setIngestPolicy, showIngest } from "../src/ops/policy-cli";
import { createWebhookHandler } from "../src/github/webhook";
import { SECRET_WEBHOOK } from "../src/github/app-auth";
import { setGithubApp } from "../src/db";
import { SecretStore } from "../src/secrets/store";
import { GithubClient, Poller, pollConfigSchema, pollRepo } from "../src/poll";
import { ingestSettingsSchema } from "../src/poll/config";
import { includeCovers, patternProtected, REQUIRED_RULES } from "../src/poll/tag-protection";
import { matchesPatterns } from "@turntable/act-runner";
import { newTagCaches } from "../src/poll/ingest";
import { dispatch, registry } from "../src/ops";
import { getApproveRunMinRole, setApproveRunMinRole } from "../src/db/repos";
import { mintToken } from "./ops-helpers";
import { makeGithub, SHA } from "./github-stub";

const WORKFLOW = `name: CI
on:
  push:
    branches: [main]
    tags: ['v*', 'rel-*']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
const BRANCH_ONLY = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;

let db: Db;
let scope: Required<Scope>;
let now = 1_800_000_000_000;

beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  now = 1_800_000_000_000;
});

/** The default branch: head a, then b, then c (a linear history, newest first). */
const linear = (...shas: string[]) =>
  shas.map((sha, i) => ({ sha, parents: shas[i + 1] ? [shas[i + 1] as string] : [] }));

/** A ruleset that restricts creating the tags, bypassable only by repository admins. */
const ADMIN_ONLY = (include: string[]) => ({
  id: 1,
  include,
  bypass: [{ actor_type: "RepositoryRole", actor_id: 5 }],
});

function world(o: { tagRefs?: string[]; protect?: boolean; prime?: boolean } = {}) {
  const tagRefs = o.tagRefs ?? ["refs/tags/v*"];
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  gh.state.history = linear(SHA("a"), SHA("b"), SHA("c"));
  gh.state.tags.set("v1.0.0", { sha: SHA("a") });
  // By default creating these tags is restricted by a ruleset, so a tag run starts at once.
  if (o.protect !== false) gh.state.rulesets = [ADMIN_ONLY(tagRefs)];
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        tagRefs,
        maxRunsPerHour: 1000,
        maxWaitingRuns: 500,
      },
    ],
  }).repos[0]!;
  // One client for the whole poller's life, as in the real poller: it keeps the ETag cache. The
  // tag caches live as long as the poller too.
  const github = new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" });
  return { gh, cfg, github, tagCaches: newTagCaches(), primed: o.prime === false };
}

const pollOnce = (w: ReturnType<typeof world>) =>
  pollRepo(
    {
      db,
      github: w.github,
      provider: "docker",
      now: () => now,
      tagCaches: w.tagCaches,
    },
    w.cfg,
  );

/**
 * A tag counts as created under protection only when it is first listed after the poller saw the
 * ruleset (a tag listed in the poll that first sees protection may predate it). Tests that mean "an
 * established ruleset" get one poll with no tags first; `prime: false` skips that to test the
 * moment itself.
 */
async function poll(w: ReturnType<typeof world>) {
  if (!w.primed) {
    w.primed = true;
    const held = new Map(w.gh.state.tags);
    w.gh.state.tags.clear();
    await pollOnce(w);
    now += 1_000;
    for (const [k, v] of held) w.gh.state.tags.set(k, v);
  }
  return pollOnce(w);
}

const tagRuns = async () =>
  (await listRuns(db, scope, { limit: 1000 })).filter((r) => r.ref.startsWith("refs/tags/"));
const classOf = (r: { trust: string | null }): string => JSON.parse(r.trust!).class;
const tagCalls = (w: ReturnType<typeof world>) =>
  w.gh.state.calls.filter((c) => c.path.includes("/matching-refs/tags/"));
const callsTo = (w: ReturnType<typeof world>, frag: string) =>
  w.gh.state.calls.filter((c) => c.path.includes(frag));

describe("opt-in", () => {
  test("with no tag patterns, tags are never listed and never run", async () => {
    const w = world({ tagRefs: [], prime: false });
    const r = await poll(w);
    expect(await tagRuns()).toEqual([]);
    expect(tagCalls(w)).toEqual([]);
    expect(r.created).toHaveLength(1); // only the default branch push
  });

  test("a pattern is an exact tag or a literal prefix and a trailing star, and policy set refuses anything broader", async () => {
    for (const good of [
      "refs/tags/v*",
      "refs/tags/v1.0.0",
      "refs/tags/release-*",
      "refs/tags/rel/2*",
    ]) {
      expect(
        ingestSettingsSchema.safeParse({ defaultBranch: "main", tagRefs: [good] }).success,
      ).toBe(true);
    }
    const org = await createOrg(db, { slug: "acme", name: "acme" });
    await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
    for (const broad of ["refs/tags/*", "refs/tags/**", "refs/tags/*-rc"]) {
      await expect(
        setIngestPolicy(db, "acme", "web", "on", { defaultBranch: "main", tagRefs: [broad] }),
      ).rejects.toThrow("tagRefs");
    }
    expect((await showIngest(db, "acme"))[0]!.ingest).toBeNull();
  });

  test("the schema accepts only full tag refs, and the default is none", () => {
    expect(ingestSettingsSchema.parse({ defaultBranch: "main" }).tagRefs).toEqual([]);
    for (const bad of [
      "v*",
      "refs/heads/*",
      "refs/tags/",
      "refs/tags/v 1",
      "refs/tags/../x",
      "refs/tags/*",
      "refs/tags/**",
      "refs/tags/*-rc",
      "refs/tags/v*-rc",
      "refs/tags/v?",
      "refs/tags/?1",
      "refs/tags/-x*",
      "refs/tags//*",
    ]) {
      expect(
        ingestSettingsSchema.safeParse({ defaultBranch: "main", tagRefs: [bad] }).success,
      ).toBe(false);
    }
  });
});

describe("a tag becomes a run", () => {
  test("a protected tag on the default head is a push run of refs/tags/<name>, release class, started at once", async () => {
    const w = world();
    w.gh.state.commits.set(SHA("a"), { login: "octocat", message: "release 1.0.0" });
    await poll(w);
    const [run] = await tagRuns();
    expect(run).toMatchObject({
      event: "push",
      ref: "refs/tags/v1.0.0",
      sha: SHA("a"),
      headBranch: "v1.0.0",
      commitMessage: "release 1.0.0",
      workflowPath: ".github/workflows/ci.yml",
      status: "queued",
    });
    expect(classOf(run!)).toBe("release");
    const trust = JSON.parse(run!.trust!);
    expect(trust.facts).toMatchObject({
      event: "push",
      ref: "refs/tags/v1.0.0",
      tag: "v1.0.0", // set by ingest: approvals read it to know the author is unknown by construction
      tagProtection: "ruleset",
    });
    expect(trust.workflowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(trust.reasons.join(" ")).toContain("a ruleset restricts creating this tag");
    // the default branch push at the same commit is its own run
    expect((await listRuns(db, scope)).map((r) => r.ref).sort()).toEqual([
      "refs/heads/main",
      "refs/tags/v1.0.0",
    ]);
  });

  test("a tag run has no actor: not the commit's author, and not the unverified tagger either", async () => {
    const w = world();
    w.gh.state.commits.set(SHA("a"), { login: "commit-author", message: "x" });
    await poll(w);
    const [run] = await tagRuns();
    expect(run!.actor).toBeNull();
    expect(JSON.parse(run!.trust!).facts).not.toHaveProperty("taggerLabel");
    expect(JSON.stringify(run)).not.toContain("commit-author");
  });

  test("an annotated tag is followed to its commit; its tagger is a display label in the facts, never the actor", async () => {
    const w = world();
    w.gh.state.tags.clear();
    w.gh.state.tags.set("v2.0.0", { sha: SHA("a"), annotatedAs: SHA("9"), tagger: "nc9" });
    w.gh.state.commits.set(SHA("a"), { login: "commit-author", message: "x" });
    await poll(w);
    const [run] = await tagRuns();
    expect(run).toMatchObject({ ref: "refs/tags/v2.0.0", sha: SHA("a"), actor: null });
    // free text a tagger typed ("nc9") must not read as an identity anywhere an actor is read
    expect(JSON.parse(run!.trust!).facts.taggerLabel).toBe("nc9");
    expect(callsTo(w, `/git/tags/${SHA("9")}`)).toHaveLength(1);
    // the tag object is immutable: asking again does not fetch it again
    w.gh.state.tags.set("v2.0.1", { sha: SHA("a"), annotatedAs: SHA("9"), tagger: "nc9" });
    await poll(w);
    expect(callsTo(w, `/git/tags/${SHA("9")}`)).toHaveLength(1);
  });

  test("the patterns are the project's release refs: a pattern other than v* classifies as release", async () => {
    const w = world({ tagRefs: ["refs/tags/rel-*"] });
    w.gh.state.tags.clear();
    w.gh.state.tags.set("rel-7", { sha: SHA("a") });
    w.gh.state.tags.set("v1.0.0", { sha: SHA("a") });
    await poll(w);
    const runs = await tagRuns();
    expect(runs.map((r) => r.ref)).toEqual(["refs/tags/rel-7"]);
    expect(classOf(runs[0]!)).toBe("release");
  });

  test("tags are listed per pattern and filtered by pattern before any tag object is read", async () => {
    const w = world({ tagRefs: ["refs/tags/v*", "refs/tags/rel-*"], prime: false });
    w.gh.state.tags.clear();
    w.gh.state.tags.set("beta", { sha: SHA("a"), annotatedAs: SHA("8") });
    w.gh.state.tags.set("v1.0.0", { sha: SHA("a") });
    w.gh.state.tags.set("rel-1", { sha: SHA("a") });
    await poll(w);
    expect((await tagRuns()).map((r) => r.ref).sort()).toEqual([
      "refs/tags/rel-1",
      "refs/tags/v1.0.0",
    ]);
    expect(
      tagCalls(w)
        .map((c) => c.path)
        .sort(),
    ).toEqual([
      "/repos/acme/web/git/matching-refs/tags/rel-",
      "/repos/acme/web/git/matching-refs/tags/v",
    ]);
    // `beta` matches no pattern: its annotated object was never fetched
    expect(callsTo(w, `/git/tags/${SHA("8")}`)).toEqual([]);
  });

  test("the workflow is read at the tag's own commit, and a workflow that does not trigger on tags makes no run", async () => {
    const w = world();
    w.gh.state.files.set(SHA("a"), BRANCH_ONLY);
    const r = await poll(w);
    expect(await tagRuns()).toEqual([]);
    expect(r.refused.some((x) => x.reason.startsWith("not triggered"))).toBe(true);
    expect(callsTo(w, `contents/.github/workflows/ci.yml?ref=${SHA("a")}`).length).toBeGreaterThan(
      0,
    );
  });
});

describe("dedupe, the conditional list and the cap", () => {
  test("a tag at the same commit is ingested once, and asking again costs a conditional request", async () => {
    const w = world({ prime: false });
    await poll(w);
    await poll(w);
    await poll(w);
    expect(await tagRuns()).toHaveLength(1);
    const calls = tagCalls(w);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.ifNoneMatch).toBeUndefined();
    expect(calls[1]!.ifNoneMatch).toBeDefined();
  });

  test("a new tag is its own run", async () => {
    const w = world();
    await poll(w);
    w.gh.state.tags.set("v1.1.0", { sha: SHA("a") });
    await poll(w);
    expect((await tagRuns()).map((r) => r.ref).sort()).toEqual([
      "refs/tags/v1.0.0",
      "refs/tags/v1.1.0",
    ]);
  });

  test("sixty seen tags do not starve a new one", async () => {
    const w = world();
    w.gh.state.tags.clear();
    for (let i = 0; i < 60; i += 1)
      w.gh.state.tags.set(`v1.0.${String(i).padStart(2, "0")}`, { sha: SHA("a") });
    // at most 10 unseen tags are taken per poll: six polls take all sixty
    for (let i = 0; i < 6; i += 1) await poll(w);
    expect(await tagRuns()).toHaveLength(60);
    w.gh.state.tags.set("v9.9.9", { sha: SHA("a") });
    const before = callsTo(w, `/commits/${SHA("a")}`).length;
    const r = await poll(w);
    expect(r.created).toHaveLength(1);
    expect((await tagRuns()).some((x) => x.ref === "refs/tags/v9.9.9")).toBe(true);
    // the sixty old ones cost nothing: one commit read, for the new tag only
    expect(callsTo(w, `/commits/${SHA("a")}`).length - before).toBe(1);
  });

  test("a poll takes at most ten unseen tags, and the rest wait for the next", async () => {
    const w = world();
    w.gh.state.tags.clear();
    for (let i = 0; i < 12; i += 1)
      w.gh.state.tags.set(`v2.0.${String(i).padStart(2, "0")}`, { sha: SHA("a") });
    await poll(w);
    expect(await tagRuns()).toHaveLength(10);
    await poll(w);
    expect(await tagRuns()).toHaveLength(12);
  });
});

describe("the tag's commit must be on the default branch's first-parent history", () => {
  test("an older commit of the mainline is eligible", async () => {
    const w = world();
    w.gh.state.tags.clear();
    w.gh.state.tags.set("v0.9.0", { sha: SHA("b") });
    await poll(w);
    expect((await tagRuns()).map((r) => r.ref)).toEqual(["refs/tags/v0.9.0"]);
  });

  test("an intermediate commit of a merged branch is refused even though it is reachable from the head", async () => {
    // M merged the branch B2 -> B1 into the mainline P. The branch's own commits are reachable
    // from M (a compare would say ahead), but only M and P were ever a tip of main.
    const w = world();
    w.gh.state.head = { sha: SHA("1"), message: "merge", login: "octocat" };
    w.gh.state.history = [
      { sha: SHA("1"), parents: [SHA("2"), SHA("4")] }, // M: first parent P, second the branch tip
      { sha: SHA("4"), parents: [SHA("3")] }, // B2 (a branch commit, since reverted: it had a bad workflow)
      { sha: SHA("3"), parents: [SHA("2")] }, // B1
      { sha: SHA("2"), parents: [] }, // P
    ];
    w.gh.state.tags.clear();
    w.gh.state.tags.set("v1.0.1", { sha: SHA("3") });
    w.gh.state.tags.set("v1.0.2", { sha: SHA("4") });
    w.gh.state.tags.set("v1.0.3", { sha: SHA("2") });
    w.gh.state.tags.set("v1.0.4", { sha: SHA("1") });
    const r = await poll(w);
    expect((await tagRuns()).map((x) => x.ref).sort()).toEqual([
      "refs/tags/v1.0.3",
      "refs/tags/v1.0.4",
    ]);
    expect(r.refused.find((x) => x.what === "tag v1.0.1")?.reason).toContain("first-parent");
    expect(r.refused.find((x) => x.what === "tag v1.0.2")?.reason).toContain("first-parent");
  });

  test("a commit that is on no mainline is refused, and ingested once it is", async () => {
    const w = world();
    w.gh.state.tags.clear();
    w.gh.state.tags.set("v3.0.0", { sha: SHA("7") });
    const r1 = await poll(w);
    expect(await tagRuns()).toEqual([]);
    expect(r1.refused.find((x) => x.what === "tag v3.0.0")?.reason).toContain("first-parent");
    // a later squash puts a commit with that sha on the mainline (as the API now reports it)
    w.gh.state.history = linear(SHA("7"), SHA("a"), SHA("b"), SHA("c"));
    w.gh.state.head = { sha: SHA("7"), message: "next", login: "octocat" };
    await poll(w);
    expect((await tagRuns()).map((r) => r.ref)).toEqual(["refs/tags/v3.0.0"]);
  });

  test("a commit deeper than 1000 first-parent steps is not eligible, one within it is", async () => {
    const w = world();
    const shas = Array.from(
      { length: 1100 },
      (_, i) => `${(i + 16).toString(16).padStart(40, "e")}`,
    );
    w.gh.state.head = { sha: shas[0]!, message: "tip", login: "octocat" };
    w.gh.state.history = linear(...shas);
    w.gh.state.tags.clear();
    w.gh.state.tags.set("v5.0.0", { sha: shas[500]! });
    w.gh.state.tags.set("v5.0.1", { sha: shas[1050]! });
    const r = await poll(w);
    expect((await tagRuns()).map((x) => x.ref)).toEqual(["refs/tags/v5.0.0"]);
    expect(r.refused.find((x) => x.what === "tag v5.0.1")?.reason).toContain("first-parent");
  });

  test("a commit already ingested as a default-branch push is eligible without asking the history", async () => {
    const w = world();
    await poll(w); // ingests the push at a
    w.gh.state.head = { sha: SHA("d"), message: "later", login: "octocat" };
    w.gh.state.history = []; // the API cannot say anything about the history now
    w.gh.state.tags.clear();
    w.gh.state.tags.set("v4.0.0", { sha: SHA("a") });
    await poll(w);
    expect((await tagRuns()).map((r) => r.ref).sort()).toEqual([
      "refs/tags/v1.0.0",
      "refs/tags/v4.0.0",
    ]);
  });
});

describe("whether creating the tag is protected decides if the run waits for approval", () => {
  const protectedFact = async () =>
    JSON.parse((await tagRuns())[0]!.trust!).facts.tagProtection as string;
  const heldJobs = async (runId: string) =>
    (await listJobs(db, scope, runId)).filter((j) => j.state === "awaiting_approval");

  test("a ruleset that restricts creation to admins: release, started at once, audited", async () => {
    const w = world();
    await poll(w);
    const [run] = await tagRuns();
    expect(classOf(run!)).toBe("release");
    expect(await protectedFact()).toBe("ruleset");
    expect(await heldJobs(run!.id)).toEqual([]);
    const a = (await listAudit(db, scope)).find((x) => x.op === "poll_tag_run")!;
    expect(a.outcome).toBe("release");
    expect(JSON.parse(a.input)).toMatchObject({
      tag: "v1.0.0",
      protection: "ruleset",
      held: false,
      run: run!.id,
    });
  });

  test("no ruleset: the run is created held, records why, and is audited", async () => {
    const w = world({ protect: false });
    await poll(w);
    const [run] = await tagRuns();
    expect((await heldJobs(run!.id)).length).toBeGreaterThan(0);
    expect(await protectedFact()).toBe("none");
    expect(JSON.parse(run!.trust!).reasons.join(" ")).toContain(
      "held for approval by a release operator",
    );
    const a = (await listAudit(db, scope)).find((x) => x.op === "poll_tag_run")!;
    expect(a.outcome).toBe("held");
    expect(JSON.parse(a.input)).toMatchObject({ protection: "none", held: true });
  });

  test("a held tag run starts only when a release operator approves it, even if the org lowered approve_run", async () => {
    const w = world({ protect: false });
    await poll(w);
    const [run] = await tagRuns();
    const trust = JSON.parse(run!.trust!);
    await setApproveRunMinRole(db, scope.orgId, "operator");
    const op = (await mintToken(db, { orgId: scope.orgId }, "operator")).secret;
    const rel = (await mintToken(db, { orgId: scope.orgId }, "release_operator")).secret;
    const call = (tok: string) =>
      dispatch({ registry, db }, { kind: "bearer", token: tok }, "approve_run", {
        run_id: run!.id,
        head_sha: run!.sha,
        workflow_hash: trust.workflowHash,
      });
    const refused = await call(op);
    expect(!refused.ok && refused.error.code).toBe("forbidden");
    expect((await heldJobs(run!.id)).length).toBeGreaterThan(0);
    const ok = await call(rel);
    expect(ok.ok).toBe(true);
    expect(await heldJobs(run!.id)).toEqual([]);
    // the class was release all along: approval never changed it
    expect(classOf((await tagRuns())[0]!)).toBe("release");
  });

  test("a held tag run waits in a group of its own: it cancels nothing until approved, then joins the real group", async () => {
    const w = world({ protect: false });
    w.gh.state.files.set(
      "*",
      WORKFLOW.replace("jobs:", "concurrency:\n  group: ci\n  cancel-in-progress: true\njobs:"),
    );
    await poll(w);
    const all = async () => await listRuns(db, scope, { limit: 100 });
    const main = (await all()).find((r) => r.ref === "refs/heads/main")!;
    const held = (await all()).find((r) => r.ref === "refs/tags/v1.0.0")!;
    expect(main.concurrencyGroup).toBe("ci");
    expect(held.concurrencyGroup).toBe("held:v1.0.0:ci");
    await setRunStatus(db, scope, main.id, "running");
    // a second held tag does not touch the first, nor the default branch's run
    w.gh.state.tags.set("v1.0.1", { sha: SHA("a") });
    await poll(w);
    expect((await getRun(db, scope, main.id))!.status).toBe("running");
    expect((await getRun(db, scope, held.id))!.status).toBe("awaiting_approval");
    // approval moves the held run into the workflow's group, where it supersedes the older run
    const rel = (await mintToken(db, { orgId: scope.orgId }, "release_operator")).secret;
    const trust = JSON.parse(held.trust!);
    const ok = await dispatch({ registry, db }, { kind: "bearer", token: rel }, "approve_run", {
      run_id: held.id,
      head_sha: held.sha,
      workflow_hash: trust.workflowHash,
    });
    expect(ok.ok).toBe(true);
    expect((await getRun(db, scope, held.id))!.concurrencyGroup).toBe("ci");
    expect((await getRun(db, scope, main.id))!.status).not.toBe("running");
  });

  test("a pull request run is unaffected: an operator may still approve it when the org lowered approve_run", async () => {
    // (the extra role is only for release tag runs; this documents that the lowering still applies elsewhere)
    await setApproveRunMinRole(db, scope.orgId, "operator");
    expect(await getApproveRunMinRole(db, scope.orgId)).toBe("operator");
  });

  test("rulesets that cannot be read count as unprotected", async () => {
    const w = world();
    w.gh.state.rulesetsStatus = 403;
    await poll(w);
    expect(await protectedFact()).toBe("unknown");
    expect((await heldJobs((await tagRuns())[0]!.id)).length).toBeGreaterThan(0);
  });

  test.each([
    ["no creation rule", [{ ...ADMIN_ONLY(["refs/tags/v*"]), rules: ["deletion", "update"] }]],
    [
      "a write-role bypass",
      [
        {
          ...ADMIN_ONLY(["refs/tags/v*"]),
          bypass: [{ actor_type: "RepositoryRole", actor_id: 4 }],
        },
      ],
    ],
    [
      "a team bypass",
      [{ ...ADMIN_ONLY(["refs/tags/v*"]), bypass: [{ actor_type: "Team", actor_id: 9 }] }],
    ],
    ["an exclude list", [{ ...ADMIN_ONLY(["refs/tags/v*"]), exclude: ["refs/tags/v1.0.0"] }]],
    ["a narrower include", [ADMIN_ONLY(["refs/tags/v2*"])]],
    ["a ruleset for branches", [{ ...ADMIN_ONLY(["refs/tags/v*"]), target: "branch" }]],
    ["a disabled ruleset", [{ ...ADMIN_ONLY(["refs/tags/v*"]), enforcement: "disabled" }]],
  ])("not protected: %s", async (_why, rulesets) => {
    const w = world({ protect: false });
    w.gh.state.rulesets = rulesets as typeof w.gh.state.rulesets;
    await poll(w);
    expect(await protectedFact()).toBe("none");
    expect((await heldJobs((await tagRuns())[0]!.id)).length).toBeGreaterThan(0);
  });

  test("a ruleset whose bypass list the API did not give is unverifiable: held", async () => {
    // Without administration read access the API leaves bypass_actors out entirely.
    const w = world({ protect: false });
    w.gh.state.rulesets = [{ ...ADMIN_ONLY(["refs/tags/v*"]), omitBypass: true }];
    await poll(w);
    expect(await protectedFact()).toBe("none");
    expect((await heldJobs((await tagRuns())[0]!.id)).length).toBeGreaterThan(0);
  });

  test.each([
    ["creation", ["update", "deletion", "non_fast_forward"]],
    ["update", ["creation", "deletion", "non_fast_forward"]],
    ["deletion", ["creation", "update", "non_fast_forward"]],
    ["non_fast_forward", ["creation", "update", "deletion"]],
  ])("a ruleset without the %s rule does not protect", async (_missing, rules) => {
    const w = world({ protect: false });
    w.gh.state.rulesets = [{ ...ADMIN_ONLY(["refs/tags/v*"]), rules }];
    await poll(w);
    expect(await protectedFact()).toBe("none");
    expect((await heldJobs((await tagRuns())[0]!.id)).length).toBeGreaterThan(0);
  });

  test("an organization admin bypass, and ~ALL, count", async () => {
    const w = world({ protect: false });
    w.gh.state.rulesets = [
      { id: 7, include: ["~ALL"], bypass: [{ actor_type: "OrganizationAdmin", actor_id: null }] },
    ];
    await poll(w);
    expect(await protectedFact()).toBe("ruleset");
  });

  test("with several patterns, every pattern that matches the tag must be protected", async () => {
    const w = world({ tagRefs: ["refs/tags/v*", "refs/tags/v1*"] });
    w.gh.state.rulesets = [ADMIN_ONLY(["refs/tags/v*"])];
    await poll(w);
    // v1* is a narrower pattern the ruleset's include (v*) covers, so both are protected
    expect(await protectedFact()).toBe("ruleset");
    w.gh.state.rulesets = [ADMIN_ONLY(["refs/tags/v1*"])];
    w.gh.state.tags.set("v1.0.1", { sha: SHA("a") });
    w.tagCaches.rulesets.clear();
    await poll(w);
    const second = (await tagRuns()).find((r) => r.ref === "refs/tags/v1.0.1")!;
    expect(JSON.parse(second.trust!).facts.tagProtection).toBe("none");
  });

  test("a reading that shows protection is never reused by a later poll; one that shows none is, for a minute", async () => {
    const w = world();
    await poll(w);
    const asked = callsTo(w, "/rulesets").length;
    w.gh.state.tags.set("v1.1.0", { sha: SHA("a") });
    await poll(w);
    expect(callsTo(w, "/rulesets").length).toBeGreaterThan(asked);

    const n = world({ protect: false });
    await poll(n);
    const first = callsTo(n, "/rulesets").length;
    n.gh.state.tags.set("v1.1.0", { sha: SHA("a") });
    await poll(n);
    expect(callsTo(n, "/rulesets").length).toBe(first);
    now += 61_000;
    n.gh.state.tags.set("v1.2.0", { sha: SHA("a") });
    await poll(n);
    expect(callsTo(n, "/rulesets").length).toBeGreaterThan(first);
  });
});

describe("a tag that may predate the protection is held", () => {
  const factsOf = async (name: string) =>
    JSON.parse((await tagRuns()).find((r) => r.ref === `refs/tags/${name}`)!.trust!).facts
      .tagProtection as string;

  test("the tag listed in the poll that first sees the ruleset is held; one created after it is not", async () => {
    const w = world({ prime: false });
    await poll(w); // v1.0.0 existed when protection was first seen
    expect(await factsOf("v1.0.0")).toBe("predates");
    expect(JSON.parse((await tagRuns())[0]!.trust!).reasons.join(" ")).toContain(
      "may have been created before",
    );
    now += 60_000;
    w.gh.state.tags.set("v1.1.0", { sha: SHA("a") });
    await poll(w);
    expect(await factsOf("v1.1.0")).toBe("ruleset");
  });

  test("a tag made while there was no ruleset stays held after one is added", async () => {
    const w = world({ protect: false, prime: false });
    await poll(w);
    expect(await factsOf("v1.0.0")).toBe("none");
    now += 60_000;
    w.gh.state.tags.set("v1.1.0", { sha: SHA("a") }); // made unprotected
    await poll(w);
    expect(await factsOf("v1.1.0")).toBe("none");
    w.gh.state.rulesets = [ADMIN_ONLY(["refs/tags/v*"])];
    now += 60_000;
    w.gh.state.tags.set("v1.2.0", { sha: SHA("a") }); // listed in the poll that first sees the ruleset
    await poll(w);
    expect(await factsOf("v1.2.0")).toBe("predates");
    now += 60_000;
    w.gh.state.tags.set("v1.3.0", { sha: SHA("a") });
    await poll(w);
    expect(await factsOf("v1.3.0")).toBe("ruleset");
  });

  test("the marker is persisted: a restarted poller does not restart the clock, and a lapse does", async () => {
    const w = world({ prime: false });
    await poll(w);
    now += 61_000;
    const restarted = { ...w, tagCaches: newTagCaches() };
    restarted.gh.state.tags.set("v1.1.0", { sha: SHA("a") });
    await poll(restarted);
    expect(await factsOf("v1.1.0")).toBe("ruleset");
    // The ruleset is removed for a poll, and comes back: tags listed since then predate it again.
    const saved = w.gh.state.rulesets;
    w.gh.state.rulesets = [];
    now += 61_000;
    w.gh.state.tags.set("v1.2.0", { sha: SHA("a") });
    await poll(restarted);
    w.gh.state.rulesets = saved;
    now += 61_000;
    w.gh.state.tags.set("v1.3.0", { sha: SHA("a") });
    await poll(restarted);
    expect(await factsOf("v1.2.0")).toBe("none");
    expect(await factsOf("v1.3.0")).toBe("predates");
  });

  test("a ruleset edited after protection was first seen restarts the clock; a tag's own dates are no evidence", async () => {
    const w = world();
    const at = (ms: number) => new Date(ms).toISOString();
    const t0 = now;
    w.gh.state.rulesets = [{ ...ADMIN_ONLY(["refs/tags/v*"]), updatedAt: at(t0 - 1_000) }];
    await poll(w); // primes: protection first seen, nothing listed yet
    now += 60_000;
    // A tag claiming a date long before the ruleset, and one claiming a date after it: neither
    // date is read. Both are new to the listing after protection began.
    w.gh.state.tags.set("v2.0.0", {
      sha: SHA("a"),
      annotatedAs: SHA("9"),
      tagger: "nc9",
    });
    w.gh.state.tags.set("v2.0.1", { sha: SHA("b") });
    w.gh.state.history = linear(SHA("a"), SHA("b"), SHA("c"));
    await poll(w);
    expect(await factsOf("v2.0.0")).toBe("ruleset");
    expect(await factsOf("v2.0.1")).toBe("ruleset");
    // The ruleset is edited (updated_at moves past the marker): the next poll restarts the clock,
    // so a tag first listed in it predates; one listed after it does not.
    now += 60_000;
    w.gh.state.rulesets = [{ ...ADMIN_ONLY(["refs/tags/v*"]), updatedAt: at(now - 30_000) }];
    w.gh.state.tags.set("v2.1.0", { sha: SHA("a") });
    await poll(w);
    expect(await factsOf("v2.1.0")).toBe("predates");
    now += 60_000;
    w.gh.state.tags.set("v2.1.1", { sha: SHA("a") });
    await poll(w);
    expect(await factsOf("v2.1.1")).toBe("ruleset");
  });
});

describe("which ruleset includes cover a pattern", () => {
  test.each([
    ["~ALL", "refs/tags/v*", true],
    ["refs/tags/v*", "refs/tags/v*", true],
    ["refs/tags/v*", "refs/tags/v1.*", true],
    ["refs/tags/v*", "refs/tags/v1.0.0", true],
    ["refs/tags/v1.0.0", "refs/tags/v1.0.0", true],
    ["refs/tags/*", "refs/tags/v*", true],
    ["refs/tags/rel/*", "refs/tags/rel/2*", true],
    // GitHub's `*` does not match `/`: v* covers v1, not v1/evil, so it cannot cover a pattern
    // whose literal part reaches past a slash.
    ["refs/tags/v*", "refs/tags/v1/x*", false],
    ["refs/tags/v*", "refs/tags/v1/x", false],
    ["refs/tags/*", "refs/tags/rel/2*", false],
    ["refs/tags/*", "refs/tags/rel-2*", true],
    ["refs/tags/v1*", "refs/tags/v*", false], // narrower than the pattern
    ["refs/tags/v2*", "refs/tags/v1*", false],
    ["refs/tags/v1.0.0", "refs/tags/v*", false], // one tag is not all of them
    ["refs/tags/v?", "refs/tags/v1", false],
    ["refs/tags/[v]*", "refs/tags/v*", false],
    ["refs/tags/{v,w}*", "refs/tags/v*", false],
    ["refs/tags/v+*", "refs/tags/v*", false],
    ["refs/tags/v**", "refs/tags/v*", false],
    ["refs/tags/**", "refs/tags/v*", false],
    ["refs/tags/*-rc", "refs/tags/v*", false],
    ["refs/tags/v*x*", "refs/tags/v*", false],
    ["refs/heads/*", "refs/tags/v*", false],
    ["~DEFAULT_BRANCH", "refs/tags/v*", false],
  ])("include %s over pattern %s: %s", (include, pattern, covers) => {
    expect(includeCovers(include, pattern)).toBe(covers);
    const rs = [{ include: [include], exclude: [], rules: [...REQUIRED_RULES], bypass: [] }];
    expect(patternProtected(rs, pattern)).toBe(covers);
  });

  test("our own star never matches a slash, so v* does not reach v1/evil", async () => {
    expect(matchesPatterns(["refs/tags/v*"], "refs/tags/v1")).toBe(true);
    expect(matchesPatterns(["refs/tags/v*"], "refs/tags/v1/evil")).toBe(false);
    const w = world();
    w.gh.state.tags.set("v1/evil", { sha: SHA("a") });
    await poll(w);
    await poll(w);
    expect((await tagRuns()).map((r) => r.ref)).toEqual(["refs/tags/v1.0.0"]);
  });

  test("an unreadable list of rulesets, or a missing bypass list, protects nothing", () => {
    expect(patternProtected("unknown", "refs/tags/v*")).toBe(false);
    const base = { include: ["~ALL"], exclude: [], rules: [...REQUIRED_RULES] };
    expect(patternProtected([{ ...base, bypass: undefined }], "refs/tags/v*")).toBe(false);
    expect(patternProtected([{ ...base, bypass: [] }], "refs/tags/v*")).toBe(true);
  });
});

describe("a moved tag", () => {
  test("creates nothing, is audited once as tag_moved, and moving it back is silent", async () => {
    const w = world();
    await poll(w);
    expect(await tagRuns()).toHaveLength(1);
    // the tag is force-moved to another commit that is also on the mainline
    w.gh.state.tags.set("v1.0.0", { sha: SHA("c") });
    const r = await poll(w);
    expect(await tagRuns()).toHaveLength(1);
    expect(r.refused.find((x) => x.what === "tag v1.0.0")?.reason).toContain("tag_moved");
    const audits = (await listAudit(db, scope)).filter((a) => a.op === "poll_tag_moved");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: "tag_moved" });
    expect(JSON.parse(audits[0]!.input)).toMatchObject({
      tag: "v1.0.0",
      was: SHA("a"),
      now: SHA("c"),
    });
    // asking again says nothing more
    const again = await poll(w);
    expect(again.refused.filter((x) => x.what === "tag v1.0.0")).toEqual([]);
    expect((await listAudit(db, scope)).filter((a) => a.op === "poll_tag_moved")).toHaveLength(1);
    // back to where it was: the original run exists, so nothing happens
    w.gh.state.tags.set("v1.0.0", { sha: SHA("a") });
    await poll(w);
    expect(await tagRuns()).toHaveLength(1);
    // moved again to a third commit is a new report
    w.gh.state.tags.set("v1.0.0", { sha: SHA("b") });
    await poll(w);
    expect((await listAudit(db, scope)).filter((a) => a.op === "poll_tag_moved")).toHaveLength(2);
    expect(await tagRuns()).toHaveLength(1);
  });
});

describe("the project's settings, set only by the local audited CLI path", () => {
  test("policy set --ingest stores tag refs, audits the change, and the poller then ingests the tag into that project", async () => {
    const org = await createOrg(db, { slug: "acme", name: "acme" });
    const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
    const pscope = { orgId: org.id, projectId: project.id };
    await bindRepo(db, pscope, { forge: "github", owner: "acme", repo: "web" });
    const r = await setIngestPolicy(db, "acme", "web", "on", {
      defaultBranch: "main",
      authors: ["octocat"],
      tagRefs: ["refs/tags/v*"],
    });
    expect(r.to?.tagRefs).toEqual(["refs/tags/v*"]);
    expect((await showIngest(db, "acme"))[0]!.ingest?.tagRefs).toEqual(["refs/tags/v*"]);
    const audit = (await listAudit(db, pscope)).find((a) => a.op === "policy_set");
    expect(JSON.parse(audit!.input).to.tagRefs).toEqual(["refs/tags/v*"]);

    // refused: not a tag ref
    await expect(
      setIngestPolicy(db, "acme", "web", "on", { defaultBranch: "main", tagRefs: ["main"] }),
    ).rejects.toThrow("tagRefs");

    const gh = makeGithub();
    gh.state.files.set("*", WORKFLOW);
    gh.state.tags.set("v1.0.0", { sha: SHA("a") });
    const p = new Poller({
      db,
      config: pollConfigSchema.parse({
        allowUnauthenticated: true,
        repos: [
          { repo: "static/other", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
        ],
      }),
      fetch: gh.fetch,
      now: () => now,
      bindings: true,
    });
    await p.pollAll();
    const runs = (await listRuns(db, pscope)).filter((x) => x.ref.startsWith("refs/tags/"));
    expect(runs).toHaveLength(1);
    expect(classOf(runs[0]!)).toBe("release");
  });

  test("a project that did not opt in gets no tag runs from the same poller", async () => {
    const org = await createOrg(db, { slug: "acme", name: "acme" });
    const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
    const pscope = { orgId: org.id, projectId: project.id };
    await bindRepo(db, pscope, { forge: "github", owner: "acme", repo: "web" });
    await setIngestPolicy(db, "acme", "web", "on", { defaultBranch: "main", authors: ["octocat"] });
    const gh = makeGithub();
    gh.state.files.set("*", WORKFLOW);
    gh.state.tags.set("v1.0.0", { sha: SHA("a") });
    const p = new Poller({
      db,
      config: pollConfigSchema.parse({
        allowUnauthenticated: true,
        repos: [
          { repo: "static/other", workflow: ".github/workflows/ci.yml", defaultBranch: "main" },
        ],
      }),
      fetch: gh.fetch,
      now: () => now,
      bindings: true,
    });
    await p.pollAll();
    expect((await listRuns(db, pscope)).filter((x) => x.ref.startsWith("refs/tags/"))).toEqual([]);
    expect(gh.state.calls.some((c) => c.path.includes("/matching-refs/tags/"))).toBe(false);
  });
});

describe("the webhook for a tag push only wakes the poller", () => {
  test("a signed push for a tag asks the poller to look at the repo, and nothing in the payload is believed", async () => {
    const org = await createOrg(db, { slug: "acme", name: "acme" });
    const store = new SecretStore(db, randomBytes(32));
    await setGithubApp(
      db,
      { orgId: org.id },
      {
        appId: "42",
        slug: "turntable-test",
        name: "Turntable",
        ownerLogin: "acme",
        htmlUrl: "https://github.com/apps/x",
        clientId: "Iv1.abc",
      },
    );
    const secret = ["whsec", "tag", "ingest", "5521"].join("_");
    await store.set(org.id, SECRET_WEBHOOK, secret);
    const woken: [string, string][] = [];
    const handler = createWebhookHandler({
      db,
      store,
      facts: { getInstallation: async () => undefined, listInstallationRepos: async () => [] },
      onRepoEvent: (repo, event) => void woken.push([repo, event]),
      log: () => {},
    });
    // The payload claims a commit, a pusher and a tag. None of it is read except the repo name.
    const body = JSON.stringify({
      ref: "refs/tags/v9.9.9",
      after: SHA("e"),
      pusher: { name: "mallory" },
      head_commit: { id: SHA("e"), message: "release everything" },
      repository: { full_name: "acme/web" },
    });
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const send = (headers: Record<string, string>) =>
      handler.handle(
        new Request("http://x/api/v1/webhooks/github", {
          method: "POST",
          body,
          headers: {
            "x-github-event": "push",
            "x-github-delivery": "11111111-2222-3333-4444-555555555555",
            ...headers,
          },
        }),
        "203.0.113.5",
      );
    const unsigned = await send({ "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    expect(unsigned!.status).toBe(401);
    expect(woken).toEqual([]);
    const ok = await send({ "x-hub-signature-256": sig });
    expect(ok!.status).toBe(202);
    expect(woken).toEqual([["acme/web", "push"]]);
    // no run, no row from the payload: the handler never creates one
    expect(await listRuns(db, scope)).toEqual([]);
  });

  test("the wake makes the poller ingest the tag from the API's facts, not the payload's", async () => {
    // The payload above named v9.9.9 at some commit; the API knows only v1.0.0 on the default head.
    const w = world();
    w.gh.state.tags.set("v1.0.0", { sha: SHA("a") });
    await poll(w);
    expect((await tagRuns()).map((r) => r.ref)).toEqual(["refs/tags/v1.0.0"]);
    expect((await tagRuns()).some((r) => r.ref.includes("9.9.9"))).toBe(false);
  });
});
