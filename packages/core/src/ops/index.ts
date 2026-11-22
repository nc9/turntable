import { cancel } from "./definitions/cancel";
import { checksForSha } from "./definitions/checks-for-sha";
import { createApiToken } from "./definitions/create-api-token";
import { getRun } from "./definitions/get-run";
import { jobLog } from "./definitions/job-log";
import { listRuns } from "./definitions/list-runs";
import { createRegistry } from "./registry";

export { authenticate, dispatch, type DispatchEnv, type DispatchResult } from "./dispatch";
export { defineOp, type Op, type OpContext, type OpSpec } from "./define";
export { type Credential, type Principal } from "./principal";
export { createRegistry, type OpRegistry } from "./registry";
export { ROLE_RANK, roleSatisfies, type Role } from "./roles";
export { generateToken, hashToken } from "./tokens";
export { ERROR_STATUS, OpError, type ErrorCode } from "./errors";

/** The shipped operations. Signature ops are added here when the first one exists. */
export const registry = createRegistry([
  listRuns,
  getRun,
  jobLog,
  checksForSha,
  cancel,
  createApiToken,
]);
