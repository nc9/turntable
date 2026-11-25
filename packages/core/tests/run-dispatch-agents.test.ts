// `run_dispatch_agents` (#520): which agent tokens may start a workflow_dispatch run. An agent
// reads untrusted text, so under the default `unprivileged` it never starts a protected or release
// run, and is refused before any forge call. A person's token is never limited by it. Runs on both
// dialects (TURNTABLE_TEST_DB). The forge is the fake GitHub of github-stub.ts, which counts calls.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  getRun,
  listRuns,
  openDatabase,
  type Db,
  type Scope,
} from "../src/db";
import { putStoredSetting } from "../src/db/repos/settings";
import { type DispatchEnv, dispatch, registry } from "../src/ops";
import { dispatchWorkflow, DispatchError, Poller, pollConfigSchema } from "../src/poll";
import { GithubClient } from "../src/poll/github";
import { RUN_DISPATCH_AGENTS, settingsRegistry } from "../src/settings/definitions";
import { loadSettingsRuntime } from "../src/settings/boot";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mintToken } from "./ops-helpers";
import { makeGithub, SHA } from "./github-stub";

const WORKFLOW = `name: Release
on:
  workflow_dispatch:
    inputs:
      version:
        required: true
        type: string
      channel:
        type: choice
        options: [stable, beta]
        default: stable
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
const KEY = "run_dispatch_agents";
const REFUSE_PRIV =
  "agent tokens may not dispatch protected or release runs in this project (run_dispatch_agents)";
const REFUSE_ALL = "agent tokens may not dispatch runs in this project (run_dispatch_agents)";

let db: Db;
const now = 1_800_000_000_000;

async function world() {
  const o = await createOrg(db, { slug: "acme", name: "acme" });
  const p = await createProject(db, { orgId: o.id }, { slug: "app", name: "App" });
  const scope = { orgId: o.id, projectId: p.id } as Required<Scope>;
  const gh = makeGithub("acme/web", ".github/workflows/release.yml");
  gh.state.files.set("*", WORKFLOW);
  gh.state.history = [{ sha: SHA("a"), parents: [] }];
  gh.state.branches.set("feature", SHA("d"));
  gh.state.branches.set("release/1", SHA("e"));
  gh.state.tags.set("v1.0.0", { sha: SHA("b") });
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        org: "acme",
        project: "app",
        workflow: ".github/workflows/release.yml",
        defaultBranch: "main",
        tagRefs: ["refs/tags/v*"],
        protectedRefs: ["refs/heads/release/**"],
      },
    ],
  });
  await bindRepo(db, scope, { forge: "github", owner: "acme", repo: "web" });
  const poller = new Poller({ db, config: cfg, fetch: gh.fetch, now: () => now });
  const env = {
    registry,
    db,
    now: () => now,
    runDispatcher: (
      s: Required<Scope>,
      r: string | undefined,
      q: Parameters<typeof poller.dispatch>[2],
    ) => poller.dispatch(s, r, q),
  } as DispatchEnv;
  const setPolicy = (v: string) =>
    putStoredSetting(
      db,
      { kind: "project", id: scope.projectId, orgId: scope.orgId },
      KEY,
      v,
      "t",
      1,
    );
  const tok = async (kind: "agent" | "person") =>
    (await mintToken(db, scope, "release_operator", { kind })).secret;
  const go = (t: string, ref: string, inputs: Record<string, string> = { version: "1" }) =>
    dispatch(env, { kind: "bearer", token: t }, "run_dispatch", {
      project: "app",
      workflow: ".github/workflows/release.yml",
      ref,
      inputs,
    });
  return { scope, gh, cfg, env, setPolicy, tok, go };
}

const expectRefused = async (r: ReturnType<typeof dispatch>, message: string) => {
  const res = await r;
  if (res.ok) throw new Error("expected a refusal");
  expect(res.error.code).toBe("forbidden");
  expect(res.error.message).toBe(message);
};
const out = async (r: ReturnType<typeof dispatch>) => {
  const res = await r;
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.output as { run_id: string; trust_class: string; state: string };
};

beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("the default, unprivileged", () => {
  test("an agent at release_operator is refused on the default branch with zero forge calls", async () => {
    const w = await world();
    const agent = await w.tok("agent");
    await expectRefused(w.go(agent, "main"), REFUSE_PRIV);
    await expectRefused(w.go(agent, "refs/heads/main"), REFUSE_PRIV);
    expect(w.gh.state.calls.length).toBe(0);
    expect((await listRuns(db, w.scope, { limit: 10 })).length).toBe(0);
  });

  test("a release tag, a bare name that could be one, and a protected ref pattern likewise", async () => {
    const w = await world();
    const agent = await w.tok("agent");
    await expectRefused(w.go(agent, "v1.0.0"), REFUSE_PRIV);
    await expectRefused(w.go(agent, "refs/tags/v1.0.0"), REFUSE_PRIV);
    await expectRefused(w.go(agent, "release/1"), REFUSE_PRIV);
    expect(w.gh.state.calls.length).toBe(0);
  });

  test("a feature branch is allowed and is trusted_pr", async () => {
    const w = await world();
    const agent = await w.tok("agent");
    expect(await out(w.go(agent, "feature"))).toMatchObject({
      trust_class: "trusted_pr",
      state: "queued",
    });
  });

  test("a person at the same role is unaffected", async () => {
    const w = await world();
    const person = await w.tok("person");
    expect((await out(w.go(person, "main"))).trust_class).toBe("protected");
  });
});

describe("none and any", () => {
  test("none refuses an agent even on a feature branch, with zero forge calls", async () => {
    const w = await world();
    await w.setPolicy("none");
    const agent = await w.tok("agent");
    await expectRefused(w.go(agent, "feature"), REFUSE_ALL);
    await expectRefused(w.go(agent, "main"), REFUSE_ALL);
    expect(w.gh.state.calls.length).toBe(0);
  });

  test("any lets an agent dispatch the default branch; a release run still waits for approval", async () => {
    const w = await world();
    await w.setPolicy("any");
    const agent = await w.tok("agent");
    expect((await out(w.go(agent, "main"))).trust_class).toBe("protected");
    expect(await out(w.go(agent, "v1.0.0"))).toMatchObject({
      trust_class: "release",
      state: "awaiting_approval",
    });
  });

  test("a person is unaffected in every mode", async () => {
    const w = await world();
    const person = await w.tok("person");
    for (const mode of RUN_DISPATCH_AGENTS) {
      await w.setPolicy(mode);
      expect((await out(w.go(person, "main"))).trust_class).toBe("protected");
      expect((await out(w.go(person, "feature"))).trust_class).toBe("trusted_pr");
    }
  });
});

describe("the re-check after the resolve", () => {
  // The op refuses by name first, and the name rule uses the same config as the real class, so
  // no ref reaches the re-check through the op today. Called directly (as a future change to the
  // name rule would), the re-check still refuses and creates nothing.
  test("a protected resolved class is refused for an agent and no run is created", async () => {
    const w = await world();
    const github = new GithubClient({
      fetch: w.gh.fetch,
      baseUrl: w.cfg.apiBaseUrl,
      now: () => now,
    });
    const req = {
      workflow: ".github/workflows/release.yml",
      ref: "main",
      inputs: { version: "1" },
      actor: "token:x",
      role: "release_operator",
      agentPolicy: "unprivileged" as const,
    };
    const deps = { db, github, provider: w.cfg.provider, now: () => now };
    const err = await dispatchWorkflow(deps, w.cfg.repos[0]!, w.scope, req).catch((e) => e);
    expect(err).toBeInstanceOf(DispatchError);
    expect(err.message).toBe(REFUSE_PRIV);
    expect(w.gh.state.calls.length).toBeGreaterThan(0);
    expect((await listRuns(db, w.scope, { limit: 10 })).length).toBe(0);
    // The same call as a person (no policy) creates the run.
    const { agentPolicy: _drop, ...person } = req;
    expect((await dispatchWorkflow(deps, w.cfg.repos[0]!, w.scope, person)).trustClass).toBe(
      "protected",
    );
  });
});

describe("who may change the setting", () => {
  const rt = loadSettingsRuntime({
    registry: settingsRegistry,
    env: {},
    config: undefined,
    read: () => "",
  });
  test("the definition: project scope, default unprivileged, not MCP-editable, instance admin loosens", () => {
    expect(settingsRegistry.get(KEY)).toMatchObject({
      scope: "project",
      default: "unprivileged",
      mcpEditable: false,
      instanceAdminOnly: true,
      strictness: ["any", "unprivileged", "none"],
      toml: "run_dispatch_agents",
    });
  });

  test("an org owner token tightens but cannot loosen; nor can the instance administrator", async () => {
    const w = await world();
    const owner = {
      kind: "principal" as const,
      principal: { kind: "member" as const, id: "o", orgId: w.scope.orgId, role: "owner" as const },
    };
    const set = (value: string) =>
      dispatch({ registry, db, settings: rt }, owner, "set_setting", {
        key: KEY,
        value,
        project: "app",
      });
    expect((await set("none")).ok).toBe(true);
    const loosen = await set("any");
    expect(!loosen.ok && loosen.error.message).toBe(
      `only the org's owner can loosen ${KEY}, from a signed-in session with a passkey step-up`,
    );
    const { secret } = await createInstanceTokenFromCli(db, { name: "ops" });
    const admin = await dispatch(
      { registry, db, settings: rt, allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: secret },
      "instance_set_setting",
      { key: KEY, value: "any", target_org: "acme", target_project: "app" },
    );
    // trust: the instance administrator tightens but never loosens (#571)
    expect(!admin.ok && admin.error.message).toBe(`only the org's owner can loosen ${KEY}`);
    expect(!admin.ok && (admin.error.details as { reason?: string }).reason).toBe(
      "trust_loosening_needs_owner",
    );
  });

  test("over MCP it is refused, a token below owner is refused", async () => {
    const w = await world();
    const person = await w.tok("person");
    const viaMcp = await dispatch(
      { registry, db, settings: rt, transport: "mcp" },
      { kind: "bearer", token: person },
      "set_setting",
      { key: KEY, value: "none" },
    );
    expect(viaMcp.ok).toBe(false);
    const below = await dispatch(
      { registry, db, settings: rt },
      { kind: "bearer", token: person },
      "set_setting",
      {
        key: KEY,
        value: "none",
      },
    );
    expect(!below.ok && below.error.message).toMatch(/requires role owner/);
  });
});

describe("what the run records", () => {
  test("runs.trust names who dispatched and the input names, never the values", async () => {
    const w = await world();
    const person = await w.tok("person");
    const value = "secret-looking-value-123";
    const o = await out(w.go(person, "feature", { version: value }));
    const run = (await getRun(db, w.scope, o.run_id))!;
    const trust = JSON.parse(run.trust!);
    expect(trust.facts.input_names).toEqual(["version", "channel"]);
    expect(run.trust).not.toContain(value);
    expect(trust.reasons.join(" ")).toContain("dispatched by token:");
    expect(trust.reasons.join(" ")).toContain("with project role release_operator");
    expect(run.actor).toStartWith("token:");
    expect(run.ref).toBe("refs/heads/feature");
    expect(run.sha).toBe(SHA("d"));
  });
});
