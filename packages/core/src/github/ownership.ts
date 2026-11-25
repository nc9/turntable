// Who owns an installation's GitHub account (#573). The App has no organization "Members"
// permission, so `GET /user/memberships/orgs/{org}` with a user-to-server token fails for an
// organization. Ownership of an organization is therefore proven by EITHER the recorded installer
// (the `sender` of a signature-verified `installation` webhook) being the claimant, compared by
// numeric GitHub id and never by login, OR the membership call answering active admin.
import type { Db } from "../db";
import { getInstallationInstaller } from "../db/repos";

/** The refusal when the user reaches the installation but is not an owner of its account. */
export function notInstallationOwnerMessage(accountLogin: string): string {
  return `you must be an owner of ${accountLogin} on GitHub`;
}

/** The refusal when ownership could not be established because GitHub's membership call failed. */
export function ownershipUnverifiableMessage(accountLogin: string): string {
  return (
    `could not verify that you own ${accountLogin}: the App cannot read org membership. ` +
    "If you installed it, ask GitHub to redeliver the installation event (App settings, " +
    "Advanced, Recent Deliveries) and retry, or ask the instance operator"
  );
}

export type OwnershipVerdict =
  | { owns: true; via: "installer" | "membership" | "account" }
  | { owns: false; reason: "not_owner" | "ownership_unverifiable" };

/**
 * Shared by the claim callback and `bind_installation`. `isOrgAdmin` resolves true for an active
 * admin, false for any other membership, and throws or rejects when the call itself failed.
 */
export async function proveInstallationOwnership(
  db: Db,
  i: {
    installationId: string;
    accountType: string;
    accountId: string;
    claimantGithubId: string;
    isOrgAdmin: () => Promise<boolean>;
  },
): Promise<OwnershipVerdict> {
  if (i.accountType === "User") {
    return i.accountId === i.claimantGithubId
      ? { owns: true, via: "account" }
      : { owns: false, reason: "not_owner" };
  }
  if (i.accountType !== "Organization") return { owns: false, reason: "not_owner" };
  const installer = await getInstallationInstaller(db, i.installationId);
  if (installer && installer.installerGithubId === i.claimantGithubId) {
    return { owns: true, via: "installer" };
  }
  try {
    return (await i.isOrgAdmin())
      ? { owns: true, via: "membership" }
      : { owns: false, reason: "not_owner" };
  } catch {
    return { owns: false, reason: "ownership_unverifiable" };
  }
}
