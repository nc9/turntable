import { EmptyState } from "@/components/empty-state";
import { useScope } from "@/features/shell/scope";
import { ApprovalNotifyToggle } from "@/features/shell/approval-notifications";
import { SettingsSection } from "./settings-section";

export function OrgSettingsPage() {
  const scope = useScope();
  if (scope.orgs && scope.org === null)
    return <EmptyState title="Org not found">Pick an org from the switcher.</EmptyState>;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">Org settings</h1>
      <p className="mt-0.5 text-sm text-dim">
        Each setting shows where its value comes from. A value set by the environment or{" "}
        <span className="font-mono">turntable.toml</span> is locked here.
      </p>
      <ApprovalNotifyToggle />
      <div className="mt-6">{scope.org ? <SettingsSection key={scope.org.id} /> : null}</div>
    </div>
  );
}
