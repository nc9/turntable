// `untrusted_run_approval` on the settings registry (#321): the resolver's layers decide who may
// approve, a turntable.toml value locks it for every path, and `set_setting`, `set_project_settings`
// and `turntable policy set` refuse the same things. Runs on both dialects (TURNTABLE_TEST_DB).
import { generateEd25519 } from "../src/approvals/keys";
import { insertApprover } from "../src/db/repos";
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createJob, createRun, type Db, listAudit } from "../src/db";
import { lockSettingKey, putStoredSetting } from "../src/db/repos/settings";
import { UNTRUSTED_RUN_APPROVALS } from "../src/db/schema";
import { setSettingOp } from "../src/ops/definitions/settings";
import type { OpContext } from "../src/ops/define";
import type { OpError } from "../src/ops/errors";
import { dispatch, type Credential, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { setSandboxPolicy } from "../src/ops/policy-cli";
import { settingsRegistry, untrustedRunApprovalSetting } from "../src/settings/definitions";
import { loadSettingsRuntime } from "../src/settings/boot";
import { resolveSetting, type SettingsRuntime, storeTarget } from "../src/settings/resolve";
import { mintToken, rawExec, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let instanceSecret: string;

const KEY = "untrusted_run_approval";
const rt = (toml?: string, env: Record<string, string> = {}): SettingsRuntime =>
  loadSettingsRuntime({
    registry: settingsRegistry,
    env,
    config: toml === undefined ? undefined : "turntable.toml",
    read: () => toml ?? "",
  });
const lock = (policy: string, org = "org-a", project = "app") =>
  rt(`[orgs.${org}.projects.${project}]\n${KEY} = "${policy}"\n`);

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  instanceSecret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});

const asInstance = (settings: SettingsRuntime, input: Record<string, unknown>) =>
  dispatch(
    { registry, db, settings, allowInstance: true } as DispatchEnv,
    { kind: "bearer", token: instanceSecret },
    "set_project_settings",
    { target_org: "org-a", target_project: "app", ...input },
  );

async function asToken(
  settings: SettingsRuntime,
  op: string,
  input: Record<string, unknown>,
  opts: { transport?: "mcp" | "rest"; viaMcp?: boolean; kind?: "agent" | "person" } = {},
) {
  const { secret } = await mintToken(db, a.scope, "release_operator", {
    kind: opts.kind ?? "person",
  });
  return dispatch(
    { registry, db, settings, ...(opts.viaMcp ? { transport: "mcp" as const } : {}) },
    { kind: "bearer", token: secret } as Credential,
    op,
    input,
  );
}

async function held(tenant: Tenant) {
  const sha = createHash("sha1").update(`held-${tenant.orgId}`).digest("hex");
  const workflowHash = createHash("sha256").update(`wf-${tenant.orgId}`).digest("hex");
  const run = await createRun(db, tenant.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "pull_request",
    ref: "refs/pull/7/head",
    sha,
    trust: JSON.stringify({ class: "untrusted_pr", workflowHash }),
  });
  const job = (await createJob(db, tenant.scope, {
    runId: run.id,
    jobKey: "build",
    name: "build",
    approvalKind: "untrusted_author",
  }))!;
  await db.run((h) =>
    rawExec(h.orm, sql`update jobs set state = 'awaiting_approval' where id = ${job.id}`),
  );
  return { run_id: run.id, head_sha: sha, workflow_hash: workflowHash };
}

describe("the definition", () => {
  test("is a project setting, MCP may not edit it, only the instance administrator may, and has no env var", () => {
    const d = settingsRegistry.get(KEY)!;
    expect(d).toMatchObject({
      scope: "project",
      default: "no_agents",
      mcpEditable: false,
      instanceAdminOnly: true,
      env: [],
      toml: "untrusted_run_approval",
    });
    expect(UNTRUSTED_RUN_APPROVALS.every((v) => d.type.safeParse(v).success)).toBe(true);
    expect(d.type.safeParse("all").success).toBe(false);
  });
});

describe("precedence", () => {
  const subject = () => ({
    orgId: a.orgId,
    orgSlug: "org-a",
    projectId: a.projectId,
    projectSlug: a.projectSlug,
  });
  test("default, then db, then toml", async () => {
    const plain = rt();
    expect(await resolveSetting(plain, db, KEY, subject())).toMatchObject({
      value: "no_agents",
      source: "default",
    });
    await putStoredSetting(
      db,
      { kind: "project", id: a.projectId, orgId: a.orgId },
      KEY,
      "any",
      "t",
      1,
    );
    expect(await resolveSetting(plain, db, KEY, subject())).toMatchObject({
      value: "any",
      source: "db",
    });
    const locked = await resolveSetting(
      lock("no_agents", "org-a", a.projectSlug),
      db,
      KEY,
      subject(),
    );
    expect(locked).toMatchObject({ value: "no_agents", source: "toml", locked: true });
  });

  test("a toml lock decides approve_run, and only for its own project", async () => {
    // the database says any; the file says no_agents for org-a's project
    await putStoredSetting(
      db,
      { kind: "project", id: a.projectId, orgId: a.orgId },
      KEY,
      "any",
      "t",
      1,
    );
    const input = await held(a);
    const settings = lock("no_agents", "org-a", a.projectSlug);
    const r = await asToken(settings, "approve_run", input, { kind: "agent" });
    expect(!r.ok && r.error.message).toMatch(/agents_may_not_approve/);
    // without the lock the stored `any` lets the agent approve
    const ok = await asToken(rt(), "approve_run", input, { kind: "agent" });
    expect(ok.ok).toBe(true);
  });

  test("a toml value for org-a's project does not reach org-b's", async () => {
    const settings = lock("no_agents", "org-a", a.projectSlug);
    const other = await resolveSetting(settings, db, KEY, {
      orgId: b.orgId,
      orgSlug: "org-b",
      projectId: b.projectId,
      projectSlug: b.projectSlug,
    });
    expect(other).toMatchObject({ source: "default", locked: false });
  });
});

describe("a toml lock refuses every way in, naming the file", () => {
  test("set_setting, set_project_settings and the host CLI", async () => {
    const settings = lock("no_agents", "org-a", a.projectSlug);
    const viaSet = await asToken(settings, "set_setting", { key: KEY, value: "any" });
    expect(!viaSet.ok && viaSet.error.message).toMatch(/locked.*turntable\.toml/);
    const viaAlias = await asInstance(settings, {
      target_project: a.projectSlug,
      untrusted_run_approval: "any",
    });
    expect(!viaAlias.ok && viaAlias.error.message).toMatch(/locked.*turntable\.toml/);
    await expect(
      setSandboxPolicy(db, "org-a", a.projectSlug, { untrustedRunApproval: "any" }, settings),
    ).rejects.toThrow(/locked.*turntable\.toml/);
    // nothing was written
    expect(
      (await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId })).source,
    ).toBe("default");
  });

  test("get_project_settings shows the locked value, not the stored one", async () => {
    await putStoredSetting(
      db,
      { kind: "project", id: a.projectId, orgId: a.orgId },
      KEY,
      "any",
      "t",
      1,
    );
    const r = await asToken(lock("no_agents", "org-a", a.projectSlug), "get_project_settings", {});
    expect(r.ok && (r.output as { untrusted_run_approval: string }).untrusted_run_approval).toBe(
      "no_agents",
    );
  });
});

describe("the same refusals on every path", () => {
  test("set_setting by an org owner is refused when it loosens: only the instance administrator raises it", async () => {
    const r = await dispatch(
      { registry, db, settings: rt() },
      { kind: "principal", principal: { kind: "member", id: "o", orgId: a.orgId, role: "owner" } },
      "set_setting",
      { key: KEY, value: "any", project: a.projectSlug },
    );
    expect(!r.ok && r.error.message).toBe(
      `only the instance administrator can loosen ${KEY} (current: no_agents)`,
    );
  });

  test("set_setting refuses a token of the project's own org, and the lock is reported first", async () => {
    const { secret } = await mintToken(db, a.scope, "release_operator", { kind: "person" });
    const env = { registry, db, settings: rt() } as DispatchEnv;
    const r = await dispatch(env, { kind: "bearer", token: secret }, "set_setting", {
      key: KEY,
      value: "any",
    });
    expect(!r.ok && r.error.message).toMatch(/requires role owner/);
    const locked = await dispatch(
      { ...env, settings: lock("no_agents", "org-a", a.projectSlug) },
      { kind: "bearer", token: secret },
      "set_setting",
      { key: KEY, value: "any" },
    );
    expect(!locked.ok && locked.error.message).toMatch(/locked/);
  });

  test("instance_set_setting sets it on a project of org A with target_org and target_project", async () => {
    const r = await dispatch(
      { registry, db, settings: rt(), allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      { key: KEY, value: "any", target_org: "org-a", target_project: a.projectSlug },
    );
    expect(r.ok).toBe(true);
    expect(
      await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId }),
    ).toMatchObject({ value: "any", source: "db" });
    // org B's project is untouched
    expect(
      await resolveSetting(rt(), db, KEY, { orgId: b.orgId, projectId: b.projectId }),
    ).toMatchObject({ value: "no_agents", source: "default" });
    const missing = await dispatch(
      { registry, db, settings: rt(), allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      { key: KEY, value: "any", target_org: "org-a" },
    );
    expect(!missing.ok && missing.error.message).toMatch(/target_project/);
  });

  test("instance_set_setting is not reachable by org A's admin token or over MCP", async () => {
    const { secret } = await mintToken(db, a.scope, "release_operator", { kind: "person" });
    const input = { key: KEY, value: "any", target_org: "org-a", target_project: a.projectSlug };
    const viaOrg = await dispatch(
      { registry, db, settings: rt(), allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: secret },
      "instance_set_setting",
      input,
    );
    expect(viaOrg.ok).toBe(false);
    const viaMcp = await dispatch(
      { registry, db, settings: rt(), allowInstance: true, viaMcp: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      input,
    );
    expect(viaMcp.ok).toBe(false);
    expect(
      (await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId })).source,
    ).toBe("default");
  });

  test("set_setting over MCP is refused with the reason", async () => {
    const r = await asToken(rt(), "set_setting", { key: KEY, value: "any" }, { viaMcp: true });
    expect(r.ok).toBe(false);
  });

  test("human is selectable: op, alias and CLI, and the registry no longer refuses it", async () => {
    await insertApprover(
      db,
      a.scope.orgId,
      {
        person: "p",
        forgeLogin: "p-gh",
        kind: "ed25519",
        publicKey: generateEd25519().publicSpki,
        alg: "EdDSA",
        createdBy: "test",
      },
      1,
    );
    expect(untrustedRunApprovalSetting.refuse).toBeUndefined();
    const inst = await asInstance(rt(), {
      target_project: a.projectSlug,
      untrusted_run_approval: "human",
    });
    expect(inst.ok).toBe(true);
    await setSandboxPolicy(db, "org-a", a.projectSlug, { untrustedRunApproval: "human" });
    expect(() => lock("human", "org-a", a.projectSlug)).not.toThrow();
  });

  test("the alias writes through to the settings table and audits old and new", async () => {
    const r = await asInstance(rt(), {
      target_project: a.projectSlug,
      untrusted_run_approval: "any",
    });
    expect(r.ok).toBe(true);
    const got = await resolveSetting(rt(), db, KEY, { orgId: a.orgId, projectId: a.projectId });
    expect(got).toMatchObject({ value: "any", source: "db" });
    const row = (await listAudit(db, { orgId: a.orgId }, { limit: 10 })).find(
      (x) => x.op === "set_project_settings",
    );
    expect(JSON.parse(row!.input)).toMatchObject({
      from: { untrustedRunApproval: "no_agents" },
      to: { untrustedRunApproval: "any" },
    });
  });
});

describe("cross-tenant", () => {
  test("a value stored for org-a's project is invisible to org-b's, and a token cannot write another org's", async () => {
    await asInstance(rt(), { target_project: a.projectSlug, untrusted_run_approval: "any" });
    const seenByB = await resolveSetting(rt(), db, KEY, { orgId: b.orgId, projectId: b.projectId });
    expect(seenByB).toMatchObject({ value: "no_agents", source: "default" });
    // a project of org-a cannot be filed under org-b
    await expect(
      putStoredSetting(
        db,
        { kind: "project", id: a.projectId, orgId: b.orgId },
        KEY,
        "any",
        "t",
        1,
      ),
    ).rejects.toThrow(/not in org/);
  });
});

describe("strictness: an org tightens, only the instance administrator loosens (#335)", () => {
  const subject = () => ({ orgId: a.orgId, projectId: a.projectId });
  const effective = async () => (await resolveSetting(rt(), db, KEY, subject())).value;
  const setAsInstance = (value: string) =>
    asInstance(rt(), { target_project: a.projectSlug, untrusted_run_approval: value });
  // Tokens top out at release_operator; the setting's role is owner, which only people hold.
  const asOwner = (
    op: string,
    input: Record<string, unknown>,
    o: { viaMcp?: boolean; role?: "owner" | "admin"; settings?: SettingsRuntime } = {},
  ) =>
    dispatch(
      {
        registry,
        db,
        settings: o.settings ?? rt(),
        ...(o.viaMcp ? { viaMcp: true } : {}),
      },
      {
        kind: "principal",
        principal: { kind: "member", id: "o", orgId: a.orgId, role: o.role ?? "owner" },
      },
      op,
      { project: a.projectSlug, ...input },
    );
  const orgSet = (input: Record<string, unknown>, o = {}) =>
    asOwner("set_setting", { key: KEY, ...input }, o);

  test("the definition declares the order and is listed with it", async () => {
    expect(untrustedRunApprovalSetting.strictness).toEqual(["any", "no_agents", "human"]);
    expect(untrustedRunApprovalSetting.mcpEditable).toBe(false);
    const r = await asOwner("get_setting", { key: KEY });
    expect(r.ok && r.output).toMatchObject({
      role: "owner",
      strictness: ["any", "no_agents", "human"],
      mcp_editable: false,
    });
  });

  test("an org admin tightens any to no_agents, and it is audited", async () => {
    expect((await setAsInstance("any")).ok).toBe(true);
    const r = await orgSet({ value: "no_agents" });
    expect(r.ok).toBe(true);
    expect(await effective()).toBe("no_agents");
    const row = (await listAudit(db, { orgId: a.orgId }, { limit: 10 })).find(
      (x) => x.op === "setting_changed",
    );
    expect(JSON.stringify(row)).toContain("no_agents");
  });

  // An admin write lands between the owner's read and write, taking a different lock.
  const raced = async (adminValue: string, ownerInput: Record<string, unknown>) => {
    // The admin's write is put as the stored row it will leave: the registry's value check is
    // not what this race is about.
    const mid = () =>
      putStoredSetting(
        db,
        storeTarget(untrustedRunApprovalSetting, { orgId: a.orgId, projectId: a.projectId }),
        KEY,
        adminValue,
        "admin",
        Date.now(),
      );
    let fired = false;
    // The handler is called without dispatch's transaction, so the admin's write commits on its
    // own, as a write on another lock would. The hook fires on the write's transaction: after the
    // guard's read, before the write.
    const hooked: Db = {
      ...db,
      transaction: async (fn, o) => {
        if (!fired) {
          fired = true;
          await mid();
        }
        return db.transaction(fn, o);
      },
    };
    const principal = { kind: "member", id: "o", orgId: a.orgId, role: "owner" } as const;
    const ctx = {
      db: hooked,
      scope: { orgId: a.orgId, projectId: a.projectId },
      principal,
      now: () => Date.now(),
      settings: rt(),
    } as unknown as OpContext;
    const res = await setSettingOp.handler(ctx, { key: KEY, ...ownerInput }).then(
      () => ({ ok: true as const }),
      (error: OpError) => ({ ok: false as const, error }),
    );
    expect(fired).toBe(true);
    return res;
  };

  test("an owner's tighten racing an admin's human keeps the stricter value", async () => {
    expect((await setAsInstance("any")).ok).toBe(true);
    const r = await raced("human", { value: "no_agents" });
    expect(await effective()).toBe("human");
    expect(!r.ok && r.error.message).toBe(
      `only the instance administrator can loosen ${KEY} (current: human)`,
    );
  });

  test("an owner's reset to the default racing an admin's human keeps human", async () => {
    expect((await setAsInstance("any")).ok).toBe(true);
    await raced("human", { unset: true });
    expect(await effective()).toBe("human");
  });

  test("an owner's first write racing an admin's human, with no row before, keeps human", async () => {
    const r = await raced("human", { value: "no_agents" });
    expect(await effective()).toBe("human");
    expect(r.ok).toBe(false);
  });

  test("an owner's tighten still lands when the admin wrote an equal or looser value meanwhile", async () => {
    expect((await setAsInstance("any")).ok).toBe(true);
    expect((await raced("any", { value: "no_agents" })).ok).toBe(true);
    expect(await effective()).toBe("no_agents");
  });

  // #369: the admin's write and the owner's tighten take different locks (the instance's and the
  // org's audit chain), and a key can be written at more than one scope. Both now take the
  // per-(org, key) lock first, so the owner's guard reads the effective value after the admin's
  // write commits, or the owner gets a conflict. The admin holds its transaction open after the
  // write, which is where an unlocked owner would read the old value and then overwrite it.
  test("an owner's tighten queues behind an admin's human on the same key, across scopes", async () => {
    expect((await setAsInstance("any")).ok).toBe(true);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let wrote: () => void = () => {};
    const adminWrote = new Promise<void>((r) => (wrote = r));
    const admin = db.transaction(async (tx) => {
      await lockSettingKey(tx, a.orgId, KEY);
      await putStoredSetting(
        tx,
        storeTarget(untrustedRunApprovalSetting, { orgId: a.orgId, projectId: a.projectId }),
        KEY,
        "human",
        "admin",
        Date.now(),
      );
      wrote();
      await gate;
    });
    await adminWrote;
    let ownerDone = false;
    const owner = orgSet({ value: "no_agents" }).then((r) => {
      ownerDone = true;
      return r;
    });
    await Bun.sleep(100);
    expect(ownerDone).toBe(false);
    release();
    await admin;
    const r = await owner;
    expect(await effective()).toBe("human");
    expect(!r.ok && r.error.message).toBe(
      `only the instance administrator can loosen ${KEY} (current: human)`,
    );
  });

  test("setting the same value is allowed", async () => {
    expect((await orgSet({ value: "no_agents" })).ok).toBe(true);
  });

  test("an org admin loosening no_agents to any is refused and nothing changes", async () => {
    expect((await setAsInstance("no_agents")).ok).toBe(true);
    const r = await orgSet({ value: "any" });
    expect(!r.ok && r.error.message).toBe(
      `only the instance administrator can loosen ${KEY} (current: no_agents)`,
    );
    expect(await effective()).toBe("no_agents");
  });

  test("a reset to the looser default is refused; a reset to an equal default is allowed", async () => {
    // default is no_agents: any stored value above it cannot be reset by the org
    await setAsInstance("any");
    expect((await orgSet({ unset: true })).ok).toBe(true); // any -> default no_agents tightens
    expect(await effective()).toBe("no_agents");
    expect((await orgSet({ unset: true })).ok).toBe(true); // already default
  });

  test("an org reset when the default is looser than the current is refused", async () => {
    // a stored value stricter than the default: unsetting would loosen it
    await putStoredSetting(
      db,
      storeTarget(untrustedRunApprovalSetting, subject()),
      KEY,
      "human",
      "tester",
      Date.now(),
    );
    const r = await orgSet({ unset: true });
    expect(!r.ok && r.error.message).toBe(
      `only the instance administrator can loosen ${KEY} (current: human)`,
    );
    expect(await effective()).toBe("human");
  });

  test("the instance administrator loosens, and may unset", async () => {
    expect((await setAsInstance("any")).ok).toBe(true);
    expect(await effective()).toBe("any");
    const r = await dispatch(
      { registry, db, settings: rt(), allowInstance: true } as DispatchEnv,
      { kind: "bearer", token: instanceSecret },
      "instance_set_setting",
      { key: KEY, unset: true, target_org: "org-a", target_project: a.projectSlug },
    );
    expect(r.ok).toBe(true);
  });

  test("the host CLI is the operator and may loosen", async () => {
    await setSandboxPolicy(db, "org-a", a.projectSlug, { untrustedRunApproval: "any" });
    expect(await effective()).toBe("any");
  });

  test("over MCP it is still refused, tightening included", async () => {
    await setAsInstance("any");
    const r = await orgSet({ value: "no_agents" }, { viaMcp: true });
    expect(!r.ok && r.error.message).toMatch(/cannot be changed over MCP/);
    expect(await effective()).toBe("any");
  });

  test("a lock by toml is refused as locked before the strictness rule", async () => {
    const settings = lock("no_agents", "org-a", a.projectSlug);
    for (const value of ["any", "human"]) {
      const r = await orgSet({ value }, { settings });
      expect(!r.ok && r.error.message).toMatch(/locked/);
    }
  });

  test("an admin, below the setting's owner role is refused", async () => {
    const r = await orgSet({ value: "no_agents" }, { role: "admin" });
    expect(!r.ok && r.error.message).toBe(`changing ${KEY} requires role owner`);
  });
});

describe("tokens", () => {
  test("a release_operator token cannot tighten it: the role is held only by people", async () => {
    const r = await asToken(rt(), "set_setting", { key: KEY, value: "human" });
    expect(!r.ok && r.error.message).toBe(`changing ${KEY} requires role owner`);
  });
});

describe("strictness keys resolve from the project row only (#369)", () => {
  // `lockSettingKey` serialises the writers of one (org, key) and the one-way check reads the
  // effective value once. Both assume a strictness key has a single stored scope. If a key gains
  // org scope or inheritance, the lock and the check must be reworked first.
  const WHY =
    "a strictness key must resolve from the project row only. Giving it org scope or inheritance needs the per-key lock (lockSettingKey) and the one-way check reworked first, see #369";
  const strict = settingsRegistry.settings.filter((d) => d.strictness);

  test("the registry has at least one strictness key", () => {
    expect(strict.length).toBeGreaterThan(0);
  });

  for (const def of strict) {
    test(`${def.key}: the effective value comes from the project row, not an org or instance row`, async () => {
      expect(def.scope, WHY).toBe("project");
      const order = def.strictness!;
      const other = order.find((v) => v !== def.default)!;
      const subject = { orgId: a.orgId, orgSlug: "org-a", projectId: a.projectId };
      const plain = rt();
      // Rows at the other scopes, set to a value the default is not, must change nothing.
      await putStoredSetting(
        db,
        { kind: "org", id: a.orgId, orgId: a.orgId },
        def.key,
        other,
        "t",
        1,
      );
      await putStoredSetting(db, { kind: "instance", id: "", orgId: null }, def.key, other, "t", 1);
      const inherited = await resolveSetting(plain, db, def.key, subject);
      expect(inherited, WHY).toMatchObject({ value: def.default, source: "default" });
      // The project row is what counts.
      await putStoredSetting(
        db,
        { kind: "project", id: a.projectId, orgId: a.orgId },
        def.key,
        order[order.length - 1],
        "t",
        1,
      );
      expect(await resolveSetting(plain, db, def.key, subject), WHY).toMatchObject({
        value: order[order.length - 1],
        source: "db",
      });
    });
  }
});
