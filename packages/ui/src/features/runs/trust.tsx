import {
  GitPullRequest,
  Globe,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { getBackend } from "@/api";
import type { Run, TrustClass } from "@/api/types";
import { Tooltip } from "@/components/ui/tooltip";
import { parseLogNotices, type LogNotice } from "@/lib/log-notices";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";

const TRUST: Record<
  TrustClass,
  { label: string; hint: string; icon: typeof ShieldCheck; tone: "calm" | "warn" }
> = {
  protected: {
    label: "Protected",
    hint: "Runs from a protected branch. Full access to its secrets.",
    icon: ShieldCheck,
    tone: "calm",
  },
  release: {
    label: "Release",
    hint: "Runs from a release tag. Release secrets and signing are available.",
    icon: Rocket,
    tone: "calm",
  },
  trusted_pr: {
    label: "Trusted PR",
    hint: "A pull request from a trusted author. No secrets by default.",
    icon: GitPullRequest,
    tone: "calm",
  },
  untrusted_pr: {
    label: "Untrusted PR",
    hint: "A pull request from an author outside the project. No secrets, and held until approved.",
    icon: ShieldAlert,
    tone: "warn",
  },
};

/** A trust class by name (an artifact's), with its hint. An unknown name is shown as given. */
export function TrustChip({ klass }: { klass: string }) {
  const t = (TRUST as Record<string, (typeof TRUST)[TrustClass] | undefined>)[klass];
  if (!t)
    return (
      <span className="inline-flex rounded-md border border-line px-1.5 py-0.5 text-xs text-dim">
        {klass}
      </span>
    );
  const Icon = t.icon;
  return (
    <Tooltip label={t.hint}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
          t.tone === "warn"
            ? "border-st-approval/40 bg-st-approval-bg text-st-approval"
            : "border-line text-dim",
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {t.label}
      </span>
    </Tooltip>
  );
}

/** The run's trust class. Renders nothing when the API does not report one. */
export function TrustBadge({
  run,
  className,
  plain = false,
}: {
  run: Run;
  className?: string;
  /** No tooltip or focus stop, for use inside a link. The hint stays as a title. */
  plain?: boolean;
}) {
  if (!run.trustClass) return null;
  const t = TRUST[run.trustClass];
  const Icon = t.icon;
  const badge = (
    <span
      {...(plain ? { title: t.hint } : { tabIndex: 0 })}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
        t.tone === "warn"
          ? "border-st-approval/40 bg-st-approval-bg text-st-approval"
          : "border-line text-dim",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t.label}
    </span>
  );
  return plain ? badge : <Tooltip label={t.hint}>{badge}</Tooltip>;
}

/** Egress `open` is the exception worth a mark; `none` is the default and stays quiet. */
export function EgressBadge({ run, className }: { run: Pick<Run, "egress">; className?: string }) {
  if (run.egress !== "open") return null;
  return (
    <Tooltip label="This run's sandboxes can reach the whole network. The default is no network.">
      <span
        tabIndex={0}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs text-dim",
          className,
        )}
      >
        <Globe className="size-3.5" aria-hidden="true" />
        Open egress
      </span>
    </Tooltip>
  );
}

/** Fetches the first 2 KiB of an attempt's log and returns the notices found there. */
export function useLogNotices(attemptId: string | null): LogNotice[] {
  const q = useAsync(async () => {
    if (!attemptId) return [];
    const slice = await getBackend().api.jobLog({ attemptId, offset: 0, limit: 2048 });
    return parseLogNotices(new TextDecoder().decode(slice.bytes));
  }, [attemptId]);
  return q.data ?? [];
}

export function NoticeBadges({
  notices,
  children,
}: {
  notices: LogNotice[];
  children?: ReactNode;
}) {
  if (notices.length === 0 && !children) return null;
  return (
    <>
      {notices.map((n) => (
        <Tooltip key={n.kind} label={n.text}>
          <span
            tabIndex={0}
            className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs text-dim"
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            {n.kind === "isolation_override" ? "Isolation overridden" : "Egress unverified"}
          </span>
        </Tooltip>
      ))}
      {children}
    </>
  );
}
