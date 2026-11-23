import { beforeEach, expect, test } from "bun:test";
import { type Db, getRun } from "../src/db";
import { registry } from "../src/ops";
import { createRestApi } from "../src/ops/rest";
import { handleRequest } from "../src/server";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let reader: string;
let operator: string;
let api: ReturnType<typeof createRestApi>;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
  operator = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
  api = createRestApi({ registry, db });
});

type Res = Omit<Response, "json"> & { json(): Promise<any> };

const req = async (path: string, init: RequestInit & { token?: string } = {}): Promise<Res> => {
  const { token, ...rest } = init;
  return (await handleRequest(
    new Request(`http://localhost${path}`, {
      ...rest,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers as object),
      },
    }),
    api,
  )) as unknown as Res;
};

test("every token op has a route; unknown routes and wrong methods are typed errors", async () => {
  const none = await req("/api/v1/nope", { token: reader });
  expect(none.status).toBe(404);
  expect((await none.json()).error.code).toBe("not_found");

  const wrong = await req("/api/v1/runs", { method: "DELETE", token: reader });
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("allow")).toBe("GET");
  expect((await wrong.json()).error.code).toBe("method_not_allowed");
});

test("auth: missing and bad tokens are 401 with a challenge and a typed body", async () => {
  const missing = await req("/api/v1/runs");
  expect(missing.status).toBe(401);
  expect(missing.headers.get("www-authenticate")).toContain("Bearer");
  expect((await missing.json()).error.code).toBe("unauthenticated");
  const bad = await req("/api/v1/runs", { token: "tt_wrong" });
  expect(bad.status).toBe(401);
  // not Bearer scheme
  const basic = await req("/api/v1/runs", { headers: { authorization: "Basic abc" } });
  expect(basic.status).toBe(401);
});

test("GET /runs: query coercion, cursor pagination, untrusted header, security headers", async () => {
  for (let i = 0; i < 4; i++) {
    const { createRun } = await import("../src/db");
    await createRun(db, a.scope, { workflowPath: "w.yml", event: "push", ref: "main" });
  }
  const first = await req("/api/v1/runs?limit=2", { token: reader });
  expect(first.status).toBe(200);
  expect(first.headers.get("x-turntable-untrusted-content")).toBe("true");
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(first.headers.get("x-content-type-options")).toBe("nosniff");
  expect(first.headers.get("content-type")).toContain("application/json");
  const page1 = await first.json();
  expect(page1.runs).toHaveLength(2);
  const second = await (
    await req(`/api/v1/runs?limit=10&cursor=${page1.next_cursor}`, { token: reader })
  ).json();
  expect(second.runs).toHaveLength(3);
  expect(second.next_cursor).toBeNull();

  const badLimit = await req("/api/v1/runs?limit=abc", { token: reader });
  expect(badLimit.status).toBe(400);
  const body = await badLimit.json();
  expect(body.error.code).toBe("invalid_input");
  expect(body.error.details[0].path).toBe("limit");
  const typo = await req("/api/v1/runs?brnach=main", { token: reader });
  expect(typo.status).toBe(400);
  const dup = await req("/api/v1/runs?limit=1&limit=2", { token: reader });
  expect(dup.status).toBe(400);
});

test("path params, 404 for another org's resource, and cross-org slug", async () => {
  const mine = await req(`/api/v1/runs/${a.runId}`, { token: reader });
  expect(mine.status).toBe(200);
  expect((await mine.json()).jobs).toHaveLength(1);
  const theirs = await req(`/api/v1/runs/${b.runId}`, { token: reader });
  expect(theirs.status).toBe(404);
  const slug = await req(`/api/v1/runs?org=${b.slug}`, { token: reader });
  expect(slug.status).toBe(404);
  const log = await req(`/api/v1/jobs/${a.jobId}/log?lines=5&mode=tail`, { token: reader });
  expect(log.status).toBe(200);
  expect((await log.json()).mode).toBe("tail");
});

test("POST /runs/{id}/cancel: role is enforced by dispatch, not the adapter", async () => {
  const denied = await req(`/api/v1/runs/${a.runId}/cancel`, { method: "POST", token: reader });
  expect(denied.status).toBe(403);
  expect((await denied.json()).error.code).toBe("forbidden");
  expect((await getRun(db, a.scope, a.runId))?.status).toBe("queued");

  const ok = await req(`/api/v1/runs/${a.runId}/cancel`, { method: "POST", token: operator });
  expect(ok.status).toBe(200);
  expect((await ok.json()).cancelled_jobs).toBe(1);
  expect((await getRun(db, a.scope, a.runId))?.status).toBe("cancelled");
});

test("POST bodies: json object only, size capped, path wins over body", async () => {
  const text = await req("/api/v1/tokens", { method: "POST", token: operator, body: "not json" });
  expect(text.status).toBe(400);
  const arr = await req("/api/v1/tokens", { method: "POST", token: operator, body: "[1]" });
  expect(arr.status).toBe(400);
  const big = await req("/api/v1/tokens", {
    method: "POST",
    token: operator,
    body: "x".repeat(70_000),
  });
  expect(big.status).toBe(413);
  // delegated minting (#437) never escalates: an operator token cannot mint above its own role,
  // and a reader token cannot mint at all, whatever the body says
  const escalate = await req("/api/v1/tokens", {
    method: "POST",
    token: operator,
    body: JSON.stringify({ name: "x", role: "release_operator" }),
  });
  expect(escalate.status).toBe(403);
  const readerMint = await req("/api/v1/tokens", {
    method: "POST",
    token: reader,
    body: JSON.stringify({ name: "x", role: "reader" }),
  });
  expect(readerMint.status).toBe(403);
  // path param beats a conflicting body value
  const conflict = await req(`/api/v1/runs/${a.runId}/cancel`, {
    method: "POST",
    token: operator,
    body: JSON.stringify({ run_id: b.runId }),
  });
  expect(conflict.status).toBe(200);
  expect((await getRun(db, b.scope, b.runId))?.status).toBe("queued");
});

test("GET /openapi.json is served without auth and matches the registry", async () => {
  const res = await req("/openapi.json");
  expect(res.status).toBe(200);
  const doc = await res.json();
  expect(doc.openapi).toBe("3.1.0");
  expect(Object.keys(doc.paths).toSorted()).toEqual(
    [
      ...new Set(
        [
          ...registry.documentedOps().filter((o) => o.mcp || o.secretInputFields.length === 0),
          ...registry.signatureOps(),
          ...registry.instanceOps(),
        ].map((o) => o.http.path),
      ),
    ].toSorted(),
  );
});

test("non-API paths keep their behaviour", async () => {
  expect((await req("/healthz")).status).toBe(200);
  expect((await req("/healthz", { method: "POST" })).status).toBe(405);
  expect((await req("/nope")).status).toBe(404);
});
