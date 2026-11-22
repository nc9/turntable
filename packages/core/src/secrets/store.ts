import type { Db } from "../db";
import { deleteSecretRecord, getSecretRecord, listSecretNames, putSecretRecord } from "../db/repos";
import { open, seal, secretAad } from "./crypto";

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

  async set(orgId: string, name: string, value: string): Promise<void> {
    assertName(name);
    await putSecretRecord(
      this.#db,
      { orgId },
      name,
      seal(this.#key, value, secretAad(orgId, name)),
    );
  }

  /** Throws SecretDecryptError if the record was tampered with or the key is wrong. */
  async get(orgId: string, name: string): Promise<string | undefined> {
    const record = await getSecretRecord(this.#db, { orgId }, name);
    return record === undefined ? undefined : open(this.#key, record, secretAad(orgId, name));
  }

  async has(orgId: string, name: string): Promise<boolean> {
    return (await getSecretRecord(this.#db, { orgId }, name)) !== undefined;
  }

  delete(orgId: string, name: string): Promise<boolean> {
    return deleteSecretRecord(this.#db, { orgId }, name);
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
