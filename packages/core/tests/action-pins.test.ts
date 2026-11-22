import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InfraError } from "@longshore/provider-sdk";
import { PlanError, planJob, tarDirectory, type ActionRefResolver } from "@longshore/act-runner";
import { type Db, listActionPins, setActionPolicy, getActionPolicy, listAudit } from "../src/db";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import {
  MovedTagError,
  createPinningResolver,
  enforceActionPolicy,
  pinClassForEvent,
  resolvePlanActions,
  type PinClass,
} from "../src/pins";
import { githubReachability } from "../src/pins/reachability";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const SHA = (c: string) => c.repeat(40);

/** Fetches a plain node action tarball for any repo and sha (no nested actions). */
const nodeTmp = mkdtempSync(join(tmpdir(), "ls-node-action-"));
afterAll(() => rmSync(nodeTmp, { recursive: true, force: true }));
const nodeFetch = async (): Promise<Uint8Array> => {
  const top = "x-y-abc123";
  const d = mkdtempSync(join(nodeTmp, "t-"));
  mkdirSync(join(d, top), { recursive: true });
  writeFileSync(join(d, top, "action.yml"), "name: n\nruns:\n  using: node20\n  main: index.js\n");
  return tarDirectory(d, [top]);
};
const reachableAll = async (): Promise<boolean> => true;

let db: Db;
let a: Tenant;

/** A GitHub that can be told to move a tag. */
function fakeGithub() {
  const tags = new Map<string, string>([
    ["acme/tool@v1", SHA("1")],
    ["actions/checkout@v4", SHA("c")],
  ]);
  const calls: string[] = [];
  const resolver: ActionRefResolver = async (owner, repo, ref) => {
    calls.push(`${owner}/${repo}@${ref}`);
    const sha = tags.get(`${owner}/${repo}@${ref}`);
    if (!sha) throw new PlanError("action ref", "unknown tag");
    return sha;
  };
  return { tags, calls, resolver };
}

beforeEach(async () => {
  ({ db, a } = await seedWorld());
});

const pinResolver = (base: ActionRefResolver, klass: PinClass, warn?: (m: string) => void) =>
  createPinningResolver({ db, scope: a.scope, base, klass, ...(warn ? { warn } : {}) });

describe("moved tags", () => {
  test("a first resolution is pinned; the same sha is unchanged", async () => {
    const gh = fakeGithub();
    const r = pinResolver(gh.resolver, "protected");
    expect(await r("acme", "tool", "v1")).toBe(SHA("1"));
    expect(await r("acme", "tool", "v1")).toBe(SHA("1"));
    const pins = await listActionPins(db, a.scope);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      repo: "acme/tool",
      ref: "v1",
      sha: SHA("1"),
      pendingSha: null,
    });
    expect(pins[0]!.lastSeen).toBeGreaterThanOrEqual(pins[0]!.firstSeen);
  });

  test("a moved tag fails protected and release runs, naming the action and both shas", async () => {
    const gh = fakeGithub();
    await pinResolver(gh.resolver, "protected")("acme", "tool", "v1");
    gh.tags.set("acme/tool@v1", SHA("2"));
    for (const klass of ["protected", "release"] as const) {
      const err = await pinResolver(gh.resolver, klass)("acme", "tool", "v1").catch((e) => e);
      expect(err).toBeInstanceOf(MovedTagError);
      expect(err).toBeInstanceOf(PlanError);
      expect(err.message).toContain("acme/tool@v1");
      expect(err.message).toContain(SHA("1"));
      expect(err.message).toContain(SHA("2"));
      expect(err.message).toContain("accept_action_move");
    }
    // The pin itself did not move; the new commit is only pending.
    expect((await listActionPins(db, a.scope))[0]).toMatchObject({
      sha: SHA("1"),
      pendingSha: SHA("2"),
    });
  });

  test("PR classes get a warning and the OLD pinned sha", async () => {
    const gh = fakeGithub();
    await pinResolver(gh.resolver, "protected")("acme", "tool", "v1");
    gh.tags.set("acme/tool@v1", SHA("2"));
    for (const klass of ["trusted_pr", "untrusted_pr"] as const) {
      const warnings: string[] = [];
      const sha = await pinResolver(gh.resolver, klass, (m) => warnings.push(m))(
        "acme",
        "tool",
        "v1",
      );
      expect(sha).toBe(SHA("1"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(SHA("2"));
    }
  });

  test("a tag that moves back clears the pending move", async () => {
    const gh = fakeGithub();
    const r = pinResolver(gh.resolver, "untrusted_pr", () => {});
    await r("acme", "tool", "v1");
    gh.tags.set("acme/tool@v1", SHA("2"));
    await r("acme", "tool", "v1");
    gh.tags.set("acme/tool@v1", SHA("1"));
    await r("acme", "tool", "v1");
    expect((await listActionPins(db, a.scope))[0]?.pendingSha).toBeNull();
  });

  test("pins are per project: another project sees no move", async () => {
    const gh = fakeGithub();
    await pinResolver(gh.resolver, "protected")("acme", "tool", "v1");
    gh.tags.set("acme/tool@v1", SHA("2"));
    const other = await seedWorld();
    const r = createPinningResolver({
      db: other.db,
      scope: other.a.scope,
      base: gh.resolver,
      klass: "protected",
    });
    expect(await r("acme", "tool", "v1")).toBe(SHA("2"));
  });
});

describe("accept_action_move", () => {
  let env: DispatchEnv;
  let operator: string;
  let reader: string;

  beforeEach(async () => {
    env = { registry, db, now: () => Date.now() };
    operator = (await mintToken(db, a.scope, "operator")).secret;
    reader = (await mintToken(db, a.scope, "reader")).secret;
  });

  const call = (token: string, op: string, input: unknown) =>
    dispatch(env, { kind: "bearer", token }, op, input);

  test("unblocks a protected run after the operator accepts the exact new sha, and is audited", async () => {
    const gh = fakeGithub();
    const protectedResolve = pinResolver(gh.resolver, "protected");
    await protectedResolve("acme", "tool", "v1");
    gh.tags.set("acme/tool@v1", SHA("2"));
    await expect(protectedResolve("acme", "tool", "v1")).rejects.toBeInstanceOf(MovedTagError);

    const pins = await call(reader, "get_action_pins", {});
    expect(
      pins.ok && (pins.output as { pins: { pending_sha: string | null }[] }).pins[0]?.pending_sha,
    ).toBe(SHA("2"));

    // A reader cannot accept; a wrong sha is refused; the exact pending sha is accepted.
    expect(
      (await call(reader, "accept_action_move", { repo: "acme/tool", ref: "v1", sha: SHA("2") }))
        .ok,
    ).toBe(false);
    const wrong = await call(operator, "accept_action_move", {
      repo: "acme/tool",
      ref: "v1",
      sha: SHA("9"),
    });
    expect(!wrong.ok && wrong.error.code).toBe("conflict");
    const ok = await call(operator, "accept_action_move", {
      repo: "Acme/Tool",
      ref: "v1",
      sha: SHA("2"),
    });
    expect(ok.ok && ok.output).toMatchObject({ previous_sha: SHA("1"), sha: SHA("2") });

    expect(await protectedResolve("acme", "tool", "v1")).toBe(SHA("2"));
    const audit = await listAudit(db, a.scope);
    expect(audit.some((e) => e.op === "accept_action_move" && e.outcome === "ok")).toBe(true);
  });

  test("accepting with no pin or no pending move is refused", async () => {
    const none = await call(operator, "accept_action_move", {
      repo: "acme/tool",
      ref: "v1",
      sha: SHA("2"),
    });
    expect(!none.ok && none.error.code).toBe("not_found");
    const gh = fakeGithub();
    await pinResolver(gh.resolver, "protected")("acme", "tool", "v1");
    const nopending = await call(operator, "accept_action_move", {
      repo: "acme/tool",
      ref: "v1",
      sha: SHA("1"),
    });
    expect(!nopending.ok && nopending.error.code).toBe("conflict");
  });
});

const wf = (uses: string[]): string =>
  `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${uses.map((u) => `      - uses: ${u}\n`).join("")}`;
const planOf = (uses: string[]) =>
  planJob(wf(uses), "a", { workflowPath: ".github/workflows/ci.yml", readFile: () => undefined });

describe("project policy", () => {
  test("require_sha_pins refuses tags and branches, and passes shas", async () => {
    const policy = { requireShaPins: true, allowedOwners: null };
    expect(() => enforceActionPolicy(planOf(["actions/checkout@v4"]), policy)).toThrow(
      /require this project|requires sha pins/,
    );
    expect(() => enforceActionPolicy(planOf(["actions/checkout@main"]), policy)).toThrow(PlanError);
    expect(() =>
      enforceActionPolicy(planOf([`actions/checkout@${SHA("c")}`]), policy),
    ).not.toThrow();
    expect(() =>
      enforceActionPolicy(planOf(["actions/checkout@v4"]), {
        requireShaPins: false,
        allowedOwners: null,
      }),
    ).not.toThrow();
  });

  test("the owner allowlist applies to every action, nested or not, and off by default", async () => {
    const policy = { requireShaPins: false, allowedOwners: ["actions"] };
    expect(() => enforceActionPolicy(planOf(["actions/checkout@v4"]), policy)).not.toThrow();
    const err = (() => {
      try {
        enforceActionPolicy(planOf(["actions/checkout@v4", "evil/steal@v1"]), policy);
      } catch (e) {
        return e as PlanError;
      }
    })();
    expect(err?.feature).toBe("action-owner");
    expect(err?.message).toContain("evil");
    expect(() =>
      enforceActionPolicy(planOf(["evil/steal@v1"]), {
        requireShaPins: false,
        allowedOwners: null,
      }),
    ).not.toThrow();
    // Case-insensitive owner match.
    expect(() => enforceActionPolicy(planOf(["Actions/checkout@v4"]), policy)).not.toThrow();
  });

  test("policy is stored per project (sha pins) and per org (allowlist) and read back", async () => {
    expect(await getActionPolicy(db, a.scope)).toEqual({
      requireShaPins: false,
      allowedOwners: null,
    });
    await setActionPolicy(db, a.scope, {
      requireShaPins: true,
      allowedOwners: ["Actions", "oven-sh"],
    });
    expect(await getActionPolicy(db, a.scope)).toEqual({
      requireShaPins: true,
      allowedOwners: ["actions", "oven-sh"],
    });
    await setActionPolicy(db, a.scope, { allowedOwners: null });
    expect((await getActionPolicy(db, a.scope)).allowedOwners).toBeNull();
  });

  test("resolvePlanActions applies policy first (nothing is resolved), then pins", async () => {
    const gh = fakeGithub();
    await setActionPolicy(db, a.scope, { requireShaPins: true });
    await expect(
      resolvePlanActions(planOf(["acme/tool@v1"]), {
        db,
        scope: a.scope,
        klass: "protected",
        base: gh.resolver,
        fetchTarball: nodeFetch,
        reachable: reachableAll,
      }),
    ).rejects.toThrow(/sha pins/);
    expect(gh.calls).toEqual([]);

    await setActionPolicy(db, a.scope, { requireShaPins: false });
    const plan = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: gh.resolver,
      fetchTarball: nodeFetch,
      reachable: reachableAll,
    });
    expect(plan.actions[0]?.sha).toBe(SHA("1"));
    expect(await listActionPins(db, a.scope)).toHaveLength(1);
    // A moved tag stops the next protected plan, and the plan never gets that sha.
    gh.tags.set("acme/tool@v1", SHA("2"));
    await expect(
      resolvePlanActions(planOf(["acme/tool@v1"]), {
        db,
        scope: a.scope,
        klass: "protected",
        base: gh.resolver,
        fetchTarball: nodeFetch,
        reachable: reachableAll,
      }),
    ).rejects.toBeInstanceOf(MovedTagError);
  });
});

test("classes: a push is protected, a pull request is not", () => {
  expect(pinClassForEvent("push")).toBe("protected");
  expect(pinClassForEvent("pull_request")).toBe("untrusted_pr");
  expect(pinClassForEvent("pull_request_target")).toBe("untrusted_pr");
});

// ---- impostor commits ----

describe("impostor commits (a sha that exists only in a fork)", () => {
  type Stub = {
    defaultBranch?: string;
    compare?: Record<string, { status: string } | number>;
    tags?: string[];
    branches?: string[];
    repo404?: boolean;
    fail?: number | "network";
  };
  function fakeApi(stub: Stub) {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      calls.push(u.pathname);
      if (stub.fail === "network") throw new Error("socket closed");
      if (typeof stub.fail === "number") return new Response("", { status: stub.fail });
      const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
      if (!m) return new Response("", { status: 404 });
      if (!m[2]) {
        return stub.repo404
          ? new Response("", { status: 404 })
          : Response.json({ default_branch: stub.defaultBranch ?? "main" });
      }
      if (m[2].startsWith("/compare/")) {
        const key = decodeURIComponent(m[2].slice("/compare/".length));
        const r = stub.compare?.[key];
        if (r === undefined) return new Response("", { status: 404 });
        return typeof r === "number" ? new Response("", { status: r }) : Response.json(r);
      }
      const list = m[2] === "/tags" ? stub.tags : m[2] === "/branches" ? stub.branches : undefined;
      return Response.json((list ?? []).map((sha) => ({ commit: { sha } })));
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test("reachable from the default branch (behind or identical) is accepted, and cached", async () => {
    for (const status of ["behind", "identical"]) {
      const api = fakeApi({ compare: { [`main...${SHA("1")}`]: { status } } });
      const check = githubReachability({ fetch: api.impl });
      expect(await check("acme", "tool", SHA("1"))).toBe(true);
      const n = api.calls.length;
      expect(await check("acme", "tool", SHA("1"))).toBe(true);
      expect(api.calls.length).toBe(n);
    }
  });

  test("a commit only in a fork (ahead or diverged, on no tag or branch) is unreachable", async () => {
    for (const status of ["ahead", "diverged"]) {
      const api = fakeApi({
        compare: { [`main...${SHA("f")}`]: { status } },
        tags: [SHA("1")],
        branches: [SHA("2")],
      });
      expect(await githubReachability({ fetch: api.impl })("acme", "tool", SHA("f"))).toBe(false);
    }
  });

  test("a commit not on the default branch is still fine when a tag or a branch points at it", async () => {
    const compare = {
      [`main...${SHA("a")}`]: { status: "diverged" },
      [`main...${SHA("b")}`]: { status: "diverged" },
    };
    const api = fakeApi({ compare, tags: [SHA("a")], branches: [SHA("b")] });
    const check = githubReachability({ fetch: api.impl });
    expect(await check("acme", "tool", SHA("a"))).toBe(true);
    expect(await check("acme", "tool", SHA("b"))).toBe(true);
  });

  test("an unknown sha or repo is unreachable; an API failure is NOT a verdict (InfraError)", async () => {
    expect(await githubReachability({ fetch: fakeApi({}).impl })("acme", "tool", SHA("9"))).toBe(
      false,
    );
    expect(
      await githubReachability({ fetch: fakeApi({ repo404: true }).impl })(
        "acme",
        "tool",
        SHA("9"),
      ),
    ).toBe(false);
    for (const fail of [500, 403, 429, "network"] as const) {
      const err = await githubReachability({ fetch: fakeApi({ fail }).impl })(
        "acme",
        "tool",
        SHA("1"),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(InfraError);
    }
  });

  test("an unreachable given sha passes the allowlist and sha-pin checks and is still refused", async () => {
    await setActionPolicy(db, a.scope, { requireShaPins: true, allowedOwners: ["acme"] });
    const reachable = async () => false;
    const err = await resolvePlanActions(planOf([`acme/tool@${SHA("f")}`]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: fakeGithub().resolver,
      reachable,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.feature).toBe("unreachable-sha");
    expect(err.message).toContain(`acme/tool@${SHA("f")}`);
    expect(err.message).toContain("fork");
  });

  test("a tag that resolves to an unreachable commit is refused too, and reachable ones pass", async () => {
    const gh = fakeGithub();
    const calls: string[] = [];
    const reachable = async (o: string, r: string, sha: string) => {
      calls.push(`${o}/${r}@${sha}`);
      return sha === SHA("1");
    };
    const ok = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: gh.resolver,
      fetchTarball: nodeFetch,
      reachable,
    });
    expect(ok.actions[0]?.sha).toBe(SHA("1"));
    gh.tags.set("acme/tool@v2", SHA("2"));
    await expect(
      resolvePlanActions(planOf(["acme/tool@v2"]), {
        db,
        scope: a.scope,
        klass: "protected",
        base: gh.resolver,
        fetchTarball: nodeFetch,
        reachable,
      }),
    ).rejects.toThrow(/not reachable/);
  });
});

// ---- nested actions inside remote composites ----

describe("nested actions in remote composites", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ls-nested-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** A GitHub source tarball: one top dir, with action.yml inside. */
  async function actionTgz(name: string, yml: string, sub = ""): Promise<Uint8Array> {
    const top = `${name}-abc123`;
    const d = mkdtempSync(join(tmp, "t-"));
    const dir = join(d, top, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "action.yml"), yml);
    return tarDirectory(d, [top]);
  }
  const composite = (...uses: string[]): string =>
    `name: c\nruns:\n  using: composite\n  steps:\n${uses.map((u) => `    - uses: ${u}\n`).join("")}    - shell: bash\n      run: echo hi\n`;
  const nodeAction = "name: n\nruns:\n  using: node20\n  main: index.js\n";

  /** Tarballs by `repo@sha`. */
  function world(tgzs: Record<string, Uint8Array>) {
    const fetched: string[] = [];
    const fetchTarball = async (repo: string, sha: string): Promise<Uint8Array> => {
      fetched.push(`${repo}@${sha}`);
      const t = tgzs[`${repo}@${sha}`];
      if (!t) throw new PlanError("nested-action", `no tarball for ${repo}@${sha}`);
      return t;
    };
    return { fetchTarball, fetched };
  }

  const base = (extra: Record<string, string> = {}): ActionRefResolver => {
    const tags = new Map<string, string>([
      ["acme/tool@v1", SHA("1")],
      ["other/dep@v2", SHA("2")],
      ["deep/one@v1", SHA("3")],
      ...Object.entries(extra),
    ]);
    return async (o, r, ref) => {
      const sha = tags.get(`${o}/${r}@${ref}`);
      if (!sha) throw new PlanError("action ref", `cannot resolve ${o}/${r}@${ref}: HTTP 404`);
      return sha;
    };
  };
  const allReachable = async () => true;

  test("a nested tag-pinned action is pinned, checked, and delivered locally by sha", async () => {
    const w = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", composite("other/dep@v2")),
      [`other/dep@${SHA("2")}`]: await actionTgz("other-dep", nodeAction),
    });
    const checked: string[] = [];
    const plan = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: async (o, r, sha) => (checked.push(`${o}/${r}@${sha}`), true),
      fetchTarball: w.fetchTarball,
    });
    const nested = plan.actions.find((x) => x.repo === "other/dep");
    expect(nested).toMatchObject({
      ref: "v2",
      sha: SHA("2"),
      kind: "remote",
      nestedIn: "acme/tool@v1",
    });
    // act would otherwise fetch other/dep@v2 itself: both keys map to the delivered dir.
    expect(plan.argv).toContain(`other/dep@v2=${nested?.dir}`);
    expect(plan.argv).toContain(`other/dep@${SHA("2")}=${nested?.dir}`);
    // pinned (tag-move detection applies), and reachability was checked for the nested sha
    const pins = await listActionPins(db, a.scope);
    expect(pins.map((p) => `${p.repo}@${p.ref}`)).toEqual(["acme/tool@v1", "other/dep@v2"]);
    expect(checked).toContain(`other/dep@${SHA("2")}`);
  });

  test("a nested action that cannot be resolved refuses the plan", async () => {
    const w = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", composite("ghost/missing@v9")),
    });
    const err = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: allReachable,
      fetchTarball: w.fetchTarball,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.message).toContain("ghost/missing@v9");
  });

  test("the allowlist and reachability apply to nested actions", async () => {
    const w = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", composite("other/dep@v2")),
      [`other/dep@${SHA("2")}`]: await actionTgz("other-dep", nodeAction),
    });
    await setActionPolicy(db, a.scope, { allowedOwners: ["acme"] });
    const blocked = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: allReachable,
      fetchTarball: w.fetchTarball,
    }).catch((e) => e);
    expect(blocked.feature).toBe("action-owner");
    expect(blocked.message).toContain("other");

    await setActionPolicy(db, a.scope, { allowedOwners: null });
    const impostor = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: async (o) => o !== "other",
      fetchTarball: w.fetchTarball,
    }).catch((e) => e);
    expect(impostor.feature).toBe("unreachable-sha");
  });

  test("require_sha_pins is about what the project writes: a nested tag does not trip it", async () => {
    const w = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", composite("other/dep@v2")),
      [`other/dep@${SHA("2")}`]: await actionTgz("other-dep", nodeAction),
    });
    await setActionPolicy(db, a.scope, { requireShaPins: true });
    const plan = await resolvePlanActions(planOf([`acme/tool@${SHA("1")}`]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: allReachable,
      fetchTarball: w.fetchTarball,
    });
    expect(plan.actions.map((x) => x.repo)).toEqual(["acme/tool", "other/dep"]);
  });

  test("a docker action, top-level or nested, is refused", async () => {
    const dockerYml = "name: d\nruns:\n  using: docker\n  image: Dockerfile\n";
    const direct = world({ [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", dockerYml) });
    const e1 = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: allReachable,
      fetchTarball: direct.fetchTarball,
    }).catch((e) => e);
    expect(e1.message).toContain("docker action");
    const nested = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", composite("docker://alpine:3")),
    });
    const e2 = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: allReachable,
      fetchTarball: nested.fetchTarball,
    }).catch((e) => e);
    expect(e2).toBeInstanceOf(PlanError);
    expect(e2.message).toContain("docker://alpine:3");
  });

  test("nesting is capped at 5 levels", async () => {
    // acme/tool -> deep/one -> deep/two -> ... a chain longer than the cap
    const chain: Record<string, string> = {};
    const tgzs: Record<string, Uint8Array> = {};
    const names = ["acme/tool", "deep/l1", "deep/l2", "deep/l3", "deep/l4", "deep/l5", "deep/l6"];
    for (const [i, n] of names.entries()) {
      const sha = String(i + 1)
        .repeat(40)
        .slice(0, 40);
      if (i > 0) chain[`${n}@v1`] = sha;
      const next = names[i + 1];
      tgzs[`${n}@${i === 0 ? SHA("1") : sha}`] = await actionTgz(
        n.replace("/", "-"),
        next ? composite(`${next}@v1`) : nodeAction,
      );
    }
    const w = world(tgzs);
    const err = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(chain),
      reachable: allReachable,
      fetchTarball: w.fetchTarball,
    }).catch((e) => e);
    expect(err.feature).toBe("nested-depth");
    // A chain within the cap is fine.
    const shortNames = names.slice(0, 4);
    const w2 = world(tgzs);
    const shortTgzs: Record<string, Uint8Array> = { ...tgzs };
    const last = shortNames[3] as string;
    shortTgzs[`${last}@${"4".repeat(40)}`] = await actionTgz(last.replace("/", "-"), nodeAction);
    const ok = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(chain),
      reachable: allReachable,
      fetchTarball: world(shortTgzs).fetchTarball,
    });
    expect(ok.actions.length).toBe(4);
    void w2;
  });

  test("a moved tag on a nested action fails a protected run", async () => {
    const w = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", composite("other/dep@v2")),
      [`other/dep@${SHA("2")}`]: await actionTgz("other-dep", nodeAction),
      [`other/dep@${SHA("9")}`]: await actionTgz("other-dep", nodeAction),
    });
    const opts = {
      db,
      scope: a.scope,
      klass: "protected" as const,
      reachable: allReachable,
      fetchTarball: w.fetchTarball,
    };
    await resolvePlanActions(planOf(["acme/tool@v1"]), { ...opts, base: base() });
    const err = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      ...opts,
      base: base({ "other/dep@v2": SHA("9") }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MovedTagError);
    expect(err.message).toContain("other/dep@v2");
  });

  // ---- runs.using is normalised and fails closed ----

  const withUsing = (using: string | undefined, extra = ""): string =>
    `name: x\nruns:\n${using === undefined ? "" : `  using: ${using}\n`}${extra}`;
  const compositeYml = (using: string): string =>
    withUsing(using, "  steps:\n    - uses: other/dep@v2\n");

  const planWith = async (yml: string, readFile?: (p: string) => string | undefined) => {
    const w = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", yml),
      [`other/dep@${SHA("2")}`]: await actionTgz("other-dep", nodeAction),
    });
    return resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: allReachable,
      fetchTarball: w.fetchTarball,
      ...(readFile ? { readFile } : {}),
    });
  };

  test.each(["composite", " composite", "COMPOSITE", "Composite\t", '"  Composite  "'])(
    "composite spelled %j is still expanded (its nested action is policed)",
    async (using) => {
      const plan = await planWith(compositeYml(using));
      expect(plan.actions.map((x) => x.repo)).toEqual(["acme/tool", "other/dep"]);
    },
  );

  test.each(["docker", "Docker", " DOCKER ", '"docker "'])(
    "%j is refused as a docker action",
    async (using) => {
      const err = await planWith(withUsing(using, "  image: Dockerfile\n")).catch((e) => e);
      expect(err).toBeInstanceOf(PlanError);
      expect(err.message).toContain("docker action");
    },
  );

  test.each(["node12", "node16", "node20", "node24", " Node20 "])(
    "%j is allowed and has no nested actions",
    async (using) => {
      const plan = await planWith(withUsing(using, "  main: index.js\n"));
      expect(plan.actions.map((x) => x.repo)).toEqual(["acme/tool"]);
    },
  );

  test.each([
    ["an unknown runtime", withUsing("bash")],
    ["an unknown version", withUsing("node99", "  main: i.js\n")],
    ["no using at all", withUsing(undefined, "  main: i.js\n")],
    ["a non-string using", withUsing("[composite]")],
    ["an empty using", withUsing('""')],
    ["a composite without steps", withUsing("composite")],
    ["a composite whose steps is not a list", withUsing("composite", "  steps: nope\n")],
  ])("%s is refused", async (_name, yml) => {
    const err = await planWith(yml).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.feature).toBe("nested-action");
  });

  // ---- ./x inside a REMOTE composite is the caller's workspace ----

  const workspace =
    (files: Record<string, string>) =>
    (p: string): string | undefined =>
      files[p];

  test("a ./ action inside a remote composite is read from the workspace and walked like any other", async () => {
    const files = {
      "tools/local/action.yml": compositeYml("composite"),
    };
    const plan = await planWith(
      `name: x\nruns:\n  using: composite\n  steps:\n    - uses: ./tools/local\n`,
      workspace(files),
    );
    // its nested remote action is resolved, pinned and delivered locally
    expect(plan.actions.map((x) => x.repo)).toEqual(["acme/tool", "other/dep"]);
    expect(plan.actions[1]?.nestedIn).toBe("./tools/local");
    expect(plan.argv).toContain(`other/dep@v2=${plan.actions[1]?.dir}`);
    // and the workspace file is part of the plan, so it is verified like the others
    expect(plan.files.map((f) => f.path)).toContain("tools/local/action.yml");
  });

  test("the allowlist and reachability apply to what a workspace action pulls in", async () => {
    const files = { "l/action.yml": compositeYml("composite") };
    const yml = `name: x\nruns:\n  using: composite\n  steps:\n    - uses: ./l\n`;
    const w = world({
      [`acme/tool@${SHA("1")}`]: await actionTgz("acme-tool", yml),
      [`other/dep@${SHA("2")}`]: await actionTgz("other-dep", nodeAction),
    });
    await setActionPolicy(db, a.scope, { allowedOwners: ["acme"] });
    const blocked = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: base(),
      reachable: allReachable,
      fetchTarball: w.fetchTarball,
      readFile: workspace(files),
    }).catch((e) => e);
    expect(blocked.feature).toBe("action-owner");
  });

  test("paths leaving the workspace, missing actions and docker or unknown local actions are refused", async () => {
    const using = (u: string) => `name: l\nruns:\n  using: ${u}\n`;
    const cases: [string, string, Record<string, string>, string][] = [
      ["a path above the root", "../secrets", {}, "outside the workspace"],
      ["an absolute path", "./../../etc", {}, "outside the workspace"],
      ["a missing action", "./nope", {}, "no action.yml"],
      ["a docker local action", "./d", { "d/action.yml": using("Docker") }, "docker action"],
      [
        "an unknown local runtime",
        "./u",
        { "u/action.yml": using("bash") },
        "unsupported runs.using",
      ],
    ];
    for (const [, uses, files, message] of cases) {
      const err = await planWith(
        `name: x\nruns:\n  using: composite\n  steps:\n    - uses: ${uses}\n`,
        workspace(files),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(PlanError);
      expect(err.message).toContain(message);
    }
  });

  test("a workspace action that refers back to itself does not loop, and an unresolvable nested remote refuses", async () => {
    const loop = {
      "a/action.yml": "name: a\nruns:\n  using: composite\n  steps:\n    - uses: ./a\n",
    };
    const ok = await planWith(
      `name: x\nruns:\n  using: composite\n  steps:\n    - uses: ./a\n`,
      workspace(loop),
    );
    expect(ok.actions).toHaveLength(1);
    const ghost = {
      "g/action.yml":
        "name: g\nruns:\n  using: composite\n  steps:\n    - uses: ghost/missing@v1\n",
    };
    const err = await planWith(
      `name: x\nruns:\n  using: composite\n  steps:\n    - uses: ./g\n`,
      workspace(ghost),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.message).toContain("ghost/missing@v1");
  });
});
