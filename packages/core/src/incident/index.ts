// Incident response plumbing: what a freeze reaches beyond the database. Two small registries so
// the pieces that hold credentials (the GitHub App's token cache, the vault) plug in without the
// freeze knowing about them.
import type { Db } from "../db";
import { type FlagSource, listSecretNames, listVaultSecrets, type Scope } from "../db/repos";

export type CredentialRevoker = {
  name: string;
  /** Drops what this process holds for the scope. Returns how many credentials were dropped. */
  revoke(scope: Scope): number | Promise<number>;
};

const revokers = new Map<string, CredentialRevoker>();

/** Replaces any revoker of the same name. Returns an unregister function. */
export function registerCredentialRevoker(r: CredentialRevoker): () => void {
  revokers.set(r.name, r);
  return () => void (revokers.get(r.name) === r && revokers.delete(r.name));
}

export type RevokeReport = { name: string; dropped: number }[];

export async function revokeMintedCredentials(scope: Scope): Promise<RevokeReport> {
  const out: RevokeReport = [];
  for (const r of revokers.values()) out.push({ name: r.name, dropped: await r.revoke(scope) });
  return out;
}

/** Names of the secrets a scope can use, from one store. Names only, never values. */
export type SecretNameSource = {
  /** The store: a flag raised from it is cleared only by an update in the same store. */
  name: FlagSource;
  list(db: Db, scope: Scope): Promise<string[]>;
};

const sources = new Map<FlagSource, SecretNameSource>([
  // The built-in store (the GitHub App's key and webhook secret) is org-wide: a project-scoped
  // freeze does not flag it.
  // The vault: every secret name in the org, or in the project for a project-scoped freeze. One
  // name can be several scoped secrets; the flag is by name.
  [
    "vault",
    {
      name: "vault",
      async list(db, scope) {
        const names = new Set<string>();
        for (let after: string | undefined; ;) {
          const page = await listVaultSecrets(db, scope, {
            limit: 500,
            ...(after ? { afterId: after } : {}),
          });
          for (const r of page) names.add(r.name);
          if (page.length < 500) break;
          after = page.at(-1)!.id;
        }
        return [...names];
      },
    },
  ],
  [
    "builtin",
    {
      name: "builtin",
      list: (db, scope) =>
        scope.projectId === undefined ? listSecretNames(db, scope) : Promise.resolve([]),
    },
  ],
]);

export function registerSecretNameSource(s: SecretNameSource): () => void {
  sources.set(s.name, s);
  return () => void (sources.get(s.name) === s && sources.delete(s.name));
}

export async function secretNamesInScope(
  db: Db,
  scope: Scope,
): Promise<{ source: FlagSource; name: string }[]> {
  const out: { source: FlagSource; name: string }[] = [];
  for (const src of sources.values()) {
    for (const name of [...new Set(await src.list(db, scope))].toSorted())
      out.push({ source: src.name, name });
  }
  return out;
}
