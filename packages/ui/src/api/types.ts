// Domain types for the UI. They mirror packages/core/src/db/schema.ts (ids are ULID strings,
// timestamps are epoch milliseconds) and are meant to be replaced by types generated from the
// operations registry (#22) once it exists. Keep field names identical to the schema.

export const JOB_STATES = [
  "queued",
  "running",
  "success",
  "failure",
  "infra_error",
  "awaiting_approval",
  "cancelled",
  "skipped",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export type Org = { id: string; slug: string; name: string };

export type Project = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  /** "owner/repo" of the bound forge repo. */
  repo: string;
};

/** How far a run is trusted, decided by the server from re-fetched forge facts. */
export const TRUST_CLASSES = ["protected", "release", "trusted_pr", "untrusted_pr"] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];

/** The trust decision recorded on a run. `workflowHash` is what an approval is bound to. */
export type RunTrust = {
  reasons: string[];
  workflowHash: string;
  decidedAt: number | null;
};

export type Run = {
  id: string;
  orgId: string;
  projectId: string;
  workflowPath: string;
  workflowName: string;
  event: string;
  ref: string;
  sha: string | null;
  /** Title shown for the run. The REST API has no commit message yet, so the HTTP adapter derives one. */
  commitMessage: string;
  /** Empty when the API does not report who triggered the run. */
  actor: string;
  status: JobState;
  /** Pull request number, when the run is for one. */
  prNumber?: number | null;
  headBranch?: string | null;
  /** null when the server has not classified the run (older data). */
  trustClass?: TrustClass | null;
  trust?: RunTrust | null;
  /** Network policy of the run's sandboxes when the API reports it; absent means not reported. */
  egress?: "none" | "open" | "allowlist" | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type Job = {
  id: string;
  orgId: string;
  projectId: string;
  runId: string;
  jobKey: string;
  name: string;
  state: JobState;
  /** jobKeys this job depends on (the `needs:` edges of the job graph). */
  needs: string[];
  /** Matrix leg values, or null for a plain job. Legs of one matrix share `matrixGroup`. */
  matrix: Record<string, string> | null;
  matrixGroup: string | null;
  /**
   * Why the job is waiting when `state` is awaiting_approval: an untrusted-author gate
   * (an operator approves) or a release/environment gate (a human approves with a security key).
   */
  approval: "untrusted_author" | "environment" | null;
  exitCode: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type JobAttempt = {
  id: string;
  orgId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  state: JobState;
  provider: string;
  sandboxId: string | null;
  exitCode: number | null;
  /** Set for infra_error: a short machine class such as "sandbox_create_failed". */
  errorClass: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

/**
 * One step boundary from act's step events. The server stores these apart from the log text and
 * delivers them out of band; `logOffset` is the byte offset in the log where the step starts
 * (for an "end" event, where it ended). Never parsed from log text, so a log cannot forge one.
 */
export type StepEvent = {
  attemptId: string;
  index: number;
  name: string;
  phase: "start" | "end";
  result?: "success" | "failure" | "skipped" | "cancelled";
  at: number;
  logOffset: number;
};

/**
 * Where the output cap removed bytes from an attempt's log. Stored as metadata next to the log,
 * never as text inside it: `atOffset` is the byte offset in the stored log where the omission falls.
 */
export type CutRecord = {
  attemptId: string;
  kind: "cut";
  atOffset: number;
  omittedBytes: number;
  reason: string;
};

/** The caller, from `whoami`. */
export type Whoami = {
  kind: "token" | "member";
  id: string;
  name: string | null;
  role: "reader" | "operator" | "release_operator" | "owner" | "admin" | "member" | "viewer";
  org: string;
  project: string | null;
};

/** What `approve_run` reports back. */
export type ApproveResult = {
  runId: string;
  state: JobState;
  releasedJobs: number;
  approvedBy: string;
  headSha: string;
  workflowHash: string;
};

export type JobDigest = {
  jobId: string;
  jobKey: string;
  state: JobState;
  attempt: number | null;
  step: {
    name: string;
    stage: "pre" | "main" | "post";
    index: number;
    result: string | null;
  } | null;
  basis: "failure_marker" | "annotation" | "error_pattern" | "tail" | null;
  /** Plain text from the job's log. Never rendered as markup. */
  excerpt: string;
  truncated: boolean;
  infraErrorReason: string | null;
};

export type RerunResult = {
  runId: string;
  state: JobState;
  reruns: {
    jobId: string;
    jobKey: string;
    attempt: number;
    previousState: JobState;
    state: JobState;
  }[];
};

/** One hit of a server-side log search. `offset` is the byte offset of the line in the log. */
export type GrepHit = { offset: number; text: string; context: boolean };
export type GrepResult = {
  hits: GrepHit[];
  matches: number;
  /** Where the scan stopped, when the log was not fully scanned; search again from here. */
  nextOffset: number | null;
  totalBytes: number;
};

export type IngestRepoStatus = {
  repo: string;
  project: string;
  lastPollAt: number | null;
  lastOutcome: "ok" | "rate_limited" | "error" | null;
  lastError: string | null;
  nextPollAt: number | null;
  consecutiveFailures: number;
  runsCreated: number;
};

export type IngestStatus = {
  running: boolean;
  rateLimit: {
    limit: number | null;
    remaining: number | null;
    resetAt: number | null;
    resource: string | null;
    observedAt: number;
  } | null;
  repos: IngestRepoStatus[];
};

/** What a human signs to approve a run in an environment. Mirrors the server's statement. */
export type ApprovalStatement = {
  type: string;
  org: string;
  project: string;
  run_id: string;
  head_sha: string;
  workflow_hash: string;
  environment: string;
  approver: string;
  /** Epoch milliseconds. */
  expires_at: number;
  nonce: string;
};

export type EnrolStatement = {
  type: string;
  org: string;
  enrolment_id: string;
  person: string;
  /** The forge login the key is enrolled under, lower-cased. */
  forge_login: string;
  key_fingerprint: string;
  approver: string;
  expires_at: number;
  nonce: string;
};

export type ApprovalChallenge<S = ApprovalStatement> = {
  statement: S;
  canonical: string;
  statementHash: string;
  /** base64url of the statement hash: the WebAuthn challenge. */
  challenge: string;
  rpId: string | null;
  passkeyId: string | null;
  challengeExpiresAt: number;
};

export type WebAuthnSignature = {
  kind: "webauthn";
  credential_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
};

export type ApprovalStatus = {
  runId: string;
  headSha: string | null;
  workflowHash: string | null;
  /** Forge login of the run's author: untrusted text. */
  author: string | null;
  environments: {
    environment: string;
    required: number;
    allowAuthorApproval: boolean;
    waiting: boolean;
    approvals: {
      person: string;
      method: "webauthn" | "ed25519";
      approvedAt: number;
      expiresAt: number;
    }[];
  }[];
};

export type Approver = {
  id: string;
  person: string;
  forgeLogin: string | null;
  kind: "webauthn" | "ed25519";
  passkeyId: string | null;
  createdAt: number;
  /** Why the key counts toward no approval or quorum; null when it does. */
  notCounting: string | null;
  /** A pinned vendor attestation chain verified when the key was enrolled. */
  attested: boolean;
  aaguid: string | null;
};

/** A key policy change, signed by a quorum of the counted approvers. */
export type PolicyStatement = {
  type: string;
  org: string;
  old: KeyPolicy;
  new: KeyPolicy;
  allowlist_hash: string;
  approver: string;
  expires_at: number;
  nonce: string;
};

export type KeyPolicy = { mode: "any" | "hardware"; presets: string[]; aaguids: string[] };

export type ApproversOverview = {
  approvers: Approver[];
  keyPolicy: KeyPolicy;
  pendingEnrolments: {
    id: string;
    person: string;
    forgeLogin: string | null;
    kind: "webauthn" | "ed25519";
    keyFingerprint: string;
    approvals: number;
    required: number;
    expiresAt: number;
  }[];
  policies: {
    environment: string;
    required: number;
    allowAuthorApproval: boolean;
    source: "configured" | "default";
  }[];
  /** Ways the approval setup is weaker than it looks, such as too few approvers. */
  warnings: string[];
};

export type EnvironmentApprovalResult = {
  runId: string;
  environment: string;
  approvals: number;
  required: number;
  releasedJobs: number;
  state: string;
};

/** The freeze that applies to a scope, and the secrets still waiting for rotation. */
export type IncidentStatus = {
  frozen: boolean;
  level: "org" | "project" | null;
  /** Text a person typed: untrusted. Render as text. */
  reason: string | null;
  frozenAt: number | null;
  frozenBy: string | null;
  /** Secrets still waiting for rotation; the names come only to release_operator and above. */
  rotationRequiredCount: number;
  rotationRequired: { name: string; reason: string; flaggedBy: string; flaggedAt: number }[];
};

export type RunDetail = { run: Run; jobs: Job[]; attempts: JobAttempt[] };

export type CheckSummary = {
  sha: string;
  state: JobState | "none";
  runs: { runId: string; workflowName: string; status: JobState }[];
};

export type RunFilter = {
  projectId: string;
  status?: JobState;
  branch?: string;
  event?: string;
  limit?: number;
  cursor?: string;
};

/** Raw log bytes for one attempt. `offset` is a byte position; `size` is the bytes available now. */
export type LogSlice = {
  attemptId: string;
  offset: number;
  bytes: Uint8Array;
  size: number;
  /** True when the attempt is finished and `offset + bytes.length === size`. */
  done: boolean;
};
