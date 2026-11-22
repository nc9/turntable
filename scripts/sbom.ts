// CycloneDX 1.5 SBOM from bun.lock, for the compiled binaries. The binaries bundle the runtime
// dependencies of packages/core and packages/ui (and the workspace packages they pull in), so
// the SBOM is the transitive closure of those, with the lockfile's sha512 integrity as hashes.
// Dev-only tooling (typescript, oxlint, drizzle-kit) is not in the binary and not listed.
//
//   bun run scripts/sbom.ts --version 0.1.0-alpha.1 --out dist/longshore-0.1.0-alpha.1.cdx.json
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseLock, resolveDep, type Lock, type LockPackage } from "./lockfile";

/** Workspaces whose runtime dependencies end up in the binary. */
export const SHIPPED_WORKSPACES = ["packages/core", "packages/ui"] as const;

export const purl = (name: string, version: string): string =>
  `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;

function integrityHash(integrity: string | null): { alg: string; content: string }[] {
  const m = integrity ? /^sha(256|384|512)-(.+)$/.exec(integrity) : null;
  if (!m) return [];
  return [{ alg: `SHA-${m[1]}`, content: Buffer.from(m[2]!, "base64").toString("hex") }];
}

export function shippedPackages(lock: Lock): LockPackage[] {
  const seen = new Map<string, LockPackage>();
  const queue: LockPackage[] = [];
  const add = (p: LockPackage | undefined) => {
    if (p && !seen.has(p.key)) {
      seen.set(p.key, p);
      queue.push(p);
    }
  };
  for (const ws of SHIPPED_WORKSPACES) {
    for (const dep of Object.keys(lock.workspaces[ws]?.dependencies ?? {}))
      add(resolveDep(lock, "", dep));
  }
  while (queue.length > 0) {
    const p = queue.pop()!;
    const deps = { ...p.dependencies, ...p.optionalDependencies };
    // A workspace package's own dependencies come from the workspace table.
    if (p.workspace) {
      const ws = Object.values(lock.workspaces).find((w) => w.name === p.name);
      Object.assign(deps, ws?.dependencies ?? {});
    }
    for (const dep of Object.keys(deps)) add(resolveDep(lock, p.key, dep));
  }
  return [...seen.values()];
}

export function buildSbom(o: {
  lockText: string;
  version: string;
  timestamp?: string;
  serialNumber?: string;
}) {
  const lock = parseLock(o.lockText);
  const all = shippedPackages(lock);
  const refOf = (p: LockPackage) => purl(p.name, p.version);
  const registry = all.filter((p) => !p.workspace);
  const components = registry
    .map((p) => ({
      type: "library" as const,
      "bom-ref": refOf(p),
      name: p.name,
      version: p.version,
      purl: refOf(p),
      hashes: integrityHash(p.integrity),
    }))
    .toSorted((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const rootRef = `pkg:generic/longshore@${o.version}`;
  const direct = SHIPPED_WORKSPACES.flatMap((ws) =>
    Object.keys(lock.workspaces[ws]?.dependencies ?? {}).map((d) => resolveDep(lock, "", d)),
  ).filter((p): p is LockPackage => p !== undefined && !p.workspace);
  const dependencies = [
    { ref: rootRef, dependsOn: [...new Set(direct.map(refOf))].toSorted() },
    ...registry
      .map((p) => ({
        ref: refOf(p),
        dependsOn: [
          ...new Set(
            Object.keys({ ...p.dependencies, ...p.optionalDependencies })
              .map((d) => resolveDep(lock, p.key, d))
              .filter((d): d is LockPackage => d !== undefined && !d.workspace)
              .map(refOf),
          ),
        ].toSorted(),
      }))
      .toSorted((a, b) => a.ref.localeCompare(b.ref)),
  ];
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: o.serialNumber ?? `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: o.timestamp ?? new Date().toISOString(),
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: "longshore",
        version: o.version,
        licenses: [{ license: { id: "MIT" } }],
      },
      tools: { components: [{ type: "application", name: "scripts/sbom.ts" }] },
    },
    components,
    dependencies,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      out: { type: "string" },
      lock: { type: "string", default: join(import.meta.dir, "..", "bun.lock") },
    },
  });
  if (!values.version || !values.out) throw new Error("usage: sbom.ts --version <v> --out <file>");
  const sbom = buildSbom({
    lockText: readFileSync(values.lock!, "utf8"),
    version: values.version.replace(/^v/, ""),
  });
  writeFileSync(values.out, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(`wrote ${values.out} (${sbom.components.length} components)`);
}
