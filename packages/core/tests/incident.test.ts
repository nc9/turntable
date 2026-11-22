import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAudit,
  claimNextAttempt,
  clearRotationFlag,
  clearRotationFlagIfRotated,
  listOpenRotationFlags,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  getJob,
  getRun,
  listAudit,
  listAttempts,
  openDatabase,
  putSecretRecord,
} from "../src/db";
import { onAttemptsCancelled } from "../src/db/abort-bus";
import { incidentCommand } from "../src/incident/cli";
import { registerCredentialRevoker } from "../src/incident";
import { SecretStore } from "../src/secrets/store";
import { SecretVault } from "../src/secrets/vault";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { USAGE_SCAN_LIMIT } from "../src/ops/definitions/secret-usage";
import { createRestApi } from "../src/ops/rest";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let release: string;
let reader: string;

const claimOpts = () => ({
  owner: "w1",
  leaseMs: 60_000,
  now: Date.now(),
  globalCap: 50,
  perOrgCap: 50,
});

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db };
  release = (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret;
  reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
});

async function run<T = any>(op: string, input: unknown = {}, tok = release): Promise<T> {
  const res = await dispatch(env, { kind: "bearer", token: tok }, op, input);
  if (!res.ok) throw new Error(`${op}: ${res.error.code} ${res.error.message}`);
  return res.output as T;
}
const fail = async (op: string, input: unknown, tok: string) => {
  const res = await dispatch(env, { kind: "bearer", token: tok }, op, input);
  return res.ok ? null : res.error.code;
};

describe("freeze and unfreeze", () => {
  test("a frozen org is never claimed; other orgs are; unfreeze resumes", async () => {
    const out = await run("incident_freeze", { reason: "leaked deploy key" });
    expect(out).toMatchObject({ frozen: true, level: "org", already_frozen: false });
    // org-a's queued attempt is skipped, org-b's is claimed.
    const first = await claimNextAttempt(db, claimOpts());
    expect(first?.attempt.orgId).toBe(b.orgId);
    expect(await claimNextAttempt(db, claimOpts())).toBeUndefined();

    const un = await run("incident_unfreeze");
    expect(un).toEqual({ was_frozen: true, level: "org", still_frozen_by: null });
    const resumed = await claimNextAttempt(db, claimOpts());
    expect(resumed?.attempt.orgId).toBe(a.orgId);
  });

  test("a project freeze blocks only that project; the org freeze outlives a project unfreeze", async () => {
    const second = await createProject(db, { orgId: a.orgId }, { slug: "web", name: "Web" });
    const sc = { orgId: a.orgId, projectId: second.id };
    const run2 = await createRun(db, sc, {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
      sha: "b".repeat(40),
    });
    const job2 = (await createJob(db, sc, { runId: run2.id, jobKey: "t", name: "t" }))!;
    await createAttempt(db, sc, { jobId: job2.id, provider: "test" });

    await run("incident_freeze", { reason: "web compromised", project: "web" });
    const claimed: string[] = [];
    for (;;) {
      const c = await claimNextAttempt(db, claimOpts());
      if (!c) break;
      claimed.push(c.attempt.projectId);
    }
    expect(claimed).not.toContain(second.id);
    expect(claimed).toContain(a.projectId);

    // Freeze the org on top, then lift the project: the org freeze still holds.
    await run("incident_freeze", { reason: "all of it" });
    const un = await run("incident_unfreeze", { project: "web" });
    expect(un).toEqual({ was_frozen: true, level: "project", still_frozen_by: "org" });
    expect(await claimNextAttempt(db, claimOpts())).toBeUndefined();
    const status = await run("incident_status", { project: "web" });
    expect(status).toMatchObject({ frozen: true, level: "org", reason: "all of it" });
    await run("incident_unfreeze");
    expect((await run("incident_status")).frozen).toBe(false);
  });

  test("freezing again keeps the first reason and time", async () => {
    const one = await run("incident_freeze", { reason: "first reason" });
    const two = await run("incident_freeze", { reason: "second reason" });
    expect(two.already_frozen).toBe(true);
    expect(two.reason).toBe("first reason");
    expect(two.frozen_at).toBe(one.frozen_at);
  });

  test("kills running jobs through the cancel path; queued-only runs stay queued", async () => {
    const claimed = await claimNextAttempt(db, claimOpts()); // org-a's (oldest first)
    expect(claimed).toBeDefined();
    const orgOfClaim = claimed!.attempt.orgId;
    const t = orgOfClaim === a.orgId ? a : b;
    const announced: string[] = [];
    const off = onAttemptsCancelled((xs) => announced.push(...xs.map((x) => x.attemptId)));
    // A second, queued-only run in the same org.
    const queuedRun = await createRun(db, t.scope, {
      workflowPath: ".github/workflows/other.yml",
      event: "push",
      ref: "refs/heads/main",
      sha: "c".repeat(40),
    });
    const queuedJob = (await createJob(db, t.scope, {
      runId: queuedRun.id,
      jobKey: "q",
      name: "q",
    }))!;
    await createAttempt(db, t.scope, { jobId: queuedJob.id, provider: "test" });
    const tok =
      t === a ? release : (await mintToken(db, { orgId: b.orgId }, "release_operator")).secret;
    try {
      const out = await run("incident_freeze", { reason: "kill it" }, tok);
      expect(out).toMatchObject({ cancelled_runs: 1, killed_jobs: 1 });
    } finally {
      off();
    }
    expect(announced).toEqual([claimed!.attempt.id]);
    expect((await getJob(db, t.scope, t.jobId))?.state).toBe("cancelled");
    expect((await getRun(db, t.scope, t.runId))?.status).toBe("cancelled");
    const attempts = await listAttempts(db, t.scope, t.jobId);
    expect(attempts.every((x) => x.state === "cancelled" && x.leaseOwner === null)).toBe(true);
    // The queued-only run was not touched and resumes after unfreeze.
    expect((await getJob(db, t.scope, queuedJob.id))?.state).toBe("queued");
    await run("incident_unfreeze", {}, tok);
    const claimedAfter: string[] = [];
    for (;;) {
      const c = await claimNextAttempt(db, claimOpts());
      if (!c) break;
      claimedAfter.push(c.job.id);
    }
    expect(claimedAfter).toContain(queuedJob.id);
  });

  test("freeze is audited with the reason; denied callers are audited too", async () => {
    await run("incident_freeze", { reason: "audit me" });
    await run("incident_unfreeze");
    expect(
      await fail(
        "incident_freeze",
        { reason: "nope nope" },
        (await mintToken(db, { orgId: a.orgId }, "operator")).secret,
      ),
    ).toBe("forbidden");
    const rows = await listAudit(db, { orgId: a.orgId }, { limit: 20 });
    const freeze = rows.find((r) => r.op === "incident_freeze" && r.outcome === "ok");
    expect(freeze).toBeDefined();
    expect(freeze!.effect).toBe("destructive");
    expect(JSON.parse(freeze!.input)).toMatchObject({ reason: "audit me" });
    expect(rows.some((r) => r.op === "incident_unfreeze" && r.outcome === "ok")).toBe(true);
    expect(rows.some((r) => r.op === "incident_freeze" && r.outcome === "error:forbidden")).toBe(
      true,
    );
  });

  test("roles: reporting needs reader, changing needs release_operator; the reason is required", async () => {
    expect(await fail("incident_freeze", { reason: "x".repeat(10) }, reader)).toBe("forbidden");
    expect(await fail("incident_unfreeze", {}, reader)).toBe("forbidden");
    expect((await run("incident_status", {}, reader)).frozen).toBe(false);
    expect(await fail("incident_freeze", {}, release)).toBe("invalid_input");
    expect(await fail("incident_freeze", { reason: "  " }, release)).toBe("invalid_input");
    expect(await fail("incident_freeze", { reason: "ok reason", extra: 1 }, release)).toBe(
      "invalid_input",
    );
  });

  test("a freeze in one org never touches another", async () => {
    await run("incident_freeze", { reason: "org a only" });
    const bTok = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
    expect((await run("incident_status", {}, bTok)).frozen).toBe(false);
    expect(await fail("incident_freeze", { reason: "cross org", org: b.slug }, release)).toBe(
      "not_found",
    );
  });

  test("REST: POST /incident/freeze and GET /incident", async () => {
    const api = createRestApi(env);
    const call = async (method: string, path: string, body?: unknown, tok = release) =>
      (await api(
        new Request(`http://x/api/v1${path}`, {
          method,
          headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      ))!;
    const res = await call("POST", "/incident/freeze", { reason: "via rest" });
    expect(res.status).toBe(200);
    expect(((await (await call("GET", "/incident", undefined, reader)).json()) as any).reason).toBe(
      "via rest",
    );
  });
});

describe("credentials and secrets", () => {
  test("drops minted credentials through registered revokers", async () => {
    let dropped = 0;
    const off = registerCredentialRevoker({
      name: "test-cache",
      revoke: () => {
        dropped++;
        return 3;
      },
    });
    try {
      const out = await run("incident_freeze", { reason: "drop tokens" });
      expect(out.cached_tokens_dropped).toBe(3);
      expect(dropped).toBe(1);
    } finally {
      off();
    }
  });

  test("flags every secret in scope, keeps the flags on unfreeze, and a second freeze adds none", async () => {
    await putSecretRecord(db, { orgId: a.orgId }, "GITHUB_APP_KEY", "sealed");
    await putSecretRecord(db, { orgId: a.orgId }, "WEBHOOK_SECRET", "sealed");
    await putSecretRecord(db, { orgId: b.orgId }, "OTHER_ORG", "sealed");
    const out = await run("incident_freeze", { reason: "rotate all" });
    expect(out.flagged_for_rotation).toBe(2);
    await run("incident_unfreeze");
    const status = await run("incident_status", {}, release);
    expect(status.rotation_required.map((r: { name: string }) => r.name)).toEqual([
      "GITHUB_APP_KEY",
      "WEBHOOK_SECRET",
    ]);
    expect(status.rotation_required[0]).toMatchObject({ reason: "rotate all" });
    expect((await run("incident_freeze", { reason: "again" })).flagged_for_rotation).toBe(0);
    // Updating the built-in store's secret closes its flag.
    const store = new SecretStore(db, randomBytes(32));
    await store.set(a.orgId, "GITHUB_APP_KEY", "new value");
    const after = await run("incident_status", {}, release);
    expect(after.rotation_required.map((r: { name: string }) => r.name)).toEqual([
      "WEBHOOK_SECRET",
    ]);
    // Never another org's secrets.
    const bTok = (await mintToken(db, { orgId: b.orgId }, "release_operator")).secret;
    expect((await run("incident_status", {}, bTok)).rotation_required).toEqual([]);
  });

  test("a reader sees how many secrets need rotation, never which; release_operator sees names", async () => {
    await putSecretRecord(db, { orgId: a.orgId }, "GITHUB_APP_KEY", "sealed");
    await putSecretRecord(db, { orgId: a.orgId }, "WEBHOOK_SECRET", "sealed");
    await run("incident_freeze", { reason: "leak" });
    const asReader = await run("incident_status", {}, reader);
    expect(asReader.rotation_required_count).toBe(2);
    expect(asReader.rotation_required).toEqual([]);
    expect(JSON.stringify(asReader)).not.toContain("GITHUB_APP_KEY");
    const op = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
    expect((await run("incident_status", {}, op)).rotation_required).toEqual([]);
    const asRelease = await run("incident_status", {}, release);
    expect(asRelease.rotation_required_count).toBe(2);
    expect(asRelease.rotation_required).toHaveLength(2);
    // REST is the same.
    const api = createRestApi(env);
    const res = await api(
      new Request("http://x/api/v1/incident", { headers: { authorization: `Bearer ${reader}` } }),
    );
    expect(JSON.stringify(await res!.json())).not.toContain("WEBHOOK_SECRET");
  });

  test("a flag is cleared only by an update in the store that raised it", async () => {
    // The same name in both stores.
    await putSecretRecord(db, { orgId: a.orgId }, "SHARED", "sealed");
    env = { registry, db, vault: new SecretVault({ db, masterKey: randomBytes(32) }) };
    await run("set_secret", { name: "SHARED", value: "v1" });
    await sleep(5);
    await run("incident_freeze", { reason: "leak" });
    const sources = async () =>
      (await listOpenRotationFlags(db, { orgId: a.orgId })).map((f) => f.name).toSorted();
    expect(await sources()).toEqual(["SHARED", "SHARED"]);
    await sleep(5);
    // Rotating in the vault closes the vault's flag, not the built-in one.
    await run("rotate_secret", { name: "SHARED", value: "v2" });
    expect(await sources()).toEqual(["SHARED"]);
    expect(await clearRotationFlag(db, { orgId: a.orgId }, "SHARED", "vault", Date.now())).toBe(
      false,
    );
    // The built-in store closes its own.
    await new SecretStore(db, randomBytes(32)).set(a.orgId, "SHARED", "new");
    expect(await sources()).toEqual([]);
  });

  test("a project-scoped caller can close only its own project's flags, never an org-wide one", async () => {
    env = { registry, db, vault: new SecretVault({ db, masterKey: randomBytes(32) }) };
    await run("set_secret", { name: "ORG_KEY", value: "v1" });
    await sleep(5);
    await run("incident_freeze", { reason: "org wide" }); // the flag has no project
    // Every vault row of the name was updated after the flag was raised.
    await db.run(async (h) => {
      await h.orm.run(sql`update vault_secrets set updated_at = ${Date.now() + 1000}`);
    });
    const project = { orgId: a.orgId, projectId: a.projectId };
    expect(await clearRotationFlagIfRotated(db, project, "ORG_KEY", Date.now())).toBe(false);
    expect(await clearRotationFlag(db, project, "ORG_KEY", "vault", Date.now())).toBe(false);
    expect((await listOpenRotationFlags(db, { orgId: a.orgId })).length).toBe(1);
    // A project-scoped token rotating through the op cannot close it either.
    const projTok = (await mintToken(db, project, "release_operator")).secret;
    await run("set_secret", { name: "PROJ_KEY", value: "p1", project: a.projectSlug }, projTok);
    await run("rotate_secret", { name: "ORG_KEY", value: "v2" }, projTok).catch(() => {});
    expect((await listOpenRotationFlags(db, { orgId: a.orgId })).length).toBe(1);
    // The org-scoped caller can.
    expect(await clearRotationFlagIfRotated(db, { orgId: a.orgId }, "ORG_KEY", Date.now())).toBe(
      true,
    );
  });
});

describe("vault secrets", () => {
  beforeEach(() => {
    env = { registry, db, vault: new SecretVault({ db, masterKey: randomBytes(32) }) };
  });

  test("a freeze flags vault secret names; rotating every scope of a name clears its flag", async () => {
    await run("set_secret", { name: "DEPLOY_KEY", value: "v1-org" });
    await run("set_secret", { name: "DEPLOY_KEY", value: "v1-proj", project: a.projectSlug });
    await run("set_secret", { name: "NPM_TOKEN", value: "v1-npm" });
    await sleep(5);
    const out = await run("incident_freeze", { reason: "vault leak" });
    expect(out.flagged_for_rotation).toBe(2);
    const names = async () =>
      (await run("incident_status", {}, release)).rotation_required.map(
        (r: { name: string }) => r.name,
      );
    expect(await names()).toEqual(["DEPLOY_KEY", "NPM_TOKEN"]);
    await sleep(5);
    // Rotating the org-level DEPLOY_KEY leaves the project-level one on its old value.
    await run("rotate_secret", { name: "DEPLOY_KEY", value: "v2-org" });
    expect(await names()).toEqual(["DEPLOY_KEY", "NPM_TOKEN"]);
    await run("rotate_secret", { name: "DEPLOY_KEY", value: "v2-proj", project: a.projectSlug });
    expect(await names()).toEqual(["NPM_TOKEN"]);
    // set_secret on an existing scope is a rotation too.
    await run("set_secret", { name: "NPM_TOKEN", value: "v2-npm" });
    expect(await names()).toEqual([]);
    // Unfreezing never cleared anything on its own.
    await run("incident_unfreeze");
  });

  test("a project freeze flags only that project's vault secrets", async () => {
    await run("set_secret", { name: "ORG_ONLY", value: "x" });
    await run("set_secret", { name: "PROJ_ONLY", value: "y", project: a.projectSlug });
    const out = await run("incident_freeze", { reason: "project leak", project: a.projectSlug });
    expect(out.flagged_for_rotation).toBe(1);
    const status = await run("incident_status", { project: a.projectSlug }, release);
    expect(status.rotation_required.map((r: { name: string }) => r.name)).toEqual(["PROJ_ONLY"]);
  });
});

describe("secret_usage", () => {
  const T0 = Date.parse("2026-11-20T10:00:00Z");
  async function use(t: Tenant, secret: string, at: number, extra: Record<string, unknown> = {}) {
    // The shape SecretVault.use writes; the row's time is set directly for a stable range.
    await appendAudit(db, t.scope, {
      principalKind: "attempt",
      principalId: t.attemptId,
      op: "secret_use",
      effect: "use",
      outcome: "ok",
      input: {
        secret,
        secret_id: "sid",
        version: 2,
        run: t.runId,
        job: t.jobId,
        attempt: t.attemptId,
        destination: "api.example.com",
        class: "protected",
        ...extra,
      },
    });
    await db.run(async (h) => {
      await h.orm.run(
        sql`update audit_log set created_at = ${at} where id = (select id from audit_log where op = 'secret_use' order by rowid desc limit 1)`,
      );
    });
  }

  test("lists uses of the named secret in the range, with where they went", async () => {
    await use(a, "DEPLOY_KEY", T0);
    await use(a, "DEPLOY_KEY", T0 + 60_000, { destination: "registry.npmjs.org" });
    await use(a, "OTHER_KEY", T0 + 1000);
    await use(a, "DEPLOY_KEY", T0 + 3_600_000 * 5); // outside the range
    await use(b, "DEPLOY_KEY", T0 + 2000); // another org
    const out = await run("secret_usage", {
      name: "DEPLOY_KEY",
      since: "2026-11-20T09:00:00Z",
      until: "2026-11-20T11:00:00Z",
    });
    expect(out.total).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.uses.map((u: { destination: string }) => u.destination)).toEqual([
      "api.example.com",
      "registry.npmjs.org",
    ]);
    expect(out.uses[0]).toMatchObject({
      at: "2026-11-20T10:00:00.000Z",
      run_id: a.runId,
      job_id: a.jobId,
      attempt_id: a.attemptId,
      version: 2,
      trust_class: "protected",
    });
    // The other org's use and the other secret never appear.
    expect(JSON.stringify(out)).not.toContain(b.runId);
  });

  test("project-scoped tokens only see their project; reader and operator are refused; bad ranges are refused", async () => {
    const second = await createProject(db, { orgId: a.orgId }, { slug: "web", name: "Web" });
    const other = { ...a, scope: { orgId: a.orgId, projectId: second.id } } as Tenant;
    await use(a, "DEPLOY_KEY", T0);
    await use(other, "DEPLOY_KEY", T0 + 1000);
    const projTok = (
      await mintToken(db, { orgId: a.orgId, projectId: a.projectId }, "release_operator")
    ).secret;
    const range = {
      name: "DEPLOY_KEY",
      since: "2026-11-20T00:00:00Z",
      until: "2026-11-21T00:00:00Z",
    };
    expect(await fail("secret_usage", range, reader)).toBe("forbidden");
    expect(
      await fail(
        "secret_usage",
        range,
        (await mintToken(db, { orgId: a.orgId }, "operator")).secret,
      ),
    ).toBe("forbidden");
    expect((await run("secret_usage", range, projTok)).total).toBe(1);
    expect((await run("secret_usage", range, release)).total).toBe(2);
    expect(await fail("secret_usage", { ...range, since: "yesterday-ish" }, release)).toBe(
      "invalid_input",
    );
    expect(await fail("secret_usage", { ...range, since: "2026-11-22T00:00:00Z" }, release)).toBe(
      "invalid_input",
    );
  });

  test("a truncated audit entry is skipped, and the scan cap is reported", async () => {
    await appendAudit(db, a.scope, {
      principalKind: "attempt",
      principalId: "x",
      op: "secret_use",
      effect: "use",
      outcome: "ok",
      input: { secret: "DEPLOY_KEY", pad: "x".repeat(5000) },
    });
    const out = await run("secret_usage", {
      name: "DEPLOY_KEY",
      since: "2020-01-01T00:00:00Z",
    });
    expect(out.total).toBe(0);
    expect(USAGE_SCAN_LIMIT).toBeGreaterThan(1000);
  });
});

describe("CLI", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "ls-incident-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("freeze, status and unfreeze as the local owner, audited", async () => {
    const file = openDatabase(join(dir, "longshore.db"));
    const org = await createOrg(file, { slug: "acme", name: "Acme" });
    file.close();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (m: string) => void logs.push(m);
    try {
      expect(
        await incidentCommand([
          "freeze",
          "--org",
          "acme",
          "--reason",
          "test freeze",
          "--data-dir",
          dir,
        ]),
      ).toBe(0);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ frozen: true, level: "org" });
      expect(await incidentCommand(["status", "--org", "acme", "--data-dir", dir])).toBe(0);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        frozen: true,
        reason: "test freeze",
        frozen_by: "member:cli",
      });
      expect(await incidentCommand(["unfreeze", "--org", "acme", "--data-dir", dir])).toBe(0);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ was_frozen: true });
    } finally {
      console.log = origLog;
    }
    const check = openDatabase(join(dir, "longshore.db"));
    const rows = await listAudit(check, { orgId: org.id });
    expect(rows.map((r) => r.op)).toContain("incident_freeze");
    check.close();
    const err = console.error;
    console.error = () => {};
    try {
      expect(await incidentCommand(["freeze", "--org", "acme", "--data-dir", dir])).toBe(2); // no reason
      expect(
        await incidentCommand(["freeze", "--org", "nope", "--reason", "x y z", "--data-dir", dir]),
      ).toBe(1);
      expect(await incidentCommand(["bogus", "--org", "acme"])).toBe(2);
    } finally {
      console.error = err;
    }
  });
});
