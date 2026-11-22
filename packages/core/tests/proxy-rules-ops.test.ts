import { beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type Db } from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import { SecretVault } from "../src/secrets/vault";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let relop: string;
let operator: string;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = {
    registry,
    db,
    now: () => 1_800_000_000_000,
    vault: new SecretVault({ db, masterKey: randomBytes(32) }),
  };
  relop = (await mintToken(db, a.scope, "release_operator")).secret;
  operator = (await mintToken(db, a.scope, "operator")).secret;
  await env.vault!.set(a.orgId, "t", { name: "NPM_TOKEN" }, "a-secret-value-123", {
    destinations: ["registry.example.test", "*.cdn.example.test"],
  });
});

const call = (token: string, op: string, input: unknown) =>
  dispatch(env, { kind: "bearer", token }, op, input);

const rule = (over: Record<string, unknown> = {}) => ({
  name: "npm",
  secret: "NPM_TOKEN",
  host: "registry.example.test",
  methods: ["GET", "PUT"],
  path_prefix: "/",
  inject: { type: "header", name: "Authorization", format: "Bearer {secret}" },
  ...over,
});

test("set, list and delete a rule; only release_operator and above may", async () => {
  expect((await call(operator, "set_proxy_rule", rule())).ok).toBe(false);
  const ok = await call(relop, "set_proxy_rule", rule());
  expect(ok.ok).toBe(true);
  // Replacing by name is an update.
  const again = await call(relop, "set_proxy_rule", rule({ methods: ["GET"] }));
  expect(again.ok && (again.output as { created: boolean }).created).toBe(false);
  const list = await call(relop, "list_proxy_rules", {});
  expect(list.ok && (list.output as { rules: { methods: string[] }[] }).rules).toHaveLength(1);
  expect((await call(operator, "list_proxy_rules", {})).ok).toBe(false);
  expect((await call(operator, "delete_proxy_rule", { name: "npm" })).ok).toBe(false);
  expect((await call(relop, "delete_proxy_rule", { name: "npm" })).ok).toBe(true);
  expect((await call(relop, "delete_proxy_rule", { name: "npm" })).ok).toBe(false);
});

test("the host must be one of the secret's destinations, at write time", async () => {
  for (const host of ["evil.example.test", "cdn.example.test", "registry.example.test.evil.test"]) {
    expect((await call(relop, "set_proxy_rule", rule({ host }))).ok).toBe(false);
  }
  expect((await call(relop, "set_proxy_rule", rule({ host: "a.cdn.example.test" }))).ok).toBe(true);
  expect((await call(relop, "set_proxy_rule", rule({ name: "x", secret: "NOPE" }))).ok).toBe(false);
});

test("a rule that would not compile is refused, never stored", async () => {
  for (const bad of [
    rule({ path_prefix: "/a/../b" }),
    rule({ methods: ["*"] }),
    rule({ inject: { type: "header", name: "Host" } }),
    rule({ inject: { type: "header", name: "Authorization", format: "no placeholder" } }),
  ]) {
    expect((await call(relop, "set_proxy_rule", bad)).ok).toBe(false);
  }
  expect(await db.orm.select().from(s.proxyRules)).toHaveLength(0);
});

test("rules are per project: another org sees and deletes none of them", async () => {
  await call(relop, "set_proxy_rule", rule());
  const other = (await mintToken(db, b.scope, "release_operator")).secret;
  const list = await call(other, "list_proxy_rules", {});
  expect(list.ok && (list.output as { rules: unknown[] }).rules).toHaveLength(0);
  expect((await call(other, "delete_proxy_rule", { name: "npm" })).ok).toBe(false);
  expect(await db.orm.select().from(s.proxyRules)).toHaveLength(1);
});

test("writes are audited and never carry a value", async () => {
  await call(relop, "set_proxy_rule", rule());
  const rows = JSON.stringify(await db.orm.select().from(s.auditLog));
  expect(rows).toContain("set_proxy_rule");
  expect(rows).not.toContain("a-secret-value-123");
});

test("the passthrough list: hosts are validated, deduplicated, per project, release_operator only", async () => {
  expect((await call(operator, "add_proxy_passthrough_host", { host: "github.com" })).ok).toBe(
    false,
  );
  const first = await call(relop, "add_proxy_passthrough_host", { host: "GitHub.com" });
  expect(first.ok && (first.output as { added: boolean; host: string; ports: number[] })).toEqual({
    added: true,
    host: "github.com",
    ports: [443],
  });
  const again = await call(relop, "add_proxy_passthrough_host", { host: "github.com" });
  expect(again.ok && (again.output as { added: boolean }).added).toBe(false);
  expect(
    (
      await call(relop, "add_proxy_passthrough_host", {
        host: "*.githubusercontent.com",
        ports: [8443, 443],
      })
    ).ok,
  ).toBe(true);
  for (const ports of [[], [0], [70000], [1.5]]) {
    expect(
      (await call(relop, "add_proxy_passthrough_host", { host: "x.example.test", ports })).ok,
    ).toBe(false);
  }
  for (const bad of ["*", "*.com", "a b", "https://github.com", "git hub.com"]) {
    expect((await call(relop, "add_proxy_passthrough_host", { host: bad })).ok).toBe(false);
  }
  const list = await call(relop, "list_proxy_passthrough_hosts", {});
  expect(list.ok && (list.output as { hosts: unknown[] }).hosts).toEqual([
    { host: "*.githubusercontent.com", ports: [443, 8443] },
    { host: "github.com", ports: [443] },
  ]);
  // Setting a host again replaces its ports.
  const replaced = await call(relop, "add_proxy_passthrough_host", {
    host: "github.com",
    ports: [443, 80],
  });
  expect(replaced.ok && (replaced.output as { added: boolean }).added).toBe(false);
  // Another org sees none and cannot remove ours.
  const other = (await mintToken(db, b.scope, "release_operator")).secret;
  const theirs = await call(other, "list_proxy_passthrough_hosts", {});
  expect(theirs.ok && (theirs.output as { hosts: string[] }).hosts).toEqual([]);
  expect((await call(other, "delete_proxy_passthrough_host", { host: "github.com" })).ok).toBe(
    false,
  );
  expect((await call(operator, "delete_proxy_passthrough_host", { host: "github.com" })).ok).toBe(
    false,
  );
  expect((await call(relop, "delete_proxy_passthrough_host", { host: "github.com" })).ok).toBe(
    true,
  );
  const audit = JSON.stringify(await db.orm.select().from(s.auditLog));
  expect(audit).toContain("add_proxy_passthrough_host");
});
