// A 1Password with no network: a fake client factory for OnePasswordBackend, plus config builders.
// Tokens and values are built at runtime, never written as literals.
import { randomBytes } from "node:crypto";
import {
  type OnePasswordAccountConfig,
  type OnePasswordConfig,
  type OpClientFactory,
} from "../src/secrets/backends/onepassword";
import { BackendError, type BackendErrorKind } from "../src/secrets/backends/types";
import type { TrustClass } from "../src/trust";

export const randomToken = (): string => `ops_${randomBytes(24).toString("hex")}`;

export class FakeOnePassword {
  /** References to values. A missing one resolves as not found. */
  values = new Map<string, string>();
  /** Every `resolve` call that reached the "network": [token, reference]. */
  calls: [string, string][] = [];
  /** When set, every call fails with this kind. */
  failWith: BackendErrorKind | undefined;
  /** When set, resolves wait for it (to hold concurrent callers in flight). */
  gate: Promise<void> | undefined;
  created = 0;

  readonly factory: OpClientFactory = async (token) => {
    this.created++;
    return {
      resolve: async (reference) => {
        this.calls.push([token, reference]);
        if (this.gate) await this.gate;
        if (this.failWith) throw new BackendError(this.failWith, "fake failure");
        const v = this.values.get(reference);
        if (v === undefined) throw new BackendError("not_found", "fake not found");
        return v;
      },
    };
  };
}

export function account(
  over: Partial<OnePasswordAccountConfig> & { name: string },
): OnePasswordAccountConfig {
  return {
    token: randomToken(),
    vaults: ["ci"],
    orgs: [],
    projects: [],
    trustClasses: ["protected"] as TrustClass[],
    hourlyReadLimit: undefined,
    ...over,
  };
}

export const config = (
  accounts: OnePasswordAccountConfig[],
  over: Partial<OnePasswordConfig> = {},
): OnePasswordConfig => ({ cacheTtlMs: 300_000, canary: undefined, accounts, ...over });
