import type { AgentRole, MemberRole, TokenKind } from "../db/schema";
import { OpError } from "./errors";
import type { Role } from "./roles";

/**
 * Who is calling. A `token` principal comes from a bearer token (REST, MCP). A `member`
 * principal is a person, built by trusted in-process callers only (the local CLI, and web
 * sessions once they exist); no network adapter can construct one.
 */
export type Principal =
  | {
      kind: "token";
      id: string;
      orgId: string;
      projectId: string | null;
      role: AgentRole;
      /** Who holds the token. A token row with no kind is an agent (fail closed). */
      tokenKind: TokenKind;
    }
  | { kind: "member"; id: string; orgId: string; role: MemberRole }
  /**
   * A signed-in person on the web (#430): a session cookie resolved to the role their membership
   * row gives in one org. It is deliberately NOT a `member`. Every `kind === "member"` check in
   * the code was written for the trusted in-process caller (the host CLI) and so refuses a
   * session; a session passes only the role checks, and only the writes the dispatcher names
   * (SESSION_WRITE_OPS) until passkey step-up exists.
   */
  | { kind: "session"; id: string; orgId: string; role: MemberRole }
  /**
   * An enrolled approver, proven by a signature over the request's statement. It exists only for
   * signature ops: no token op accepts it, and no bearer token or member can become one.
   */
  | { kind: "approver"; id: string; orgId: string; person: string; role: "viewer" }
  /**
   * The instance administrator, from a `tti_` token. It holds no org grant: `orgId` is the
   * system org only so its audit entries land in that chain. It can call `instance` ops and
   * nothing else, and no org principal can call those.
   */
  | { kind: "instance"; id: string; orgId: string; role: "instance_admin" };

/** What a caller presents to the dispatcher. */
export type Credential =
  | { kind: "bearer"; token: string }
  /**
   * The request carries its own proof: a signed statement in the input. Only signature ops accept
   * it, and the dispatcher verifies the signature before anything else runs.
   */
  | { kind: "signed" }
  /**
   * A web session cookie's value (REST only; MCP and the sockets never build one). The dispatcher
   * resolves it to the signed-in user's `member` principal for one org, from the database.
   */
  | { kind: "session"; cookie: string }
  /** In-process only: an already-authenticated principal. Adapters never build this. */
  | { kind: "principal"; principal: Principal };

export const principalLabel = (p: Principal): string => `${p.kind}:${p.id}`;

/**
 * The org role of a principal. An instance administrator holds none: the dispatcher never gives
 * it an org op, and this makes the type say so for the handlers that read a role.
 */
export function orgRole(p: Principal): Role {
  if (p.kind === "instance") throw new OpError("forbidden", "an instance token holds no org role");
  return p.role;
}
