import {
  approvalChallenge,
  approvalStatus,
  approveEnrolment,
  approveEnvironment,
  enrolmentChallenge,
  approversOverview,
  registerChallenge,
  keyPolicyChallenge,
  approveKeyPolicy,
  requestEnrolment,
  submitApproval,
} from "./definitions/approvals";
import { dbBackupOp } from "./definitions/db-backup";
import { approveRunOp } from "./definitions/approve-run";
import { cancel } from "./definitions/cancel";
import { doctor } from "./definitions/doctor";
import { checksForSha } from "./definitions/checks-for-sha";
import { acceptActionMoveOp, listActionPinsOp } from "./definitions/action-pins";
import { checkArtifactConsumption, listArtifacts } from "./definitions/artifacts";
import { instanceListOrgs, instanceWhoami, setQuotas } from "./definitions/instance";
import { getQuotas } from "./definitions/quotas";
import {
  createProjectOp,
  getProjectSettings,
  setProjectSettings,
} from "./definitions/project-settings";
import { createApiToken } from "./definitions/create-api-token";
import { events } from "./definitions/events";
import { failureDigest } from "./definitions/failure-digest";
import { listOrgs } from "./definitions/list-orgs";
import { listProjects } from "./definitions/list-projects";
import { rerun } from "./definitions/rerun";
import { signRelease } from "./definitions/sign-release";
import { getReleaseRequestOp, requestReleaseOp } from "./definitions/release-requests";
import { startInstallationClaim } from "./definitions/installation-claim";
import { whoami } from "./definitions/whoami";
import {
  addPassthroughHostOp,
  deletePassthroughHostOp,
  deleteProxyRuleOp,
  listPassthroughHostsOp,
  listProxyRulesOp,
  setProxyRuleOp,
} from "./definitions/proxy-rules";
import { deleteSecretOp, listSecretsOp, rotateSecretOp, setSecretOp } from "./definitions/vault";
import { getRun } from "./definitions/get-run";
import { incidentFreeze, incidentStatus, incidentUnfreeze } from "./definitions/incident";
import { sandboxUsageOp } from "./definitions/sandbox-usage";
import { secretUsage } from "./definitions/secret-usage";
import { ingestStatusOp } from "./definitions/ingest-status";
import { jobCuts } from "./definitions/job-cuts";
import { jobLog } from "./definitions/job-log";
import { jobSteps } from "./definitions/job-steps";
import { listRuns } from "./definitions/list-runs";
import {
  createWebhookOp,
  disableWebhookOp,
  enableWebhookOp,
  webhookEndpointsOp,
  rotateWebhookSecretOp,
  webhookDeliveriesOp,
} from "./definitions/webhooks";
import { setOidcAudiencesOp } from "./definitions/oidc-audiences";
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
  signRelease,
  whoami,
  doctor,
  listOrgs,
  listProjects,
  ingestStatusOp,
  createApiToken,
  listActionPinsOp,
  listArtifacts,
  checkArtifactConsumption,
  getQuotas,
  instanceWhoami,
  instanceListOrgs,
  setQuotas,
  dbBackupOp,
  acceptActionMoveOp,
  setSecretOp,
  rotateSecretOp,
  deleteSecretOp,
  setProxyRuleOp,
  listProxyRulesOp,
  deleteProxyRuleOp,
  addPassthroughHostOp,
  listPassthroughHostsOp,
  deletePassthroughHostOp,
  listSecretsOp,
  approvalStatus,
  approversOverview,
  approvalChallenge,
  enrolmentChallenge,
  registerChallenge,
  keyPolicyChallenge,
  approveKeyPolicy,
  requestEnrolment,
  submitApproval,
  approveEnvironment,
  approveEnrolment,
  incidentFreeze,
  incidentUnfreeze,
  incidentStatus,
  secretUsage,
  sandboxUsageOp,
  requestReleaseOp,
  getReleaseRequestOp,
  startInstallationClaim,
  setOidcAudiencesOp,
  getProjectSettings,
  setProjectSettings,
  createProjectOp,
  createWebhookOp,
  webhookEndpointsOp,
  rotateWebhookSecretOp,
  disableWebhookOp,
  enableWebhookOp,
  webhookDeliveriesOp,
]);
