import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chainedAudit, type Db } from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry, type Credential, type DispatchEnv } from "../src/ops";
import { createRestApi, secureTransport } from "../src/ops/rest";
import { mcpTools } from "../src/ops/mcp";
import { resetFailureThrottle } from "../src/audit/failures";
import { SecretVault } from "../src/secrets/vault";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const SENTINEL = "s3ntinel-op-value-77ab";
let db: Db;
let a: Tenant;
let env: DispatchEnv;
let relop: string;
let operator: string;
const spies: { mockRestore(): void }[] = [];
const logged: string[] = [];

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  env = {
    registry,
    db,
    now: () => 1_800_000_000_000,
    vault: new SecretVault({ db, masterKey: randomBytes(32) }),
  };
  relop = (await mintToken(db, a.scope, "release_operator")).secret;
  operator = (await mintToken(db, a.scope, "operator")).secret;
  resetFailureThrottle();
  logged.length = 0;
  for (const m of ["log", "error", "warn"] as const) {
    spies.push(
      spyOn(console, m).mockImplementation(
        (...x: unknown[]) => void logged.push(x.map(String).join(" ")),
      ),
    );
  }
});
afterEach(() => spies.splice(0).forEach((x) => x.mockRestore()));

const call = (token: string, op: string, input: unknown, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token }, op, input);
const principal = (role: "member" | "admin"): Credential => ({
  kind: "principal",
  principal: { kind: "member", id: "m", orgId: a.orgId, role },
});

const everywhere = async (): Promise<string> => {
  const rows = await db.orm.select().from(s.auditLog);
  const secrets = await db.orm.select().from(s.vaultSecrets);
  return JSON.stringify({ rows, secrets, logged });
};

test("set_secret: release_operator and admin may; operator, member and reader may not", async () => {
  const input = { name: "DEPLOY_KEY", value: SENTINEL, destinations: ["api.example.com"] };
  const ok = await call(relop, "set_secret", input);
  expect(ok.ok).toBe(true);
  expect(JSON.stringify(ok)).not.toContain(SENTINEL);
  expect(
    (await dispatch(env, principal("admin"), "set_secret", { ...input, name: "OTHER" })).ok,
  ).toBe(true);
  for (const cred of [
    { kind: "bearer", token: operator } as Credential,
    principal("member"),
    { kind: "bearer", token: (await mintToken(db, a.scope, "reader")).secret } as Credential,
  ]) {
    const r = await dispatch(env, cred, "set_secret", { ...input, name: "NOPE" });
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe("forbidden");
  }
  // a project-scoped token sets and sees project secrets; an org admin sees both
  const list = await call(relop, "list_secrets", {});
  expect(list.ok && (list.output as { entries: unknown[] }).entries.length).toBe(1);
  const all = await dispatch(env, principal("admin"), "list_secrets", {});
  expect(all.ok && (all.output as { entries: unknown[] }).entries.length).toBe(2);
  expect((await call(operator, "list_secrets", {})).ok).toBe(false);
});

test("the value is in no audit entry on any path: ok, forbidden, invalid input, handler error", async () => {
  await call(relop, "set_secret", { name: "A1", value: SENTINEL });
  await call(operator, "set_secret", { name: "A2", value: SENTINEL }); // forbidden
  await call(relop, "set_secret", { name: "A3", value: SENTINEL, trust_classes: "not-an-array" }); // zod
  await call(relop, "set_secret", { name: "A4", value: SENTINEL, trust_classes: ["untrusted_pr"] }); // handler
  await call(relop, "rotate_secret", { name: "MISSING", value: SENTINEL }); // not_found
  const noVault: DispatchEnv = { ...env, vault: undefined };
  const r = await call(relop, "set_secret", { name: "A5", value: SENTINEL }, noVault);
  expect((r as { error: { code: string } }).error.code).toBe("unavailable");

  const audited = (await chainedAudit(db, a.orgId, 0, 100)).filter((x) => x.op.endsWith("_secret"));
  expect(audited.map((x) => x.outcome).toSorted()).toEqual([
    "error:forbidden",
    "error:invalid_input",
    "error:invalid_input",
    "error:not_found",
    "error:unavailable",
    "ok",
  ]);
  expect(await everywhere()).not.toContain(SENTINEL);
  expect(audited.find((x) => x.outcome === "ok")!.input).toContain("[redacted]");
});

test("REST: a value in the URL is refused; plain http from afar is refused; https, loopback and a trusted proxy pass", async () => {
  const api = createRestApi(env);
  const post = (url: string, peer?: string, headers: Record<string, string> = {}, e = api) =>
    e(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${relop}`,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ name: "REST_KEY", value: SENTINEL }),
      }),
      peer,
    );
  const asUrl = await api(
    new Request(`http://x/api/v1/secrets?name=Q&value=${SENTINEL}`, {
      method: "POST",
      headers: { authorization: `Bearer ${relop}` },
    }),
    "127.0.0.1",
  );
  expect(asUrl?.status).toBe(400);
  expect(await asUrl!.text()).not.toContain(SENTINEL);

  const plain = await post("http://x/api/v1/secrets", "203.0.113.5");
  expect(plain?.status).toBe(400);
  expect(await plain!.text()).not.toContain(SENTINEL);
  expect((await post("https://x/api/v1/secrets", "203.0.113.5"))?.status).toBe(200);
  expect((await post("http://localhost/api/v1/secrets", "127.0.0.1", {}))?.status).toBe(200);
  // a Host header that says localhost proves nothing about the peer
  expect((await post("http://localhost/api/v1/secrets", "203.0.113.5"))?.status).toBe(400);
  // behind a proxy: loopback peer plus forwarded headers is not enough without the opt-in
  expect(
    (await post("http://x/api/v1/secrets", "127.0.0.1", { "x-forwarded-proto": "http" }))?.status,
  ).toBe(400);
  expect(
    (await post("http://x/api/v1/secrets", "127.0.0.1", { "x-forwarded-for": "198.51.100.1" }))
      ?.status,
  ).toBe(400);
  const trusting = createRestApi(env, { trustForwardedProto: true });
  expect(
    (await post("http://x/api/v1/secrets", "10.0.0.2", { "x-forwarded-proto": "https" }, trusting))
      ?.status,
  ).toBe(200);
  expect(
    (await post("http://x/api/v1/secrets", "10.0.0.2", { "x-forwarded-proto": "http" }, trusting))
      ?.status,
  ).toBe(400);
  expect(secureTransport(new Request("http://x/"), {}, undefined)).toBe(false);

  // an unauthenticated plain-http request is a 401, not a hint that the route exists differently
  const unauth = await api(
    new Request("http://x/api/v1/secrets", { method: "POST" }),
    "203.0.113.5",
  );
  expect(unauth?.status).toBe(401);
  expect(await everywhere()).not.toContain(SENTINEL);
});

test("REST: list, rotate and delete round trip; no response carries a value", async () => {
  const api = createRestApi(env);
  const req = (method: string, path: string, body?: unknown) =>
    api(
      new Request(`https://x/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${relop}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      "203.0.113.5",
    );
  const texts: string[] = [];
  for (const [m, p, b] of [
    ["POST", "/secrets", { name: "R1", value: SENTINEL }],
    ["POST", "/secrets", { name: "R2", value: SENTINEL }],
    ["POST", "/secrets/rotate", { name: "R1", value: `${SENTINEL}2`, overlap_seconds: 60 }],
    ["GET", "/secrets?limit=1"],
    ["DELETE", "/secrets?name=R1"],
    ["DELETE", "/secrets?name=R1"],
  ] as [string, string, unknown?][]) {
    const res = (await req(m, p, b))!;
    texts.push(`${res.status} ${await res.text()}`);
  }
  expect(texts.map((t) => t.slice(0, 3))).toEqual(["200", "200", "200", "200", "200", "404"]);
  expect(JSON.parse(texts[3]!.slice(4)).next_cursor).toBeString();
  expect(texts.join("\n")).not.toContain(SENTINEL);
});

test("MCP never lists value-bearing ops", () => {
  const names = mcpTools(registry).map((t) => t.name);
  expect(names).not.toContain("set_secret");
  expect(names).not.toContain("rotate_secret");
  expect(names).toContain("list_secrets");
  expect(names).toContain("delete_secret");
});

test("system secrets never show up and cannot be named", async () => {
  const { SecretStore } = await import("../src/secrets/store");
  await new SecretStore(db, randomBytes(32)).set(a.orgId, "audit/signing-key", "PRIVATE-PEM");
  const list = await call(relop, "list_secrets", {});
  expect(JSON.stringify(list)).not.toContain("audit");
  for (const op of ["set_secret", "rotate_secret"]) {
    const r = await call(relop, op, { name: "audit/signing-key", value: "x" });
    expect(r.ok).toBe(false);
  }
  const d = await call(relop, "delete_secret", { name: "audit/signing-key" });
  expect(d.ok).toBe(false);
});
