// The instance-administrator client: one method per instance operation, over REST only
// (`/api/v1/instance/*`). It holds the `tti_` token and nothing else; the org client never sees it
// and this one never sees an org token. Every refusal is thrown with the server's own message.
import { getInstanceToken, disconnectInstance } from "@/lib/instance-auth";
import { ApiError, mapSetting } from "./http-adapter";
import type { OrgQuotas, Setting } from "./types";
import type { WireError, WireQuotas, WireSetting } from "./wire";

export type InstanceWhoami = { id: string; name: string; expiresAt: number | null };
/** What the sandbox limits allow together (#661). */
export type EffectiveConcurrency = {
  value: number;
  boundedBy: string;
  orgCap: number;
  cpuLimit: number;
  note: string;
};
export type InstanceOrg = { slug: string; name: string };
export type QuotaPatch = {
  maxConcurrent?: number | null;
  maxRunsPerHour?: number | null;
  maxSandboxMinutesPerDay?: number | null;
  maxLogBytes?: number | null;
  maxStoredBytes?: number | null;
};
export type ProjectSettings = {
  project: string;
  sandboxSnapshot: string | null;
  maxConcurrent: number | null;
  untrustedRunApproval: string;
};
export type ProjectPatch = {
  sandboxSnapshot?: string | null;
  maxConcurrent?: number | null;
};
export type CreatedProject = { org: string; project: string; id: string; name: string };
export type BackupResult = { path: string; sizeBytes: number; sha256: string };
export type RotatedToken = { id: string; secret: string; expiresAt: number; revokedId: string };

export interface InstanceApi {
  whoami(): Promise<InstanceWhoami>;
  listOrgs(): Promise<InstanceOrg[]>;
  listSettings(): Promise<Setting[]>;
  sandboxLimits(): Promise<EffectiveConcurrency>;
  setSetting(args: { key: string; value?: unknown; unset?: boolean }): Promise<Setting>;
  setQuotas(args: { org: string; patch: QuotaPatch }): Promise<OrgQuotas>;
  createProject(args: { org: string; slug: string; name: string }): Promise<CreatedProject>;
  setProjectSettings(args: {
    org: string;
    project: string;
    patch: ProjectPatch;
  }): Promise<ProjectSettings>;
  dbBackup(): Promise<BackupResult>;
  rotateToken(): Promise<RotatedToken>;
}

export type InstanceApiOptions = {
  baseUrl?: string;
  /** The `tti_` token, read per request so it is never captured. */
  token: () => string | null;
  /** Called on a 401: the token is not accepted. */
  onUnauthenticated?: () => void;
  fetch?: typeof fetch;
};

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function createInstanceApi(options: InstanceApiOptions): InstanceApi {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = `${options.baseUrl ?? ""}/api/v1/instance`;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = options.token();
    if (!token)
      throw new ApiError(401, "unauthenticated", "Not signed in as instance administrator");
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) {
      let code = "internal";
      let message = `Request failed (${res.status})`;
      try {
        const e = (await res.json()) as WireError;
        code = e.error.code;
        message = e.error.message;
      } catch {
        // not JSON; keep the generic message
      }
      if (res.status === 401) options.onUnauthenticated?.();
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  const quotasOf = (w: WireQuotas): OrgQuotas => ({
    limits: {
      maxConcurrent: w.limits.max_concurrent,
      maxRunsPerHour: w.limits.max_runs_per_hour,
      maxSandboxMinutesPerDay: w.limits.max_sandbox_minutes_per_day,
      maxLogBytes: w.limits.max_log_bytes,
      maxStoredBytes: w.limits.max_stored_bytes,
    },
    usage: w.usage,
  });

  return {
    async whoami() {
      const w = await call<{ id: string; name: string; expires_at: string | null }>(
        "GET",
        "/whoami",
      );
      return { id: w.id, name: w.name, expiresAt: ms(w.expires_at) };
    },
    async listOrgs() {
      return (await call<{ orgs: InstanceOrg[] }>("GET", "/orgs")).orgs;
    },
    async listSettings() {
      const w = await call<{ settings: WireSetting[] }>("GET", "/settings");
      return w.settings.map(mapSetting);
    },
    async sandboxLimits() {
      const w = await call<{
        effective_concurrency: {
          value: number;
          bounded_by: string;
          org_cap: number;
          cpu_limit: number;
          note: string;
        };
      }>("GET", "/sandbox-limits");
      const e = w.effective_concurrency;
      return {
        value: e.value,
        boundedBy: e.bounded_by,
        orgCap: e.org_cap,
        cpuLimit: e.cpu_limit,
        note: e.note,
      };
    },
    async setSetting({ key, value, unset }) {
      return mapSetting(
        await call<WireSetting>("POST", "/settings", {
          key,
          ...(unset ? { unset: true } : { value }),
        }),
      );
    },
    async setQuotas({ org, patch }) {
      return quotasOf(
        await call<WireQuotas>("POST", "/quotas", {
          target_org: org,
          ...(patch.maxConcurrent !== undefined ? { max_concurrent: patch.maxConcurrent } : {}),
          ...(patch.maxRunsPerHour !== undefined
            ? { max_runs_per_hour: patch.maxRunsPerHour }
            : {}),
          ...(patch.maxSandboxMinutesPerDay !== undefined
            ? { max_sandbox_minutes_per_day: patch.maxSandboxMinutesPerDay }
            : {}),
          ...(patch.maxLogBytes !== undefined ? { max_log_bytes: patch.maxLogBytes } : {}),
          ...(patch.maxStoredBytes !== undefined ? { max_stored_bytes: patch.maxStoredBytes } : {}),
        }),
      );
    },
    async createProject({ org, slug, name }) {
      return call<CreatedProject>("POST", "/projects", { target_org: org, slug, name });
    },
    async setProjectSettings({ org, project, patch }) {
      const w = await call<{
        project: string;
        sandbox_snapshot: string | null;
        max_concurrent: number | null;
        untrusted_run_approval: string;
      }>("POST", "/project-settings", {
        target_org: org,
        target_project: project,
        ...(patch.sandboxSnapshot !== undefined ? { sandbox_snapshot: patch.sandboxSnapshot } : {}),
        ...(patch.maxConcurrent !== undefined ? { max_concurrent: patch.maxConcurrent } : {}),
      });
      return {
        project: w.project,
        sandboxSnapshot: w.sandbox_snapshot,
        maxConcurrent: w.max_concurrent,
        untrustedRunApproval: w.untrusted_run_approval,
      };
    },
    async dbBackup() {
      const w = await call<{ path: string; size_bytes: number; sha256: string }>(
        "POST",
        "/db-backup",
        {},
      );
      // Path, size and sha256 only: the file is never offered for download.
      return { path: w.path, sizeBytes: w.size_bytes, sha256: w.sha256 };
    },
    async rotateToken() {
      const w = await call<{
        id: string;
        secret: string;
        expires_at: string;
        revoked_id: string;
      }>("POST", "/tokens/rotate", {});
      return {
        id: w.id,
        secret: w.secret,
        expiresAt: ms(w.expires_at) ?? 0,
        revokedId: w.revoked_id,
      };
    },
  };
}

let shared: InstanceApi | null = null;

/** The client the instance pages use, wired to the instance token store. */
export function getInstanceApi(): InstanceApi {
  shared ??= createInstanceApi({
    token: getInstanceToken,
    onUnauthenticated: () =>
      disconnectInstance("The server did not accept the instance token. Sign in again."),
  });
  return shared;
}
