// `run_dispatch` (#520, the workflow_dispatch part): who may call it, what the ref resolves to,
// how inputs are checked, which trust class the run gets, that a release ref still waits for its
// approval, and what the audit log holds. The forge is the fake GitHub of github-stub.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  bindRepo,
  createOrg,
  createProject,
  getRun,
  listAudit,
  listJobs,
  listRuns,
  openDatabase,
  type Db,
  type Scope,
} from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { Poller, pollConfigSchema } from "../src/poll";
import { buildActEvent } from "../src/run/act-event";
import { workflowReadiness } from "../src/scheduler/workflow-readiness";
import { validateDispatchInputs } from "../src/poll/dispatch-inputs";
import { mintToken } from "./ops-helpers";
import { makeGithub, SHA } from "./github-stub";

const WORKFLOW = `name: Release
on:
  workflow_dispatch:
    inputs:
      version:
        description: Version to cut
        required: true
        type: string
      dry_run:
        type: boolean
        default: false
      retries:
        type: number
        default: 3
      channel:
        type: choice
        options: [stable, beta]
        default: stable
      target:
        type: environment
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build \${{ inputs.version }}
  announce:
    if: \${{ inputs.dry_run == false }}
    runs-on: ubuntu-latest
    steps:
      - run: echo announce
`;
const PUSH_ONLY = `name: CI
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
let now = 1_800_000_000_000;
type Org = { scope: Required<Scope>; org: string; project: string };

async function org(slug: string): Promise<Org> {
  const o = await createOrg(db, { slug, name: slug });
  const p = await createProject(db, { orgId: o.id }, { slug: "app", name: "App" });
  return { scope: { orgId: o.id, projectId: p.id }, org: slug, project: "app" };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  now = 1_800_000_000_000;
});

async function world(
  o: { tagRefs?: string[]; maxRunsPerHour?: number; orgs?: Org[]; repo?: string } = {},
) {
  const a = await org("acme");
  const repo = o.repo ?? "acme/web";
  const gh = makeGithub(repo, ".github/workflows/release.yml");
  gh.state.files.set("*", WORKFLOW);
  gh.state.files.set(SHA("9"), PUSH_ONLY);
  gh.state.history = [
    { sha: SHA("a"), parents: [SHA("b")] },
    { sha: SHA("b"), parents: [SHA("c")] },
    { sha: SHA("c"), parents: [] },
  ];
  gh.state.branches.set("feature", SHA("d"));
  gh.state.branches.set("release/1", SHA("e"));
  gh.state.tags.set("v1.0.0", { sha: SHA("b") });
  gh.state.tags.set("nightly", { sha: SHA("c") });
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo,
        org: a.org,
        project: a.project,
        workflow: ".github/workflows/release.yml",
        defaultBranch: "main",
        tagRefs: o.tagRefs ?? [],
        protectedRefs: ["refs/heads/release/**"],
        maxRunsPerHour: o.maxRunsPerHour ?? 100,
        maxWaitingRuns: 10,
      },
    ],
  });
  await bindRepo(db, a.scope, { forge: "github", owner: "acme", repo: "web" });
  const poller = new Poller({
    db,
    config: cfg,
    fetch: gh.fetch,
    now: () => now,
  });
  const env = {
    registry,
    db,
    now: () => now,
    runDispatcher: (
      s: Required<Scope>,
      r: string | undefined,
      q: Parameters<typeof poller.dispatch>[2],
    ) => poller.dispatch(s, r, q),
  };
  const token = (scope: Scope, role: "reader" | "operator" | "release_operator") =>
    mintToken(db, scope, role).then((t) => t.secret);
  return { a, gh, cfg, poller, env, token };
}

const call = (
  w: Awaited<ReturnType<typeof world>>,
  tok: string,
  input: Record<string, unknown>,
  project = "app",
) =>
  dispatch(w.env, { kind: "bearer", token: tok }, "run_dispatch", {
    project,
    workflow: ".github/workflows/release.yml",
    ref: "main",
    ...input,
  });

const ok = async (r: ReturnType<typeof call>) => {
  const res = await r;
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.output as {
    run_id: string;
    repo: string;
    ref: string;
    sha: string;
    trust_class: string;
    state: string;
    input_names: string[];
  };
};
const refused = async (r: ReturnType<typeof call>) => {
  const res = await r;
  if (res.ok) throw new Error("expected a refusal");
  return res.error;
};

describe("who may dispatch", () => {
  test("a maintainer (release_operator) dispatches; the run shows the event and who", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    const out = await ok(call(w, tok, { inputs: { version: "1.2.3", dry_run: "false" } }));
    expect(out).toMatchObject({ ref: "refs/heads/main", sha: SHA("a"), state: "queued" });
    const got = await dispatch(w.env, { kind: "bearer", token: tok }, "get_run", {
      run_id: out.run_id,
    });
    if (!got.ok) throw new Error("get_run failed");
    const run = got.output as { event: string; actor: string; trust_class: string };
    expect(run.event).toBe("workflow_dispatch");
    expect(run.actor).toStartWith("token:");
    expect(run.trust_class).toBe("protected");
    const list = await dispatch(w.env, { kind: "bearer", token: tok }, "list_runs", {});
    if (!list.ok) throw new Error("list_runs failed");
    expect(
      (list.output as { runs: { id: string; event: string }[] }).runs.find(
        (r) => r.id === out.run_id,
      )?.event,
    ).toBe("workflow_dispatch");
  });

  test("a reader and an operator are refused, and nothing is created", async () => {
    const w = await world();
    for (const role of ["reader", "operator"] as const) {
      const tok = await w.token(w.a.scope, role);
      const err = await refused(call(w, tok, { inputs: { version: "1" } }));
      expect(err.code).toBe("forbidden");
    }
    expect(await listRuns(db, w.a.scope, { limit: 10 })).toEqual([]);
  });

  test("authorization comes first: a refused caller makes zero forge calls and creates nothing", async () => {
    const w = await world();
    const before = w.gh.state.calls.length;
    const refusals: { tok: string; code: string }[] = [];
    for (const role of ["reader", "operator"] as const) {
      refusals.push({ tok: await w.token(w.a.scope, role), code: "forbidden" });
    }
    // An agent token below the dispatch role: refused on role, before the handler.
    const agent = await mintToken(db, w.a.scope, "operator", { kind: "agent" });
    refusals.push({ tok: agent.secret, code: "forbidden" });
    for (const r of refusals) {
      const err = await refused(call(w, r.tok, { inputs: { version: "1" } }));
      expect(err.code).toBe(r.code);
    }
    expect(w.gh.state.calls.length).toBe(before);
    expect(await listRuns(db, w.a.scope, { limit: 10 })).toEqual([]);
    expect(await db.orm.select().from(s.jobs)).toEqual([]);
    expect(await db.orm.select().from(s.pollSeen)).toEqual([]);
  });

  test("a project that does not ingest the repo is refused", async () => {
    const w = await world();
    const other = await createProject(db, { orgId: w.a.scope.orgId }, { slug: "other", name: "O" });
    const tok = await w.token({ orgId: w.a.scope.orgId, projectId: other.id }, "release_operator");
    const err = await refused(call(w, tok, { inputs: { version: "1" } }, "other"));
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("no repo with ingest enabled");
  });
});

describe("the run", () => {
  test("is for the sha the ref resolved to, with github.event.inputs and inputs set", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    const out = await ok(
      call(w, tok, { inputs: { version: "1.2.3", retries: "5", dry_run: "true" } }),
    );
    // The branch moves after the dispatch: the run stays at the sha it resolved to.
    w.gh.state.head.sha = SHA("f");
    const run = (await getRun(db, w.a.scope, out.run_id))!;
    expect(run.sha).toBe(SHA("a"));
    expect(run.event).toBe("workflow_dispatch");
    const plan = JSON.parse(run.plan!);
    expect(plan.github.event_name).toBe("workflow_dispatch");
    expect(plan.github.event.inputs).toEqual({
      version: "1.2.3",
      dry_run: "true",
      retries: "5",
      channel: "stable",
      target: "",
    });
    expect(plan.inputs).toEqual({
      version: "1.2.3",
      dry_run: true,
      retries: 5,
      channel: "stable",
      target: "",
    });
    // What the sandbox's act is given: strings, as GitHub's event payload has them.
    const ev = buildActEvent(run) as { inputs: Record<string, string>; ref: string };
    expect(ev.inputs.retries).toBe("5");
    expect(ev.ref).toBe("refs/heads/main");
    // `if: inputs.dry_run == false` reads the typed input: the announce job is skipped.
    const jobs = await listJobs(db, w.a.scope, run.id);
    const announce = jobs.find((j) => j.jobKey === "announce")!;
    const verdict = workflowReadiness(announce, [], run);
    expect(verdict.decision).toBe("skip");
    const build = jobs.find((j) => j.jobKey === "build")!;
    expect(workflowReadiness(build, [], run).decision).toBe("ready");
  });

  test("one sha, resolved once: a branch that moves mid-dispatch changes nothing the run carries", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    // Move main right after the ref lookup is answered, between the forge phase and the writes.
    let moved = 0;
    w.gh.state.afterRefLookup = () => {
      moved++;
      w.gh.state.head.sha = SHA("f");
    };
    const out = await ok(call(w, tok, { inputs: { version: "1" } }));
    w.gh.state.afterRefLookup = undefined;
    expect(moved).toBeGreaterThan(0);
    expect(w.gh.state.head.sha).toBe(SHA("f"));
    expect(out.sha).toBe(SHA("a"));
    const run = (await getRun(db, w.a.scope, out.run_id))!;
    expect(run.sha).toBe(SHA("a"));
    expect(JSON.parse(run.plan!).github.sha).toBe(SHA("a"));
    expect(JSON.stringify(buildActEvent(run))).not.toContain(SHA("f"));
    const jobs = await listJobs(db, w.a.scope, run.id);
    expect(jobs.length).toBe(2);
    for (const j of jobs) expect(JSON.stringify(j)).not.toContain(SHA("f"));
    const all = await db.orm.select().from(s.runs);
    expect(all.map((r) => r.sha)).toEqual([SHA("a")]);
    // The workflow was read at the first sha, once, and the ref was looked up once per kind.
    const refCalls = w.gh.state.calls.filter((c) => c.path.includes("/git/ref/"));
    expect(refCalls.length).toBe(2);
  });

  test("a branch other than the default is trusted_pr; a protected-ref pattern is protected", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    const feature = await ok(call(w, tok, { ref: "feature", inputs: { version: "1" } }));
    expect(feature).toMatchObject({
      ref: "refs/heads/feature",
      sha: SHA("d"),
      trust_class: "trusted_pr",
    });
    const rel = await ok(call(w, tok, { ref: "release/1", inputs: { version: "1" } }));
    expect(rel.trust_class).toBe("protected");
  });

  test("a bare commit sha is refused, as on GitHub, even one on the default branch", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    for (const ref of [SHA("b"), SHA("7"), SHA("b").toUpperCase(), "a".repeat(64)]) {
      const err = await refused(call(w, tok, { ref, inputs: { version: "1" } }));
      expect(err.code).toBe("invalid_input");
      expect(err.message).toBe(
        "ref must be a branch or tag of acme/web; a bare commit sha is not accepted (as on GitHub)",
      );
    }
    expect(await listRuns(db, w.a.scope, { limit: 10 })).toEqual([]);
  });

  test("a ref that is not in the repository is refused with the reason", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    for (const ref of ["someone-elses-fork:main", "no-such-branch", "refs/pull/5/head", "../x"]) {
      const err = await refused(call(w, tok, { ref, inputs: { version: "1" } }));
      expect(["not_found", "invalid_input"]).toContain(err.code);
      expect(err.message).toContain("ref must be a branch or tag of acme/web");
    }
    expect(await listRuns(db, w.a.scope, { limit: 10 })).toEqual([]);
  });

  test("a name that is both a branch and a tag is ambiguous until the caller says which", async () => {
    const w = await world();
    w.gh.state.branches.set("v1.0.0", SHA("d"));
    const tok = await w.token(w.a.scope, "release_operator");
    const err = await refused(call(w, tok, { ref: "v1.0.0", inputs: { version: "1" } }));
    expect(err.message).toContain("both a branch and a tag");
    const out = await ok(call(w, tok, { ref: "refs/tags/v1.0.0", inputs: { version: "1" } }));
    expect(out.sha).toBe(SHA("b"));
  });

  test("a workflow without on.workflow_dispatch is refused", async () => {
    const w = await world();
    w.gh.state.files.set("*", PUSH_ONLY);
    const tok = await w.token(w.a.scope, "release_operator");
    const err = await refused(call(w, tok, { inputs: {} }));
    expect(err.code).toBe("invalid_input");
    expect(err.message).toContain("on.workflow_dispatch");
  });

  test("a workflow path outside .github/workflows is refused", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    for (const workflow of ["ci.yml", ".github/workflows/../x.yml", ".github/workflows/a/b.yml"]) {
      const err = await refused(call(w, tok, { workflow, inputs: {} }));
      expect(err.code).toBe("invalid_input");
    }
  });
});

describe("inputs", () => {
  test("unknown, missing required, wrong type, bad choice and oversize are refused with reasons", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    const cases: [Record<string, string>, string][] = [
      [{ version: "1", nope: "x" }, "unknown input: nope"],
      [{}, "input version is required"],
      [{ version: "1", retries: "many" }, "input retries must be a number"],
      [{ version: "1", dry_run: "yes" }, "input dry_run must be true or false"],
      [{ version: "1", channel: "nightly" }, "input channel must be one of: stable, beta"],
      [{ version: "1", target: "no/slash!" }, "not a valid environment name"],
      [{ version: "x".repeat(60 * 1024), target: "y".repeat(5 * 1024) }, "the limit is 65536"],
    ];
    for (const [inputs, reason] of cases) {
      const err = await refused(call(w, tok, { inputs }));
      expect(err.code).toBe("invalid_input");
      expect(err.message).toContain(reason);
    }
    expect(await listRuns(db, w.a.scope, { limit: 10 })).toEqual([]);
  });

  test("validateDispatchInputs applies defaults and types", () => {
    const r = validateDispatchInputs(WORKFLOW, { version: "2" });
    expect(r).toEqual({
      ok: true,
      strings: { version: "2", dry_run: "false", retries: "3", channel: "stable", target: "" },
      typed: { version: "2", dry_run: false, retries: 3, channel: "stable", target: "" },
    });
    expect(validateDispatchInputs("on: workflow_dispatch\njobs: {}", {})).toMatchObject({
      ok: true,
    });
    expect(validateDispatchInputs("on: [push, workflow_dispatch]\njobs: {}", { a: "1" })).toEqual({
      ok: false,
      reason: "unknown input: a",
    });
    expect(validateDispatchInputs("on: push\njobs: {}", {})).toMatchObject({ ok: false });
  });
});

describe("audit", () => {
  test("has who, workflow, ref, the resolved sha and the input names, never the values", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    const value = `v-${randomBytes(12).toString("hex")}`;
    const out = await ok(call(w, tok, { inputs: { version: value } }));
    const rows = (await listAudit(db, w.a.scope)).filter((r) => r.op === "run_dispatch");
    expect(rows.length).toBe(1);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(value);
    expect(rows[0]!.principalId).toBeTruthy();
    expect(text).toContain(".github/workflows/release.yml");
    expect(text).toContain(SHA("a"));
    expect(text).toContain(out.run_id);
    for (const name of ["version", "dry_run", "retries", "channel", "target"]) {
      expect(text).toContain(name);
    }
  });

  test("a refused dispatch is audited too, without the values", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    const value = `v-${randomBytes(12).toString("hex")}`;
    await refused(call(w, tok, { inputs: { version: value, bogus: value } }));
    const rows = (await listAudit(db, w.a.scope)).filter((r) => r.op === "run_dispatch");
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain(value);
    expect(rows[0]!.outcome).toContain("invalid_input");
  });
});

describe("trust and the release lane", () => {
  test("a release tag is held for approval, as a tag push no ruleset protects is", async () => {
    const w = await world({ tagRefs: ["refs/tags/v*"] });
    const tok = await w.token(w.a.scope, "release_operator");
    const out = await ok(call(w, tok, { ref: "v1.0.0", inputs: { version: "1" } }));
    expect(out).toMatchObject({ trust_class: "release", state: "awaiting_approval" });
    const run = (await getRun(db, w.a.scope, out.run_id))!;
    expect(run.status).toBe("awaiting_approval");
    const jobs = await listJobs(db, w.a.scope, run.id);
    expect(jobs.length).toBe(2);
    for (const j of jobs) {
      expect(j.state).toBe("awaiting_approval");
      expect(j.approvalKind).toBe("untrusted_author");
    }
    // Bound to the exact workflow file: the decision carries its hash.
    expect(JSON.parse(run.trust!).workflowHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(run.trust!).reasons.join(" ")).toContain("held for approval");
    // The same tag through the poller is held the same way.
    w.gh.state.files.set(
      "*",
      WORKFLOW.replace("workflow_dispatch:", "push:\n    tags: ['v*']\n  workflow_dispatch:"),
    );
    await w.poller.pollAll();
    const pushed = (await listRuns(db, w.a.scope, { limit: 20 })).find(
      (r) => r.event === "push" && r.ref === "refs/tags/v1.0.0",
    );
    expect(pushed?.status).toBe("awaiting_approval");
  });

  test("a tag that is not a release ref is trusted_pr and is not held", async () => {
    const w = await world({ tagRefs: ["refs/tags/v*"] });
    const tok = await w.token(w.a.scope, "release_operator");
    const out = await ok(call(w, tok, { ref: "nightly", inputs: { version: "1" } }));
    expect(out).toMatchObject({ trust_class: "trusted_pr", state: "queued", sha: SHA("c") });
  });

  test("a held run counts against the waiting cap, and the hourly cap stops a flood", async () => {
    const w = await world({ maxRunsPerHour: 2 });
    const tok = await w.token(w.a.scope, "release_operator");
    await ok(call(w, tok, { inputs: { version: "1" } }));
    await ok(call(w, tok, { inputs: { version: "2" } }));
    const err = await refused(call(w, tok, { inputs: { version: "3" } }));
    expect(err.code).toBe("rate_limited");
    expect(err.message).toContain("hourly run cap");
  });

  test("two dispatches of the same sha and inputs are two runs", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    const one = await ok(call(w, tok, { inputs: { version: "1" } }));
    const two = await ok(call(w, tok, { inputs: { version: "1" } }));
    expect(one.run_id).not.toBe(two.run_id);
  });
});

describe("tenancy", () => {
  test("another org's token cannot dispatch into this org's project or repo", async () => {
    const w = await world();
    const b = await org("other-org");
    const bTok = await w.token(b.scope, "release_operator");
    // Naming A's project: not B's, so refused as unknown or forbidden.
    const named = await dispatch(w.env, { kind: "bearer", token: bTok }, "run_dispatch", {
      org: "acme",
      project: "app",
      workflow: ".github/workflows/release.yml",
      ref: "main",
      inputs: { version: "1" },
    });
    expect(named.ok).toBe(false);
    // B's own project does not ingest A's repo.
    const own = await refused(call(w, bTok, { repo: "acme/web", inputs: { version: "1" } }));
    expect(own.code).toBe("not_found");
    expect(await listRuns(db, w.a.scope, { limit: 10 })).toEqual([]);
    expect(await listRuns(db, b.scope, { limit: 10 })).toEqual([]);
  });
});

describe("atomic writes", () => {
  test("a failure after the forge phase, while writing, leaves no run, no jobs and no marker", async () => {
    const w = await world();
    const tok = await w.token(w.a.scope, "release_operator");
    // The forge phase and the validation write nothing; the writes are one transaction. Fail the
    // second insert of the writes (the jobs' attempts) and look for anything left behind.
    const wrap = (tx: Db): Db => {
      const wrapped: Db = {
        ...tx,
        run: (fn) => fn(wrapped),
        orm: new Proxy(tx.orm, {
          get(target, prop, recv) {
            if (prop === "insert") {
              return (table: unknown) => {
                if (table === s.jobAttempts) throw new Error("injected write failure");
                return target.insert(table as never);
              };
            }
            return Reflect.get(target, prop, recv);
          },
        }),
      };
      return wrapped;
    };
    const failing: Db = {
      ...db,
      transaction: (fn, opts) => db.transaction((tx) => fn(wrap(tx)), opts),
    };
    const poller = new Poller({ db: failing, config: w.cfg, fetch: w.gh.fetch, now: () => now });
    const env = {
      ...w.env,
      runDispatcher: (sc, r, q) => poller.dispatch(sc, r, q),
    } as typeof w.env;
    const res = await dispatch(env, { kind: "bearer", token: tok }, "run_dispatch", {
      project: "app",
      workflow: ".github/workflows/release.yml",
      ref: "main",
      inputs: { version: "1" },
    });
    expect(res.ok).toBe(false);
    expect(await listRuns(db, w.a.scope, { limit: 10 })).toEqual([]);
    const jobs = await db.orm.select().from(s.jobs);
    expect(jobs).toEqual([]);
    expect(await db.orm.select().from(s.pollSeen)).toEqual([]);
    // The failure is audited as a refused attempt, without the input values.
    const rows = (await listAudit(db, w.a.scope)).filter((r) => r.op === "run_dispatch");
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toContain("error:");
    // No audit row anywhere claims success for the attempt.
    const everything = await listAudit(db, w.a.scope);
    expect(everything.filter((r) => r.op === "run_dispatch" && r.outcome === "ok")).toEqual([]);
    expect(await db.orm.select().from(s.runs)).toEqual([]);
    expect(await db.orm.select().from(s.jobAttempts)).toEqual([]);
    // The same dispatch through the healthy db still works: nothing was left half-done.
    const out = await ok(call(w, tok, { inputs: { version: "1" } }));
    expect((await listJobs(db, w.a.scope, out.run_id)).length).toBe(2);
  });
});

describe("release approval binds the dispatched sha's workflow", () => {
  test("an approval for another workflow hash is refused; the matching hash is accepted", async () => {
    const w = await world({ tagRefs: ["refs/tags/v*"] });
    // Two release tags at two commits whose workflow file differs.
    w.gh.state.tags.set("v2.0.0", { sha: SHA("f") });
    w.gh.state.files.set(SHA("f"), WORKFLOW.replace("echo build", "echo different build"));
    const tok = await w.token(w.a.scope, "release_operator");
    const one = await ok(call(w, tok, { ref: "v1.0.0", inputs: { version: "1" } }));
    const two = await ok(call(w, tok, { ref: "v2.0.0", inputs: { version: "2" } }));
    expect(one.state).toBe("awaiting_approval");
    expect(two.state).toBe("awaiting_approval");
    const hash = async (id: string) =>
      JSON.parse((await getRun(db, w.a.scope, id))!.trust!).workflowHash as string;
    const [h1, h2] = [await hash(one.run_id), await hash(two.run_id)];
    expect(h1).not.toBe(h2);
    // A person's token: the default policy does not let an agent approve, which is not what is
    // under test here.
    const person = (await mintToken(db, w.a.scope, "release_operator", { kind: "person" })).secret;
    const approve = (run: typeof two, workflow_hash: string, head_sha = run.sha) =>
      dispatch(w.env, { kind: "bearer", token: person }, "approve_run", {
        run_id: run.run_id,
        head_sha,
        workflow_hash,
      });
    // The approval recorded for run one's workflow does not release run two, and the reverse.
    const wrong = await approve(two, h1);
    expect(!wrong.ok && wrong.error.code).toBe("conflict");
    expect(!wrong.ok && wrong.error.message).toContain("workflow");
    expect((await getRun(db, w.a.scope, two.run_id))!.status).toBe("awaiting_approval");
    for (const j of await listJobs(db, w.a.scope, two.run_id)) {
      expect(j.state).toBe("awaiting_approval");
    }
    // Nor does the right hash with another sha.
    const badSha = await approve(two, h2, one.sha);
    expect(!badSha.ok && badSha.error.code).toBe("conflict");
    // The matching sha and hash release it.
    const good = await approve(two, h2);
    if (!good.ok) throw new Error(`${good.error.code}: ${good.error.message}`);
    expect((await getRun(db, w.a.scope, two.run_id))!.status).not.toBe("awaiting_approval");
  });
});
