import { describe, expect, test } from "bun:test";
import * as s from "../src/ops/onboarding-schemas";
import { z } from "zod";

const keys = (o: { shape: Record<string, unknown> }) => Object.keys(o.shape).sort();

describe("onboarding schemas", () => {
  test("create org", () => {
    const ok = { slug: "acme", display_name: "Acme" };
    expect(s.onboardingCreateOrgInput.safeParse(ok).success).toBe(true);
    expect(s.onboardingCreateOrgInput.safeParse({ ...ok, slug: "Bad Slug" }).success).toBe(false);
    expect(
      s.onboardingCreateOrgInput.safeParse({ ...ok, display_name: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      s.onboardingCreateOrgOutput.safeParse({
        org: { id: "1", slug: "acme", display_name: "A" },
        role: "owner",
      }).success,
    ).toBe(true);
    expect(
      s.onboardingCreateOrgOutput.safeParse({
        org: { id: "1", slug: "acme", display_name: "A" },
        role: "admin",
      }).success,
    ).toBe(false);
  });
  test("list_my_orgs rejects a bad role", () => {
    expect(
      s.listMyOrgsOutput.safeParse({ orgs: [{ slug: "a", display_name: "A", role: "admin" }] })
        .success,
    ).toBe(true);
    expect(
      s.listMyOrgsOutput.safeParse({ orgs: [{ slug: "a", display_name: "A", role: "root" }] })
        .success,
    ).toBe(false);
  });
  test("claim schemas", () => {
    expect(s.startInstallationClaimExtraInput.safeParse({ popup: true }).success).toBe(true);
    expect(s.startInstallationClaimExtraInput.safeParse({ popup: "yes" }).success).toBe(false);
    expect(s.startInstallationClaimExtraOutput.safeParse({ claim_id: "c1" }).success).toBe(true);
    expect(
      s.getInstallationClaimOutput.safeParse({
        state: "completed",
        installation_id: "123",
        account_login: "a",
      }).success,
    ).toBe(true);
    expect(s.getInstallationClaimOutput.safeParse({ state: "done" }).success).toBe(false);
    expect(
      s.getInstallationClaimOutput.safeParse({ state: "pending", installation_id: "12x" }).success,
    ).toBe(false);
  });
  test("list_user_installations has no field that could carry an org slug", () => {
    const item = s.listUserInstallationsOutput.shape.installations.element as unknown as {
      shape: Record<string, unknown>;
    };
    expect(keys(item)).toEqual([
      "account_login",
      "account_type",
      "bound",
      "installation_id",
      "repository_selection",
    ]);
    const row = {
      installation_id: "1",
      account_login: "a",
      account_type: "User",
      repository_selection: "all",
      bound: "none",
    };
    expect(s.listUserInstallationsOutput.safeParse({ installations: [row] }).success).toBe(true);
    expect(
      s.listUserInstallationsOutput.safeParse({ installations: [{ ...row, bound: "acme" }] })
        .success,
    ).toBe(false);
  });
  test("bind and list repos", () => {
    expect(s.bindInstallationInput.safeParse({ installation_id: "abc" }).success).toBe(false);
    expect(
      s.bindInstallationOutput.safeParse({
        installation_id: "1",
        account_login: "a",
        projects: [{ slug: "p", repo: "o/r", created: true }],
      }).success,
    ).toBe(true);
    const repo = {
      repo: "o/r",
      repo_id: "9",
      private: false,
      project: null,
      status: "new",
      mode: null,
      paused: false,
    };
    expect(s.listInstallationReposOutput.safeParse({ repos: [repo] }).success).toBe(true);
    expect(
      s.listInstallationReposOutput.safeParse({ repos: [{ ...repo, status: "old" }] }).success,
    ).toBe(false);
  });
  test("onboard_repos defaults mode to off, caps the array", () => {
    const r = s.onboardReposInput.parse({
      installation_id: "1",
      repos: [{ repo_id: "2", enable: true }],
    });
    expect(r.repos[0]?.mode).toBe("off");
    for (const m of ["off", "shadow", "live"]) {
      expect(
        s.onboardReposInput.safeParse({
          installation_id: "1",
          repos: [{ repo_id: "2", enable: true, mode: m }],
        }).success,
      ).toBe(true);
    }
    expect(s.CHECKS_MODE_LABELS.off).toBe(
      "Off: runs on Turntable, posts nothing to GitHub (default)",
    );
    const many = Array.from({ length: 101 }, () => ({ repo_id: "2", enable: true }));
    expect(s.onboardReposInput.safeParse({ installation_id: "1", repos: many }).success).toBe(
      false,
    );
    expect(
      s.onboardReposInput.safeParse({
        installation_id: "1",
        repos: [{ repo_id: "2", enable: true, mode: "x" }],
      }).success,
    ).toBe(false);
  });
  test("preview_workflows", () => {
    expect(s.PREVIEW_MAX_FILES).toBe(50);
    expect(s.PREVIEW_MAX_BYTES).toBe(512 * 1024);
    const wf = {
      path: ".github/workflows/ci.yml",
      name: null,
      triggers: ["push"],
      ingested: true,
      too_large: false,
      jobs: [{ job_id: "b", name: null, verdict: "run" }],
    };
    expect(
      s.previewWorkflowsOutput.safeParse({ sha: "a", truncated: false, workflows: [wf] }).success,
    ).toBe(true);
    const bad = { ...wf, jobs: [{ job_id: "b", name: null, verdict: "maybe" }] };
    expect(
      s.previewWorkflowsOutput.safeParse({ sha: "a", truncated: false, workflows: [bad] }).success,
    ).toBe(false);
  });
  test("run_default_branch", () => {
    const ok = { run_id: "r", sha: "a", trust_class: "protected", created: false };
    expect(s.runDefaultBranchOutput.safeParse(ok).success).toBe(true);
    expect(s.runDefaultBranchOutput.safeParse({ ...ok, trust_class: "other" }).success).toBe(false);
  });
  test("agent token", () => {
    expect(s.createOnboardingAgentTokenInput.parse({}).ttl_days).toBe(30);
    expect(s.createOnboardingAgentTokenInput.safeParse({ ttl_days: 31 }).success).toBe(false);
    expect(s.createOnboardingAgentTokenInput.safeParse({ ttl_days: 0 }).success).toBe(false);
    expect(
      s.createOnboardingAgentTokenInput.safeParse({
        projects: Array.from({ length: 21 }, () => "p"),
      }).success,
    ).toBe(false);
    expect(s.MAX_ACTIVE_ONBOARDING_TOKENS).toBe(5);
    expect([...s.ONBOARDING_TOKEN_SECRET_FIELDS]).toEqual(["token", "claude_command", "mcp_json"]);
    const out = {
      token: "t",
      token_id: "i",
      expires_at: 1,
      mcp_url: "u",
      setup: { claude_command: "c", mcp_json: "{}" },
      prompt: "p",
    };
    expect(s.createOnboardingAgentTokenOutput.safeParse(out).success).toBe(true);
    expect(s.createOnboardingAgentTokenOutput.safeParse({ ...out, expires_at: 1.5 }).success).toBe(
      false,
    );
  });
  test("token secret fields are leaf names of the output, never prompt", () => {
    const leaves = new Set<string>();
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const n = node as { properties?: Record<string, unknown> };
      for (const [k, v] of Object.entries(n.properties ?? {})) {
        leaves.add(k);
        walk(v);
      }
    };
    walk(z.toJSONSchema(s.createOnboardingAgentTokenOutput));
    for (const f of s.ONBOARDING_TOKEN_SECRET_FIELDS) expect(leaves.has(f)).toBe(true);
    expect((s.ONBOARDING_TOKEN_SECRET_FIELDS as readonly string[]).includes("prompt")).toBe(false);
  });
  test("ack and events", () => {
    expect(
      s.onboardingAckOutput.safeParse({
        run_id: "r",
        conclusion: null,
        jobs: [{ name: "b", conclusion: "success" }],
      }).success,
    ).toBe(true);
    expect(
      s.onboardingAckOutput.safeParse({ run_id: "r", conclusion: null, jobs: [{ name: "b" }] })
        .success,
    ).toBe(false);
    expect(
      s.tokenFirstUsedEvent.safeParse({ token_id: "t", principal_kind: "agent" }).success,
    ).toBe(true);
    expect(
      s.tokenFirstUsedEvent.safeParse({ token_id: "t", principal_kind: "robot" }).success,
    ).toBe(false);
    expect(s.onboardingAgentAckEvent.safeParse({ run_id: "r", token_id: "t" }).success).toBe(true);
    expect(
      s.installationClaimUpdatedEvent.safeParse({ claim_id: "c", state: "refused" }).success,
    ).toBe(true);
    expect(s.installationClaimUpdatedEvent.safeParse({ claim_id: "c", state: "x" }).success).toBe(
      false,
    );
  });
  test("vars", () => {
    expect(s.setVarInput.safeParse({ scope: "org", name: "NODE_ENV", value: "x" }).success).toBe(
      true,
    );
    expect(s.setVarInput.safeParse({ scope: "team", name: "NODE_ENV", value: "x" }).success).toBe(
      false,
    );
    expect(s.setVarInput.safeParse({ scope: "org", name: "1BAD", value: "x" }).success).toBe(false);
    expect(
      s.listVarsOutput.safeParse({ vars: [{ name: "A", value: "1", scope: "org", locked: false }] })
        .success,
    ).toBe(true);
  });
  test("secret trust classes exclude untrusted_pr", () => {
    expect([...s.SECRET_TRUST_CLASSES]).not.toContain("untrusted_pr");
    expect(s.secretTrustInput.parse({}).trust_classes).toEqual(["protected"]);
    expect(s.secretTrustInput.safeParse({ trust_classes: ["untrusted_pr"] }).success).toBe(false);
    expect(
      s.secretTrustInput.safeParse({
        trust_classes: ["protected", "trusted_pr"],
        environments: ["prod"],
      }).success,
    ).toBe(true);
    expect(
      s.mapSecretRefInput.safeParse({
        name: "K",
        provider_id: "p",
        ref: "r",
        trust_classes: ["untrusted_pr"],
      }).success,
    ).toBe(false);
  });
  test("secret provider schemas", () => {
    expect(
      s.listSecretProviderTypesOutput.safeParse({
        types: [{ type: "vault", display_name: "V", config_schema: { a: 1 } }],
      }).success,
    ).toBe(true);
    expect(
      s.connectSecretProviderInput.safeParse({ type: "vault", config: { a: 1 } }).success,
    ).toBe(false);
    expect(
      s.connectSecretProviderOutput.safeParse({ provider_id: "p", ok: false, error: "no" }).success,
    ).toBe(true);
    expect(keys(s.testSecretRefOutput)).toEqual(["error", "ok"]);
  });
  test("op list", () => {
    expect(s.ONBOARDING_OPS).toContain("onboard_repos");
    expect(new Set(s.ONBOARDING_OPS).size).toBe(s.ONBOARDING_OPS.length);
  });
});
