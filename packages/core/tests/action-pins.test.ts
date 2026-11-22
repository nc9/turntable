import { beforeEach, describe, expect, test } from "bun:test";
import { PlanError, planJob, type ActionRefResolver } from "@longshore/act-runner";
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
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const SHA = (c: string) => c.repeat(40);

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
      }),
    ).rejects.toThrow(/sha pins/);
    expect(gh.calls).toEqual([]);

    await setActionPolicy(db, a.scope, { requireShaPins: false });
    const plan = await resolvePlanActions(planOf(["acme/tool@v1"]), {
      db,
      scope: a.scope,
      klass: "protected",
      base: gh.resolver,
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
      }),
    ).rejects.toBeInstanceOf(MovedTagError);
  });
});

test("classes: a push is protected, a pull request is not", () => {
  expect(pinClassForEvent("push")).toBe("protected");
  expect(pinClassForEvent("pull_request")).toBe("untrusted_pr");
  expect(pinClassForEvent("pull_request_target")).toBe("untrusted_pr");
});
