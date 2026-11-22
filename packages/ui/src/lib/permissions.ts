import { getBackend } from "@/api";
import { useWhoami } from "@/lib/directory";
import { meetsRole, roleLabel, type Role } from "@/lib/roles";

/**
 * Minimum role that may approve a held run. The API does not report it per org yet, so this
 * mirrors the server default (`approve_run` needs release_operator). TODO: read it from the org.
 */
export const APPROVE_MIN_ROLE: Role = "release_operator";

/** Whether the caller may approve a held run, and a plain-language reason when not. */
export function useCanApprove(): { allowed: boolean; reason: string; role: Role | null } {
  const who = useWhoami();
  if (!getBackend().api.capabilities.approve)
    return { allowed: false, reason: "This server does not offer approvals yet.", role: null };
  if (who.error)
    return {
      allowed: false,
      reason: "Could not check your role. Reload to try again.",
      role: null,
    };
  if (!who.data) return { allowed: false, reason: "Checking your role.", role: null };
  const role = who.data.role;
  if (!meetsRole(role, APPROVE_MIN_ROLE))
    return {
      allowed: false,
      reason: `Approving needs the ${roleLabel(APPROVE_MIN_ROLE)} role or higher. You are signed in as ${roleLabel(role)}.`,
      role,
    };
  return { allowed: true, reason: "", role };
}
