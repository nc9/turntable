import type { JobState } from "@/api/types";

export type StateMeta = {
  label: string;
  /** Tailwind classes for text colour and tinted background. Always paired with an icon and label. */
  text: string;
  bg: string;
  description: string;
};

export const STATE_META: Record<JobState, StateMeta> = {
  queued: {
    label: "Queued",
    text: "text-st-queued",
    bg: "bg-st-queued-bg",
    description: "Waiting for a sandbox or for jobs it needs.",
  },
  running: {
    label: "Running",
    text: "text-st-running",
    bg: "bg-st-running-bg",
    description: "Executing in a sandbox.",
  },
  success: {
    label: "Success",
    text: "text-st-success",
    bg: "bg-st-success-bg",
    description: "Finished with exit code 0.",
  },
  failure: {
    label: "Failed",
    text: "text-st-failure",
    bg: "bg-st-failure-bg",
    description: "The job itself exited non-zero.",
  },
  infra_error: {
    label: "Infra error",
    text: "text-st-infra",
    bg: "bg-st-infra-bg",
    description: "The sandbox or provider failed. No trustworthy result, not a code failure.",
  },
  awaiting_approval: {
    label: "Needs approval",
    text: "text-st-approval",
    bg: "bg-st-approval-bg",
    description: "Paused until a human approves it.",
  },
  cancelled: {
    label: "Cancelled",
    text: "text-st-cancelled",
    bg: "bg-st-cancelled-bg",
    description: "Stopped before it finished.",
  },
};

export const isActive = (s: JobState): boolean =>
  s === "queued" || s === "running" || s === "awaiting_approval";
