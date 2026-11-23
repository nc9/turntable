import { useCallback, useState } from "react";
import { getBackend } from "@/api";
import type { Setting } from "@/api/types";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useWhoami } from "@/lib/directory";
import { saveSetting } from "@/lib/settings";
import { useAsync } from "@/lib/use-async";
import { SettingsPanel } from "./settings-panel";

/**
 * The settings of an org, or with `project` of that project, generated from `list_settings`.
 * A save goes to `set_setting` and the list is read again, so the page shows what the server
 * now resolves, whichever layer it came from.
 */
export function SettingsSection({ project }: { project?: string }) {
  const { api } = getBackend();
  const list = useAsync(
    () => api.listSettings(project === undefined ? undefined : { project }),
    [project],
  );
  const who = useWhoami();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const reload = list.reload;

  const run = useCallback(
    async (s: Setting, change: { draft: string } | { unset: true }) => {
      setBusy(s.key);
      setErrors(({ [s.key]: _gone, ...rest }) => rest);
      const r = await saveSetting((a) => api.setSetting(a), s, change, project);
      setBusy(null);
      if (!r.ok) {
        setErrors((e) => ({ ...e, [s.key]: r.message }));
        return;
      }
      setDrafts(({ [s.key]: _gone, ...rest }) => rest);
      reload();
    },
    [api, project, reload],
  );

  if (list.error) return <ErrorState message={list.error} onRetry={reload} />;
  if (!list.data) return <Skeleton className="mt-6 h-40 w-full" />;
  if (list.data.length === 0)
    return (
      <EmptyState title="No settings here yet">
        This server has no {project === undefined ? "org" : "project"} settings to change.
      </EmptyState>
    );
  return (
    <SettingsPanel
      settings={list.data}
      role={who.data?.role ?? null}
      drafts={drafts}
      errors={errors}
      busy={busy}
      onDraft={(key, text) => setDrafts((d) => ({ ...d, [key]: text }))}
      onSave={(s) => void run(s, { draft: drafts[s.key] ?? "" })}
      onReset={(s) => void run(s, { unset: true })}
    />
  );
}
