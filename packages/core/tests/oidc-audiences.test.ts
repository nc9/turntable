import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { resetFailureThrottle } from "../src/audit/failures";
import { type Db, listAudit } from "../src/db";
import * as s from "../src/db/schema";
import { mintAttemptCredential } from "../src/oidc/attempt-credential";
import { createOidcHandler, type OidcHandler } from "../src/oidc/http";
import { OidcIssuer } from "../src/oidc/issuer";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { setOidcAudiencesPolicy, showOidcAudiences } from "../src/ops/policy-cli";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const BASE = "https://ci.example.com/oidc";
let db: Db;
let a: Tenant;
let b: Tenant;
let master: Buffer;
let issuer: OidcIssuer;
let handler: OidcHandler;
let env: DispatchEnv;
const now = 1_800_000_000_000;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  master = randomBytes(32);
  resetFailureThrottle();
  issuer = new OidcIssuer({ db, masterKey: master, baseUrl: BASE, now: () => now });
  handler = createOidcHandler({ db, issuer, masterKey: master, now: () => now });
  env = { registry, db, now: () => now };
  for (const t of [a, b]) {
    await db.orm
      .update(s.runs)
      .set({ repo: "acme/web", actor: "octo", ref: "refs/heads/main", event: "push" })
      .where(eq(s.runs.id, t.runId));
    await db.orm
      .update(s.jobAttempts)
      .set({ state: "running", trustClass: "protected" })
      .where(eq(s.jobAttempts.id, t.attemptId));
  }
});

const mint = (t: Tenant, aud: string) =>
  handler.handle(
    new Request(`https://ci.example.com/oidc/${t.slug}/token?audience=${encodeURIComponent(aud)}`, {
      headers: {
        authorization: `Bearer ${mintAttemptCredential(master, { orgId: t.orgId, attemptId: t.attemptId }, now)}`,
      },
    }),
  );
const as = (t: Tenant) => ({ kind: "principal" as const, principal: t.admin });
const setAud = (t: Tenant, audiences: string[] | null, over: Record<string, unknown> = {}) =>
  dispatch(env, as(t), "set_oidc_audiences", { project: t.projectSlug, audiences, ...over });

describe("the per-project audience allow list", () => {
  test("unset: any audience is minted, as before", async () => {
    for (const aud of ["sts.amazonaws.com", "vault", "anything-at-all"]) {
      expect((await mint(a, aud))!.status).toBe(200);
    }
  });

  test("set: an allowed audience is minted, any other is refused with its own code and audited", async () => {
    const r = await setAud(a, ["sts.amazonaws.com", "vault"]);
    expect(r.ok).toBe(true);
    expect((await mint(a, "sts.amazonaws.com"))!.status).toBe(200);
    expect((await mint(a, "vault"))!.status).toBe(200);
    const refused = (await mint(a, "https://evil.example.com"))!;
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("audience_not_allowed");
    // Exact match only: a prefix or another case is not the audience.
    expect((await mint(a, "vault2"))!.status).toBe(403);
    expect((await mint(a, "VAULT"))!.status).toBe(403);
    const rows = await listAudit(db, a.scope);
    const denied = rows.filter((x) => x.outcome === "error:audience_not_allowed");
    expect(denied.length).toBeGreaterThanOrEqual(1);
    // Refusals are throttled per source, so which of the refused audiences got a row can vary;
    // every row names the audience that was asked for.
    for (const d of denied)
      expect(String(d.input)).toMatch(/"aud":"(https:\/\/evil\.example\.com|vault2|VAULT)"/);
    // The allowed list itself is not in the denial's detail.
    expect(JSON.stringify(denied)).not.toContain("sts.amazonaws.com");
  });

  test("clearing the list (null) lifts the limit", async () => {
    await setAud(a, ["vault"]);
    expect((await mint(a, "other"))!.status).toBe(403);
    expect((await setAud(a, null)).ok).toBe(true);
    expect((await mint(a, "other"))!.status).toBe(200);
  });

  test("the setting is the project's: another project of the same org is not limited", async () => {
    await setAud(a, ["vault"]);
    const rows = await db.orm.select().from(s.projects).where(eq(s.projects.id, a.projectId));
    expect(rows[0]!.oidcAudiences).toBe(JSON.stringify(["vault"]));
    expect(await showOidcAudiences(db, a.slug)).toEqual([{ project: "app", audiences: ["vault"] }]);
  });

  test("a stored value that is damaged allows nothing, never everything", async () => {
    await db.orm
      .update(s.projects)
      .set({ oidcAudiences: "{not json" })
      .where(eq(s.projects.id, a.projectId));
    expect((await mint(a, "vault"))!.status).toBe(403);
    await db.orm
      .update(s.projects)
      .set({ oidcAudiences: '"vault"' })
      .where(eq(s.projects.id, a.projectId));
    expect((await mint(a, "vault"))!.status).toBe(403);
  });
});

describe("the operation", () => {
  test("it is audited, validates audiences, de-duplicates, and shows in list_projects", async () => {
    const r = await setAud(a, ["vault", "vault", "sts"]);
    expect(r.ok && r.output).toMatchObject({ oidc_audiences: ["vault", "sts"] });
    expect((await listAudit(db, a.scope)).map((x) => x.op)).toContain("set_oidc_audiences");
    const list = await dispatch(env, as(a), "list_projects", {});
    expect(
      list.ok &&
        (list.output as { projects: { oidc_audiences: string[] | null }[] }).projects[0]!
          .oidc_audiences,
    ).toEqual(["vault", "sts"]);
    for (const bad of [
      [],
      ["has space"],
      ["x".repeat(257)],
      Array.from({ length: 21 }, (_, i) => `a${i}`),
    ]) {
      expect((await setAud(a, bad)).ok).toBe(false);
    }
    // Missing project.
    const noProject = await dispatch(env, as(a), "set_oidc_audiences", { audiences: ["vault"] });
    expect(noProject.ok).toBe(false);
  });

  test("an agent token cannot change it, whatever its role", async () => {
    for (const role of ["reader", "operator", "release_operator"] as const) {
      const tok = (await mintToken(db, { orgId: a.orgId }, role)).secret;
      const r = await dispatch(env, { kind: "bearer", token: tok }, "set_oidc_audiences", {
        project: a.projectSlug,
        audiences: ["vault"],
      });
      expect(r.ok).toBe(false);
    }
    expect((await mint(a, "anything"))!.status).toBe(200);
  });
});

describe("tenant isolation", () => {
  test("org B cannot read or change org A's list, and A's list does not limit B", async () => {
    await setAud(a, ["vault"]);
    // B names A's project slug and id: it only reaches B's own scope or nothing.
    const bySlug = await setAud(b, ["evil"], { project: a.projectSlug });
    expect(bySlug.ok).toBe(true); // "app" in B's org is B's own project
    const rowsA = await db.orm.select().from(s.projects).where(eq(s.projects.id, a.projectId));
    expect(rowsA[0]!.oidcAudiences).toBe(JSON.stringify(["vault"]));
    const byId = await dispatch(env, as(b), "set_oidc_audiences", {
      project: a.projectId,
      audiences: ["evil"],
    });
    expect(byId.ok).toBe(false);
    expect(
      (await db.orm.select().from(s.projects).where(eq(s.projects.id, a.projectId)))[0]!
        .oidcAudiences,
    ).toBe(JSON.stringify(["vault"]));
    // A's list is not B's.
    expect(await showOidcAudiences(db, b.slug)).toEqual([{ project: "app", audiences: ["evil"] }]);
    await setAud(b, null);
    expect((await mint(b, "whatever"))!.status).toBe(200);
    expect((await mint(a, "whatever"))!.status).toBe(403);
  });
});

describe("the CLI setter", () => {
  test("sets, shows, clears with any, validates, and audits like the other policy settings", async () => {
    const r = await setOidcAudiencesPolicy(db, a.slug, "app", "vault, sts ,vault");
    expect(r).toEqual([{ project: "app", from: null, to: ["vault", "sts"] }]);
    expect(await showOidcAudiences(db, a.slug)).toEqual([
      { project: "app", audiences: ["vault", "sts"] },
    ]);
    expect((await mint(a, "nope"))!.status).toBe(403);
    expect(JSON.stringify(await listAudit(db, a.scope))).toContain("oidc_audiences");
    expect(await setOidcAudiencesPolicy(db, a.slug, undefined, "any")).toEqual([
      { project: "app", from: ["vault", "sts"], to: null },
    ]);
    expect((await mint(a, "nope"))!.status).toBe(200);
    await expect(setOidcAudiencesPolicy(db, a.slug, "app", "has space")).rejects.toThrow(
      /not an audience/,
    );
    await expect(setOidcAudiencesPolicy(db, a.slug, "nope", "x")).rejects.toThrow(/no project/);
    await expect(setOidcAudiencesPolicy(db, a.slug, "app", ",")).rejects.toThrow(/1 to 20/);
  });
});
