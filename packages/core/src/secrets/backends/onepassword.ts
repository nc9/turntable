// The 1Password backend: service accounts, resolved on the control plane only. A job never holds
// a service-account token or a raw reference; the proxy injects the value (secrets/vault.ts).
//
// Rules enforced here:
//  - Fail closed. An outage, a rate limit, an auth failure or a hang is a BackendError; no path
//    returns an empty value or one older than the TTL.
//  - Memory only. Values live in a TTL cache keyed by (account, reference), never on disk.
//  - One read per miss, however many callers ask at once (single-flight). After a 429 the account
//    is blocked locally for a growing backoff, so a limited account is not hammered.
//  - The SDK is imported on first use. An instance with no 1Password config loads none of it.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ALLOWED_SECRET_CLASSES } from "../vault";
import type { TrustClass } from "../../trust";
import {
  BackendError,
  type BackendAccount,
  type BackendErrorKind,
  type BackendHealth,
  type BackendRef,
  type SecretBackend,
} from "./types";

export const ONEPASSWORD_SOURCE = "onepassword";
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIRST_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
const RESOLVE_TIMEOUT_MS = 15 * 1000;
/** Bound on distinct cached references, so a bad actor cannot grow the cache without limit. */
const MAX_CACHE_ENTRIES = 2048;

/** `op://<vault>/<item>/[section/]<field>`. Names may contain spaces, never `?`, `/` or controls. */
export function parseOpRef(ref: string): BackendRef {
  if (!ref.startsWith("op://")) throw new Error("a 1Password reference starts with op://");
  if (ref.length > 512) throw new Error("reference is too long");
  const parts = ref.slice("op://".length).split("/");
  if (parts.length < 3 || parts.length > 4) {
    throw new Error("a 1Password reference is op://<vault>/<item>/[section/]<field>");
  }
  for (const p of parts) {
    // oxlint-disable-next-line no-control-regex
    if (p.trim() === "" || /[?\u0000-\u001f]/.test(p)) {
      throw new Error("a 1Password reference has empty or invalid segments");
    }
  }
  const [vault, item] = parts as [string, string];
  const field = parts[parts.length - 1]!;
  return parts.length === 4 ? { vault, item, section: parts[2]!, field } : { vault, item, field };
}

export const formatOpRef = (r: BackendRef): string =>
  `op://${[r.vault, r.item, ...(r.section ? [r.section] : []), r.field].join("/")}`;

const accountSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    tokenEnv: z.string().min(1).optional(),
    tokenFile: z.string().min(1).optional(),
    /** The 1Password vaults this account serves. One account per vault. */
    vaults: z.array(z.string().min(1)).min(1),
    orgs: z.array(z.string().min(1)).default([]),
    projects: z.array(z.string().min(1)).default([]),
    trustClasses: z.array(z.enum(ALLOWED_SECRET_CLASSES)).min(1),
    /** Optional: the plan's hourly read limit per token, to report the remaining quota. */
    hourlyReadLimit: z.int().positive().optional(),
  })
  .strict();

const configSchema = z
  .object({
    cacheTtlSeconds: z.int().min(0).max(86400).default(300),
    /** A reference the doctor check resolves to prove reachability. */
    canary: z.string().optional(),
    accounts: z.array(accountSchema).min(1),
  })
  .strict();

export interface OnePasswordAccountConfig extends BackendAccount {
  vaults: readonly string[];
  token: string;
  hourlyReadLimit: number | undefined;
}

export interface OnePasswordConfig {
  cacheTtlMs: number;
  canary: string | undefined;
  accounts: readonly OnePasswordAccountConfig[];
}

type Env = Record<string, string | undefined>;

/** The operator config file or JSON variable. Absent: no 1Password backend, no SDK load. */
export const ONEPASSWORD_CONFIG_FILE_ENV = "TURNTABLE_OP_CONFIG";
export const ONEPASSWORD_CONFIG_JSON_ENV = "TURNTABLE_OP_CONFIG_JSON";

/**
 * Reads and validates the operator's 1Password config. Tokens come from an env var or a file the
 * config names (never from the config itself); a missing or empty one is an error. Every error
 * message names the account, never a token.
 */
export function loadOnePasswordConfig(
  env: Env = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): OnePasswordConfig | undefined {
  const file = env[ONEPASSWORD_CONFIG_FILE_ENV]?.trim();
  const json = env[ONEPASSWORD_CONFIG_JSON_ENV]?.trim();
  if (!file && !json) return undefined;
  const parsed = configSchema.safeParse(JSON.parse(file ? readFile(file) : json!));
  if (!parsed.success) {
    throw new Error(`1Password config is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  const cfg = parsed.data;
  const names = new Set<string>();
  const vaultOwner = new Map<string, string>();
  const accounts: OnePasswordAccountConfig[] = cfg.accounts.map((a) => {
    if (names.has(a.name)) throw new Error(`1Password account ${a.name} is listed twice`);
    names.add(a.name);
    if ((a.tokenEnv === undefined) === (a.tokenFile === undefined)) {
      throw new Error(`1Password account ${a.name} needs exactly one of tokenEnv or tokenFile`);
    }
    if (a.orgs.length === 0 && a.projects.length === 0) {
      throw new Error(`1Password account ${a.name} must be bound to orgs or projects`);
    }
    for (const v of a.vaults) {
      const owner = vaultOwner.get(v);
      if (owner) throw new Error(`1Password vault ${v} is served by both ${owner} and ${a.name}`);
      vaultOwner.set(v, a.name);
    }
    const raw = a.tokenEnv !== undefined ? env[a.tokenEnv] : readFile(a.tokenFile!);
    const token = raw?.trim();
    if (!token) throw new Error(`1Password account ${a.name} has no token`);
    return {
      name: a.name,
      token,
      vaults: a.vaults,
      orgs: a.orgs,
      projects: a.projects,
      trustClasses: a.trustClasses as TrustClass[],
      hourlyReadLimit: a.hourlyReadLimit,
    };
  });
  if (cfg.canary !== undefined) parseOpRef(cfg.canary);
  return { cacheTtlMs: cfg.cacheTtlSeconds * 1000, canary: cfg.canary, accounts };
}

/** The slice of the SDK client this backend uses. */
export interface OpClient {
  resolve(reference: string): Promise<string>;
}
export type OpClientFactory = (token: string) => Promise<OpClient>;

/**
 * The real client factory: imports the SDK on first call (never at startup). The SDK's typed
 * errors map to BackendError kinds; anything else is an outage.
 */
export const sdkClientFactory: OpClientFactory = async (token) => {
  const sdk = await import("@1password/sdk");
  const client = await sdk.createClient({
    auth: token,
    integrationName: "Turntable",
    integrationVersion: "1",
  });
  return {
    async resolve(reference) {
      try {
        return await client.secrets.resolve(reference);
      } catch (err) {
        throw classifySdkError(err, sdk);
      }
    },
  };
};

/** Never copies the SDK message through: it can name an item. Only a fixed phrase per kind. */
function classifySdkError(
  err: unknown,
  sdk: {
    RateLimitExceededError: new (m: string) => Error;
    AuthExpiredError: new (m: string) => Error;
  },
): BackendError {
  if (err instanceof sdk.RateLimitExceededError) {
    return new BackendError("rate_limited", "1Password rate limit reached");
  }
  if (err instanceof sdk.AuthExpiredError) {
    return new BackendError("auth", "1Password service account token rejected");
  }
  const m = err instanceof Error ? err.message : "";
  if (/rate limit|too many requests/i.test(m)) {
    return new BackendError("rate_limited", "1Password rate limit reached");
  }
  if (/invalid service account token|unauthori[sz]ed|forbidden|token.*(expired|revoked)/i.test(m)) {
    return new BackendError("auth", "1Password service account token rejected");
  }
  if (/isn't an item|isn't a vault|no item|could not find|not found|no such/i.test(m)) {
    return new BackendError("not_found", "1Password reference not found");
  }
  return new BackendError("outage", "1Password request failed");
}

interface AccountState {
  cfg: OnePasswordAccountConfig;
  client: Promise<OpClient> | undefined;
  /** Timestamps of reads in the last hour. */
  reads: number[];
  blockedUntil: number;
  backoffMs: number;
}

export interface OnePasswordOptions {
  config: OnePasswordConfig;
  /** Defaults to the real SDK, imported on first use. */
  factory?: OpClientFactory;
  now?: () => number;
  log?: (message: string) => void;
}

export class OnePasswordBackend implements SecretBackend {
  readonly source = ONEPASSWORD_SOURCE;
  readonly #cfg: OnePasswordConfig;
  readonly #factory: OpClientFactory;
  readonly #now: () => number;
  readonly #log: (m: string) => void;
  readonly #accounts = new Map<string, AccountState>();
  readonly #byVault = new Map<string, OnePasswordAccountConfig>();
  readonly #cache = new Map<string, { value: string; expiresAt: number }>();
  readonly #flights = new Map<string, Promise<string>>();
  /** Bumped by refresh(): a read that started before it must not repopulate the cache. */
  #generation = 0;

  constructor(o: OnePasswordOptions) {
    this.#cfg = o.config;
    this.#factory = o.factory ?? sdkClientFactory;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? ((m) => console.warn(`[turntable] ${m}`));
    for (const a of o.config.accounts) {
      this.#accounts.set(a.name, {
        cfg: a,
        client: undefined,
        reads: [],
        blockedUntil: 0,
        backoffMs: 0,
      });
      for (const v of a.vaults) this.#byVault.set(v, a);
    }
  }

  parseRef(ref: string): BackendRef {
    return parseOpRef(ref);
  }

  accountFor(ref: BackendRef): BackendAccount | undefined {
    return this.#byVault.get(ref.vault);
  }

  tokens(): readonly string[] {
    return this.#cfg.accounts.map((a) => a.token);
  }

  refresh(): number {
    const n = this.#cache.size;
    this.#cache.clear();
    this.#flights.clear();
    this.#generation++;
    return n;
  }

  async resolve(account: string, ref: BackendRef): Promise<string> {
    const st = this.#accounts.get(account);
    if (!st) throw new BackendError("auth", "unknown 1Password account");
    const key = `${account}\u0000${formatOpRef(ref)}`;
    const hit = this.#cache.get(key);
    if (hit && hit.expiresAt > this.#now()) return hit.value;
    if (hit) this.#cache.delete(key);
    const pending = this.#flights.get(key);
    if (pending) return pending;
    const flight = this.#read(st, key, ref).finally(() => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    this.#flights.set(key, flight);
    return flight;
  }

  /** One uncached read, with the limiter and the failure bookkeeping. */
  async #read(st: AccountState, key: string, ref: BackendRef, fresh = false): Promise<string> {
    const generation = this.#generation;
    const now = this.#now();
    if (st.blockedUntil > now) {
      throw new BackendError("rate_limited", "1Password account is backing off after a rate limit");
    }
    st.reads = st.reads.filter((t) => t > now - HOUR_MS);
    const limit = st.cfg.hourlyReadLimit;
    if (limit !== undefined && st.reads.length >= limit) {
      this.#log(`1Password account ${st.cfg.name}: hourly read limit reached, refusing reads`);
      throw new BackendError("rate_limited", "1Password hourly read limit reached");
    }
    st.reads.push(now);
    try {
      st.client ??= this.#factory(st.cfg.token);
      let client: OpClient;
      try {
        client = await st.client;
      } catch (err) {
        st.client = undefined;
        throw err;
      }
      const value = await withTimeout(client.resolve(formatOpRef(ref)), RESOLVE_TIMEOUT_MS);
      if (typeof value !== "string" || value === "") {
        throw new BackendError("not_found", "1Password reference resolved to an empty value");
      }
      st.backoffMs = 0;
      if (!fresh && generation === this.#generation && this.#cfg.cacheTtlMs > 0) {
        if (this.#cache.size >= MAX_CACHE_ENTRIES) this.#cache.clear();
        this.#cache.set(key, { value, expiresAt: this.#now() + this.#cfg.cacheTtlMs });
      }
      return value;
    } catch (err) {
      const e =
        err instanceof BackendError ? err : new BackendError("outage", "1Password request failed");
      if (e.kind === "rate_limited") {
        st.backoffMs = Math.min(
          st.backoffMs === 0 ? FIRST_BACKOFF_MS : st.backoffMs * 2,
          MAX_BACKOFF_MS,
        );
        st.blockedUntil = this.#now() + st.backoffMs;
        this.#log(
          `1Password account ${st.cfg.name}: rate limited, backing off ${st.backoffMs / 1000}s${remaining(st, this.#now())}`,
        );
      } else if (e.kind === "auth") {
        this.#log(`1Password account ${st.cfg.name}: token rejected${remaining(st, this.#now())}`);
      }
      throw e;
    }
  }

  async health(): Promise<BackendHealth> {
    const canary = await this.#probeCanary();
    // Counted after the probe, so the canary's own read is in the quota it reports.
    const now = this.#now();
    const accounts = [...this.#accounts.values()].map((st) => {
      st.reads = st.reads.filter((t) => t > now - HOUR_MS);
      const limit = st.cfg.hourlyReadLimit;
      return {
        name: st.cfg.name,
        vaults: st.cfg.vaults,
        reads_last_hour: st.reads.length,
        remaining_hourly: limit === undefined ? null : Math.max(0, limit - st.reads.length),
        blocked_until: st.blockedUntil > now ? st.blockedUntil : null,
      };
    });
    return { accounts, canary };
  }

  async #probeCanary(): Promise<BackendHealth["canary"]> {
    if (this.#cfg.canary === undefined) return { configured: false };
    const ref = parseOpRef(this.#cfg.canary);
    const names = { vault: ref.vault, item: ref.item, field: ref.field };
    const acct = this.#byVault.get(ref.vault);
    if (!acct) {
      return { configured: true, account: null, ...names, reachable: false, error_kind: "unbound" };
    }
    try {
      // A live read, not the cache: the check is whether 1Password answers now. The value is
      // dropped here and never leaves this function.
      await this.#read(this.#accounts.get(acct.name)!, "", ref, true);
      return { configured: true, account: acct.name, ...names, reachable: true, error_kind: null };
    } catch (err) {
      const kind = err instanceof BackendError ? err.kind : "outage";
      return { configured: true, account: acct.name, ...names, reachable: false, error_kind: kind };
    }
  }
}

const remaining = (st: AccountState, now: number): string => {
  const limit = st.cfg.hourlyReadLimit;
  if (limit === undefined) return "";
  const used = st.reads.filter((t) => t > now - HOUR_MS).length;
  return `, ${Math.max(0, limit - used)} of ${limit} hourly reads left`;
};

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BackendError("outage", "1Password request timed out")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { BackendErrorKind };
