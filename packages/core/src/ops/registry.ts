import { AGENT_ROLES } from "../db/schema";
import type { Op } from "./define";
import { roleSatisfies } from "./roles";

export type OpRegistry = {
  readonly ops: readonly Op[];
  get(name: string): Op | undefined;
  /** Ops a bearer token may call. Excludes every `signature` op. */
  tokenOps(): Op[];
  /** Ops that take no token: the signed statement in the request is the credential. */
  signatureOps(): Op[];
  /**
   * Ops worth listing for an agent: token ops that at least one token role can actually call. An
   * op that needs a role no token holds (create_api_token needs admin) can only be refused, so
   * listing it in the MCP tools or the OpenAPI document is noise and an invitation.
   */
  documentedOps(): Op[];
  /** documentedOps minus ops that must not reach an agent's context (those that carry a value). */
  mcpOps(): Op[];
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
  const documented = (): Op[] =>
    ops.filter(
      (op) =>
        op.auth.type === "token" && AGENT_ROLES.some((r) => roleSatisfies(r, op.auth.minRole)),
    );
  return {
    ops,
    mcpOps: () => documented().filter((op) => op.mcp),
    get: (name) => byName.get(name),
    tokenOps: () => ops.filter((op) => op.auth.type === "token"),
    // Only signature ops that take a signed statement are routed and documented. Others (such
    // as sign_release, which only refuses) have no unauthenticated route.
    signatureOps: () =>
      ops.filter(
        (op) =>
          op.auth.type === "signature" && "statement" in op.input.shape && "signature" in op.input.shape,
      ),
    documentedOps: () =>
      ops.filter(
        (op) =>
          op.auth.type === "token" && AGENT_ROLES.some((r) => roleSatisfies(r, op.auth.minRole)),
      ),
  };
}
