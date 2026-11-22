import { ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { getBackend } from "@/api";
import { useScope } from "@/features/shell/scope";
import { formatRelative } from "@/lib/format";
import { sanitize } from "@/log/parser";
import { useAsync } from "@/lib/use-async";

const POLL_MS = 30_000;

/**
 * Shown on every page while the org (or the open project) is frozen by an incident response:
 * nothing new is scheduled. The reason is text a person typed, so it is sanitised and rendered
 * as text. Hidden when the API does not have the operation.
 */
export function IncidentBanner() {
  const scope = useScope();
  const project = scope.projectSlug ?? undefined;
  const q = useAsync(
    () => getBackend().api.incidentStatus(project ? { project } : {}),
    [scope.orgSlug, project],
  );
  const reload = q.reload;
  useEffect(() => {
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  const s = q.data;
  if (!s?.frozen) return null;
  const n = s.rotationRequired.length;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-st-failure/40 bg-st-failure-bg px-4 py-2.5 text-sm"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-st-failure" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-64">
        <p className="font-medium text-foreground">
          Scheduling is frozen for this {s.level === "project" ? "project" : "org"}
        </p>
        <p className="mt-0.5 break-words text-foreground">
          {s.reason ? `Reason: ${sanitize(s.reason)}` : "No reason was recorded."}
        </p>
        <p className="mt-0.5 text-[13px] text-dim">
          {s.frozenBy ? `Frozen by ${sanitize(s.frozenBy)}` : "Frozen"}
          {s.frozenAt ? ` ${formatRelative(s.frozenAt)}` : ""}. Running jobs were stopped and
          nothing new starts until it is unfrozen.
          {n > 0
            ? ` ${n} ${n === 1 ? "secret needs" : "secrets need"} rotation: ${s.rotationRequired
                .slice(0, 5)
                .map((r) => sanitize(r.name))
                .join(", ")}${n > 5 ? ` and ${n - 5} more` : ""}.`
            : ""}
        </p>
      </div>
    </div>
  );
}
