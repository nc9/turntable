import { z } from "zod";
import { parseTrust, type Run } from "../db/repos";
import { JOB_STATES } from "../db/schema";
import { OpError } from "./errors";

export const jobStateSchema = z.enum(JOB_STATES);

export const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export const durationMs = (start: number | null, end: number | null): number | null =>
  start === null || end === null ? null : Math.max(0, end - start);

// ---- cursors: opaque to clients, an id underneath (ids sort by creation) ----

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id })).toString("base64url");
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { id?: unknown }).id === "string" &&
      /^[0-9A-HJKMNP-TV-Z]{26}$/.test((parsed as { id: string }).id)
    ) {
      return (parsed as { id: string }).id;
    }
  } catch {
    // fall through
  }
  throw new OpError("invalid_input", "invalid cursor");
}

/** Cursor over any ascending ULID: used where the id is not a run id. */
export const encodeCursorRaw = encodeCursor;
export const decodeProjectCursor = decodeCursor;

/** Cursor paging inputs shared by every list operation. */
export const pageInput = {
  limit: z.int().min(1).max(100).default(20).describe("Page size, 1 to 100."),
  cursor: z
    .string()
    .max(200)
    .optional()
    .describe("Opaque cursor from a previous response's next_cursor."),
};

export const nextCursor = z
  .string()
  .nullable()
  .describe("Pass as cursor to get the next page; null on the last page.");

export const runSummarySchema = z.object({
  id: z.string(),
  project: z.string().describe("Project slug."),
  workflow_path: z.string(),
  event: z.string(),
  ref: z.string().describe("Branch or tag ref as the forge reported it."),
  sha: z.string().nullable(),
  workflow_name: z.string().nullable().describe("Workflow display name, from the forge."),
  commit_message: z.string().nullable().describe("Head commit message (capped), from the forge."),
  actor: z.string().nullable().describe("Forge login of whoever triggered the run."),
  head_branch: z.string().nullable(),
  pr_number: z.int().nullable().describe("Pull request number, when the run is for one."),
  state: jobStateSchema,
  trust_class: z
    .enum(["protected", "release", "trusted_pr", "untrusted_pr"])
    .nullable()
    .describe(
      "How far the run is trusted (decided at ingest from re-fetched forge facts); null for runs with no decision. untrusted_pr runs wait for approval and never get secrets.",
    ),
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.int().nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export function toRunSummary(row: Run & { projectSlug: string }): RunSummary {
  return {
    id: row.id,
    project: row.projectSlug,
    workflow_path: row.workflowPath,
    event: row.event,
    ref: row.ref,
    sha: row.sha,
    workflow_name: row.workflowName,
    commit_message: row.commitMessage,
    actor: row.actor,
    head_branch: row.headBranch,
    pr_number: row.prNumber,
    state: row.status as RunSummary["state"],
    trust_class: (parseTrust(row)?.class as RunSummary["trust_class"] | undefined) ?? null,
    created_at: iso(row.createdAt)!,
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
    duration_ms: durationMs(row.startedAt, row.finishedAt),
  };
}
