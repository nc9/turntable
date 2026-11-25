import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { WireRunDetail } from "@/api/wire";
import { Button } from "@/components/ui/button";
import { SAMPLE_WORKFLOW, runFinished } from "@/lib/onboarding";

const RUN_WORDS: Record<string, string> = {
  success: "Passed",
  failure: "Failed",
  infra_error: "Stopped by an infrastructure error",
  cancelled: "Cancelled",
  skipped: "Skipped",
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Waiting for approval",
};
export const runWord = (state: string): string => RUN_WORDS[state] ?? state;

/** A job Turntable would refuse to run, from the workflow preview: its reason and the fix. */
export type RefusedJob = {
  workflow: string;
  name: string;
  reason: string | null;
  fix: string | null;
};

export type FinishViewProps = {
  project: string;
  /** Link to the live run page, built by the page (this view stays router-free). */
  runLink: ReactNode;
  run: WireRunDetail | null;
  refused: readonly RefusedJob[];
  /** `turntable / <job>` names for a ruleset. */
  contexts: readonly string[];
  /** The project's checks mode, when known. */
  mode: string | null;
  canGoLive: boolean;
  goLive: { busy: boolean; error: string | null; done: boolean };
  onGoLive: () => void;
  /** The reserved slot for the "Connect an agent" step. */
  agentSlot: ReactNode;
};

/** Copies text to the clipboard, and says whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      onClick={async () => setState((await copyText(text)) ? "copied" : "failed")}
    >
      {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span className="sr-only" role="status">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed: select the text" : ""}
      </span>
    </Button>
  );
}

/** The exact names to add under "Require status checks" in a GitHub ruleset. */
export function ContextList({ contexts }: { contexts: readonly string[] }) {
  if (contexts.length === 0)
    return <p className="text-[13px] text-dim">The check names appear once a run has jobs.</p>;
  return (
    <div className="space-y-1.5">
      <ul className="divide-y divide-line rounded-lg border border-line">
        {contexts.map((c) => (
          <li key={c} className="flex items-center gap-2 px-3 py-1.5">
            <code data-testid="context-name" className="min-w-0 flex-1 break-all text-[13px]">
              {c}
            </code>
            <CopyButton text={c} label={`Copy ${c}`} />
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <CopyButton text={contexts.join("\n")} label="Copy all check names" />
      </div>
    </div>
  );
}

export function NoWorkflowsHint() {
  return (
    <div className="space-y-2 rounded-xl border border-dashed border-line-strong p-4">
      <h3 className="text-sm font-semibold">Add a workflow</h3>
      <p className="text-[13px] text-dim">
        This repo has no workflow Turntable can run yet. Add this file as{" "}
        <code>.github/workflows/ci.yml</code> on the default branch and push it, then run CI.
      </p>
      <pre className="overflow-x-auto rounded-lg bg-subtle p-3 text-xs">{SAMPLE_WORKFLOW}</pre>
      <CopyButton text={SAMPLE_WORKFLOW} label="Copy the sample workflow" />
    </div>
  );
}

export function FinishView(p: FinishViewProps) {
  const jobs = p.run?.jobs ?? [];
  const bad = jobs.filter((j) => j.state === "failure" || j.state === "infra_error");
  const done = p.run ? runFinished(p.run.state) : false;
  return (
    <div className="space-y-6">
      <section aria-labelledby="first-run" className="space-y-2">
        <h2 id="first-run" className="text-sm font-semibold">
          First run of {p.project}
        </h2>
        <p className="text-sm" role="status">
          {p.run ? (
            <>
              {done ? "Conclusion: " : "Status: "}
              <strong>{runWord(p.run.state)}</strong>
            </>
          ) : (
            "Waiting for the run..."
          )}
        </p>
        <div className="text-sm">{p.runLink}</div>
        {bad.length > 0 ? (
          <ul className="space-y-1 text-[13px]">
            {bad.map((j) => (
              <li key={j.id} className="rounded-lg border border-line p-2">
                <span className="font-medium">{j.name}</span>{" "}
                <span className="text-dim">{runWord(j.state)}</span>
                {j.infra_error_reason ? <p className="text-dim">{j.infra_error_reason}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {p.refused.length > 0 ? (
          <div className="space-y-1">
            <h3 className="text-[13px] font-semibold">Jobs Turntable cannot run</h3>
            <ul className="space-y-1 text-[13px]">
              {p.refused.map((j) => (
                <li key={`${j.workflow}:${j.name}`} className="rounded-lg border border-line p-2">
                  <span className="font-medium">{j.name}</span>
                  {j.reason ? <p className="text-dim">{j.reason}</p> : null}
                  {j.fix ? <p>Fix: {j.fix}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="next-steps" className="space-y-4">
        <h2 id="next-steps" className="text-sm font-semibold">
          Next steps
        </h2>
        <div className="space-y-1.5">
          <h3 className="text-[13px] font-semibold">Go live</h3>
          <p className="text-[13px] text-dim">
            {p.mode === "live"
              ? "This project posts live checks already."
              : "Live mode posts `turntable / <job>` checks that your rules can require. Changing the mode needs an owner or admin."}
          </p>
          {p.mode !== "live" ? (
            <Button
              type="button"
              size="sm"
              disabled={!p.canGoLive || p.goLive.busy || p.goLive.done}
              onClick={p.onGoLive}
            >
              {p.goLive.done ? "Live" : p.goLive.busy ? "Switching..." : "Go live"}
            </Button>
          ) : null}
          {p.goLive.error ? (
            <p role="alert" className="text-[13px] text-st-failure">
              {p.goLive.error}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <h3 className="text-[13px] font-semibold">
            Require Turntable checks in your GitHub ruleset
          </h3>
          <p className="text-[13px] text-dim">
            Add these names under Require status checks, exactly as written. They appear on commits
            once the project is live.
          </p>
          <ContextList contexts={p.contexts} />
        </div>
        <div className="space-y-1">
          <h3 className="text-[13px] font-semibold">Invite teammates</h3>
          <p className="text-[13px] text-dim">
            An owner or admin invites a GitHub login to this org. The person signs in with GitHub
            and lands in the org. See the web sign-in page of the docs.
          </p>
        </div>
        {p.agentSlot}
      </section>
    </div>
  );
}
