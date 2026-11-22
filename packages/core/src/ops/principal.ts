import type { AgentRole, MemberRole } from "../db/schema";

/**
 * Who is calling. A `token` principal comes from a bearer token (REST, MCP). A `member`
 * principal is a person, built by trusted in-process callers only (the local CLI, and web
 * sessions once they exist); no network adapter can construct one.
 */
export type Principal =
  | { kind: "token"; id: string; orgId: string; projectId: string | null; role: AgentRole }
  | { kind: "member"; id: string; orgId: string; role: MemberRole }
  /**
   * An enrolled approver, proven by a signature over the request's statement. It exists only for
   * signature ops: no token op accepts it, and no bearer token or member can become one.
   */
  | { kind: "approver"; id: string; orgId: string; person: string; role: "viewer" };

/** What a caller presents to the dispatcher. */
export type Credential =
  | { kind: "bearer"; token: string }
  /**
   * The request carries its own proof: a signed statement in the input. Only signature ops accept
   * it, and the dispatcher verifies the signature before anything else runs.
   */
  | { kind: "signed" }
  /** In-process only: an already-authenticated principal. Adapters never build this. */
  | { kind: "principal"; principal: Principal };

export const principalLabel = (p: Principal): string => `${p.kind}:${p.id}`;
