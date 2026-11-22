import type { ApprovalStatement } from "@/api/types";

/** The values on screen must be the values in the statement the server issued. */
export function statementMismatch(
  s: ApprovalStatement,
  shown: {
    runId: string;
    headSha: string;
    workflowHash: string;
    environment: string;
    approver: string;
  },
): string | null {
  const checks: [string, string, string][] = [
    ["run", s.run_id, shown.runId],
    ["commit", s.head_sha, shown.headSha.toLowerCase()],
    ["workflow hash", s.workflow_hash, shown.workflowHash.toLowerCase()],
    ["environment", s.environment, shown.environment],
    ["approver", s.approver, shown.approver],
  ];
  const bad = checks.find(([, got, want]) => got !== want);
  return bad ? `the ${bad[0]} in the statement is not the one shown` : null;
}
