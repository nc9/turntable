import type { Db } from "../db";
import { getApprover } from "../db/repos";
import type { ApproverKeyStore } from "./verify";

/** The default key store: the org's enrolled approvers. */
export function dbKeyStore(db: Db, orgId: string): ApproverKeyStore {
  return {
    async lookup(id) {
      const a = await getApprover(db, orgId, id);
      return a ? { ...a, revoked: a.revokedAt !== null } : undefined;
    },
  };
}
