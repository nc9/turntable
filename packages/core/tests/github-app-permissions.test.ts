// The App's widened permission set: a scoped mint checks what the installation has accepted, the
// stored set feeds the status op, and the delivery table is bounded.
import { describe, expect, test } from "bun:test";
import {
  getInstallation,
  listInstallationPermissions,
  purgeDeliveries,
  upsertInstallation,
} from "../src/db";
import { webhookDeliveries } from "../src/db/schema";
import { AppAuth, missingPermissions, PermissionNotAcceptedError } from "../src/github/app-auth";
import { APP_PERMISSIONS } from "../src/github/manifest";
import { syncInstallation } from "../src/github/installations";
import { fakeFacts, inst, setup } from "./github-helpers";

const OLD_SET = { checks: "write", contents: "read", metadata: "read", pull_requests: "read" };

function fakeApi(initial: Record<string, string>) {
  const state = { accepted: initial, gets: 0, mints: 0 };
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      state.mints += 1;
      return Response.json(
        { token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    }
    state.gets += 1;
    expect(String(url)).toContain("/app/installations/7");
    return Response.json({ permissions: state.accepted });
  }) as unknown as typeof fetch;
  return { state, impl };
}

describe("permission-aware mints", () => {
  test("missingPermissions: read is covered by write, write is not covered by read", () => {
    expect(missingPermissions({ contents: "write" }, { contents: "read" })).toEqual([]);
    expect(missingPermissions({ contents: "read" }, { contents: "write" })).toEqual([
      "contents:write",
    ]);
    expect(missingPermissions({}, { issues: "read", checks: "write" })).toEqual([
      "checks:write",
      "issues:read",
    ]);
  });

  test("polling, checkout and checks scopes still mint on the old set", async () => {
    const { db, store } = await setup();
    const g = fakeApi(OLD_SET);
    const auth = new AppAuth({ db, store, fetch: g.impl });
    await auth.mint("7", {
      repositories: ["r"],
      permissions: { contents: "read", metadata: "read", pull_requests: "read" },
    });
    await auth.mint("7", { repositories: ["r"], permissions: { checks: "write" } });
    await auth.mint("7", { permissions: { metadata: "read" } });
    expect(g.state.mints).toBe(3);
  });

  test("a permission the installation has not accepted fails clearly, with no mint attempted", async () => {
    const { db, store } = await setup();
    const g = fakeApi(OLD_SET);
    const auth = new AppAuth({ db, store, fetch: g.impl });
    const err = await auth.mint("7", { permissions: { issues: "write" } }).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionNotAcceptedError);
    expect((err as Error).message).toBe(
      "the installation has not accepted issues:write: an owner must accept the App's new permissions on GitHub",
    );
    expect(g.state.mints).toBe(0);
    // Write asked where only read was accepted is missing too, and mintFresh checks the same.
    await expect(auth.mintFresh("7", { permissions: { contents: "write" } })).rejects.toThrow(
      /has not accepted contents:write/,
    );
    expect(g.state.mints).toBe(0);
  });

  test("an owner's acceptance takes effect without waiting for the cache", async () => {
    const { db, store } = await setup();
    const g = fakeApi(OLD_SET);
    const auth = new AppAuth({ db, store, fetch: g.impl });
    await expect(auth.mint("7", { permissions: { issues: "write" } })).rejects.toThrow();
    g.state.accepted = { ...OLD_SET, issues: "write" };
    await auth.mint("7", { permissions: { issues: "write" } });
    expect(g.state.mints).toBe(1);
  });

  test("an unreadable grant lets the mint go ahead: GitHub is the check", async () => {
    const { db, store } = await setup();
    let mints = 0;
    const impl = (async (_u: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response("no", { status: 500 });
      mints += 1;
      return Response.json(
        { token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    await new AppAuth({ db, store, fetch: impl }).mint("7", { permissions: { issues: "write" } });
    expect(mints).toBe(1);
  });
});

describe("stored installation permissions", () => {
  test("a sync stores the accepted set and a later sync (new_permissions_accepted) refreshes it", async () => {
    const { db, org } = await setup();
    const f = fakeFacts();
    f.installations.set("7", inst("7", "42", { permissions: OLD_SET }));
    await syncInstallation(db, f.facts, "7");
    expect(JSON.parse((await getInstallation(db, "7"))!.permissions!)).toEqual(OLD_SET);
    let rows = await listInstallationPermissions(db, 10);
    expect(missingPermissions(rows[0]!.permissions!, APP_PERMISSIONS).length).toBeGreaterThan(0);

    f.installations.set("7", inst("7", "42", { permissions: { ...APP_PERMISSIONS } }));
    await syncInstallation(db, f.facts, "7");
    rows = await listInstallationPermissions(db, 10);
    expect(missingPermissions(rows[0]!.permissions!, APP_PERMISSIONS)).toEqual([]);
    expect(org.id).toBeTruthy();
  });

  test("a sync that cannot read the set leaves the stored one alone", async () => {
    const { db, org } = await setup();
    await upsertInstallation(
      db,
      { orgId: org.id },
      {
        installationId: "8",
        appId: "42",
        accountLogin: "acme",
        accountId: "1",
        accountType: "Organization",
        repositorySelection: "all",
        status: "active",
        permissions: OLD_SET,
      },
    );
    await upsertInstallation(
      db,
      { orgId: org.id },
      {
        installationId: "8",
        appId: "42",
        accountLogin: "acme",
        accountId: "1",
        accountType: "Organization",
        repositorySelection: "all",
        status: "active",
      },
    );
    expect((await listInstallationPermissions(db, 10))[0]!.permissions).toEqual(OLD_SET);
  });
});

describe("webhook delivery retention", () => {
  test("drops what is past the age, then the oldest finished rows over the cap, never a received one", async () => {
    const { db, org } = await setup();
    const rec = (id: string, at: number, status: "received" | "ignored") =>
      db.run((h) =>
        h.orm
          .insert(webhookDeliveries)
          .values({ id, orgId: org.id, event: "push", status, receivedAt: at }),
      );
    await rec("old-aaaaaaaa", 1000, "ignored");
    await rec("a-aaaaaaaaa", 5000, "ignored");
    await rec("b-aaaaaaaaa", 5001, "received");
    await rec("c-aaaaaaaaa", 5002, "ignored");
    await rec("d-aaaaaaaaa", 5003, "ignored");
    // Age: only the 1000 one. Cap 3: one more goes, the oldest finished (a), not the received (b).
    expect(await purgeDeliveries(db, 2000, 3)).toBe(2);
    const left = (await db.run((h) => h.orm.select().from(webhookDeliveries))).map((r) => r.id);
    expect(left.toSorted()).toEqual(["b-aaaaaaaaa", "c-aaaaaaaaa", "d-aaaaaaaaa"]);
  });
});
