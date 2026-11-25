// The release lane's signing keys over the instance ops (#541): `release_init_key` creates a key
// INSIDE the lane (sealed under the release master key, never returned), `release_public_key`
// reads its public half for the org's readers. A real lane file, vault view and channel; only the
// clock and the authenticator are software.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { AttestationStore } from "../src/release/attest";
import { fileKeyVault, type FileKeyVault } from "../src/release/key-vault";
import { opsHarness, type Harness } from "./release-config-helpers";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let attest: AttestationStore;
let dir: string;
let keys: FileKeyVault;
let h: Harness;

const INIT = (t: Tenant, name = "release") => ({ target_org: t.slug, name });

/** Every place a private key or its sealed bytes could leak to, as one string. */
async function everything(): Promise<string> {
  const rows = await db.run(async (x) => ({
    audit: await x.orm.select().from(s.auditLog),
    events: await x.orm.select().from(s.events),
  }));
  return JSON.stringify(rows) + h.logs.join("\n");
}

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  attest = new AttestationStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "tt-keys-"));
  keys = fileKeyVault(join(dir, "keys"), randomBytes(32));
  h = await opsHarness({ db, attest, orgId: a.orgId, keys });
});
afterEach(() => {
  h.dispose();
  attest.close();
  rmSync(dir, { recursive: true, force: true });
});

const sealedFiles = (): string[] =>
  existsSync(join(dir, "keys")) ? readdirSync(join(dir, "keys")) : [];

describe("release_init_key", () => {
  test("creates the key in the lane and returns only the public half", async () => {
    const r = await h.signedCall("release_init_key", INIT(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as Record<string, string>;
    expect(Object.keys(out).toSorted()).toEqual(["created_at", "keyid", "public_key_pem"]);
    expect(out.public_key_pem).toContain("BEGIN PUBLIC KEY");
    expect(out.keyid).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(out.created_at!))).toBe(false);
    expect(sealedFiles()).toHaveLength(1);
  });

  test("no private key material, and not the sealed bytes, in any output, audit row, event or log", async () => {
    const spy = spyOn(console, "log");
    const spyErr = spyOn(console, "error");
    try {
      const r = await h.signedCall("release_init_key", INIT(a));
      expect(r.ok).toBe(true);
      const sealed = readFileSync(join(dir, "keys", sealedFiles()[0]!), "utf8");
      // the private PEM, opened from the vault here only to know what must never appear
      const privatePem = (await keys.get(`signing/${await keyRefOf()}`))!;
      expect(privatePem).toContain("PRIVATE KEY");
      const body = privatePem.replace(/-----[A-Z ]+-----|\s/g, "");
      const seen = [
        JSON.stringify(r),
        await everything(),
        ...spy.mock.calls.flat().map(String),
        ...spyErr.mock.calls.flat().map(String),
      ].join("\n");
      expect(seen).not.toContain("PRIVATE KEY");
      expect(seen).not.toContain(body);
      expect(seen).not.toContain(sealed.trim());
      expect(seen).not.toContain(sealed.trim().slice(0, 40));
      // the public key IS allowed, so the check is not vacuous
      expect(seen).toContain("keyid");
    } finally {
      spy.mockRestore();
      spyErr.mockRestore();
    }
  });

  test("the audit records the keyid and who", async () => {
    const r = await h.signedCall("release_init_key", INIT(a, "prod"));
    expect(r.ok).toBe(true);
    const keyid = r.ok ? (r.output as { keyid: string }).keyid : "";
    const rows = await db.run((x) => x.orm.select().from(s.auditLog));
    const row = rows.find((x) => x.op === "release_init_key" && x.outcome === "ok");
    expect(row).toBeDefined();
    expect(row!.principalKind).toBe("instance");
    expect(row!.principalId).toBeTruthy();
    const input = JSON.parse(row!.input) as Record<string, unknown>;
    expect(input).toMatchObject({ name: "prod", keyid });
  });

  test("a second init with the same name is refused, and the first key is untouched", async () => {
    const first = await h.signedCall("release_init_key", INIT(a));
    expect(first.ok).toBe(true);
    const file = join(dir, "keys", sealedFiles()[0]!);
    const before = readFileSync(file, "utf8");
    const second = await h.signedCall("release_init_key", INIT(a));
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error.message).toContain("already exists");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(sealedFiles()).toHaveLength(1);
    // another name is fine, and so is the same name in another org (its own approver, its own lane view)
    expect((await h.signedCall("release_init_key", INIT(a, "other"))).ok).toBe(true);
    const hb = await opsHarness({ db, attest, orgId: b.orgId, keys });
    try {
      expect((await hb.signedCall("release_init_key", INIT(b))).ok).toBe(true);
    } finally {
      hb.dispose();
    }
    expect(sealedFiles()).toHaveLength(3);
  });

  test("with no release master key on the lane it is refused, and nothing is created", async () => {
    const w2 = await seedWorld();
    const bare = await opsHarness({ db: w2.db, attest, orgId: w2.a.orgId });
    try {
      const r = await bare.signedCall("release_init_key", INIT(w2.a));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.message).toContain("release master key is not configured");
      expect(sealedFiles()).toHaveLength(0);
    } finally {
      bare.dispose();
    }
  });

  test("with no lane at all it is refused as not configured", async () => {
    const w2 = await seedWorld();
    const none = await opsHarness({ db: w2.db, attest, orgId: w2.a.orgId, lane: false });
    try {
      const r = await none.signedCall("release_init_key", INIT(w2.a));
      expect(!r.ok && r.error.code).toBe("unavailable");
    } finally {
      none.dispose();
    }
  });

  test("it needs the instance token and a step-up bound to this op and this input", async () => {
    const bare = await h.call("release_init_key", INIT(a));
    expect(!bare.ok && bare.error.code).toBe("forbidden");
    // a step-up for the name "x" authorises no other name
    const su = await h.stepUpFor("release_init_key", INIT(a, "x"));
    const wrong = await h.call("release_init_key", INIT(a, "y"), su);
    expect(wrong.ok).toBe(false);
    // and a step-up for another op does not open this one
    const pin = await h.stepUpFor("release_pin_repo", {
      target_org: a.slug,
      target_project: a.projectSlug,
      repo: "acme/web",
    });
    expect((await h.call("release_init_key", INIT(a, "z"), pin)).ok).toBe(false);
    // an org token, even an admin's, is refused
    const orgTok = (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret;
    const asOrg = await dispatch(
      { registry, db, transport: "rest" },
      { kind: "bearer", token: orgTok },
      "release_init_key",
      INIT(a),
    );
    expect(asOrg.ok).toBe(false);
    expect(sealedFiles()).toHaveLength(0);
  });

  test("an org that does not exist is not found", async () => {
    const r = await h.call("instance_step_up_challenge", {
      action: "release_init_key",
      input: { target_org: "no-such-org", name: "k" },
    });
    expect(!r.ok && r.error.code).toBe("not_found");
  });

  test("it is not an MCP tool", () => {
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("release_init_key");
    expect(registry.get("release_init_key")!.mcp).toBe(false);
  });
});

/** The vault name of org a's key `release`: the org's id and the name. */
async function keyRefOf(name = "release"): Promise<string> {
  return `${a.orgId}.${name}`;
}

describe("release_public_key", () => {
  test("a reader reads the public half over REST and over MCP, and it matches what init returned", async () => {
    const init = await h.signedCall("release_init_key", INIT(a));
    const made = init.ok ? (init.output as Record<string, string>) : {};
    const reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
    for (const transport of ["rest", "mcp"] as const) {
      const r = await dispatch(
        { ...h.env, allowInstance: false, transport },
        { kind: "bearer", token: reader },
        "release_public_key",
        { name: "release" },
      );
      expect(r.ok, transport).toBe(true);
      if (!r.ok) continue;
      expect(r.output).toEqual({
        keyid: made.keyid,
        public_key_pem: made.public_key_pem,
        created_at: made.created_at,
        status: "active",
      });
    }
    expect(mcpTools(registry).map((t) => t.name)).toContain("release_public_key");
  });

  test("an unknown name is not found; another org's reader never sees this org's key", async () => {
    await h.signedCall("release_init_key", INIT(a));
    const readerA = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
    const readerB = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
    const ask = (tok: string, name: string) =>
      dispatch(
        { ...h.env, allowInstance: false, transport: "rest" },
        { kind: "bearer", token: tok },
        "release_public_key",
        { name },
      );
    const unknown = await ask(readerA, "nope");
    expect(!unknown.ok && unknown.error.code).toBe("not_found");
    // org b has no key of that name: the lookup is inside the caller's own org
    const other = await ask(readerB, "release");
    expect(!other.ok && other.error.code).toBe("not_found");
    // and naming org a from b's token is refused outright
    const named = await dispatch(
      { ...h.env, allowInstance: false, transport: "rest" },
      { kind: "bearer", token: readerB },
      "release_public_key",
      { name: "release", org: a.slug },
    );
    expect(named.ok).toBe(false);
  });

  test("without a lane it is refused as unavailable; without a token it is refused", async () => {
    const none = await opsHarness({ db, attest, orgId: a.orgId, lane: false });
    try {
      const reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
      const r = await dispatch(
        { ...none.env, allowInstance: false, transport: "rest" },
        { kind: "bearer", token: reader },
        "release_public_key",
        { name: "release" },
      );
      expect(!r.ok && r.error.code).toBe("unavailable");
      const anon = await dispatch(
        { ...none.env, allowInstance: false, transport: "rest" },
        { kind: "bearer", token: "not-a-token" },
        "release_public_key",
        { name: "release" },
      );
      expect(anon.ok).toBe(false);
    } finally {
      none.dispose();
    }
  });
});
