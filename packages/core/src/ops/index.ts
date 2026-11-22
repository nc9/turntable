import { approveRunOp } from "./definitions/approve-run";
import { cancel } from "./definitions/cancel";
import { checksForSha } from "./definitions/checks-for-sha";
import { acceptActionMoveOp, listActionPinsOp } from "./definitions/action-pins";
import { createApiToken } from "./definitions/create-api-token";
import { events } from "./definitions/events";
import { failureDigest } from "./definitions/failure-digest";
import { listOrgs } from "./definitions/list-orgs";
import { listProjects } from "./definitions/list-projects";
import { rerun } from "./definitions/rerun";
import { whoami } from "./definitions/whoami";
import { deleteSecretOp, listSecretsOp, rotateSecretOp, setSecretOp } from "./definitions/vault";
import { getRun } from "./definitions/get-run";
import { ingestStatusOp } from "./definitions/ingest-status";
import { jobCuts } from "./definitions/job-cuts";
import { jobLog } from "./definitions/job-log";
import { jobSteps } from "./definitions/job-steps";
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
  jobSteps,
  jobCuts,
  failureDigest,
  events,
  checksForSha,
  cancel,
  rerun,
  approveRunOp,
  whoami,
  listOrgs,
  listProjects,
  ingestStatusOp,
  createApiToken,
  listActionPinsOp,
  acceptActionMoveOp,
  setSecretOp,
  rotateSecretOp,
  deleteSecretOp,
  listSecretsOp,
]);
