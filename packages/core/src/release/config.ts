// The release lane's configuration, in one place (#541): which repository a project releases
// from, where its signed bytes go, and the lane secrets those targets use. The `turntable release`
// CLI and the lane's config channel both call this, so the two cannot disagree about what is valid.
// Everything it writes lives in the lane's own file (and, for a secret, its own vault view); the
// main database is only read, to refuse a destination no target uses.
import type { Db } from "../db";
import { vaultCandidates } from "../db/repos";
import type { SecretVault } from "../secrets/vault";
import { VaultInputError } from "../secrets/vault";
import type { AttestationStore } from "./attest";
import { initReleaseKey, readReleaseKey, ReleaseKeyError, type ReleaseKeyInfo } from "./init-key";
import type { FileKeyVault } from "./key-vault";
import { parseTarget, PublishConfigError, TARGET_KEY } from "./publish/config";
import type { PublishTarget } from "./publish/types";

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** A refusal that says what is wrong with the input: shown to the caller, never echoing a secret. */
export class LaneConfigError extends Error {}

/** The fields of a publish target as the CLI flags and the op input name them. */
export type TargetFields = {
  kind?: string | undefined;
  mode?: string | undefined;
  package?: string | undefined;
  artifact?: string | undefined;
  secret?: string | undefined;
  tag?: string | undefined;
  access?: string | undefined;
  assets?: readonly string[] | undefined;
  /** A name, or `none` for no provenance asset. */
  provenance_asset?: string | undefined;
  accept_long_lived_token?: boolean | undefined;
  registry?: string | undefined;
  repository?: string | undefined;
  manifest?: string | undefined;
  tags?: readonly string[] | undefined;
  username?: string | undefined;
  realm_host?: string | undefined;
};

export function validateRepo(repo: string): string {
  if (!REPO.test(repo)) throw new LaneConfigError("repo must be owner/name");
  return repo;
}

export function validateTargetKey(key: string | undefined): string {
  if (!key || !TARGET_KEY.test(key)) {
    throw new LaneConfigError("key must be a short lower-case name (letters, digits, dashes)");
  }
  return key;
}

/** Builds and validates a target from flat fields. Throws LaneConfigError on anything off. */
export function buildTarget(f: TargetFields): PublishTarget {
  const mode = f.mode ? { mode: f.mode } : {};
  const raw =
    f.kind === "npm"
      ? {
          kind: "npm",
          ...mode,
          package: f.package,
          artifact: f.artifact,
          secret: f.secret,
          ...(f.tag ? { tag: f.tag } : {}),
          ...(f.access ? { access: f.access } : {}),
        }
      : f.kind === "github-release"
        ? {
            kind: "github-release",
            ...mode,
            assets: [...(f.assets ?? [])],
            ...(f.provenance_asset !== undefined
              ? { provenanceAsset: f.provenance_asset === "none" ? null : f.provenance_asset }
              : {}),
          }
        : f.kind === "oci-image"
          ? {
              kind: "oci-image",
              mode: f.mode ?? "compat",
              registry: f.registry,
              repository: f.repository,
              manifest: f.manifest,
              tags: [...(f.tags ?? [])],
              username: f.username,
              ...(f.realm_host !== undefined ? { realmHost: f.realm_host } : {}),
              secret: f.secret,
            }
          : undefined;
  if (!raw) throw new LaneConfigError("kind must be npm, github-release or oci-image");
  if (raw.kind === "npm" && !f.accept_long_lived_token) {
    throw new LaneConfigError(
      "publishing to npm uses a long-lived registry token (a granular, package-scoped, publish-only one); pass accept_long_lived_token (--accept-long-lived-token) to say you accept that",
    );
  }
  try {
    return parseTarget(raw);
  } catch (e) {
    if (e instanceof PublishConfigError) throw new LaneConfigError(e.message);
    throw e;
  }
}

/** The hosts a lane secret may be sent to, for the targets that name it. */
function destinationsFor(
  targets: Record<string, PublishTarget>,
  name: string,
  npmRegistry: string,
): string[] {
  const hosts = new Set<string>();
  for (const t of Object.values(targets)) {
    if (t.kind === "npm" && t.secret === name) hosts.add(new URL(npmRegistry).hostname);
    if (t.kind === "oci-image" && t.secret === name) hosts.add(t.registry);
  }
  return [...hosts];
}

export type TargetView = {
  key: string;
  kind: string;
  mode: string;
  /** True when the vault holds a usable lane secret for the target (or the lane has its GitHub write token). */
  has_credential: boolean;
  /** The declaration, with the vault secret's name as `vault_name`. Never a value. */
  settings: Record<string, unknown>;
};

export type LaneConfigSnapshot = {
  config_version: number;
  pinned_repo: string | null;
  targets: TargetView[];
};

export interface LaneConfigOptions {
  attest: AttestationStore;
  /** The lane's own vault view, and the database it reads. Absent: lane secrets cannot be set. */
  vault?: SecretVault | undefined;
  db?: Db | undefined;
  /** Whether the lane holds its GitHub publish token (for a github-release target). */
  githubCredential?: boolean | undefined;
  npmRegistry?: string | undefined;
  /**
   * The lane's signing keys, sealed under the release master key. Absent: the release master key
   * is not configured here, and creating or reading a key is refused.
   */
  keys?: FileKeyVault | undefined;
  now?: () => number;
}

export class LaneConfig {
  readonly #o: LaneConfigOptions;

  constructor(o: LaneConfigOptions) {
    this.#o = o;
  }

  get version(): number {
    return this.#o.attest.configVersion();
  }

  pinRepo(orgId: string, projectId: string, repo: string): string {
    validateRepo(repo);
    this.#o.attest.pinRepo(orgId, projectId, repo, (this.#o.now ?? Date.now)());
    return repo.toLowerCase();
  }

  setTarget(orgId: string, projectId: string, key: string, fields: TargetFields): PublishTarget {
    validateTargetKey(key);
    const target = buildTarget(fields);
    this.#o.attest.setPublishTarget(orgId, projectId, key, target, (this.#o.now ?? Date.now)());
    return target;
  }

  removeTarget(orgId: string, projectId: string, key: string): boolean {
    validateTargetKey(key);
    return this.#o.attest.removePublishTarget(orgId, projectId, key);
  }

  async snapshot(orgId: string, projectId: string): Promise<LaneConfigSnapshot> {
    const targets: TargetView[] = [];
    for (const [key, t] of Object.entries(this.#o.attest.publishTargets(orgId, projectId))) {
      const { secret, ...rest } = t as PublishTarget & { secret?: string };
      targets.push({
        key,
        kind: t.kind,
        mode: t.mode,
        has_credential:
          secret === undefined
            ? this.#o.githubCredential === true
            : await this.#hasSecret(orgId, projectId, secret),
        settings: { ...rest, ...(secret === undefined ? {} : { vault_name: secret }) },
      });
    }
    return {
      config_version: this.version,
      pinned_repo: this.#o.attest.pinnedRepo(orgId, projectId) ?? null,
      targets,
    };
  }

  /**
   * Creates the org's signing key `name`, inside the lane: the private half is sealed under the
   * release master key and never leaves. Refuses a name already taken and an unset master key.
   * Returns the public half only.
   */
  async initKey(orgId: string, name: string): Promise<ReleaseKeyInfo> {
    const keys = this.#needKeys();
    try {
      return await initReleaseKey({ vault: keys, orgId, name, refuseExisting: true });
    } catch (e) {
      if (e instanceof ReleaseKeyError) throw new LaneConfigError(e.message);
      throw e;
    }
  }

  /** The public half of the org's signing key `name`. */
  async publicKey(orgId: string, name: string): Promise<ReleaseKeyInfo> {
    const keys = this.#needKeys();
    try {
      const k = await readReleaseKey({ vault: keys, orgId, name });
      if (!k) throw new LaneConfigError("no such release key");
      return k;
    } catch (e) {
      if (e instanceof ReleaseKeyError) throw new LaneConfigError(e.message);
      throw e;
    }
  }

  #needKeys(): FileKeyVault {
    if (!this.#o.keys) {
      throw new LaneConfigError(
        "the release master key is not configured on this lane, so it holds no signing keys",
      );
    }
    return this.#o.keys;
  }

  async #hasSecret(orgId: string, projectId: string, name: string): Promise<boolean> {
    if (!this.#o.db) return false;
    const rows = await vaultCandidates(this.#o.db, orgId, name);
    return rows.some(
      (r) =>
        (r.projectId === null || r.projectId === projectId) &&
        r.environment === null &&
        (JSON.parse(r.trustClasses) as string[]).includes("release"),
    );
  }

  /**
   * Stores a lane secret (a publish credential) in the lane's vault, for the hosts the project's
   * targets that name it send to. Release class only. The value is sealed under the release key
   * and never returned; a change bumps the config version like any other.
   */
  async setSecret(
    orgId: string,
    projectId: string,
    name: string,
    value: string,
    actor: string,
  ): Promise<{ created: boolean }> {
    const vault = this.#o.vault;
    if (!vault) throw new LaneConfigError("this lane has no vault");
    const destinations = destinationsFor(
      this.#o.attest.publishTargets(orgId, projectId),
      name,
      this.#o.npmRegistry ?? "https://registry.npmjs.org",
    );
    if (destinations.length === 0) {
      throw new LaneConfigError(
        "no publish target of this project uses that secret name: declare the target first",
      );
    }
    try {
      const r = await vault.set(orgId, actor, { name, projectId }, value, {
        trustClasses: ["release"],
        destinations,
      });
      this.#o.attest.bumpConfigVersion();
      return { created: r.created };
    } catch (e) {
      // A vault refusal names what is wrong with the input and never echoes the value.
      if (e instanceof VaultInputError) throw new LaneConfigError(e.message);
      throw e;
    }
  }
}
