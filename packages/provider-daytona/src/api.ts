import { SsrfError, type SafeFetch, safeFetch } from "@turntable/net";
import {
  FileTooLargeError,
  InfraError,
  SandboxNotFoundError,
  SpecError,
  TransientInfraError,
  readCappedJson,
  readCappedText,
} from "@turntable/provider-sdk";
import { type ApiKeySource, readApiKey } from "./key";

/** The key was refused (401 or 403). The status is kept so a caller can tell a missing permission from a bad key. */
export class DaytonaKeyRejectedError extends InfraError {
  readonly status: number;
  constructor(status: number) {
    super(`Daytona rejected the API key (${status}); check the configured key`);
    this.name = "DaytonaKeyRejectedError";
    this.status = status;
  }
}

/**
 * Daytona answered 400 because the account is at a quota ("Total disk limit exceeded. Maximum
 * allowed: 2000GiB"). That is capacity, not a bad request: the caller waits and tries again.
 */
export class DaytonaQuotaExceededError extends InfraError {
  constructor(detail: string) {
    super(`Daytona quota exceeded: ${detail}`);
    this.name = "DaytonaQuotaExceededError";
  }
}

/** The 400 messages that mean "full", not "wrong": only these are retried. */
const QUOTA_400 =
  /(total )?(cpu|disk|memory|ram|sandbox(es)?)[^.]*limit exceeded|quota (exceeded|reached)/i;

export const DEFAULT_BASE_URL = "https://app.daytona.io/api";

/** Most we will buffer from any one response: API JSON (a page of 200 sandboxes is far smaller). */
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
/** Most of an error body we read, to build a message. */
const MAX_ERROR_BYTES = 8 * 1024;

/** The fields of a Daytona sandbox that we read. */
export type DaytonaSandbox = {
  id: string;
  name: string;
  state?: string;
  desiredState?: string;
  snapshot?: string;
  labels?: Record<string, string>;
  createdAt?: string;
  toolboxProxyUrl?: string;
  organizationId?: string;
  networkAllowList?: string | null;
  domainAllowList?: string | null;
  errorReason?: string;
  sandboxClass?: string;
  networkBlockAll?: boolean;
  cpu?: number;
  memory?: number;
  disk?: number;
};

export type ApiOptions = {
  baseUrl?: string;
  apiKey: ApiKeySource;
  fetch?: SafeFetch;
};

type ReqInit = {
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
  /** Returns the raw Response instead of parsing JSON (downloads). */
  raw?: boolean;
};

/**
 * Thin fetch wrapper. Failures become typed provider errors. Error text is built from the status
 * and the server's message only: request headers (the key) never reach an error or a log.
 */
export class DaytonaApi {
  readonly baseUrl: string;
  private readonly doFetch: SafeFetch;
  private readonly keySource: ApiKeySource;
  private key: Promise<string> | null = null;

  constructor(o: ApiOptions) {
    this.baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.doFetch = o.fetch ?? safeFetch;
    this.keySource = o.apiKey;
  }

  private apiKey(): Promise<string> {
    // Read once per instance on first use, so the key is not held longer than the provider is.
    this.key ??= readApiKey(this.keySource);
    return this.key;
  }

  async request(method: string, url: string, init: ReqInit = {}): Promise<Response> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) qs.append(k, String(item));
      else qs.set(k, String(v));
    }
    const full = `${url}${qs.size > 0 ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.apiKey()}`,
      accept: "application/json",
    };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.doFetch(full, {
        method,
        headers,
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        ...(init.form ? { body: init.form } : {}),
        // The client enforces the deadline (DNS and body included); the signal is a second guard.
        timeoutMs: init.timeoutMs ?? 60_000,
        signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
        redirect: "error",
      });
    } catch (e) {
      const message = `Daytona request failed: ${method} ${new URL(full).pathname} (${(e as Error).name})`;
      // A refused address is a policy answer, not weather; a timeout or a reset is weather.
      if (e instanceof SsrfError) throw new InfraError(message);
      throw new TransientInfraError(message);
    }
    if (res.ok) return res;
    const detail = await errorDetail(res);
    const where = `${method} ${new URL(full).pathname}`;
    if (res.status === 400 && QUOTA_400.test(detail)) throw new DaytonaQuotaExceededError(detail);
    if (res.status === 404) throw new SandboxNotFoundError(`Daytona: not found (${where})`);
    if (res.status === 401 || res.status === 403) {
      throw new DaytonaKeyRejectedError(res.status);
    }
    if (res.status === 429) {
      throw new TransientInfraError(`Daytona rate limit (${where}); retry later`);
    }
    if (res.status === 408 || res.status === 502 || res.status === 503 || res.status === 504) {
      throw new TransientInfraError(`Daytona ${res.status} (${where}): ${detail}`);
    }
    if (res.status >= 500) throw new InfraError(`Daytona ${res.status} (${where}): ${detail}`);
    throw new SpecError(`Daytona ${res.status} (${where}): ${detail}`);
  }

  async json<T>(method: string, path: string, init: ReqInit = {}): Promise<T> {
    const res = await this.request(method, `${this.baseUrl}${path}`, init);
    return readJson<T>(res, MAX_JSON_BYTES);
  }
}

/** Reads a capped JSON body; an empty body is `{}`. An oversized one is an infrastructure fault. */
export async function readJson<T>(res: Response, maxBytes: number): Promise<T> {
  try {
    const text = await readCappedText(res, maxBytes);
    return (text === "" ? {} : JSON.parse(text)) as T;
  } catch (e) {
    if (e instanceof FileTooLargeError)
      throw new InfraError(`Daytona reply is larger than ${maxBytes} bytes; refusing to buffer it`);
    throw e;
  }
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const j = await readCappedJson<{ message?: unknown }>(res, MAX_ERROR_BYTES);
    return typeof j.message === "string" ? j.message.slice(0, 300) : res.statusText;
  } catch {
    return res.statusText;
  }
}
