// What the vault needs from an external secret store (1Password today). A backend resolves a
// reference to a value at use time. The vault's one policy path decides whether it may; a backend
// only answers "which account serves this reference" and "what is the value".
import type { TrustClass } from "../../trust";

/** A parsed external reference: names only, never a value. */
export interface BackendRef {
  /** The backend's own vault (or equivalent) name. Accounts are matched on it. */
  vault: string;
  item: string;
  /** Present when the reference names a section. */
  section?: string;
  field: string;
}

/** A named credential the operator configured, and what it is allowed to serve. */
export interface BackendAccount {
  name: string;
  /** Org ids the account serves. */
  orgs: readonly string[];
  /** Project ids the account serves. */
  projects: readonly string[];
  /** Trust classes the account may serve. A PR-class job never resolves through a release account. */
  trustClasses: readonly TrustClass[];
}

export type BackendErrorKind = "outage" | "rate_limited" | "auth" | "not_found";

/** Any failure to produce a value. The vault maps every one of them to a refusal. */
export class BackendError extends Error {
  readonly kind: BackendErrorKind;
  constructor(kind: BackendErrorKind, message: string) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
  }
}

export interface BackendHealth {
  accounts: {
    name: string;
    vaults: readonly string[];
    /** Reads this process made in the last hour. */
    reads_last_hour: number;
    /** The configured hourly limit minus those reads, when a limit is configured. */
    remaining_hourly: number | null;
    /** While set and in the future, reads are refused locally after a rate limit. */
    blocked_until: number | null;
  }[];
  canary:
    | { configured: false }
    | {
        configured: true;
        account: string | null;
        vault: string;
        item: string;
        field: string;
        reachable: boolean;
        error_kind: BackendErrorKind | "unbound" | null;
      };
}

export interface SecretBackend {
  /** The `vault_secrets.source` value this backend serves, e.g. `onepassword`. */
  readonly source: string;
  /** Parses a reference; throws an Error with a message that never echoes more than the input. */
  parseRef(ref: string): BackendRef;
  /** The one account that serves this reference's vault, if any is configured. */
  accountFor(ref: BackendRef): BackendAccount | undefined;
  /** Throws BackendError. Never returns an empty or an expired value. */
  resolve(account: string, ref: BackendRef): Promise<string>;
  /** Drops every cached value. Returns how many were dropped. */
  refresh(): number;
  /** Every credential this backend holds, for the redactor. */
  tokens(): readonly string[];
  health(): Promise<BackendHealth>;
}
