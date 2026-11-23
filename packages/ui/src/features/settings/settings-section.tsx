import { useCallback, useState } from "react";
import { getBackend } from "@/api";
import type { Setting } from "@/api/types";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useWhoami } from "@/lib/directory";
import type { Role } from "@/lib/roles";
import { saveSetting } from "@/lib/settings";
import { useAsync } from "@/lib/use-async";
import { SettingsPanel } from "./settings-panel";

type SettingsSource = {
  list: () => Promise<Setting[]>;
  set: (a: { key: string; value?: unknown; unset?: boolean }) => Promise<Setting>;
  /** The caller's role; null until it is known. The server enforces it either way. */
  role: Role | null;
  /** What the empty state calls these settings. */
  noun: string;
};

/**
 * The settings of an org, or with `project` of that project, generated from `list_settings`.
 * A save goes to `set_setting` and the list is read again, so the page shows what the server
 * now resolves, whichever layer it came from.
 */
export function SettingsSection({ project }: { project?: string }) {
  const { api } = getBackend();
  const who = useWhoami();
  return (
    <SettingsList
      deps={[project]}
      source={{
        list: () => api.listSettings(project === undefined ? undefined : { project }),
        set: (a) => api.setSetting({ ...a, ...(project !== undefined ? { project } : {}) }),
        role: who.data?.role ?? null,
        noun: project === undefined ? "org" : "project",
      }}
    />
  );
}

/** The registry-generated list and its save flow, for any scope: the source says where to go. */
export function SettingsList({
  source,
  deps,
}: {
  source: SettingsSource;
  deps: readonly unknown[];
}) {
  const list = useAsync(source.list, deps);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const reload = list.reload;

  const run = useCallback(
    async (s: Setting, change: { draft: string } | { unset: true }) => {
      setBusy(s.key);
      setErrors(({ [s.key]: _gone, ...rest }) => rest);
      const r = await saveSetting(source.set, s, change);
      setBusy(null);
      if (!r.ok) {
        setErrors((e) => ({ ...e, [s.key]: r.message }));
        return;
      }
      setDrafts(({ [s.key]: _gone, ...rest }) => rest);
      reload();
    },
    [source, reload],
  );

  if (list.error) return <ErrorState message={list.error} onRetry={reload} />;
  if (!list.data) return <Skeleton className="mt-6 h-40 w-full" />;
  if (list.data.length === 0)
    return (
      <EmptyState title="No settings here yet">
        This server has no {source.noun} settings to change.
      </EmptyState>
    );
  return (
    <SettingsPanel
      settings={list.data}
      role={source.role}
      drafts={drafts}
      errors={errors}
      busy={busy}
      onDraft={(key, text) => setDrafts((d) => ({ ...d, [key]: text }))}
      onSave={(s) => void run(s, { draft: drafts[s.key] ?? "" })}
      onReset={(s) => void run(s, { unset: true })}
    />
  );
}
