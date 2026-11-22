import { Package } from "lucide-react";
import { getBackend } from "@/api";
import type { Artifact, ConsumeResult } from "@/api/types";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { formatSize, shortDigest } from "@/lib/artifact";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useAsync } from "@/lib/use-async";
import { sanitize } from "@/log/parser";
import { TrustChip } from "./trust";

type Row = { a: Artifact; asRun: ConsumeResult | undefined; asRelease: ConsumeResult | undefined };

function ArtifactRow({ a, asRun, asRelease }: Row) {
  // Both answers come from the server. Quarantined: this run may not take it as is, because the
  // attempt that wrote it was less trusted than the run.
  const quarantined = asRun !== undefined && asRun.decision !== "allow";
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Package className="size-4 shrink-0 text-dim" aria-hidden="true" />
        <span className="min-w-0 flex-1 basis-48 truncate font-mono text-[13px]">
          {sanitize(a.name)}
        </span>
        <TrustChip klass={a.trustClass} />
        {quarantined ? (
          <Tooltip label={asRun?.reason ? sanitize(asRun.reason) : "Quarantined"}>
            <span
              tabIndex={0}
              className="rounded-md border border-st-approval/40 bg-st-approval-bg px-1.5 py-0.5 text-xs text-st-approval"
            >
              Quarantined
            </span>
          </Tooltip>
        ) : null}
        <span className="tabular text-xs text-dim">{formatSize(a.size)}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs text-dim">
        <dt>sha256</dt>
        <dd className="min-w-0 truncate font-mono" title={a.sha256}>
          {shortDigest(a.sha256)}
        </dd>
        <dt>Digest</dt>
        <dd>
          {a.digestSource === "computed"
            ? "computed by the control plane from the bytes"
            : "reported by the recorder"}
        </dd>
        <dt>Commit</dt>
        <dd className="font-mono">{a.runSha ? a.runSha.slice(0, 12) : "unknown"}</dd>
        <dt>Recorded</dt>
        <dd title={formatDateTime(a.createdAt)}>{formatRelative(a.createdAt)}</dd>
        <dt>Release builds</dt>
        <dd>
          {asRelease === undefined
            ? "unknown"
            : asRelease.decision === "allow"
              ? "may consume it"
              : `cannot consume it: ${sanitize(asRelease.reason ?? asRelease.decision)}`}
        </dd>
      </dl>
    </li>
  );
}

/** What a run recorded, with where each artifact came from and what may consume it. */
export function ArtifactsPanel({ runId, project }: { runId: string; project: string }) {
  const q = useAsync(async (): Promise<Row[]> => {
    const { api } = getBackend();
    const arts = await api.getArtifacts({ runId, project });
    if (arts.length === 0) return [];
    // The server decides who may consume what: once as this run, once as a release build.
    const sources = arts.map((a) => ({ runId, name: a.name }));
    const [asRun, asRelease] = await Promise.all([
      api.checkArtifactConsumption({ project, consumer: { runId }, sources }),
      api.checkArtifactConsumption({ project, consumer: { klass: "release" }, sources }),
    ]);
    return arts.map((a) => ({
      a,
      asRun: asRun.find((r) => r.name === a.name),
      asRelease: asRelease.find((r) => r.name === a.name),
    }));
  }, [runId, project]);
  if (q.error && !q.data)
    return <ErrorState title="Could not load artifacts" message={q.error} onRetry={q.reload} />;
  if (!q.data) return <Skeleton className="mt-6 h-40 w-full" />;
  return (
    <section className="mt-6" aria-labelledby="artifacts-h">
      <h2 id="artifacts-h" className="mb-1 text-sm font-semibold">
        Artifacts
      </h2>
      <p className="mb-3 text-xs text-dim">
        The class and commit are set by the control plane when an artifact is recorded and never
        change. A lower-class artifact can reach a higher-class job only on explicit request, as
        quarantine. What may consume each one is the server's answer.
      </p>
      {q.data.length === 0 ? (
        <EmptyState title="No artifacts">This run recorded none.</EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {q.data.map((r) => (
            <ArtifactRow key={r.a.name} {...r} />
          ))}
        </ul>
      )}
    </section>
  );
}
