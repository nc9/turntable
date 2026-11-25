// Who installed the App (#573): the `sender` of a signature-verified `installation` webhook,
// recorded per installation and compared with a claimant by numeric GitHub id at claim time.
// Only the webhook handler calls this, after the signature check, and only for the `installation`
// event. It sets no run actor (runs come only from poll ingest, see webhook.ts and #416).
import type { Db } from "../db";
import { deleteInstallationInstaller, recordInstallationInstaller } from "../db/repos";

/** `installation` actions whose sender is recorded as the installer. */
const INSTALLER_ACTIONS = new Set(["created", "new_permissions_accepted", "unsuspend"]);

/**
 * Records, replaces or removes the installer for one `installation` delivery. `payload` is the
 * verified body. Anything other than a plain numeric id and a login is ignored. Idempotent, so a
 * redelivery (GitHub reuses the GUID) can run it again.
 */
export async function noteInstaller(
  db: Db,
  now: number,
  installationId: string,
  action: string | undefined,
  payload: object,
): Promise<void> {
  const sender = (payload as { sender?: { id?: unknown; login?: unknown } }).sender;
  if (action === "deleted") {
    await deleteInstallationInstaller(db, installationId);
    return;
  }
  if (action === undefined || !INSTALLER_ACTIONS.has(action)) return;
  const sid = sender?.id;
  const login = sender?.login;
  if (
    (typeof sid === "number" || typeof sid === "string") &&
    /^\d{1,20}$/.test(String(sid)) &&
    typeof login === "string" &&
    login.length > 0 &&
    login.length <= 100
  ) {
    await recordInstallationInstaller(db, {
      installationId,
      githubId: String(sid),
      login,
      recordedAt: now,
    });
  }
}
