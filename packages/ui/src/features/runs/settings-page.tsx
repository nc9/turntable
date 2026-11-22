import { Lock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { useScope } from "@/features/shell/scope";

export function SettingsPage() {
  const scope = useScope();
  if (scope.projects && scope.project === null)
    return <EmptyState title="Project not found">Pick a project from the sidebar.</EmptyState>;
  const rows: [string, string][] = [
    ["Name", scope.project?.name ?? ""],
    ["Slug", scope.project?.slug ?? ""],
    ["Repository", scope.project?.repo ?? ""],
  ];
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">Project settings</h1>
      <p className="mt-0.5 text-sm text-dim">
        Read-only for now. Editing arrives with the configuration API.
      </p>
      <dl className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center gap-4 px-4 py-3 text-sm">
            <dt className="w-32 shrink-0 text-dim">{k}</dt>
            <dd className="min-w-0 flex-1 truncate font-mono text-[13px]">{v || "-"}</dd>
            <Lock className="size-3.5 text-faint" aria-label="Read-only" />
          </div>
        ))}
      </dl>
      <p className="mt-6 text-sm text-dim">
        Secrets, environments and approval rules will live here. Secret values are never shown in
        the UI.
      </p>
    </div>
  );
}
