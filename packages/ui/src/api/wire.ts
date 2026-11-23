// Response shapes of the REST API (`/api/v1`), written to match docs/openapi.json. The contract
// test in tests/openapi-contract.test.ts fails when the spec stops matching what is listed here,
// so a server change cannot silently break the adapter.
import type { JobState, TrustClass } from "./types";

export type WireRun = {
  id: string;
  project: string;
  workflow_path: string;
  event: string;
  ref: string;
  sha: string | null;
  workflow_name: string | null;
  commit_message: string | null;
  actor: string | null;
  head_branch: string | null;
  pr_number: number | null;
  state: JobState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  /** Added with trust classes (#98); absent from older servers. */
  trust_class?: TrustClass | null;
  trust?: WireTrust | null;
};

export type WireTrust = {
  class: TrustClass;
  reasons: string[];
  facts: Record<string, unknown>;
  workflow_hash: string;
  decided_at: string;
};

export type WireAttempt = {
  id: string;
  attempt: number;
  state: JobState;
  provider: string;
  exit_code: number | null;
  error_class: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
};

export type WireJob = {
  id: string;
  job_key: string;
  name: string;
  state: JobState;
  needs: string[];
  matrix: Record<string, unknown> | null;
  approval_kind: "untrusted_author" | "environment" | null;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  infra_error_reason: string | null;
  attempts: WireAttempt[];
  log_path: string | null;
};

export type WireRunDetail = WireRun & { jobs: WireJob[] };
export type WireRunList = { runs: WireRun[]; next_cursor: string | null };

export type WireLog = {
  job_id: string;
  attempt: number | null;
  mode: "head" | "tail" | "range" | "grep";
  matches: number;
  text: string;
  offset: number;
  bytes: number;
  total_bytes: number;
  next_offset: number | null;
  truncated: boolean;
};

export type WireChecks = {
  sha: string;
  state: "GREEN" | "PENDING" | "RED" | "NONE";
  counts: Record<string, unknown>;
  runs: { id: string; project: string; workflow_path: string; state: JobState }[];
};

export type WireCancel = {
  run_id: string;
  state: JobState;
  cancelled_jobs: number;
  unchanged_jobs: number;
};

export type WireError = { error: { code: string; message: string; details?: unknown } };

export type WireWhoami = {
  kind: "token" | "member";
  id: string;
  name: string | null;
  role: "reader" | "operator" | "release_operator" | "owner" | "admin" | "member" | "viewer";
  org: string;
  project: string | null;
  expires_at: string | null;
};

export type WireOrgs = {
  orgs: { id: string; slug: string; name: string }[];
  next_cursor: string | null;
};
export type WireProjects = {
  projects: {
    id: string;
    slug: string;
    name: string;
    repos: { forge: string; owner: string; repo: string }[];
  }[];
  next_cursor: string | null;
};

export type WireStep = {
  key: string;
  stage: "pre" | "main" | "post";
  index: number;
  name: string;
  result: "success" | "failure" | "skipped" | "cancelled" | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  log_offset: number;
};
export type WireSteps = { job_id: string; attempt: number | null; steps: WireStep[] };
export type WireCuts = {
  job_id: string;
  attempt: number | null;
  cuts: { at_offset: number; omitted_bytes: number; reason: string }[];
};

export type WireDigest = {
  job_id: string;
  job_key: string;
  state: JobState;
  attempt: number | null;
  step: {
    name: string;
    stage: "pre" | "main" | "post";
    index: number;
    result: "success" | "failure" | "skipped" | "cancelled" | null;
  } | null;
  basis: "failure_marker" | "annotation" | "error_pattern" | "tail" | null;
  excerpt: string;
  truncated: boolean;
  infra_error_reason: string | null;
};
export type WireFailureDigest = { failing_jobs: number; digests: WireDigest[] };

export type WireRerun = {
  run_id: string;
  state: JobState;
  reruns: {
    job_id: string;
    job_key: string;
    attempt: number;
    previous_state: JobState;
    state: JobState;
    reruns_used: number;
  }[];
};

export type WireApprove = {
  run_id: string;
  state: JobState;
  released_jobs: number;
  approved_by: string;
  head_sha: string;
  workflow_hash: string;
};

export type WireIngestStatus = {
  running: boolean;
  rate_limit: {
    limit: number | null;
    remaining: number | null;
    reset_at: string | null;
    resource: string | null;
    observed_at: string;
  } | null;
  repos: {
    repo: string;
    project: string;
    last_poll_at: string | null;
    last_outcome: "ok" | "rate_limited" | "error" | null;
    last_error: string | null;
    next_poll_at: string | null;
    consecutive_failures: number;
    runs_created: number;
  }[];
};

export type WireApprovalStatus = {
  run_id: string;
  head_sha: string | null;
  workflow_hash: string | null;
  author: string | null;
  environments: {
    environment: string;
    required: number;
    allow_author_approval: boolean;
    waiting: boolean;
    approvals: {
      person: string;
      method: "webauthn" | "ed25519";
      approved_at: string;
      expires_at: string;
    }[];
  }[];
};

export type WireApprovers = {
  approvers: {
    id: string;
    person: string;
    forge_login: string | null;
    kind: "webauthn" | "ed25519";
    passkey_id: string | null;
    created_at: string;
    not_counting: string | null;
    attested: boolean;
    aaguid: string | null;
  }[];
  key_policy: { mode: "any" | "hardware"; presets: string[]; aaguids: string[] };
  pending_enrolments: {
    id: string;
    person: string;
    forge_login: string | null;
    kind: "webauthn" | "ed25519";
    key_fingerprint: string;
    approvals: number;
    required: number;
    expires_at: string;
  }[];
  policies: {
    environment: string;
    required: number;
    allow_author_approval: boolean;
    source: "configured" | "default";
  }[];
  warnings: string[];
};

export type WireChallenge = {
  statement: Record<string, unknown>;
  canonical: string;
  statement_hash: string;
  challenge: string;
  rp_id: string | null;
  passkey_id: string | null;
  challenge_expires_at: string;
};

export type WireEnvironmentApproval = {
  run_id: string;
  environment: string;
  approvals: number;
  required: number;
  released_jobs: number;
  state: string;
};

export type WireRegisterChallenge = {
  challenge: string;
  rp_id: string;
  expires_at: string;
  attestation: "none" | "direct";
};
export type WireEnrolmentRequest = {
  enrolment_id: string;
  kind: "webauthn" | "ed25519";
  key_fingerprint: string;
  required: number;
  expires_at: string;
};
export type WireEnrolmentApproval = {
  enrolment_id: string;
  approvals: number;
  required: number;
  activated: boolean;
  approver_id: string | null;
};

export type WireIncident = {
  frozen: boolean;
  level: "org" | "project" | null;
  reason: string | null;
  frozen_at: number | null;
  frozen_by: string | null;
  rotation_required_count: number;
  rotation_required: { name: string; reason: string; flagged_by: string; flagged_at: number }[];
};

export type WireArtifacts = {
  artifacts: {
    name: string;
    size: number;
    sha256: string;
    digest_source: "reported" | "computed";
    trust_class: string;
    run_sha: string | null;
    attempt_id: string;
    created_at: string;
  }[];
};

export type WireConsumption = {
  results: {
    run_id: string;
    name: string;
    decision: "allow" | "quarantine" | "deny";
    reason: string | null;
    trust_class: string | null;
    sha256: string | null;
  }[];
};

export type WireQuotas = {
  limits: {
    max_concurrent: number | null;
    max_runs_per_hour: number | null;
    max_sandbox_minutes_per_day: number | null;
    max_log_bytes: number | null;
    max_stored_bytes: number | null;
  };
  usage: {
    metric: "concurrent" | "runs_per_hour" | "sandbox_minutes" | "log_bytes" | "stored_bytes";
    used: number;
    limit: number | null;
    percent: number | null;
    held: string | null;
  }[];
};
