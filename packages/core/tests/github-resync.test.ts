// Adopting polled bindings on an installation that was synced before the adoption existed: the
// boot sweep and the org-scoped `resync_installation` op.
import { describe, expect, test } from "bun:test";
import {
  bindRepo,
  createOrg,
  createProject,
  listAudit,
  listRepos,
  upsertInstallation,
} from "../src/db";
import { adoptPolledBindings } from "../src/github/installations";
import { dispatch, registry } from "../src/ops";
import { RESYNC_LIMIT } from "../src/ops/definitions/resync-installation";
import { fakeFacts, inst, repo, setup } from "./github-helpers";
import { mintToken } from "./ops-helpers";

/** Before the fix: the installation is recorded, its repo was skipped, the binding has no installation. */
async function preFix() {
  const w = await setup();
  const project = await createProject(w.db, { orgId: w.org.id }, { slug: "poll", name: "Poll" });
  const scope = { orgId: w.org.id, projectId: project.id };
  await bindRepo(w.db, scope, { forge: "github", owner: "acme", repo: "api" });
  await upsertInstallation(
    w.db,
    { orgId: w.org.id },
    {
      installationId: "100",
      appId: "42",
      accountLogin: "acme",
      accountId: "7",
      accountType: "Organization",
      repositorySelection: "selected",
      status: "active",
    },
  );
  const f = fakeFacts();
  f.installations.set("100", inst("100"));
  f.repos.set("100", [repo("1", "api")]);
  return { ...w, scope, f };
}

const adoptedRows = async (w: { db: Parameters<typeof listAudit>[0]; org: { id: string } }) =>
  (await listAudit(w.db, { orgId: w.org.id })).filter((a) => a.op === "adopt_repo_binding");

describe("boot sweep", () => {
  test("adopts a binding left unbound by an earlier sync, and audits it", async () => {
    const w = await preFix();
    const r = await adoptPolledBindings(w.db, w.f.facts);
    expect(r).toEqual({ adopted: ["acme/api"], failed: [] });
    expect(await listRepos(w.db, w.scope)).toMatchObject([
      { installationId: "100", forgeRepoId: "1" },
    ]);
    expect(await adoptedRows(w)).toHaveLength(1);
  });

  test("is idempotent, and makes no GitHub call when there is nothing to adopt", async () => {
    const w = await preFix();
    await adoptPolledBindings(w.db, w.f.facts);
    const calls = { ...w.f.calls };
    expect(await adoptPolledBindings(w.db, w.f.facts)).toEqual({ adopted: [], failed: [] });
    expect(w.f.calls).toEqual(calls);
    expect(await adoptedRows(w)).toHaveLength(1);
  });

  test("a failing installation is logged and audited and does not stop the sweep", async () => {
    const w = await preFix();
    w.f.installations.set("100", inst("100", "other-app"));
    const logs: string[] = [];
    const r = await adoptPolledBindings(w.db, w.f.facts, (m) => logs.push(m));
    expect(r).toEqual({ adopted: [], failed: ["100"] });
    expect(logs.join("\n")).toContain("installation 100");
    const rows = (await listAudit(w.db, { orgId: w.org.id })).filter((a) => a.op === "adopt_sweep");
    expect(rows).toMatchObject([{ outcome: "error:sync_failed" }]);
    expect(await listRepos(w.db, w.scope)).toMatchObject([{ installationId: null }]);
  });
});

describe("resync_installation", () => {
  const call = (
    w: Awaited<ReturnType<typeof preFix>>,
    secret: string,
    id = "100",
    now = 1_800_000_000_000,
  ) =>
    dispatch(
      { registry, db: w.db, githubFacts: w.f.facts, now: () => now },
      { kind: "bearer", token: secret },
      "resync_installation",
      { installation_id: id },
    );

  test("adopts the polled binding for the org that owns the installation, audited", async () => {
    const w = await preFix();
    const t = await mintToken(w.db, { orgId: w.org.id }, "release_operator");
    const r = await call(w, t.secret);
    expect(r.ok && r.output).toMatchObject({ outcome: "synced", adopted: ["acme/api"] });
    expect(await listRepos(w.db, w.scope)).toMatchObject([{ installationId: "100" }]);
    const ops = (await listAudit(w.db, { orgId: w.org.id })).filter(
      (a) => a.op === "resync_installation",
    );
    expect(ops).toMatchObject([{ outcome: "ok" }]);
  });

  test("another org's installation id is not_found and nothing is fetched", async () => {
    const w = await preFix();
    const other = await createOrg(w.db, { slug: "other", name: "Other" });
    const t = await mintToken(w.db, { orgId: other.id }, "release_operator");
    const r = await call(w, t.secret);
    expect(!r.ok && r.error.code).toBe("not_found");
    expect(w.f.calls).toEqual({ getInstallation: 0, listRepos: 0 });
    expect(await listRepos(w.db, w.scope)).toMatchObject([{ installationId: null }]);
    // Same answer as an id nobody has.
    const none = await call(w, t.secret, "999");
    expect(!none.ok && none.error.code).toBe("not_found");
  });

  test("a reader is forbidden and a project-scoped token is refused", async () => {
    const w = await preFix();
    const reader = await mintToken(w.db, { orgId: w.org.id }, "reader");
    const r = await call(w, reader.secret);
    expect(!r.ok && r.error.code).toBe("forbidden");
    const scoped = await mintToken(w.db, w.scope, "release_operator");
    const s = await call(w, scoped.secret);
    expect(!s.ok && s.error.code).toBe("forbidden");
  });

  test("is not an MCP-excluded op: it is listed for agents", () => {
    expect(registry.mcpOps().map((o) => o.name)).toContain("resync_installation");
  });

  test("is rate limited per org, and the window slides", async () => {
    const w = await preFix();
    const t = await mintToken(w.db, { orgId: w.org.id }, "release_operator");
    for (let i = 0; i < RESYNC_LIMIT; i++) expect((await call(w, t.secret)).ok).toBe(true);
    const calls = w.f.calls.getInstallation;
    const r = await call(w, t.secret);
    expect(!r.ok && r.error.code).toBe("rate_limited");
    expect(w.f.calls.getInstallation).toBe(calls);
    // Another org is not held up by this one's budget.
    const other = await createOrg(w.db, { slug: "other", name: "Other" });
    const ot = await mintToken(w.db, { orgId: other.id }, "release_operator");
    const n = await call(w, ot.secret);
    expect(!n.ok && n.error.code).toBe("not_found");
    expect((await call(w, t.secret, "100", 1_800_000_061_000)).ok).toBe(true);
  });
});
