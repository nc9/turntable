import { useEffect, useState, useSyncExternalStore } from "react";
import { getBackend } from "@/api";
import type { ConnectionStatus, Topic } from "@/api/realtime";
import { applyChange, attempts, jobs, runs } from "./collections";

export type Loadable = { loading: boolean; error: string | null; reload: () => void };

/** Connection status of the realtime transport, for the live indicator. */
export function useConnectionStatus(): ConnectionStatus {
  const { realtime } = getBackend();
  return useSyncExternalStore(
    (cb) => realtime.onStatus(cb),
    () => realtime.status(),
  );
}

function useScopedSync(
  key: string | null,
  load: () => Promise<void>,
  topic: Topic | null,
): Loadable {
  const [state, setState] = useState<{
    key: string | null;
    loading: boolean;
    error: string | null;
  }>({
    key,
    loading: key !== null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (key === null || topic === null) return;
    let cancelled = false;
    setState({ key, loading: true, error: null });
    const { realtime } = getBackend();
    // Subscribe first (live-only) so nothing between the fetch and the subscription is lost;
    // the collections upsert by id, so an event that overlaps the snapshot is harmless.
    const off = realtime.subscribe(topic, {}, (msg) => {
      if (msg.type === "change") applyChange(msg);
      else if (msg.type === "reset") setNonce((n) => n + 1);
    });
    load().then(
      () => !cancelled && setState({ key, loading: false, error: null }),
      (e: unknown) =>
        !cancelled &&
        setState({ key, loading: false, error: e instanceof Error ? e.message : "Request failed" }),
    );
    return () => {
      cancelled = true;
      off();
    };
    // `load` and `topic` are derived from `key`
  }, [key, nonce]);

  return {
    loading: key !== null && (state.key !== key || state.loading),
    error: state.key === key ? state.error : null,
    reload: () => setNonce((n) => n + 1),
  };
}

/** Load a project's recent runs into the collections and keep them live. */
export function useProjectSync(projectId: string | null): Loadable {
  return useScopedSync(
    projectId,
    async () => {
      if (!projectId) return;
      const { runs: rows } = await getBackend().api.listRuns({ projectId, limit: 100 });
      runs.upsert(rows);
    },
    projectId ? { kind: "project", projectId } : null,
  );
}

/** Load one run with its jobs and attempts and keep them live. */
export function useRunSync(runId: string | null): Loadable {
  return useScopedSync(
    runId,
    async () => {
      if (!runId) return;
      const detail = await getBackend().api.getRun(runId);
      runs.upsert([detail.run]);
      jobs.upsert(detail.jobs);
      attempts.upsert(detail.attempts);
    },
    runId ? { kind: "run", runId } : null,
  );
}

/** Load recent runs for every project of an org and keep the org topic live. */
export function useOrgSync(orgId: string | null, projectIds: string[]): Loadable {
  const key = orgId && projectIds.length > 0 ? `${orgId}:${projectIds.join(",")}` : null;
  return useScopedSync(
    key,
    async () => {
      const { api } = getBackend();
      const pages = await Promise.all(
        projectIds.map((projectId) => api.listRuns({ projectId, limit: 30 })),
      );
      for (const page of pages) runs.upsert(page.runs);
    },
    key && orgId ? { kind: "org", orgId } : null,
  );
}
