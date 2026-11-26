import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, createHttpApi } from "../src/api/http-adapter";
import type { ApprovalPolicy, ApprovalPolicyEnv, StepUpProof } from "../src/api/types";
import { ApprovalPolicyPanel } from "../src/features/settings/approval-policy-section";
import { loosensPolicy, saveApprovalPolicy, stepUpInput } from "../src/lib/approval-policy";

const proof: StepUpProof = {
  id: "step-up-id-0123456789",
  approver: "a1",
  signature: { credential_id: "c", client_data_json: "d", authenticator_data: "e", signature: "f" },
};

const prod: ApprovalPolicyEnv = {
  environment: "production",
  required: 2,
  allowAuthorApproval: false,
  keyPolicy: "any",
  gated: true,
  source: "default",
};
const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  environments: [prod],
  source: "default",
  locked: false,
  lockedBy: null,
  approvers: 1,
  ...over,
});
const LOOSE = {
  environment: "production",
  required: 1,
  allowAuthorApproval: true,
  keyPolicy: "any" as const,
};

describe("saving the approval policy", () => {
  test("a loosening in a one-approver org confirms with the passkey first, bound to the exact change", async () => {
    const order: string[] = [];
    const confirm = async (input: Record<string, unknown>) => {
      order.push("confirm");
      expect(input).toEqual({
        environment: "production",
        required: 1,
        allow_author_approval: true,
        key_policy: "any",
      });
      return proof;
    };
    const save = async (a: { stepUp?: StepUpProof }) => {
      order.push("save");
      expect(a.stepUp).toEqual(proof);
      return policy();
    };
    const r = await saveApprovalPolicy(save, prod, LOOSE, confirm);
    expect(r.ok).toBe(true);
    expect(order).toEqual(["confirm", "save"]);
  });

  test("a tightening saves with no passkey", async () => {
    let confirmed = false;
    const r = await saveApprovalPolicy(
      async (a) => {
        expect(a.stepUp).toBeUndefined();
        return policy();
      },
      prod,
      { ...prod, required: 3, allowAuthorApproval: false },
      async () => {
        confirmed = true;
        return proof;
      },
    );
    expect(r.ok).toBe(true);
    expect(confirmed).toBe(false);
  });

  test("a refusal is shown in the server's words, a quorum one included", async () => {
    const msg =
      "loosening approval_policy in an org with 2 approvers needs a quorum of them to sign this exact change first (0 of 2 so far)";
    const r = await saveApprovalPolicy(
      async () => {
        throw new ApiError(403, "forbidden", msg, "approver_quorum_required");
      },
      prod,
      LOOSE,
      async () => proof,
    );
    expect(r).toEqual({ ok: false, message: msg });
  });

  test("loosening is judged per field", () => {
    expect(loosensPolicy(prod, { ...LOOSE, required: 2, allowAuthorApproval: false })).toBe(false);
    expect(loosensPolicy(prod, { ...LOOSE, required: 1, allowAuthorApproval: false })).toBe(true);
    expect(loosensPolicy(prod, { ...LOOSE, required: 2, allowAuthorApproval: true })).toBe(true);
    expect(
      loosensPolicy(
        { ...prod, keyPolicy: "hardware" },
        { ...LOOSE, required: 2, allowAuthorApproval: false },
      ),
    ).toBe(true);
    expect(stepUpInput(LOOSE).allow_author_approval).toBe(true);
  });
});

describe("the approvals section", () => {
  const render = (p: ApprovalPolicy, canEdit = true, drafts = {}) =>
    renderToStaticMarkup(
      <ApprovalPolicyPanel
        policy={p}
        canEdit={canEdit}
        drafts={drafts}
        errors={{}}
        busy={null}
        onDraft={() => {}}
        onSave={() => {}}
      />,
    );

  test("an editable policy shows the effective values with defaults filled in", () => {
    const html = render(policy());
    expect(html).toContain('data-environment="production"');
    expect(html).toContain('value="2"');
    expect(html).not.toContain('disabled=""');
  });

  test("a loosening draft warns that the passkey is asked for and shows Save", () => {
    const html = render(policy(), true, { production: LOOSE });
    expect(html).toContain('data-loosening="production"');
    expect(html).toContain("Save");
  });

  test("a policy locked by turntable.toml is read-only and names its source", () => {
    const html = render(
      policy({ locked: true, source: "toml", lockedBy: "turntable.toml" }),
      true,
      {
        production: LOOSE,
      },
    );
    expect(html).toContain('data-locked="approval_policy"');
    expect(html).toContain("Set in turntable.toml");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain(">Save<");
  });

  test("an env-locked policy names the variable", () => {
    const html = render(
      policy({ locked: true, source: "env", lockedBy: "TURNTABLE_APPROVAL_POLICY" }),
    );
    expect(html).toContain("Set by TURNTABLE_APPROVAL_POLICY");
  });

  test("a non-owner sees it read-only", () => {
    expect(render(policy(), false)).toContain('disabled=""');
  });
});

describe("http adapter", () => {
  test("posts the change with the step-up and maps the policy", async () => {
    const calls: { url: URL; body: unknown; method: string }[] = [];
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_secret",
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({
          url: new URL(String(input), "http://localhost"),
          body: init.body ? JSON.parse(String(init.body)) : undefined,
          method: String(init.method),
        });
        return new Response(
          JSON.stringify({
            environments: [
              {
                environment: "production",
                required: 1,
                allow_author_approval: true,
                key_policy: "any",
                gated: true,
                source: "configured",
              },
            ],
            source: "db",
            locked: false,
            locked_by: null,
            approvers: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const out = await api.setApprovalPolicy({ ...LOOSE, stepUp: proof });
    expect(calls[0]!.url.pathname).toBe("/api/v1/approval-policy");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({
      org: "acme",
      environment: "production",
      required: 1,
      allow_author_approval: true,
      step_up: proof,
    });
    expect(out.environments[0]).toMatchObject({ required: 1, allowAuthorApproval: true });
    await api.getApprovalPolicy();
    expect(calls[1]!.method).toBe("GET");
  });
});
