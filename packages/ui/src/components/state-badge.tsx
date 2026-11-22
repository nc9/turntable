import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  Hand,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { JobState } from "@/api/types";
import { STATE_META } from "@/lib/states";
import { cn } from "@/lib/utils";

// Each state has a distinct glyph shape as well as a colour, so state never relies on colour alone:
// dashed ring, spinning arc, check, cross, warning triangle, raised hand, slashed circle.
const ICONS: Record<JobState, LucideIcon> = {
  queued: CircleDashed,
  running: LoaderCircle,
  success: CircleCheck,
  failure: CircleX,
  infra_error: TriangleAlert,
  awaiting_approval: Hand,
  cancelled: Ban,
};

export function StateIcon({
  state,
  className,
  title = true,
}: {
  state: JobState;
  className?: string;
  title?: boolean;
}) {
  const Icon = ICONS[state];
  const meta = STATE_META[state];
  return (
    <Icon
      role="img"
      aria-label={meta.label}
      className={cn("size-4 shrink-0", meta.text, state === "running" && "spin", className)}
      {...(title ? { "data-state": state } : {})}
    />
  );
}

export function StateBadge({
  state,
  className,
  label,
}: {
  state: JobState;
  className?: string;
  label?: string;
}) {
  const meta = STATE_META[state];
  const Icon = ICONS[state];
  return (
    <span
      title={meta.description}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium",
        meta.bg,
        meta.text,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("size-3.5", state === "running" && "spin")} />
      {label ?? meta.label}
    </span>
  );
}
