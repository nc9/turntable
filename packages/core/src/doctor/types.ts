// `turntable doctor`: a read-only readiness check an operator runs before going live. Each check
// says pass, warn or fail with a hint for fixing it. Nothing here creates, starts or changes
// anything, and nothing carries a secret value: a check says a key is present and has the right
// shape, never what it is.
import type { SQL } from "drizzle-orm";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  /** Stable id, for example `master_key`. */
  id: string;
  area: string;
  status: CheckStatus;
  /** A fixed sentence: never carries text from an exception or an upstream error. */
  summary: string;
  /** Raw error text, for the local CLI only. `forApi` removes it. */
  detail?: string;
  /** What to do about it, when it is not a pass. */
  fix?: string;
}

export interface DoctorReport {
  /** The worst status of any check. */
  status: CheckStatus;
  counts: { pass: number; warn: number; fail: number };
  checks: DoctorCheck[];
}

export function report(checks: DoctorCheck[]): DoctorReport {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] += 1;
  return {
    status: counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "pass",
    counts,
    checks,
  };
}

/** The report as the API returns it: the same checks without the raw error text. */
export function forApi(r: DoctorReport): DoctorReport {
  return {
    ...r,
    checks: r.checks.map(({ detail: _detail, ...c }) => c),
  };
}

export interface FileFacts {
  uid: number;
  gid: number;
  /** Permission bits only (0o600). */
  mode: number;
  size: number;
  isDirectory: boolean;
}

/** The filesystem as the checks see it, so a test can describe one. */
export interface DoctorFs {
  stat(path: string): FileFacts | undefined;
  /** Whether this process can write there. */
  writable(path: string): boolean;
  /** At most `maxBytes` of a file, or undefined if it cannot be read. */
  read(path: string, maxBytes: number): Buffer | undefined;
  /** File names directly in a directory; empty when it cannot be listed. */
  list?(path: string): string[];
}

/** The part of the database the checks use: read-only queries, on either dialect. */
export interface DbReader {
  all(query: SQL): Promise<Record<string, unknown>[]>;
  hasTable(name: string): Promise<boolean>;
}

export type ChannelProbe = { ok: true } | { ok: false; reason: string; detail?: string };

export interface ForwardedSnapshot {
  /** Requests seen since the server started. */
  requests: number;
  withForwardedProto: number;
  withForwardedFor: number;
}

export interface DoctorInputs {
  env: Record<string, string | undefined>;
  dataDir: string;
  hosted: boolean;
  fs: DoctorFs;
  proc: { uid: number; gid: number };
  /** Undefined when the database could not be opened: `openError` says why. */
  db: DbReader | undefined;
  openError?: string | undefined;
  /** The migration tags this binary carries. */
  expectedMigrations: readonly string[];
  /** The master key, for checking that sealed records open; never printed. */
  masterKey: () => Buffer | undefined;
  /**
   * The key came from TURNTABLE_MASTER_KEY. The server deletes that variable at boot, so it says
   * so here rather than through `env`.
   */
  masterKeyEnv?: boolean;
  /** The release lane's key file and data directory, when configured here. */
  releaseKey?: { file: string; dataDir: string | undefined } | undefined;
  /** Where the sealed audit anchor state lives; undefined without a master key (there is none). */
  auditStateDir?: string | undefined;
  /** Org ids whose sealed audit anchor does not open under the current master key. */
  unreadableAnchors?: () => string[];
  /** The providers' own read-only checks (`Provider.diagnose`). */
  providerChecks: () => Promise<DoctorCheck[]>;
  /** Whether the release channel answers, when one is configured. */
  channel: (() => Promise<ChannelProbe>) | undefined;
  /**
   * The probe of the lane's CONFIG channel, present only when this process holds the main-side
   * config channel client settings. Release approval challenges need that channel.
   */
  configChannel?: (() => Promise<ChannelProbe>) | undefined;
  /** What the running server has seen of forwarded headers; absent from the command line. */
  observed: ForwardedSnapshot | undefined;
  /**
   * How many projects resolve to `human` run approval while their org has no approver that
   * counts. Absent from the command line, which has no settings layers to resolve.
   */
  humanApprovalGaps?: (() => Promise<number>) | undefined;
  /** How many projects resolve to `human` while their org key policy is `any`. Server only. */
  humanAnyKeyPolicy?: (() => Promise<number>) | undefined;
  /** Whether this host can read a process's resident memory (`/proc`); the checkout ceiling needs it. */
  rssReadable?: () => boolean;
  now: () => number;
}
