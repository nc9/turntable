import type { Db } from "../db";
import {
  appendAudit,
  clearRotationFlag,
  deleteSecretRecord,
  getSecretRecord,
  listSecretNames,
  putSecretRecord,
  putSecretRecordIfAbsent,
} from "../db/repos";
import { assertResealAllowed, open, recordVersion, seal, secretAad } from "./crypto";

/**
 * The built-in encrypted secret store (minimal, ahead of the full vault). Values go in sealed and
 * come out only through `get`, for the code that must use them. No operation, log line or error
 * message carries a value; `list` returns names only.
 */
export class SecretStore {
  readonly #db: Db;
  readonly #key: Buffer;

  constructor(db: Db, masterKey: Buffer) {
    this.#db = db;
    this.#key = masterKey;
  }

  /** The same store on another handle, so its writes join a caller's transaction. */
  withDb(db: Db): SecretStore {
    return new SecretStore(db, this.#key);
  }

  /**
   * `audit: false` is for a caller that writes its own, more specific audit row (the sealed GitHub
   * user token). The row is then not a tenant-secret event and gets no `secret_set`.
   */
  async set(
    orgId: string,
    name: string,
    value: string,
    opts: { audit?: boolean } = {},
  ): Promise<void> {
    assertName(name);
    await putSecretRecord(
      this.#db,
      { orgId },
      name,
      seal(this.#key, value, secretAad(orgId, name), "system", orgId),
    );
    // Audited by name only: a value never goes near the log.
    if (opts.audit !== false) await this.#audit(orgId, "secret_set", name);
    // A new value in this store closes an incident rotation flag it raised (and only this
    // store's flags: a vault secret of the same name is rotated through the vault).
    await clearRotationFlag(this.#db, { orgId }, name, "builtin", Date.now());
  }

  /**
   * Stores the value only when the name is free (atomic, both dialects). True when this call
   * stored it; false means another writer got there first and the caller must read the stored value.
   */
  async setIfAbsent(orgId: string, name: string, value: string): Promise<boolean> {
    assertName(name);
    const inserted = await putSecretRecordIfAbsent(
      this.#db,
      { orgId },
      name,
      seal(this.#key, value, secretAad(orgId, name), "system", orgId),
    );
    if (!inserted) return false;
    await this.#audit(orgId, "secret_set", name);
    await clearRotationFlag(this.#db, { orgId }, name, "builtin", Date.now());
    return true;
  }

  /** Throws SecretDecryptError if the record was tampered with or the key is wrong. */
  async get(orgId: string, name: string): Promise<string | undefined> {
    const record = await getSecretRecord(this.#db, { orgId }, name);
    return record === undefined
      ? undefined
      : open(this.#key, record, secretAad(orgId, name), "system", orgId);
  }

  /**
   * Re-seals every record of an org under the org's own key (format v3), in place and without
   * touching the value. Records already v3 are left alone. Returns how many were changed. A
   * record that cannot be opened stops the run (nothing is half-converted: each record is
   * replaced whole).
   */
  async reseal(orgId: string): Promise<number> {
    assertResealAllowed();
    let n = 0;
    for (const name of await listSecretNames(this.#db, { orgId })) {
      const record = await getSecretRecord(this.#db, { orgId }, name);
      if (record === undefined || recordVersion(record) === "v3") continue;
      const value = open(this.#key, record, secretAad(orgId, name), "system", orgId, {
        allowLegacy: true,
      });
      await putSecretRecord(
        this.#db,
        { orgId },
        name,
        seal(this.#key, value, secretAad(orgId, name), "system", orgId),
      );
      n++;
    }
    if (n > 0) await this.#audit(orgId, "secrets_resealed", `${n} records`);
    return n;
  }

  async has(orgId: string, name: string): Promise<boolean> {
    return (await getSecretRecord(this.#db, { orgId }, name)) !== undefined;
  }

  async delete(orgId: string, name: string, opts: { audit?: boolean } = {}): Promise<boolean> {
    const removed = await deleteSecretRecord(this.#db, { orgId }, name);
    if (removed && opts.audit !== false) await this.#audit(orgId, "secret_delete", name);
    return removed;
  }

  #audit(orgId: string, op: string, name: string): Promise<void> {
    return appendAudit(
      this.#db,
      { orgId },
      {
        principalKind: "system",
        principalId: "secret-store",
        op,
        effect: "write",
        outcome: "ok",
        input: { name },
      },
    );
  }

  list(orgId: string): Promise<string[]> {
    return listSecretNames(this.#db, { orgId });
  }
}

function assertName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name)) {
    throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
  }
}
