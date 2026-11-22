import type { Op } from "./define";

export type OpRegistry = {
  readonly ops: readonly Op[];
  get(name: string): Op | undefined;
  /** Ops a bearer token may call. Excludes every `signature` op. */
  tokenOps(): Op[];
};

/** Builds a registry. A value, not a global, so tests can add ops the shipped one never has. */
export function createRegistry(ops: readonly Op[]): OpRegistry {
  const byName = new Map<string, Op>();
  const routes = new Set<string>();
  for (const op of ops) {
    if (byName.has(op.name)) throw new Error(`duplicate op name: ${op.name}`);
    byName.set(op.name, op);
    const route = `${op.http.method} ${op.http.path.replaceAll(/\{[^}]+\}/g, "{}")}`;
    if (routes.has(route)) throw new Error(`duplicate route: ${route}`);
    routes.add(route);
  }
  return {
    ops,
    get: (name) => byName.get(name),
    tokenOps: () => ops.filter((op) => op.auth.type === "token"),
  };
}
