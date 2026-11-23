import { Link, useParams, useSearch } from "@tanstack/react-router";
import { CheckCircle2, ChevronRight, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { getBackend } from "@/api";
import type { Approver, EnvironmentApprovalResult } from "@/api/types";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useScope } from "@/features/shell/scope";
import { formatRelative } from "@/lib/format";
import { statementMismatch } from "@/lib/approval-statement";
import { useAsync } from "@/lib/use-async";
import { CeremonyError, signWithPasskey, webauthnAvailable } from "@/lib/webauthn";
import { sanitize } from "@/log/parser";
import { cn } from "@/lib/utils";

const APPROVAL_VALID_FOR = "24 hours";

function Field({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <dt className="text-[13px] text-dim">{label}</dt>
      <dd className={cn("mt-1 break-all text-[13px]", mono && "font-mono")}>{children}</dd>
    </div>
  );
}

/** Review exactly what is being approved, then sign it with a passkey. */
export function ApproveEnvironmentPage() {
  const scope = useScope();
  const { runId = "" } = useParams({ strict: false }) as { runId?: string };
  const search = useSearch({ strict: false }) as { environment?: string };
  const orgSlug = scope.orgSlug as string;
  const projectSlug = scope.projectSlug as string;
  const { api } = getBackend();
  const status = useAsync(() => api.approvalStatus({ runId }), [runId]);
  const approvers = useAsync(() => api.approversOverview(), [scope.orgSlug]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<EnvironmentApprovalResult | null>(null);

  if (status.error && !status.data)
    return (
      <ErrorState
        title="Could not load this approval"
        message={status.error}
        onRetry={status.reload}
      />
    );
  if (!status.data || !approvers.data)
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-5" role="status" aria-label="Loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );

  const s = status.data;
  const env =
    s.environments.find((e) => e.environment === search.environment && e.waiting) ??
    s.environments.find((e) => e.waiting);
  if (!env || !s.headSha || !s.workflowHash)
    return (
      <EmptyState title="Nothing is waiting for approval">
        No job of this run waits on a protected environment.{" "}
        <Link
          to="/$org/$project/runs/$runId"
          params={{ org: orgSlug, project: projectSlug, runId }}
          className="underline"
        >
          Back to the run
        </Link>
      </EmptyState>
    );

  const people = new Set(env.approvals.map((a) => a.person));
  const isAuthor = (a: Approver) =>
    !env.allowAuthorApproval &&
    a.forgeLogin !== null &&
    s.author !== null &&
    a.forgeLogin.toLowerCase() === s.author.toLowerCase();
  const reason = (a: Approver): string | null =>
    a.kind !== "webauthn"
      ? "An offline key signs with the CLI, not in the browser."
      : isAuthor(a)
        ? "The author of a run cannot approve it."
        : people.has(a.person)
          ? "Already approved."
          : null;
  const selected = approvers.data.approvers.find((a) => a.id === chosen) ?? null;
  const simulated = api.capabilities.simulatedCeremony;
  const canSign = simulated || webauthnAvailable();

  const sign = async () => {
    if (!selected || selected.passkeyId === null) return;
    setBusy(true);
    setError(null);
    try {
      const ch = await api.approvalChallenge({
        runId,
        environment: env.environment,
        approver: selected.id,
        project: projectSlug,
      });
      const mismatch = statementMismatch(ch.statement, {
        runId,
        headSha: s.headSha!,
        workflowHash: s.workflowHash!,
        environment: env.environment,
        approver: selected.id,
      });
      // Never sign what is not on the screen.
      if (mismatch) throw new CeremonyError(`Nothing was signed: ${mismatch}.`);
      const signature = simulated
        ? ({
            kind: "webauthn",
            credential_id: "fixture",
            client_data_json: "fixture",
            authenticator_data: "fixture",
            signature: "fixture",
          } as const)
        : await signWithPasskey({
            challenge: ch.challenge,
            rpId: ch.rpId ?? "",
            passkeyId: ch.passkeyId ?? selected.passkeyId,
          });
      setDone(await api.approveEnvironment({ statement: ch.statement, signature }));
      status.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The approval was not accepted.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-5 sm:px-5">
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-[13px] text-dim">
        <Link
          to="/$org/$project/runs/$runId"
          params={{ org: orgSlug, project: projectSlug, runId }}
          className="rounded hover:text-foreground"
        >
          Run
        </Link>
        <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />
        <span className="text-foreground">Approve</span>
      </nav>
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <ShieldCheck className="size-5 text-st-approval" aria-hidden="true" />
        Approve for {sanitize(env.environment)}
      </h1>
      <p className="mt-1 text-sm text-dim">
        You sign exactly what is below. If the commit or the workflow changes, the signature no
        longer applies and the run needs a new approval.
      </p>

      <dl className="mt-5 divide-y divide-line overflow-hidden rounded-xl border border-line">
        <Field label="Environment" mono>
          {sanitize(env.environment)}
        </Field>
        <Field label="Commit (full sha)" mono>
          {s.headSha}
        </Field>
        <Field label="Workflow hash" mono>
          {s.workflowHash}
        </Field>
        <Field label="Run author">{s.author ? sanitize(s.author) : "unknown"}</Field>
        <Field label="Valid for">{APPROVAL_VALID_FOR} after you sign</Field>
        <Field label="Approvals">
          {people.size} of {env.required} distinct people
          {env.approvals.length > 0
            ? ` (${env.approvals.map((a) => `${sanitize(a.person)}, ${formatRelative(a.approvedAt)}`).join("; ")})`
            : ""}
        </Field>
      </dl>

      {done ? (
        <div
          role="status"
          className="mt-5 flex gap-3 rounded-lg border border-st-success/40 bg-st-success-bg p-3.5 text-sm"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-st-success" aria-hidden="true" />
          <p>
            Approved. {done.approvals} of {done.required} approvals.{" "}
            {done.releasedJobs > 0
              ? `${done.releasedJobs} ${done.releasedJobs === 1 ? "job was" : "jobs were"} released.`
              : "Waiting for another approver."}
          </p>
          {done.releasedJobs === 0 ? (
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setDone(null);
                setChosen(null);
              }}
            >
              Sign as another approver
            </Button>
          ) : null}
        </div>
      ) : (
        <section aria-labelledby="who-h" className="mt-6">
          <h2 id="who-h" className="text-sm font-semibold">
            Sign as
          </h2>
          {approvers.data.approvers.length === 0 ? (
            <p className="mt-2 text-sm text-dim">
              No approvers are enrolled. The first one is enrolled from the server with{" "}
              <code className="font-mono text-xs">turntable approvals bootstrap</code>.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
              {approvers.data.approvers.map((a) => {
                const why = reason(a);
                return (
                  <li key={a.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-3 px-4 py-3 text-sm",
                        why && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <input
                        type="radio"
                        name="approver"
                        value={a.id}
                        disabled={why !== null}
                        checked={chosen === a.id}
                        onChange={() => setChosen(a.id)}
                        className="mt-1"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{sanitize(a.person)}</span>
                        <span className="block text-xs text-dim">
                          {a.kind === "webauthn"
                            ? "Passkey or security key"
                            : "Offline ed25519 key"}
                          {why ? `. ${why}` : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-st-failure">
              {error}
            </p>
          ) : null}
          {!canSign ? (
            <p className="mt-3 text-sm text-dim">
              This browser or page cannot use passkeys. Open it over https in a current browser, or
              approve with an offline key.
            </p>
          ) : null}
          <div className="mt-4">
            <Button
              onClick={() => void sign()}
              disabled={busy || !selected || reason(selected) !== null || !canSign}
            >
              <KeyRound />
              {busy ? "Waiting for your key" : "Approve with passkey"}
            </Button>
            {!selected ? (
              <p className="mt-2 text-xs text-dim">Choose who is signing first.</p>
            ) : null}
          </div>
        </section>
      )}

      <details className="mt-8 text-sm">
        <summary className="cursor-pointer text-dim">Approve with an offline key instead</summary>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-dim">
          <li>
            Ask the server for the statement:{" "}
            <code className="font-mono text-xs">POST /api/v1/approvals/challenge</code> with the
            run, environment and your approver id.
          </li>
          <li>
            On the machine that holds your key, sign its{" "}
            <code className="font-mono text-xs">canonical</code> text:{" "}
            <code className="font-mono text-xs">
              turntable approvals sign --key key.pem --statement response.json
            </code>
            .
          </li>
          <li>
            Send the statement and signature to{" "}
            <code className="font-mono text-xs">POST /api/v1/approvals</code>. No token is needed:
            the signature is the credential.
          </li>
        </ol>
      </details>
    </div>
  );
}
