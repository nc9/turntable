import { expect, test } from "bun:test";
import type { ApprovalStatement } from "../src/api/types";
import { statementMismatch } from "../src/lib/approval-statement";

const statement: ApprovalStatement = {
  type: "longshore.approve_environment.v1",
  org: "acme",
  project: "app",
  run_id: "run1",
  head_sha: "c".repeat(40),
  workflow_hash: "ab".repeat(32),
  environment: "production",
  approver: "ap1",
  expires_at: 1,
  nonce: "n".repeat(20),
};
const shown = {
  runId: "run1",
  headSha: "C".repeat(40),
  workflowHash: "AB".repeat(32),
  environment: "production",
  approver: "ap1",
};

test("the page signs only what it shows", () => {
  expect(statementMismatch(statement, shown)).toBeNull();
  for (const [field, value, text] of [
    ["run_id", "run2", "run"],
    ["head_sha", "d".repeat(40), "commit"],
    ["workflow_hash", "cd".repeat(32), "workflow hash"],
    ["environment", "staging", "environment"],
    ["approver", "ap2", "approver"],
  ] as const) {
    expect(statementMismatch({ ...statement, [field]: value }, shown)).toContain(text);
  }
});
