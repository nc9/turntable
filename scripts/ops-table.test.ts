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
  release_approval_challenge:
    "an agent may relay a signed release approval, never create the statement a human signs over the release manifest",
  approve_run_challenge: "an agent may relay a signed statement, never create one for signing",
  enrolment_challenge: "approver enrolment is a human act",
  register_challenge: "approver enrolment is a human act",
  request_enrolment: "approver enrolment is a human act",
  session_step_up_challenge: "a passkey step-up is a human act in a browser session",
  request_release: "releasing is a human decision; the release lane re-checks everything anyway",
  start_installation_claim: "binding a GitHub installation to an org is a human act in a browser",
  get_installation_claim: "a claim belongs to the person who started it in a browser",
  bind_installation:
    "binding a GitHub installation needs the person's own GitHub authorization: a human act in a browser",
  onboarding_create_org: "an account session (a person in a browser) creates it: never a token",
  list_my_orgs: "an account session (a person in a browser) reads it: never a token",
  list_user_installations: "an account session (a person in a browser) reads it: never a token",
  set_proxy_rule: "decides where a secret may be sent: a limit-raising setter",
  add_proxy_passthrough_host: "widens the egress of secret-bearing jobs: a limit-raising setter",
  accept_action_move: "a trust decision: it blesses a moved action tag for protected runs",
  incident_unfreeze: "reversing the safety stop is human-only (freezing stays on MCP)",
  create_api_token: "token minting: never into an agent's context, and no agent role can call it",
  sign_release: "signature op: a human-signed assertion, never a token",
  approve_environment: "signature op: a human-signed statement, never a token",
  approve_release:
    "signature op: a human-signed statement over the release manifest, never a token",
  approve_enrolment: "signature op: a human-signed statement, never a token",
  key_policy_challenge: "changing which approver keys count is a human act, like enrolment",
  instance_whoami:
    "instance administrator ops are REST only: that token is never given to an agent",
  instance_list_orgs:
    "instance administrator ops are REST only: that token is never given to an agent",
  instance_github_app_status:
    "instance administrator ops are REST only: the App's id, owner and unclaimed installations are the operator's",
  instance_doctor:
    "instance administrator ops are REST only: instance-wide readiness facts, never an agent's",
  instance_ingest_status:
    "instance administrator ops are REST only: cross-tenant poll health is the operator's view, never an agent's",
  instance_audit_verify:
    "instance administrator ops are REST only: audit integrity is the operator's check, never an agent's",
  set_quotas: "instance administrator ops are REST only, and quotas are a limit-raising setter",
  set_project_settings:
    "instance administrator ops are REST only: a project's snapshot and cap are operator controls, never an agent's",
  create_project:
    "instance administrator ops are REST only: projects are made by the operator, never an agent",
  create_org:
    "instance administrator ops are REST only: tenants are made by the operator, never an agent",
  create_org_token:
    "instance administrator ops are REST only: minting an org's first token must never land in an agent's context",
  move_repo_binding:
    "instance administrator ops are REST only: moving a repo between tenants is the operator's act, never an agent's",
  instance_start_installation_claim:
    "instance administrator ops are REST only: starting a tenant's GitHub claim is the operator's act, never an agent's",
  instance_drain:
    "instance administrator ops are REST only: pausing every tenant's scheduling for a deploy is the operator's act, never an agent's",
  instance_drain_status:
    "instance administrator ops are REST only: it reports cross-tenant running counts, which never land in an agent's context",
  instance_revoke_org_token:
    "instance administrator ops are REST only: breaking glass on a tenant's token is the operator's act, never an agent's",
  instance_org_summary:
    "instance administrator ops are REST only: cross-tenant identity counts are the operator's check, never an agent's",
  instance_run_activity:
    "instance administrator ops are REST only: cross-tenant run counts are the operator's deploy check, never an agent's",
  instance_bind_github_login:
    "instance administrator ops are REST only: granting an org's first admin or owner is the operator's act, never an agent's",
  invite_member:
    "granting membership binds a person's identity: never an agent's act (an agent token is refused too)",
  db_backup:
    "instance administrator ops are REST only: it writes a copy of the whole database, never an agent's act",
  rotate_instance_token:
    "instance administrator ops are REST only: instance tokens are never MCP credentials, and minting one must not land in an agent's context",
  bootstrap_approver:
    "instance administrator ops are REST only, and enrolling an org's first approver is a human act: the trust root, never an agent's",
  instance_get_setting:
    "instance administrator ops are REST only: instance settings (and where a locked one is set) are the operator's",
  instance_list_settings:
    "instance administrator ops are REST only: instance settings (and where a locked one is set) are the operator's",
  instance_set_setting:
    "instance administrator ops are REST only: instance settings are the operator's, never changed from an agent's context",
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
      expect(main).toContain(`turntable ${group} `);
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
    const off = registry.ops.filter((o) => !o.mcp && o.secretInputFields.length === 0);
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
