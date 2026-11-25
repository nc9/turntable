// Org installation ownership (#573): the App cannot read org membership, so an Organization's
// installation is owned by its recorded installer (a verified `installation` webhook's sender, by
// numeric id) or an active admin. Also the instance operator's fallback, instance_bind_installation.
import { afterAll, describe, expect, test } from "bun:test";
import {
  createOrg,
  type Db,
  getInstallation,
  getInstallationInstaller,
  listAudit,
  listEvents,
  listProjects,
  openDatabase,
  recordInstallationInstaller,
  upsertInstallation,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import {
  CLAIM_PATH,
  claimCookieName,
  createClaimHandler,
  InstallationClaims,
} from "../src/github/claim";
import { notInstallationOwnerMessage, ownershipUnverifiableMessage } from "../src/github/ownership";
import { createWebhookHandler, WEBHOOK_PATH } from "../src/github/webhook";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import {
  fakeFacts,
  fakeUserVerifier,
  type FakeClaimUser,
  inst,
  ownerOf100,
  repo,
  setup,
  sign,
  WEBHOOK_SECRET,
} from "./github-helpers";
import { mintToken } from "./ops-helpers";

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite"
    ? { url: t, schema: `lstest_installer_${process.pid}` }
    : { pglite: true };
};

const opened: Db[] = [];
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];
afterAll(() => {
  for (const db of opened) db.close();
});

describe.each(dialects)("org installation ownership (%s)", (_n, open) => {
  async function harness() {
    const s = await setup("42", open);
    opened.push(s.db);
    const tenant = await createOrg(s.db, { slug: "tenant-b", name: "Tenant B" });
    const other = await createOrg(s.db, { slug: "tenant-c", name: "Tenant C" });
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api"), repo("2", "web")]);
    const claims = new InstallationClaims({ db: s.db, store: s.store });
    const users = new Map<string, FakeClaimUser>();
    const handler = createClaimHandler({
      claims,
      facts: f.facts,
      user: fakeUserVerifier(users),
      log: () => {},
    });
    const hook = createWebhookHandler({
      db: s.db,
      store: s.store,
      facts: f.facts,
      claimMode: true,
      log: () => {},
    });
    const env: DispatchEnv = {
      registry,
      db: s.db,
      claims,
      githubFacts: f.facts,
      allowInstance: true,
      instanceOrgCap: 4,
    };
    const tti = (await createInstanceTokenFromCli(s.db, { name: "ops" })).secret;
    const post = async (
      body: unknown,
      h: { event?: string; secret?: string; guid?: string } = {},
    ): Promise<Response | undefined> => {
      const raw = JSON.stringify(body);
      return hook.handle(
        new Request(`http://x${WEBHOOK_PATH}`, {
          method: "POST",
          headers: {
            "x-github-event": h.event ?? "installation",
            "x-github-delivery": h.guid ?? crypto.randomUUID(),
            "x-hub-signature-256": sign(h.secret ?? WEBHOOK_SECRET, raw),
          },
          body: raw,
        }),
      );
    };
    const installEvent = (action: string, senderId: number, login = "someone") => ({
      action,
      installation: { id: 100 },
      sender: { id: senderId, login },
    });
    /** Runs a claim for `orgId` as the user behind `code`; resolves to the callback response. */
    const claim = async (code: string, orgId = tenant.id, installationId = "100") => {
      const r = await claims.start(orgId, "p", {});
      const state = new URL(r.url, "http://x").searchParams.get("state")!;
      const n = (
        JSON.parse(Buffer.from(state.split(".")[1] ?? "", "base64url").toString()) as {
          n: string;
        }
      ).n;
      return (await handler.handle(
        new Request(
          `http://x${CLAIM_PATH}?${new URLSearchParams({
            installation_id: installationId,
            setup_action: "install",
            state,
            code,
          })}`,
          { headers: { cookie: `${claimCookieName(n)}=${n}` } },
        ),
      ))!;
    };
    const userOf = (extra: Partial<FakeClaimUser> = {}): FakeClaimUser => ({
      ...ownerOf100,
      id: "9",
      adminOf: [],
      membershipFails: true,
      ...extra,
    });
    return { ...s, tenant, other, f, users, env, tti, post, installEvent, claim, userOf, hook };
  }

  const refusalAudit = async (h: { db: Db; tenant: { id: string } }) => {
    const rows = await listAudit(h.db, { orgId: h.tenant.id });
    const row = rows.find((e) => e.outcome === "error:forbidden");
    return row ? (JSON.parse(row.input) as { refusal?: string; reason?: string }) : undefined;
  };

  test("recorded installer is the claimant: accepted with the membership call 403", async () => {
    const h = await harness();
    await recordInstallationInstaller(h.db, {
      installationId: "100",
      githubId: "9",
      login: "owner-b",
      recordedAt: 1,
    });
    h.users.set("c", h.userOf());
    expect((await h.claim("c")).status).toBe(200);
    expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenant.id);
    // The installation is a permission: no project exists until someone adds a repo (#577).
    expect(await listProjects(h.db, { orgId: h.tenant.id })).toHaveLength(0);
  });

  test("another recorded installer with membership 403: refused ownership_unverifiable", async () => {
    const h = await harness();
    await recordInstallationInstaller(h.db, {
      installationId: "100",
      githubId: "77",
      login: "owner-b", // same login, different numeric id: logins never count
      recordedAt: 1,
    });
    h.users.set("c", h.userOf());
    const res = await h.claim("c");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("could not verify that you own acme");
    expect(ownershipUnverifiableMessage("acme")).toContain("Recent Deliveries");
    expect(await getInstallation(h.db, "100")).toBeUndefined();
    expect((await refusalAudit(h))?.refusal).toBe("ownership_unverifiable");
  });

  test("membership admin with no installer recorded: accepted", async () => {
    const h = await harness();
    h.users.set("c", h.userOf({ membershipFails: false, adminOf: ["acme"] }));
    expect((await h.claim("c")).status).toBe(200);
  });

  test("membership ok but member, no installer match: refused not_owner", async () => {
    const h = await harness();
    h.users.set("c", h.userOf({ membershipFails: false }));
    const res = await h.claim("c");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(notInstallationOwnerMessage("acme"));
    expect((await refusalAudit(h))?.refusal).toBe("not_owner");
  });

  test("a User-account installation is unchanged", async () => {
    const h = await harness();
    h.f.installations.set("100", {
      ...inst("100"),
      account: { login: "solo", id: "9", type: "User" },
    });
    const own = {
      ...ownerOf100,
      installations: [{ id: "100", accountId: "9", accountLogin: "solo", accountType: "User" }],
      membershipFails: true,
    };
    h.users.set("owner", own);
    h.users.set("stranger", { ...own, id: "55", login: "stranger" });
    expect((await h.claim("stranger")).status).toBe(403);
    expect((await h.claim("owner")).status).toBe(200);
  });

  test("a verified installation.created for an UNCLAIMED installation records the installer; a later claim succeeds", async () => {
    const h = await harness();
    expect(await getInstallation(h.db, "100")).toBeUndefined();
    const res = await h.post(h.installEvent("created", 9, "owner-b"));
    expect(res?.status).toBe(202);
    await h.hook.drain();
    expect(await getInstallationInstaller(h.db, "100")).toMatchObject({
      installerGithubId: "9",
      installerLogin: "owner-b",
    });
    expect(await getInstallation(h.db, "100")).toBeUndefined(); // still unclaimed
    h.users.set("c", h.userOf());
    expect((await h.claim("c")).status).toBe(200);
  });

  test("new_permissions_accepted and unsuspend replace the installer; other actions and bad senders do not", async () => {
    const h = await harness();
    await h.post(h.installEvent("created", 9));
    await h.post(h.installEvent("new_permissions_accepted", 10));
    await h.hook.drain();
    expect((await getInstallationInstaller(h.db, "100"))?.installerGithubId).toBe("10");
    await h.post(h.installEvent("unsuspend", 11));
    await h.post(h.installEvent("suspend", 12));
    await h.post({
      action: "created",
      installation: { id: 100 },
      sender: { id: "x1", login: "x" },
    });
    await h.hook.drain();
    expect((await getInstallationInstaller(h.db, "100"))?.installerGithubId).toBe("11");
  });

  test("a redelivery with the same GUID still records the installer", async () => {
    const h = await harness();
    await h.post(h.installEvent("created", 1), { guid: "guid-redeliver-1" });
    await h.hook.drain();
    await recordInstallationInstaller(h.db, {
      installationId: "100",
      githubId: "0",
      login: "old",
      recordedAt: 1,
    });
    await h.post(h.installEvent("created", 9), { guid: "guid-redeliver-1" });
    expect((await getInstallationInstaller(h.db, "100"))?.installerGithubId).toBe("9");
  });

  test("a bad signature writes nothing", async () => {
    const h = await harness();
    const res = await h.post(h.installEvent("created", 9), { secret: "wrong" });
    expect(res?.status).toBe(401);
    await h.hook.drain();
    expect(await getInstallationInstaller(h.db, "100")).toBeUndefined();
  });

  test("installation.deleted removes the row", async () => {
    const h = await harness();
    await h.post(h.installEvent("created", 9));
    await h.hook.drain();
    expect(await getInstallationInstaller(h.db, "100")).toBeDefined();
    h.f.installations.delete("100");
    await h.post(h.installEvent("deleted", 9));
    await h.hook.drain();
    expect(await getInstallationInstaller(h.db, "100")).toBeUndefined();
  });

  describe("instance_bind_installation", () => {
    const input = {
      installation_id: "100",
      target_org: "tenant-b",
      expected_account: "ACME",
      reason: "the App cannot read org membership",
    };
    const bind = (h: { env: DispatchEnv; tti: string }, over: Record<string, unknown> = {}) =>
      dispatch(h.env, { kind: "bearer", token: h.tti }, "instance_bind_installation", {
        ...input,
        ...over,
      });

    test("binds an unclaimed installation, syncs its repos, audits and emits the event", async () => {
      const h = await harness();
      const r = await bind(h);
      expect(r.ok).toBe(true);
      expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenant.id);
      // The installation is a permission: no project exists until someone adds a repo (#577).
      expect(await listProjects(h.db, { orgId: h.tenant.id })).toHaveLength(0);
      const chain = await listAudit(h.db, { orgId: h.tenant.id });
      const row = chain.find((e) => e.op === "instance_bind_installation");
      expect(JSON.parse(row!.input)).toMatchObject({
        installation_id: "100",
        account_login: "acme",
        reason: input.reason,
      });
      const evs = await listEvents(
        h.db,
        { orgId: h.tenant.id },
        { after: 0, limit: 20, types: ["org.installation_bound_by_instance"] },
      );
      expect(evs).toHaveLength(1);
      expect(JSON.parse(evs[0]!.payload)).toEqual({
        installation_id: "100",
        account_login: "acme",
      });
    });

    test("an expected_account mismatch, a suspended or unknown installation bind nothing", async () => {
      const h = await harness();
      const bad = await bind(h, { expected_account: "someone-else" });
      expect(bad.ok).toBe(false);
      expect(await getInstallation(h.db, "100")).toBeUndefined();
      h.f.installations.set("100", inst("100", "42", { suspended: true }));
      expect((await bind(h)).ok).toBe(false);
      expect((await bind(h, { installation_id: "999" })).ok).toBe(false);
      expect(await getInstallation(h.db, "100")).toBeUndefined();
    });

    test("one held by another org is refused with a message naming no org", async () => {
      const h = await harness();
      await upsertInstallation(
        h.db,
        { orgId: h.other.id },
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
      const r = await bind(h);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("conflict");
        expect(JSON.stringify(r.error)).not.toContain("tenant-c");
      }
      expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.other.id);
    });

    test("org, project, agent, session and user principals are refused", async () => {
      const h = await harness();
      for (const role of ["reader", "operator", "release_operator"] as const) {
        const t = await mintToken(h.db, { orgId: h.tenant.id }, role);
        const r = await dispatch(
          h.env,
          { kind: "bearer", token: t.secret },
          "instance_bind_installation",
          input,
        );
        expect(r.ok, role).toBe(false);
      }
      for (const principal of [
        { kind: "member", id: "m", orgId: h.tenant.id, role: "owner" },
        { kind: "session", id: "s", orgId: h.tenant.id, role: "owner" },
        { kind: "agent", id: "a", orgId: h.tenant.id, role: "operator" },
        { kind: "user", id: "u", orgId: h.tenant.id, role: "owner" },
      ] as const) {
        const r = await dispatch(
          { ...h.env, viaMcp: true },
          { kind: "principal", principal: principal as never },
          "instance_bind_installation",
          input,
        );
        expect(r.ok, principal.kind).toBe(false);
      }
      expect(await getInstallation(h.db, "100")).toBeUndefined();
      expect(registry.mcpOps().map((o) => o.name)).not.toContain("instance_bind_installation");
    });
  });
});
