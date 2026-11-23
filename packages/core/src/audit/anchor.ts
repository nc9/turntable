// Trust kept outside the database. The database is where an attacker who can rewrite audit rows
// works, so two facts the checkpointer relies on live in a small sealed file per org, in a
// directory next to the master key file:
//   - that a signing key existed (so a deleted key is an alert, not a reason to make a new one),
//   - the last (seq, hash) that was signed (so a checkpoint table rolled back, or a chain that no
//     longer extends what was signed, is refused).
// The file is sealed with the master key: someone with only the database cannot forge or edit
// it, and an edit by someone without the master key fails to open.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertResealAllowed,
  open,
  recordVersion,
  seal,
  SecretDecryptError,
} from "../secrets/crypto";

export interface AnchorState {
  v: 1;
  /** Id of the signing key that exists for this org. */
  keyId: string;
  /** The last checkpoint signed: 0 and the genesis hash before any. */
  lastSeq: number;
  lastHash: string;
  updatedAt: number;
}

/** The sealed file could not be opened: edited, or sealed with another master key. */
export class AnchorCorrupt extends Error {
  constructor(orgId: string) {
    super(`audit anchor state for org ${orgId} cannot be opened (edited, or another master key)`);
  }
}

const aad = (orgId: string): Buffer => Buffer.from(`longshore:audit-anchor:${orgId}`, "utf8");

export class AuditAnchor {
  readonly #dir: string;
  readonly #key: Buffer;

  constructor(dir: string, masterKey: Buffer) {
    this.#dir = dir;
    this.#key = masterKey;
  }

  /** The conventional directory: next to the master key file. */
  static dirFor(masterKeyFile: string): string {
    return `${masterKeyFile}.audit-state`;
  }

  #file(orgId: string): string {
    if (!/^[0-9A-Za-z]+$/.test(orgId)) throw new Error("invalid org id");
    return join(this.#dir, `${orgId}.state`);
  }

  /** The state, undefined when there is none, or throws AnchorCorrupt. */
  read(orgId: string): AnchorState | undefined {
    const f = this.#file(orgId);
    if (!existsSync(f)) return undefined;
    try {
      const s = JSON.parse(
        open(this.#key, readFileSync(f, "utf8"), aad(orgId), "system", orgId),
      ) as AnchorState;
      if (s.v !== 1 || typeof s.keyId !== "string" || typeof s.lastSeq !== "number") {
        throw new SecretDecryptError();
      }
      return s;
    } catch {
      throw new AnchorCorrupt(orgId);
    }
  }

  /** Re-seals an org's state file under the org's own key. False when there is none or it is already. */
  reseal(orgId: string): boolean {
    assertResealAllowed();
    const f = this.#file(orgId);
    if (!existsSync(f) || recordVersion(readFileSync(f, "utf8")) === "v3") return false;
    const st = this.read(orgId);
    if (!st) return false;
    this.write(
      orgId,
      { keyId: st.keyId, lastSeq: st.lastSeq, lastHash: st.lastHash },
      st.updatedAt,
    );
    return true;
  }

  /** Org ids whose state file is here but does not open under this key (edited, or another key). */
  unreadable(): string[] {
    return this.orgIds().filter((id) => {
      try {
        this.read(id);
        return false;
      } catch {
        return true;
      }
    });
  }

  /** Org ids that have a state file here. Used so an org whose database rows are gone is still checked. */
  orgIds(): string[] {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir)
      .map((f) => /^([0-9A-Za-z]+)\.state$/.exec(f)?.[1])
      .filter((x): x is string => x !== undefined);
  }

  /** Atomic: written to a temp file and renamed over the old one. Mode 0600. */
  write(orgId: string, state: Omit<AnchorState, "v" | "updatedAt">, now = Date.now()): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const body = seal(
      this.#key,
      JSON.stringify({ v: 1, ...state, updatedAt: now }),
      aad(orgId),
      "system",
      orgId,
    );
    const f = this.#file(orgId);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, f);
  }
}
