import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { JobState } from "@/api/types";
import { StateIcon } from "@/components/state-badge";
import { useNow } from "@/components/live-clock";
import { formatDuration } from "@/lib/format";
import type { Annotation, StepInfo } from "@/log/parser";
import { cn } from "@/lib/utils";

function stepState(step: StepInfo, attemptState: JobState, truncated: boolean): JobState {
  if (step.result === "success") return "success";
  if (step.result === "failure") return "failure";
  if (step.result === "skipped") return "cancelled";
  // The end marker may lie beyond the loaded window: borrow the attempt's own result.
  if (truncated)
    return attemptState === "running" || attemptState === "queued" ? "running" : attemptState;
  // Open step: still running while the attempt runs, otherwise it never finished.
  if (attemptState === "running" || attemptState === "queued") return "running";
  if (attemptState === "infra_error") return "infra_error";
  return "cancelled";
}

export function StepList({
  steps,
  attemptState,
  truncated,
  activeStep,
  onJump,
}: {
  steps: readonly StepInfo[];
  attemptState: JobState;
  truncated: boolean;
  activeStep: number;
  onJump: (offset: number) => void;
}) {
  const live =
    steps.some((s) => s.result === null) &&
    (attemptState === "running" || attemptState === "queued");
  const now = useNow(live);
  if (steps.length === 0)
    return (
      <p className="px-3 py-6 text-sm text-dim">
        No step boundaries yet. They appear as the job starts each step.
      </p>
    );
  return (
    <ol className="flex flex-col gap-0.5 p-2">
      {steps.map((s) => {
        const state = stepState(s, attemptState, truncated);
        const end = s.endTs ?? (state === "running" ? now : null);
        const dur = s.startTs !== null && end !== null ? formatDuration(end - s.startTs) : null;
        return (
          <li key={s.index}>
            <button
              type="button"
              onClick={() => onJump(s.startOffset)}
              aria-current={activeStep === s.index ? "step" : undefined}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors duration-150 hover:bg-muted aria-[current=step]:bg-muted",
                s.result === "failure" && "text-st-failure",
              )}
            >
              <StateIcon state={state} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="tabular shrink-0 text-xs text-faint">{dur ?? ""}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const LEVEL_ICON = { error: CircleAlert, warning: TriangleAlert, notice: Info } as const;
const LEVEL_TEXT = {
  error: "text-st-failure",
  warning: "text-st-infra",
  notice: "text-st-running",
} as const;

export function AnnotationList({
  annotations,
  onJump,
}: {
  annotations: readonly Annotation[];
  onJump: (line: number) => void;
}) {
  if (annotations.length === 0)
    return (
      <p className="px-3 py-6 text-sm text-dim">
        No annotations. Errors, warnings and notices from the job are listed here.
      </p>
    );
  return (
    <ul className="flex flex-col gap-0.5 p-2">
      {annotations.map((a) => {
        const Icon = LEVEL_ICON[a.level];
        return (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onJump(a.lineIndex)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
            >
              <Icon
                className={cn("mt-0.5 size-3.5 shrink-0", LEVEL_TEXT[a.level])}
                aria-label={a.level}
              />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 break-words">
                  {a.title ? `${a.title}: ${a.message}` : a.message}
                </span>
                {a.file ? (
                  <span className="mt-0.5 block truncate font-mono text-xs text-faint">
                    {a.file}
                    {a.line !== null ? `:${a.line}` : ""}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 font-mono text-xs text-faint">L{a.lineIndex + 1}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function LogSidebar({
  steps,
  annotations,
  attemptState,
  truncated,
  activeStep,
  onJumpLine,
  onJumpOffset,
  className,
}: {
  steps: readonly StepInfo[];
  annotations: readonly Annotation[];
  attemptState: JobState;
  truncated: boolean;
  activeStep: number;
  onJumpLine: (line: number) => void;
  onJumpOffset: (offset: number) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<"steps" | "annotations">("steps");
  const errors = annotations.filter((a) => a.level === "error").length;
  const tabBtn = (id: "steps" | "annotations", label: string, badge?: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      id={`log-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`log-panel-${id}`}
      onClick={() => setTab(id)}
      className={cn(
        "flex h-9 flex-1 items-center justify-center gap-1.5 border-b-2 text-[13px] font-medium transition-colors duration-150 focus-visible:-outline-offset-2",
        tab === id
          ? "border-foreground text-foreground"
          : "border-transparent text-dim hover:text-foreground",
      )}
    >
      {label}
      {badge}
    </button>
  );
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div
        role="tablist"
        aria-label="Log navigation"
        className="flex shrink-0 border-b border-line"
      >
        {tabBtn("steps", "Steps")}
        {tabBtn(
          "annotations",
          "Annotations",
          annotations.length > 0 ? (
            <span
              className={cn(
                "tabular rounded-full px-1.5 text-xs",
                errors > 0 ? "bg-st-failure-bg text-st-failure" : "bg-muted text-dim",
              )}
            >
              {annotations.length}
            </span>
          ) : null,
        )}
      </div>
      <div
        role="tabpanel"
        id={`log-panel-${tab}`}
        aria-labelledby={`log-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {tab === "steps" ? (
          <StepList
            steps={steps}
            attemptState={attemptState}
            truncated={truncated}
            activeStep={activeStep}
            onJump={onJumpOffset}
          />
        ) : (
          <AnnotationList annotations={annotations} onJump={onJumpLine} />
        )}
      </div>
    </div>
  );
}
