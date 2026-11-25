// Who may configure the release lane (#541): ONLY a signed-in web session of an owner of the
// operator org, with a fresh passkey step-up in that org. An instance token, an org token, MCP, an
// owner of another org and a non-owner member of the operator org are all refused, for every op.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db";
import { dispatch, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { AttestationStore } from "../src/release/attest";
import { fileKeyVault } from "../src/release/key-vault";
import { opsHarness, type Harness } from "./release-config-helpers";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant; // the operator org
let b: Tenant; // a tenant
let attest: AttestationStore;
let dir: string;
let h: Harness;

const P = (t: Tenant) => ({ target_org: t.slug, target_project: t.projectSlug });
type Case = { op: string; input: (t: Tenant) => Record<string, unknown> };
const WRITES: Case[] = [
  { op: "release_pin_repo", input: (t) => ({ ...P(t), repo: "acme/web" }) },
  {
    op: "release_publish_target_set",
    input: (t) => ({
      ...P(t),
      key: "npm",
      kind: "npm",
      package: "@acme/web",
      artifact: "web.tgz",
      secret: "NPM_TOKEN",
      accept_long_lived_token: true,
    }),
  },
  {
    op: "release_secret_set",
    input: (t) => ({ ...P(t), name: "NPM_TOKEN", value: "tok-value-0123456789" }),
  },
  { op: "release_init_key", input: (t) => ({ target_org: t.slug, name: "release" }) },
  {
    op: "release_set_project_signing",
    input: (t) => ({ ...P(t), signing_key: "builtin:release" }),
  },
  { op: "release_publish_target_delete", input: (t) => ({ ...P(t), key: "npm" }) },
];
const SIGN = WRITES.find((c) => c.op === "release_set_project_signing")!;
const READS: Case[] = [
  { op: "release_publish_target_list", input: P },
  { op: "release_key_show", input: (t) => ({ target_org: t.slug, name: "release" }) },
  { op: "release_secret_status", input: (t) => ({ ...P(t), name: "NPM_TOKEN" }) },
];

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  attest = new AttestationStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "tt-owner-"));
  const keys = fileKeyVault(join(dir, "keys"), randomBytes(32));
  h = await opsHarness({ db, attest, orgId: a.orgId, keys });
});
afterEach(() => {
  h.dispose();
  attest.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The state a write could change: the lane's version moves on every accepted one. */
const version = () => attest.configVersion();

describe("the operator org's owner, with a step-up", () => {
  test("every write succeeds (set up in order), and every read answers", async () => {
    for (const c of WRITES) {
      // the secret needs its target declared; set_project_signing needs the key and tenant ownership
      const r = await h.signedCall(c.op, c.input(a));
      expect(r.ok, `${c.op}: ${!r.ok ? r.error.message : ""}`).toBe(true);
    }
    for (const c of READS) {
      const r = await h.call(c.op, c.input(a));
      expect(r.ok, `${c.op}: ${!r.ok ? r.error.message : ""}`).toBe(true);
    }
  });

  test("a step-up for a tenant's project works when the owner owns that tenant too", async () => {
    const op = SIGN;
    await h.signedCall("release_init_key", { target_org: b.slug, name: "release" });
    const owner = await h.person({
      login: "dana",
      memberships: [
        { orgId: a.orgId, role: "owner" },
        { orgId: b.orgId, role: "owner" },
      ],
    });
    const input = op.input(b);
    const su = await h.stepUpFor(op.op, input, { cookie: owner.cookie });
    const r = await h.call(op.op, input, su, owner.cookie);
    expect(r.ok, !r.ok ? r.error.message : "").toBe(true);
  });
});

describe("refusals, for every op", () => {
  test("no step-up: step_up_required, nothing changed", async () => {
    const v0 = version();
    for (const c of WRITES) {
      const r = await h.call(c.op, c.input(a));
      expect(!r.ok && r.error.code, c.op).toBe("forbidden");
      expect(!r.ok && r.error.details, c.op).toEqual({ reason: "step_up_required" });
    }
    expect(version()).toBe(v0);
  });

  test("a tti_ instance token is refused, with or without a step-up", async () => {
    const tti = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
    const v0 = version();
    for (const c of [...WRITES, ...READS]) {
      const bare = await dispatch(h.env, { kind: "bearer", token: tti }, c.op, c.input(a));
      expect(bare.ok, c.op).toBe(false);
    }
    for (const c of WRITES.slice(0, 5)) {
      const su = await h.stepUpFor(c.op, c.input(a));
      const withSu = await dispatch(h.env, { kind: "bearer", token: tti }, c.op, {
        ...c.input(a),
        step_up: su,
      });
      expect(withSu.ok, c.op).toBe(false);
    }
    expect(version()).toBe(v0);
  });

  test("an org token (any role) and an in-process principal are refused", async () => {
    const v0 = version();
    for (const role of ["operator", "release_operator", "reader"] as const) {
      const tok = (await mintToken(db, { orgId: a.orgId }, role)).secret;
      for (const c of [...WRITES, ...READS]) {
        const r = await dispatch(h.env, { kind: "bearer", token: tok }, c.op, c.input(a));
        expect(r.ok, `${role} ${c.op}`).toBe(false);
      }
    }
    for (const c of [...WRITES, ...READS]) {
      const r = await dispatch(h.env, { kind: "principal", principal: a.admin }, c.op, c.input(a));
      expect(r.ok, c.op).toBe(false);
    }
    expect(version()).toBe(v0);
  });

  test("an owner of ANOTHER org is refused, passkey and step-up notwithstanding", async () => {
    const other = await h.person({
      login: "eve",
      memberships: [{ orgId: b.orgId, role: "owner" }],
    });
    const v0 = version();
    for (const c of WRITES) {
      // naming the operator org: not a member, so not found; naming her own org: not the operator
      for (const org of [a.slug, b.slug]) {
        const r = await dispatch(h.env, { kind: "session", cookie: other.cookie }, c.op, {
          ...c.input(b),
          org,
        });
        expect(r.ok, `${c.op} ${org}`).toBe(false);
      }
      const ch = await dispatch(
        h.env,
        { kind: "session", cookie: other.cookie },
        "session_step_up_challenge",
        { org: b.slug, action: c.op, input: { org: b.slug, ...c.input(b) } },
      );
      expect(ch.ok, `challenge ${c.op}`).toBe(false);
    }
    for (const c of READS) {
      const r = await dispatch(h.env, { kind: "session", cookie: other.cookie }, c.op, {
        ...c.input(b),
        org: b.slug,
      });
      expect(r.ok, c.op).toBe(false);
    }
    expect(version()).toBe(v0);
  });

  test("a non-owner member of the operator org is refused, even with a valid step-up of their own", async () => {
    const v0 = version();
    for (const role of ["admin", "member", "viewer"] as const) {
      const m = await h.person({ login: `m-${role}`, memberships: [{ orgId: a.orgId, role }] });
      for (const c of WRITES) {
        const ch = await h.call(
          "session_step_up_challenge",
          { action: c.op, input: { org: a.slug, ...c.input(a) } },
          undefined,
          m.cookie,
        );
        expect(ch.ok, `challenge ${role} ${c.op}`).toBe(false);
        const r = await h.call(c.op, c.input(a), undefined, m.cookie);
        expect(r.ok, `${role} ${c.op}`).toBe(false);
      }
      // a step-up the owner obtained is no use to the member
      const su = await h.stepUpFor("release_pin_repo", WRITES[0]!.input(a));
      const stolen = await h.call("release_pin_repo", WRITES[0]!.input(a), su, m.cookie);
      expect(stolen.ok, `${role} stolen step-up`).toBe(false);
      for (const c of READS) {
        const r = await h.call(c.op, c.input(a), undefined, m.cookie);
        expect(r.ok, `${role} ${c.op}`).toBe(false);
      }
    }
    expect(version()).toBe(v0);
  });

  test("release_set_project_signing needs ownership of the TARGET org", async () => {
    await h.signedCall("release_init_key", { target_org: b.slug, name: "release" });
    const v0 = version();
    const input = SIGN.input(b);
    // the operator owner (alice) owns the operator org only
    const su = await h.stepUpFor("release_set_project_signing", input);
    const r = await h.call("release_set_project_signing", input, su);
    expect(!r.ok && r.error.code).toBe("forbidden");
    expect(!r.ok && r.error.details).toEqual({ reason: "not_target_org_owner" });
    // an admin (not owner) of the tenant is refused too
    const adminOfB = await h.person({
      login: "frank",
      memberships: [
        { orgId: a.orgId, role: "owner" },
        { orgId: b.orgId, role: "admin" },
      ],
    });
    const su2 = await h.stepUpFor("release_set_project_signing", input, {
      cookie: adminOfB.cookie,
    });
    const r2 = await h.call("release_set_project_signing", input, su2, adminOfB.cookie);
    expect(!r2.ok && r2.error.details).toEqual({ reason: "not_target_org_owner" });
    expect(version()).toBe(v0);
  });

  test("the registry knows every op and none is on MCP", () => {
    for (const c of [...WRITES, ...READS]) {
      expect(registry.get(c.op)?.mcp, c.op).toBe(false);
      expect(registry.get(c.op)?.auth.type, c.op).toBe("token");
    }
  });
});
