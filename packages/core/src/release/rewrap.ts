// Release lane key rotation at boot, with TURNTABLE_RELEASE_MASTER_KEY and _PREVIOUS. Everything the
// lane's key seals moves to the new key in one database transaction (plus the signing key files,
// renamed into place after the commit and read back):
//   - release-class vault rows (publish credentials) in the shared database. The lane cannot tell
//     them from a main-key row that merely allows `release`, so a row that opens under neither of
//     its keys is left alone and named in the log (the main process's re-wrap fails the boot on a
//     release-class row that opens under none of the keys it holds, unless the lane runs elsewhere);
//   - the signing key files in the lane's own data directory (`keysDir`).
// A row or file is tried under the NEW key first (already done: skipped), then the previous one.
// Each re-sealed value is opened again under the new key and compared before anything commits. A
// signing key file that opens under neither fails the run before anything is written.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { appendAudit } from "../db/repos";
import * as s from "../db/schema";
import { open, vaultAad } from "../secrets/crypto";
import { replan, RewrapError } from "../secrets/rewrap";

export interface ReleaseRewrapOptions {
  db: Db;
  next: Buffer;
  previous: Buffer;
  /** The lane's signing key directory (`keysDir(dataDir)`). */
  keysDir: string;
  auditOrgId: string;
  log?: (m: string) => void;
}

export interface ReleaseRewrapResult {
  vault_secret_versions: number;
  signing_key_files: number;
  skipped: string[];
}

const keyAad = (name: string): Buffer => Buffer.from(`longshore:release-key:${name}`, "utf8"); // rename-keep: frozen sealing string

export async function rewrapReleaseKey(o: ReleaseRewrapOptions): Promise<ReleaseRewrapResult> {
  const keys = { next: o.next, previous: o.previous };
  // Signing key files first, read only. The file name maps back to the key name (`/` is `__`); a
  // name that itself holds `__` is tried as written too.
  const filePlan: { file: string; name: string; sealed: string }[] = [];
  const files = existsSync(o.keysDir)
    ? readdirSync(o.keysDir).filter((f) => f.endsWith(".sealed"))
    : [];
  for (const f of files) {
    const base = f.slice(0, -".sealed".length);
    const path = join(o.keysDir, f);
    const record = readFileSync(path, "utf8");
    let found: { name: string; sealed: string | undefined } | undefined;
    for (const name of new Set([base.replaceAll("__", "/"), base])) {
      try {
        found = { name, sealed: replan(keys, record, keyAad(name), "system", undefined) };
        break;
      } catch {
        // try the next spelling
      }
    }
    if (!found) {
      throw new RewrapError(
        `cannot re-wrap signing key file ${f}: it opens under neither the current nor the previous release master key. Nothing was changed.`,
      );
    }
    if (found.sealed !== undefined)
      filePlan.push({ file: path, name: found.name, sealed: found.sealed });
  }

  const skipped: string[] = [];
  let vault = 0;
  await o.db.transaction(async (tx) => {
    skipped.length = 0;
    vault = 0;
    const rows = await tx.orm
      .select({
        orgId: s.vaultSecretVersions.orgId,
        secretId: s.vaultSecretVersions.secretId,
        version: s.vaultSecretVersions.version,
        name: s.vaultSecrets.name,
        trustClasses: s.vaultSecrets.trustClasses,
        ciphertext: s.vaultSecretVersions.ciphertext,
      })
      .from(s.vaultSecretVersions)
      .innerJoin(
        s.vaultSecrets,
        and(
          eq(s.vaultSecrets.id, s.vaultSecretVersions.secretId),
          eq(s.vaultSecrets.orgId, s.vaultSecretVersions.orgId),
        ),
      );
    for (const r of rows) {
      if (!(JSON.parse(r.trustClasses) as string[]).includes("release")) continue;
      const aad = vaultAad(r.orgId, r.secretId, r.version, r.name);
      let sealed: string | undefined;
      try {
        sealed = replan(keys, r.ciphertext, aad, "job", r.orgId);
      } catch {
        skipped.push(`${r.orgId}/${r.secretId}@${r.version}`);
        continue;
      }
      if (sealed === undefined) continue;
      await tx.orm
        .update(s.vaultSecretVersions)
        .set({ ciphertext: sealed })
        .where(
          and(
            eq(s.vaultSecretVersions.orgId, r.orgId),
            eq(s.vaultSecretVersions.secretId, r.secretId),
            eq(s.vaultSecretVersions.version, r.version),
          ),
        );
      vault++;
    }
    if (vault + filePlan.length > 0) {
      await appendAudit(
        tx,
        { orgId: o.auditOrgId },
        {
          principalKind: "system",
          principalId: "release-lane",
          op: "release_key_rewrap",
          effect: "write",
          outcome: "ok",
          input: { vault_secret_versions: vault, signing_key_files: filePlan.length },
        },
      );
    }
  });

  // Committed. Atomic renames, each read back under the new key; a crash before they finish is
  // repaired by the next boot (what is left opens under the previous key and is planned again).
  for (const { file, name, sealed } of filePlan) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, sealed, { mode: 0o600 });
    renameSync(tmp, file);
    try {
      open(o.next, readFileSync(file, "utf8"), keyAad(name), "system");
    } catch {
      throw new RewrapError(`signing key file ${file} did not verify after the re-wrap`);
    }
  }
  o.log?.(
    `release key re-wrap: re-sealed ${vault} publish credential versions and ${filePlan.length} signing key files${skipped.length > 0 ? `; left ${skipped.length} vault rows that open under neither release key (the main key's): ${skipped.join(", ")}` : ""}`,
  );
  return { vault_secret_versions: vault, signing_key_files: filePlan.length, skipped };
}
