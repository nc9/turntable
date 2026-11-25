import { Lock, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import { getBackend } from "@/api";
import type { ApprovalPolicy, ApprovalPolicyEnv, StepUpProof } from "@/api/types";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { loosensPolicy, type PolicyDraft, saveApprovalPolicy } from "@/lib/approval-policy";
import { useWhoami } from "@/lib/directory";
import { SOURCE_LABEL } from "@/lib/settings";
import { useAsync } from "@/lib/use-async";
import { signWithPasskey } from "@/lib/webauthn";
import { SourceBadge } from "./settings-panel";

const draftOf = (e: ApprovalPolicyEnv): PolicyDraft => ({
  environment: e.environment,
  required: e.required,
  allowAuthorApproval: e.allowAuthorApproval,
  keyPolicy: e.keyPolicy,
});

/** The presentational editor: one row per environment, read-only when locked. */
export function ApprovalPolicyPanel({
  policy,
  canEdit,
  drafts,
  errors,
  busy,
  onDraft,
  onSave,
}: {
  policy: ApprovalPolicy;
  canEdit: boolean;
  drafts: Record<string, PolicyDraft>;
  errors: Record<string, string>;
  busy: string | null;
  onDraft: (d: PolicyDraft) => void;
  onSave: (e: ApprovalPolicyEnv) => void;
}) {
  const editable = canEdit && !policy.locked;
  return (
    <section data-section="approval-policy" className="mt-8">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 className="text-base font-semibold tracking-tight">Approvals</h2>
        <SourceBadge source={policy.source} />
        {policy.locked ? (
          <span
            data-locked="approval_policy"
            className="inline-flex items-center gap-1 text-xs text-dim"
          >
            <Lock className="size-3" aria-hidden="true" />
            {policy.source === "env"
              ? `Set by ${policy.lockedBy ?? "the environment"}`
              : "Set in turntable.toml"}
            . Change it there.
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-dim">
        How many distinct people approve a run in each environment, and whether its author may.
        Source: <span className="font-mono">{SOURCE_LABEL[policy.source]}</span>. Tightening saves
        at once. Loosening asks you to confirm with your passkey
        {policy.approvers >= 2
          ? `, and needs signatures from a quorum of the org's ${policy.approvers} approvers over the same change`
          : ""}
        .
      </p>
      <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
        {policy.environments.map((e) => {
          const d = drafts[e.environment] ?? draftOf(e);
          const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(e));
          const saving = busy === e.environment;
          const error = errors[e.environment];
          return (
            <li
              key={e.environment}
              className="px-4 py-3.5 text-sm"
              data-environment={e.environment}
            >
              <div className="font-mono text-[13px] font-medium">
                {e.environment}
                {e.gated ? "" : " (no approval needed)"}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-[13px]">
                  Approvers
                  <Input
                    aria-label={`${e.environment} approvers`}
                    className="h-9 w-20 font-mono text-[13px]"
                    type="number"
                    min={1}
                    max={10}
                    value={d.required}
                    disabled={!editable || saving}
                    onChange={(ev) => onDraft({ ...d, required: Number(ev.target.value) })}
                  />
                </label>
                <label className="inline-flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    aria-label={`${e.environment} author may approve`}
                    checked={d.allowAuthorApproval}
                    disabled={!editable || saving}
                    onChange={(ev) => onDraft({ ...d, allowAuthorApproval: ev.target.checked })}
                  />
                  Author may approve their own run
                </label>
                <label className="inline-flex items-center gap-2 text-[13px]">
                  Keys
                  <select
                    aria-label={`${e.environment} key policy`}
                    value={d.keyPolicy}
                    disabled={!editable || saving}
                    onChange={(ev) =>
                      onDraft({
                        ...d,
                        keyPolicy: ev.target.value === "hardware" ? "hardware" : "any",
                      })
                    }
                    className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm disabled:opacity-50"
                  >
                    <option value="any">any key</option>
                    <option value="hardware">hardware keys only</option>
                  </select>
                </label>
                {editable && dirty ? (
                  <Button size="sm" disabled={saving} onClick={() => onSave(e)}>
                    {saving ? "Saving" : "Save"}
                  </Button>
                ) : null}
              </div>
              {editable && dirty && loosensPolicy(e, d) ? (
                <p
                  data-loosening={e.environment}
                  className="mt-1.5 inline-flex items-start gap-1.5 text-[13px] font-medium text-st-approval"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  This weakens human approval and asks for your passkey.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="mt-1.5 text-[13px] font-medium text-st-failure">
                  {error}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The owner's approval policy editor, shown on the org settings page. */
export function ApprovalPolicySection() {
  const { api } = getBackend();
  const who = useWhoami();
  const policy = useAsync(() => api.getApprovalPolicy(), []);
  const [drafts, setDrafts] = useState<Record<string, PolicyDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const reload = policy.reload;

  const confirm = useCallback(
    async (input: Record<string, unknown>): Promise<StepUpProof> => {
      const c = await api.stepUpChallenge({ action: "set_approval_policy", input });
      const key = c.passkeys[0];
      if (!key) throw new Error("No passkey of yours is enrolled to confirm this.");
      const sig = await signWithPasskey({
        challenge: c.challenge,
        rpId: c.rpId,
        passkeyId: key.passkeyId,
      });
      return {
        id: c.id,
        approver: key.approver,
        signature: {
          credential_id: sig.credential_id,
          client_data_json: sig.client_data_json,
          authenticator_data: sig.authenticator_data,
          signature: sig.signature,
        },
      };
    },
    [api],
  );

  const save = useCallback(
    async (e: ApprovalPolicyEnv) => {
      const d = drafts[e.environment];
      if (!d) return;
      setBusy(e.environment);
      setErrors(({ [e.environment]: _gone, ...rest }) => rest);
      const r = await saveApprovalPolicy((a) => api.setApprovalPolicy(a), e, d, confirm);
      setBusy(null);
      if (!r.ok) {
        setErrors((x) => ({ ...x, [e.environment]: r.message }));
        return;
      }
      setDrafts(({ [e.environment]: _gone, ...rest }) => rest);
      reload();
    },
    [api, confirm, drafts, reload],
  );

  if (who.data && who.data.role !== "owner") return null;
  if (policy.error) return <ErrorState message={policy.error} onRetry={reload} />;
  if (!policy.data) return <Skeleton className="mt-6 h-32 w-full" />;
  return (
    <ApprovalPolicyPanel
      policy={policy.data}
      canEdit={who.data?.role === "owner"}
      drafts={drafts}
      errors={errors}
      busy={busy}
      onDraft={(d) => setDrafts((x) => ({ ...x, [d.environment]: d }))}
      onSave={(e) => void save(e)}
    />
  );
}
