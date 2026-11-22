import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "../packages/core/src/ops";
import { mcpTools } from "../packages/core/src/ops/mcp";
import { buildOpenApi } from "../packages/core/src/ops/openapi";
import { applyTable, CLI_COMMANDS, surfaces } from "./ops-table";

const root = join(import.meta.dir, "..");
const doc = readFileSync(join(root, "docs/agent-interface.mdx"), "utf8");
const main = readFileSync(join(root, "packages/core/src/main.ts"), "utf8");

/**
 * Why an operation is kept out of MCP although a token can call it. Every `mcp: false` needs an
 * entry here, so a new one is a decision somebody wrote down, and a stale entry fails.
 */
const MCP_OFF: Record<string, string> = {
  set_secret: "the value would sit in an agent's context",
  rotate_secret: "the value would sit in an agent's context",
  approval_challenge: "an agent may relay a signed statement, never create one for signing",
  enrolment_challenge: "approver enrolment is a human act",
  register_challenge: "approver enrolment is a human act",
  request_enrolment: "approver enrolment is a human act",
  request_release: "releasing is a human decision; the release lane re-checks everything anyway",
  start_installation_claim: "binding a GitHub installation to an org is a human act in a browser",
};

describe("the operations table", () => {
  test("docs/agent-interface.mdx is current (bun run scripts/ops-table.ts --write)", () => {
    expect(applyTable(doc)).toBe(doc);
  });

  test("it names every operation exactly once", () => {
    for (const op of registry.ops) {
      expect(doc.split(`| \`${op.name}\` |`).length - 1).toBe(1);
    }
  });

  test("a CLI mapping names a real operation and a command in the usage text", () => {
    for (const [name, cmd] of Object.entries(CLI_COMMANDS)) {
      expect(registry.get(name)).toBeDefined();
      const [group] = cmd.split(" ");
      expect(main).toContain(`longshore ${group} `);
    }
  });

  test("a signature operation has no MCP tool and no CLI mapping", () => {
    for (const op of registry.ops.filter((o) => o.auth.type === "signature")) {
      const s = surfaces(op);
      expect(s.mcp).toBe(false);
      expect(CLI_COMMANDS[op.name]).toBeUndefined();
    }
  });
});

describe("what an agent is shown", () => {
  const tools = mcpTools(registry);
  const spec = buildOpenApi(registry, "0.0.0") as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };
  const inOpenApi = new Set(
    Object.values(spec.paths).flatMap((m) => Object.values(m).map((o) => o.operationId)),
  );

  test("an operation that takes a secret value is never an MCP tool and never in OpenAPI", () => {
    for (const op of registry.ops.filter((o) => o.secretInputFields.length > 0)) {
      expect(op.mcp).toBe(false);
      expect(tools.some((t) => t.name === op.name)).toBe(false);
      expect(inOpenApi.has(op.name)).toBe(false);
    }
  });

  test("every MCP-off operation has a recorded reason, and every reason is still true", () => {
    const off = registry.documentedOps().filter((o) => !o.mcp && o.secretInputFields.length === 0);
    expect(off.map((o) => o.name).toSorted()).toEqual(
      Object.keys(MCP_OFF)
        .filter((n) => registry.get(n)!.secretInputFields.length === 0)
        .toSorted(),
    );
  });

  test("every token operation a role can call is in OpenAPI, and every MCP tool is too", () => {
    for (const op of registry.documentedOps()) {
      if (op.secretInputFields.length === 0) expect(inOpenApi.has(op.name)).toBe(true);
    }
    for (const t of tools) expect(inOpenApi.has(t.name)).toBe(true);
  });

  test("every MCP tool says what it needs and what it does to the world", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(80);
      expect(t.description).toMatch(/Requires role |Needs |role/i);
      expect(t.description).toMatch(/Read-only\.|Side effects: (write|destructive); audited\./);
    }
  });

  test("a signature operation is routed only when it takes a signed statement", () => {
    for (const op of registry.ops.filter((o) => o.auth.type === "signature")) {
      const routed = registry.signatureOps().includes(op);
      expect(surfaces(op).rest !== "").toBe(routed);
      expect(inOpenApi.has(op.name)).toBe(routed);
    }
  });
});
