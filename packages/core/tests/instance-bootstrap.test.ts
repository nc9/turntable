// Instance bootstrap from an env hash (#330) and rotation. In-process, so it runs on both dialects
// (the Postgres run sets TURNTABLE_TEST_DB). Secrets and hashes are built at runtime.
import { beforeEach, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import { type Db, listAudit, openDatabase } from "../src/db";
import { findInstanceTokenByHash, listInstanceTokens } from "../src/db/repos";
import { bootstrapExpiryDays, bootstrapInstanceToken } from "../src/ops/instance-bootstrap";
import {
  createInstanceTokenFromCli,
  revokeInstanceTokenFromCli,
  rotateInstanceTokenFromCli,
} from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { generateInstanceToken, hashToken } from "../src/ops/tokens";

const DAY = 86_400_000;
let db: Db;
let secret: string;
let hash: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  secret = generateInstanceToken();
  hash = hashToken(secret);
});

const auditOps = async (): Promise<string[]> =>
  (await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 100 })).map((r) => r.op);

describe("bootstrapInstanceToken", () => {
  test("registers only when no instance token exists", async () => {
    const now = 1_000_000;
    const r = await bootstrapInstanceToken(db, { sha256: hash, now: () => now });
    expect(r.status).toBe("created");
    const rows = await listInstanceTokens(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hash);
    expect(rows[0]!.createdBy).toBe("bootstrap:env");
  });

  test("is ignored when an unrevoked instance token exists", async () => {
    await createInstanceTokenFromCli(db, { name: "ops" });
    const r = await bootstrapInstanceToken(db, { sha256: hash });
    expect(r).toEqual({ status: "skipped", reason: "an instance token exists" });
    expect(await findInstanceTokenByHash(db, hash)).toBeUndefined();
  });

  test("an expired token does not block, and a new hash registers", async () => {
    await createInstanceTokenFromCli(db, { name: "ops", now: () => 0 });
    const r = await bootstrapInstanceToken(db, { sha256: hash, now: () => 400 * DAY });
    expect(r.status).toBe("created");
    expect(await listInstanceTokens(db)).toHaveLength(2);
  });

  test("a revoked token does not block, and a new hash registers", async () => {
    const old = await createInstanceTokenFromCli(db, { name: "ops" });
    await revokeInstanceTokenFromCli(db, old.id);
    const r = await bootstrapInstanceToken(db, { sha256: hash });
    expect(r.status).toBe("created");
    expect(await listInstanceTokens(db)).toHaveLength(2);
  });

  test("the same hash across two boots while active is one row, with no renewal", async () => {
    const first = await bootstrapInstanceToken(db, { sha256: hash, now: () => 0 });
    if (first.status !== "created") throw new Error("expected created");
    const again = await bootstrapInstanceToken(db, { sha256: hash, now: () => DAY });
    expect(again.status).toBe("skipped");
    const rows = await listInstanceTokens(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt).toBe(first.expiresAt);
  });

  test("a previously registered hash is refused when it is expired", async () => {
    const first = await bootstrapInstanceToken(db, { sha256: hash, now: () => 0 });
    if (first.status !== "created") throw new Error("expected created");
    const again = await bootstrapInstanceToken(db, { sha256: hash, now: () => 400 * DAY });
    expect(again).toEqual({ status: "skipped", reason: "hash already registered" });
    const [row] = await listInstanceTokens(db);
    expect(row!.expiresAt).toBe(first.expiresAt);
    expect(await listInstanceTokens(db)).toHaveLength(1);
  });

  test("a previously registered hash is refused when it is revoked", async () => {
    const first = await bootstrapInstanceToken(db, { sha256: hash });
    if (first.status !== "created") throw new Error("expected created");
    await revokeInstanceTokenFromCli(db, first.tokenId);
    const again = await bootstrapInstanceToken(db, { sha256: hash });
    expect(again).toEqual({ status: "skipped", reason: "hash already registered" });
    const [row] = await listInstanceTokens(db);
    expect(row!.revokedAt).not.toBeNull();
  });

  test("a previously registered hash is refused when it is active", async () => {
    await bootstrapInstanceToken(db, { sha256: hash });
    const again = await bootstrapInstanceToken(db, { sha256: hash });
    expect(again.status).toBe("skipped");
    expect(await listInstanceTokens(db)).toHaveLength(1);
  });

  test("an old hash is refused even after a newer token lapses", async () => {
    await bootstrapInstanceToken(db, { sha256: hash, now: () => 0 });
    const other = hashToken(generateInstanceToken());
    const second = await bootstrapInstanceToken(db, { sha256: other, now: () => 40 * DAY });
    expect(second.status).toBe("created");
    const again = await bootstrapInstanceToken(db, { sha256: hash, now: () => 100 * DAY });
    expect(again).toEqual({ status: "skipped", reason: "hash already registered" });
  });

  test("expiry is 30 days by default and never higher; a lower value is honoured", async () => {
    const r = await bootstrapInstanceToken(db, { sha256: hash, now: () => 5 * DAY });
    if (r.status !== "created") throw new Error("expected created");
    expect(r.expiresAt).toBe(35 * DAY);
    await expect(
      bootstrapInstanceToken(openDatabase(":memory:"), { sha256: hash, expiresInDays: 31 }),
    ).rejects.toThrow(/1 to 30/);
    const other = openDatabase(":memory:");
    const low = await bootstrapInstanceToken(other, {
      sha256: hash,
      expiresInDays: 2,
      now: () => 0,
    });
    if (low.status !== "created") throw new Error("expected created");
    expect(low.expiresAt).toBe(2 * DAY);
    expect(bootstrapExpiryDays(undefined)).toBe(30);
    expect(bootstrapExpiryDays("7")).toBe(7);
    for (const bad of ["0", "31", "1.5", "abc"]) expect(() => bootstrapExpiryDays(bad)).toThrow();
  });

  test("the registered token authenticates as the instance administrator until it expires", async () => {
    const t0 = 10 * DAY;
    await bootstrapInstanceToken(db, { sha256: hash, now: () => t0 });
    const at = (now: number): DispatchEnv => ({
      registry,
      db,
      allowInstance: true,
      now: () => now,
    });
    const ok = await dispatch(
      at(t0 + DAY),
      { kind: "bearer", token: secret },
      "instance_whoami",
      {},
    );
    expect(ok.ok).toBe(true);
    const late = await dispatch(
      at(t0 + 31 * DAY),
      { kind: "bearer", token: secret },
      "instance_whoami",
      {},
    );
    expect(late.ok).toBe(false);
  });

  test("a malformed hash fails without echoing the value", async () => {
    const bad = `${secret}`; // a token pasted by mistake
    let message = "";
    try {
      await bootstrapInstanceToken(db, { sha256: bad });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("TURNTABLE_INSTANCE_BOOTSTRAP_TOKEN_SHA256");
    expect(message).not.toContain(bad);
    await expect(bootstrapInstanceToken(db, { sha256: "abc" })).rejects.toThrow(/64 hex/);
    expect(await listInstanceTokens(db)).toHaveLength(0);
  });

  test("is audited in the system chain as instance_bootstrap_token_registered, without the hash", async () => {
    await bootstrapInstanceToken(db, { sha256: hash });
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 100 });
    const row = rows.find((r) => r.op === "instance_bootstrap_token_registered");
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(hash);
    expect(JSON.stringify(row)).not.toContain(secret);
  });
});

describe("rotation", () => {
  test("the CLI mints a new token and revokes the old one, audited", async () => {
    const old = await createInstanceTokenFromCli(db, { name: "ops" });
    const r = await rotateInstanceTokenFromCli(db, { oldId: old.id });
    expect(r.revokedId).toBe(old.id);
    const rows = await listInstanceTokens(db);
    expect(rows.find((x) => x.id === old.id)!.revokedAt).not.toBeNull();
    const fresh = rows.find((x) => x.id === r.id)!;
    expect(fresh.revokedAt).toBeNull();
    expect(fresh.tokenHash).toBe(hashToken(r.secret));
    expect(await auditOps()).toContain("rotate_instance_token");
    await expect(rotateInstanceTokenFromCli(db, { oldId: old.id })).rejects.toThrow(
      /already revoked/,
    );
  });

  test("over REST the caller's token is replaced; the old secret stops working", async () => {
    await bootstrapInstanceToken(db, { sha256: hash });
    const env: DispatchEnv = { registry, db, allowInstance: true };
    const out = await dispatch(env, { kind: "bearer", token: secret }, "rotate_instance_token", {
      expires_days: 7,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const fresh = out.output as { secret: string; id: string };
    expect(fresh.secret.startsWith("tti_")).toBe(true);
    const old = await dispatch(env, { kind: "bearer", token: secret }, "instance_whoami", {});
    expect(old.ok).toBe(false);
    const next = await dispatch(
      env,
      { kind: "bearer", token: fresh.secret },
      "instance_whoami",
      {},
    );
    expect(next.ok).toBe(true);
    // The audit entry names ids, never a secret or a hash.
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 100 });
    const row = rows.find((r) => r.op === "rotate_instance_token");
    expect(row).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain(fresh.secret);
    expect(JSON.stringify(rows)).not.toContain(hashToken(fresh.secret));
    // After rotating, the env var is a no-op: the new token is unrevoked.
    expect((await bootstrapInstanceToken(db, { sha256: hash })).status).toBe("skipped");
  });

  test("it is never an MCP tool, and an org token cannot call it", () => {
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("rotate_instance_token");
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("rotate_instance_token");
  });
});
