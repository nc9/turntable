// github_app_status (#364): the instance view (REST, instance administrator) and the org view
// (REST and MCP, release_operator and up, scoped to the caller's own org). Neither returns
// credential material.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  type Db,
  bindRepo,
  finishDelivery,
  putSecretRecord,
  recordDelivery,
  setGithubApp,
  upsertInstallation,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { SECRET_APP_ID, SECRET_PRIVATE_KEY, SECRET_WEBHOOK } from "../src/github/app-auth";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let instanceSecret: string;
const PEM = "sealed-pem-marker";
const WEBHOOK = "sealed-webhook-marker";

const inst = (id: string, status: "active" | "suspended" | "deleted", login: string) => ({
  installationId: id,
  appId: "4242",
  accountLogin: login,
  accountId: `acct-${id}`,
  accountType: "Organization",
  repositorySelection: "selected",
  status,
});

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db, allowInstance: true, now: () => 1_700_000_000_000 };
  instanceSecret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
});

const asInstance = () =>
  dispatch(env, { kind: "bearer", token: instanceSecret }, "instance_github_app_status", {});
const asOrg = async (t: Tenant, role: "release_operator" | "operator" = "release_operator") => {
  const { secret } = await mintToken(db, { orgId: t.orgId }, role);
  return dispatch(env, { kind: "bearer", token: secret }, "github_app_status", {});
};

async function seedApp(sealed = true): Promise<void> {
  await setGithubApp(
    db,
    { orgId: a.orgId },
    {
      appId: "4242",
      slug: "turntable-test",
      name: "Turntable test",
      ownerLogin: "acme-owner",
      htmlUrl: "https://example.test/apps/turntable-test",
      clientId: "client-1",
    },
  );
  if (sealed) {
    await putSecretRecord(db, { orgId: a.orgId }, SECRET_APP_ID, "ct-id");
    await putSecretRecord(db, { orgId: a.orgId }, SECRET_PRIVATE_KEY, PEM);
    await putSecretRecord(db, { orgId: a.orgId }, SECRET_WEBHOOK, WEBHOOK);
  }
  await upsertInstallation(db, { orgId: a.orgId }, inst("1", "active", "a-acct"));
  await upsertInstallation(db, { orgId: a.orgId }, inst("2", "suspended", "a-susp"));
  await upsertInstallation(db, { orgId: b.orgId }, inst("3", "active", "b-acct"));
  await bindRepo(db, a.scope, {
    forge: "github",
    owner: "a-acct",
    repo: "svc",
    installationId: "1",
  });
  await bindRepo(db, b.scope, {
    forge: "github",
    owner: "b-acct",
    repo: "other",
    installationId: "3",
  });
  await recordDelivery(db, {
    id: "d1",
    orgId: a.orgId,
    event: "installation",
    installationId: "900",
  });
  await finishDelivery(db, "d1", "ignored", "installation not claimed by any org");
  await recordDelivery(db, {
    id: "d2",
    orgId: a.orgId,
    event: "installation",
    installationId: "1",
  });
  await finishDelivery(db, "d2", "ignored", "installation not claimed by any org");
}

describe("instance_github_app_status", () => {
  test("no App configured", async () => {
    const r = await asInstance();
    expect(r.ok && r.output).toMatchObject({
      configured: false,
      app: null,
      installations: { active: 0, suspended: 0, deleted: 0 },
      unclaimed_installation_ids: [],
    });
  });

  test("the full view: app, owner org, sealed flag, counts, unclaimed ids", async () => {
    await seedApp();
    const r = await asInstance();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toMatchObject({
      configured: true,
      app: {
        app_id: "4242",
        slug: "turntable-test",
        owner_login: "acme-owner",
        owning_org: "org-a",
        sealed: true,
      },
      installations: { active: 2, suspended: 1, deleted: 0 },
      // 1 has a row now, so only 900 is still unclaimed.
      unclaimed_installation_ids: ["900"],
    });
    expect((r.output as { app: { created_at: string } }).app.created_at).toMatch(/^\d{4}-/);
  });

  test("sealed is false when a record is missing", async () => {
    await seedApp(false);
    await putSecretRecord(db, { orgId: a.orgId }, SECRET_PRIVATE_KEY, PEM);
    const r = await asInstance();
    expect(r.ok && (r.output as { app: { sealed: boolean } }).app.sealed).toBe(false);
  });

  test("no secret material in the output", async () => {
    await seedApp();
    const r = await asInstance();
    const text = JSON.stringify(r);
    for (const m of [PEM, WEBHOOK, "ct-id", "client-1"]) expect(text).not.toContain(m);
  });

  test("REST instance token only: an org token of any role is refused, and it is no MCP tool", async () => {
    await seedApp();
    const { secret } = await mintToken(db, { orgId: a.orgId }, "release_operator");
    const r = await dispatch(
      env,
      { kind: "bearer", token: secret },
      "instance_github_app_status",
      {},
    );
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(registry.get("instance_github_app_status")!.mcp).toBe(false);
    expect(mcpTools(registry).some((t) => t.name === "instance_github_app_status")).toBe(false);
  });
});

describe("github_app_status (org view)", () => {
  test("the owning org sees owns_app and only its own installations and repos", async () => {
    await seedApp();
    const r = await asOrg(a);
    expect(r.ok && r.output).toEqual({
      owns_app: true,
      installations: [
        {
          installation_id: "1",
          account_login: "a-acct",
          account_type: "Organization",
          repository_selection: "selected",
          status: "active",
          repos: ["a-acct/svc"],
        },
        expect.objectContaining({ installation_id: "2", status: "suspended", repos: [] }),
      ],
    });
  });

  test("another org sees only its own, and does not own the App", async () => {
    await seedApp();
    const r = await asOrg(b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.output as { owns_app: boolean; installations: { installation_id: string }[] };
    expect(v.owns_app).toBe(false);
    expect(v.installations.map((i) => i.installation_id)).toEqual(["3"]);
    const text = JSON.stringify(r);
    for (const m of ["a-acct", "acme-owner", "turntable-test", "svc", "900", PEM, WEBHOOK]) {
      expect(text).not.toContain(m);
    }
  });

  test("no App: owns_app false, no installations", async () => {
    const r = await asOrg(a);
    expect(r.ok && r.output).toEqual({ owns_app: false, installations: [] });
  });

  test("release_operator may call it; operator may not", async () => {
    await seedApp();
    expect((await asOrg(a, "release_operator")).ok).toBe(true);
    const r = await asOrg(a, "operator");
    expect(!r.ok && r.error.code).toBe("forbidden");
  });

  test("the instance token is refused, and it is an MCP tool", async () => {
    const r = await dispatch(
      env,
      { kind: "bearer", token: instanceSecret },
      "github_app_status",
      {},
    );
    expect(r.ok).toBe(false);
    expect(mcpTools(registry).some((t) => t.name === "github_app_status")).toBe(true);
  });
});
