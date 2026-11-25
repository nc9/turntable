import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffMcpTools, diffOpenApi, isWatchedOp } from "./cd/api-surface";
import { renderMcpTools } from "./mcp-tools";

const prop = (extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties: { id: { type: "string" }, state: { type: "string", enum: ["a", "b"] } },
  required: ["id"],
  ...extra,
});
const doc = (o: {
  id?: string;
  path?: string;
  method?: string;
  params?: unknown[];
  body?: unknown;
  response?: unknown;
}) => ({
  paths: {
    [o.path ?? "/checks/{sha}"]: {
      [o.method ?? "get"]: {
        operationId: o.id ?? "checks_for_sha",
        parameters: o.params ?? [
          { name: "sha", in: "path", required: true, schema: { type: "string" } },
        ],
        ...(o.body === undefined ? {} : { requestBody: o.body }),
        responses: { "200": { content: { "application/json": { schema: o.response ?? prop() } } } },
      },
    },
  },
});
const base = doc({});

describe("the OpenAPI diff", () => {
  test("no change passes; description edits are ignored", () => {
    expect(diffOpenApi(base, base)).toEqual([]);
    const text = doc({ response: { ...prop(), description: "reworded" } });
    expect(diffOpenApi(base, text)).toEqual([]);
  });

  test("a new optional response property passes, also nested and via $ref", () => {
    const grown = prop({
      properties: {
        id: { type: "string" },
        state: { type: "string", enum: ["a", "b"] },
        extra: { type: "integer" },
      },
    });
    expect(diffOpenApi(base, doc({ response: grown }))).toEqual([]);
    const refd = (extra: boolean) => ({
      paths: (doc({ response: { $ref: "#/components/schemas/R" } }) as { paths: unknown }).paths,
      components: { schemas: { R: extra ? grown : prop() } },
    });
    expect(diffOpenApi(refd(false), refd(true))).toEqual([]);
  });

  const holds: [string, unknown][] = [
    [
      "a new required response property",
      doc({
        response: prop({
          properties: {
            id: { type: "string" },
            state: { type: "string", enum: ["a", "b"] },
            extra: { type: "string" },
          },
          required: ["id", "extra"],
        }),
      }),
    ],
    ["a removed property", doc({ response: prop({ properties: { id: { type: "string" } } }) })],
    [
      "a renamed property",
      doc({
        response: prop({
          properties: { id: { type: "string" }, status: { type: "string", enum: ["a", "b"] } },
        }),
      }),
    ],
    [
      "a type change",
      doc({
        response: prop({
          properties: { id: { type: "integer" }, state: { type: "string", enum: ["a", "b"] } },
        }),
      }),
    ],
    ["a property becoming required", doc({ response: prop({ required: ["id", "state"] }) })],
    [
      "an enum value removed",
      doc({
        response: prop({
          properties: { id: { type: "string" }, state: { type: "string", enum: ["a"] } },
        }),
      }),
    ],
    ["a path change", doc({ path: "/checks/by/{sha}" })],
    ["a method change", doc({ method: "post" })],
    [
      "a parameter added",
      doc({
        params: [
          { name: "sha", in: "path", required: true, schema: { type: "string" } },
          { name: "q", in: "query", schema: { type: "string" } },
        ],
      }),
    ],
    [
      "a parameter type change",
      doc({ params: [{ name: "sha", in: "path", required: true, schema: { type: "integer" } }] }),
    ],
    ["a request body added", doc({ body: { content: {} } })],
    ["the operation removed", { paths: {} }],
  ];
  for (const [name, next] of holds) {
    test(`${name} holds`, () => {
      expect(diffOpenApi(base, next).length).toBeGreaterThan(0);
    });
  }

  test("a request-body property added or removed holds, even optional", () => {
    const body = (props: Record<string, unknown>) => ({
      content: { "application/json": { schema: { type: "object", properties: props } } },
    });
    const a = doc({
      id: "request_release",
      path: "/release-requests",
      method: "post",
      body: body({ tag: { type: "string" } }),
    });
    const b = doc({
      id: "request_release",
      path: "/release-requests",
      method: "post",
      body: body({ tag: { type: "string" }, x: { type: "string" } }),
    });
    expect(diffOpenApi(a, b).join()).toContain("request");
    expect(diffOpenApi(b, a).length).toBeGreaterThan(0);
  });

  test("release and approval operations are watched, others are not", () => {
    for (const n of [
      "checks_for_sha",
      "failure_digest",
      "job_log",
      "list_runs",
      "get_run",
      "events",
      "request_release",
      "get_release_request",
      "approve_run",
      "approve_release",
      "release_approval_challenge",
      "submit_approval",
      "approval_status",
    ]) {
      expect(isWatchedOp(n)).toBe(true);
    }
    for (const n of ["whoami", "list_orgs", "set_setting", "job_steps"])
      expect(isWatchedOp(n)).toBe(false);
    const other = (extra: boolean) =>
      doc({ id: "whoami", response: extra ? prop({ properties: {} }) : prop() });
    expect(diffOpenApi(other(false), other(true))).toEqual([]);
  });
});

describe("the MCP tool diff", () => {
  const tool = (name: string, props: Record<string, unknown>) => ({
    name,
    inputSchema: { type: "object", properties: props },
  });
  test("an input change, a removed tool and an added tool hold; no change and unwatched changes pass", () => {
    const a = [tool("get_run", { run_id: { type: "string" } }), tool("whoami", {})];
    expect(diffMcpTools(a, a)).toEqual([]);
    expect(
      diffMcpTools(a, [
        tool("get_run", { run_id: { type: "string" }, x: { type: "string" } }),
        tool("whoami", {}),
      ]).length,
    ).toBe(1);
    expect(
      diffMcpTools(a, [tool("get_run", { run_id: { type: "integer" } }), tool("whoami", {})])
        .length,
    ).toBe(1);
    expect(diffMcpTools(a, [tool("whoami", {})]).join()).toContain("removed");
    expect(diffMcpTools(a, [...a, tool("approve_run", {})]).join()).toContain("added");
    expect(diffMcpTools(a, [a[0], tool("whoami", { y: {} })])).toEqual([]);
  });
});

test("docs/mcp-tools.json is current (run bun run scripts/mcp-tools.ts --write)", () => {
  expect(JSON.parse(readFileSync(join(import.meta.dir, "../docs/mcp-tools.json"), "utf8"))).toEqual(
    JSON.parse(renderMcpTools()),
  );
});
