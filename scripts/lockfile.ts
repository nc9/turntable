// Reads bun.lock (JSONC). Shared by the SBOM generator and the dependency age check.
export type LockPackage = {
  /** Key in the lockfile: "name", or "parent/name" for a nested copy. */
  key: string;
  name: string;
  version: string;
  integrity: string | null;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  workspace: boolean;
};

export type Lock = {
  workspaces: Record<
    string,
    {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
  packages: Map<string, LockPackage>;
};

type RawEntry = [string, string?, Record<string, unknown>?, string?];

export function parseLock(text: string): Lock {
  const raw = Bun.JSONC.parse(text) as {
    workspaces: Lock["workspaces"];
    packages: Record<string, RawEntry>;
  };
  const packages = new Map<string, LockPackage>();
  for (const [key, entry] of Object.entries(raw.packages)) {
    const id = entry[0];
    const at = id.lastIndexOf("@");
    if (at <= 0) continue;
    const name = id.slice(0, at);
    const version = id.slice(at + 1);
    const meta = (entry[2] ?? {}) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    packages.set(key, {
      key,
      name,
      version,
      integrity: typeof entry[3] === "string" ? entry[3] : null,
      dependencies: meta.dependencies ?? {},
      optionalDependencies: meta.optionalDependencies ?? {},
      workspace: version.startsWith("workspace:"),
    });
  }
  return { workspaces: raw.workspaces, packages };
}

/** `name@version` of every registry package in the lockfile (workspace packages excluded). */
export function registryPackages(lock: Lock): Set<string> {
  const out = new Set<string>();
  for (const p of lock.packages.values()) if (!p.workspace) out.add(`${p.name}@${p.version}`);
  return out;
}

/** Resolves a dependency of `parentKey` the way the package manager does: nested copy first. */
export function resolveDep(lock: Lock, parentKey: string, dep: string): LockPackage | undefined {
  let scope = parentKey;
  for (;;) {
    const hit = lock.packages.get(scope === "" ? dep : `${scope}/${dep}`);
    if (hit) return hit;
    if (scope === "") return undefined;
    const slash = scope.lastIndexOf("/");
    // A scoped name like "@a/b" has its own slash; strip a whole name segment.
    scope =
      slash <= 0 || (scope.startsWith("@") && scope.indexOf("/") === slash)
        ? ""
        : scope.slice(0, slash);
  }
}
