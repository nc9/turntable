import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "../src/ops";
import { lintOutputSchemas, outputFieldNames } from "../src/ops/lint";
import { mcpTools } from "../src/ops/mcp";
import { buildOpenApi } from "../src/ops/openapi";
import { createRegistry, defineOp } from "../src/ops";
import { z } from "zod";

const DOC = join(import.meta.dir, "../../../docs/openapi.json");

test("docs/openapi.json is current (run `bun run --cwd packages/core openapi:gen`)", () => {
  const committed = JSON.parse(readFileSync(DOC, "utf8"));
  // compare parsed, so formatter whitespace cannot flap this
  expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApi(registry, "0.0.0-dev"))));
});

test("the generated document is a structurally valid OpenAPI 3.1 document", () => {
  const doc = buildOpenApi(registry, "0.0.0-dev") as any;
  expect(doc.openapi).toBe("3.1.0");
  expect(doc.info.title).toBeString();
  expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
    type: "http",
    scheme: "bearer",
  });

  const ids = new Set<string>();
  const refs: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string") refs.push(v);
        else collect(v);
      }
    }
  };
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    expect(path.startsWith("/")).toBe(true);
    for (const [method, op] of Object.entries<any>(item)) {
      expect(["get", "post", "delete"]).toContain(method);
      expect(ids.has(op.operationId)).toBe(false);
      ids.add(op.operationId);
      expect(op.responses["200"].content["application/json"].schema.type).toBe("object");
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      // every {param} in the path is declared, required, and in: path
      for (const m of path.matchAll(/\{(\w+)\}/g)) {
        const p = (op.parameters ?? []).find((x: any) => x.name === m[1]);
        expect(p).toMatchObject({ in: "path", required: true });
      }
      if (method === "get") expect(op.requestBody).toBeUndefined();
    }
  }
  collect(doc);
  for (const ref of refs) {
    const target = ref
      .slice(2)
      .split("/")
      .reduce((n: any, k) => n?.[k], doc);
    expect(target).toBeDefined();
  }
  expect([...ids].toSorted()).toEqual(
    registry
      .tokenOps()
      .map((o) => o.name)
      .toSorted(),
  );
});

test("MCP tool list equals the registry minus signature ops", () => {
  const sig = defineOp({
    name: "sign_thing",
    summary: "Placeholder signature op.",
    description: "Test-only placeholder for a human signed action; excluded from tools.",
    input: z.object({}),
    output: z.object({}),
    effect: "write",
    auth: { type: "signature", minRole: "owner" },
    untrustedOutput: false,
    scope: "org",
    http: { method: "POST", path: "/sign" },
    handler: async () => ({}),
  });
  const withSig = createRegistry([...registry.ops, sig]);
  expect(mcpTools(withSig).map((t) => t.name)).toEqual(
    withSig.ops.filter((o) => o.auth.type !== "signature").map((o) => o.name),
  );
  expect(mcpTools(registry).map((t) => t.name)).toEqual(registry.ops.map((o) => o.name));

  for (const tool of mcpTools(registry)) {
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tool.description.length).toBeGreaterThan(60);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toHaveProperty("org");
    const op = registry.get(tool.name)!;
    expect(tool.annotations.readOnlyHint).toBe(op.effect === "read");
    expect(tool.annotations.destructiveHint).toBe(op.effect === "destructive");
    expect(tool.untrustedOutput).toBe(op.untrustedOutput);
  }
});

test("operations meet the agent-facing conventions", () => {
  for (const op of registry.ops) {
    expect(op.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    // log and forge text is flagged
    if (["job_log", "list_runs", "get_run", "checks_for_sha"].includes(op.name)) {
      expect(op.untrustedOutput).toBe(true);
    }
    // writes need at least the operator role; reads may be readers
    if (op.effect !== "read") expect(op.auth.minRole).not.toBe("reader");
    // list ops page by cursor
    if (op.name.startsWith("list_")) {
      const props = Object.keys(
        mcpTools(registry).find((t) => t.name === op.name)!.inputSchema.properties ?? {},
      );
      expect(props).toEqual(expect.arrayContaining(["limit", "cursor"]));
      expect(outputFieldNames(op)).toContain("next_cursor");
    }
  }
});

test("output lint: no secret-looking output field except a declared one-time secret", () => {
  expect(lintOutputSchemas(registry)).toEqual([]);
  expect(registry.get("create_api_token")!.oneTimeSecretFields).toEqual(["token"]);

  const make = (field: string, oneTime: string[] = []) =>
    createRegistry([
      defineOp({
        name: "bad_op",
        summary: "Lint fixture.",
        description: "Fixture op used to prove the output lint catches secret-looking fields.",
        input: z.object({}),
        output: z.object({ nested: z.object({ [field]: z.string() }) }),
        effect: "read",
        auth: { type: "token", minRole: "reader" },
        untrustedOutput: false,
        scope: "org",
        http: { method: "GET", path: "/bad" },
        oneTimeSecretFields: oneTime,
        handler: async () => ({ nested: { [field]: "" } }),
      }),
    ]);
  for (const field of [
    "secret",
    "client_secret",
    "password",
    "token_value",
    "api_key",
    "token",
    "private_key",
  ]) {
    expect(lintOutputSchemas(make(field)).length).toBeGreaterThan(0);
  }
  // a declared one-time secret passes; declaring a field that does not exist is flagged
  expect(lintOutputSchemas(make("token", ["token"]))).toEqual([]);
  expect(lintOutputSchemas(make("name", ["token"]))).toHaveLength(1);
});
