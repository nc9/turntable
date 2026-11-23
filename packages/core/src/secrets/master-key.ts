// Where the master key comes from at boot: a file (TURNTABLE_MASTER_KEY_FILE, 32 raw bytes) or an
// environment variable (TURNTABLE_MASTER_KEY, the same 32 bytes as base64, base64url or 64 hex
// characters). The variable keeps the key off the data volume, so a volume backup does not hold
// the key next to what it unseals.
//
// The variable is read ONCE and deleted from the environment before anything else starts: no
// child process, plugin or provider can inherit it, and it is gone from /proc/<pid>/environ of
// the children. (Children get an allowlisted env anyway, see provider-sdk scrubbedEnv.)
//
// For a rotation, TURNTABLE_MASTER_KEY_PREVIOUS (or _PREVIOUS_FILE) names the key the sealed rows
// are under now; see rewrap.ts.
import { join } from "node:path";
import { AuditAnchor } from "../audit/anchor";
import { loadMasterKey } from "./crypto";

export const MASTER_KEY_ENV = "TURNTABLE_MASTER_KEY";
export const MASTER_KEY_FILE_ENV = "TURNTABLE_MASTER_KEY_FILE";
export const PREVIOUS_KEY_ENV = "TURNTABLE_MASTER_KEY_PREVIOUS";
export const PREVIOUS_KEY_FILE_ENV = "TURNTABLE_MASTER_KEY_PREVIOUS_FILE";

const KEY_BYTES = 32;
type Env = Record<string, string | undefined>;

export type MasterKeySource = "env" | "file";

export interface MasterKeys {
  key: Buffer;
  source: MasterKeySource;
  /** Absolute-as-given path when the key came from a file. */
  file?: string;
  /** The key the rows are sealed under before a rotation. Absent when no rotation is asked for. */
  previous?: Buffer;
}

/** A key variable or file that cannot be used. Never carries the value. */
export class MasterKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyConfigError";
  }
}

const set = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);

/** Decodes an env key: 64 hex characters, or base64 / base64url of 32 bytes. Throws without the value. */
export function parseMasterKeyValue(name: string, value: string): Buffer {
  const v = value.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const b = Buffer.from(v.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    if (b.length === KEY_BYTES) key = b;
  }
  if (!key) {
    throw new MasterKeyConfigError(
      `${name} must be ${KEY_BYTES} bytes as base64 or 64 hex characters (for example \`openssl rand -base64 32\`)`,
    );
  }
  return key;
}

/**
 * What to tell an operator whose audit anchor does not open under the current key: the usual cause
 * is a rotation without the previous key, and the fix is to give it. Never carries a key.
 */
export const anchorKeyMessage = (orgId: string): string =>
  `audit anchor for org ${orgId} is not sealed under the current master key (most likely the previous one): set ${PREVIOUS_KEY_ENV} (or ${PREVIOUS_KEY_FILE_ENV}) to the previous key and restart. Keep it set until a clean boot (doctor green, no AnchorCorrupt) is confirmed. If the key did not change, the file was edited: do not re-wrap, investigate.`;

/**
 * Reads the master key (and the previous one, if a rotation is asked for) from `env`, and DELETES
 * the key variables from it. Call it once, early, before any child process or plugin is started.
 * Both a variable and a file for the same key is an error: it would be unclear which one is live.
 */
export function takeMasterKeys(env: Env = process.env): MasterKeys | undefined {
  const value = set(env[MASTER_KEY_ENV]);
  const file = set(env[MASTER_KEY_FILE_ENV]);
  const prevValue = set(env[PREVIOUS_KEY_ENV]);
  const prevFile = set(env[PREVIOUS_KEY_FILE_ENV]);
  // Gone from the environment whatever happens next, even if this throws.
  delete env[MASTER_KEY_ENV];
  delete env[PREVIOUS_KEY_ENV];
  if (value && file) {
    throw new MasterKeyConfigError(
      `${MASTER_KEY_ENV} and ${MASTER_KEY_FILE_ENV} are both set: use one. Remove the file setting once the key is in the variable.`,
    );
  }
  if (prevValue && prevFile) {
    throw new MasterKeyConfigError(
      `${PREVIOUS_KEY_ENV} and ${PREVIOUS_KEY_FILE_ENV} are both set: use one`,
    );
  }
  if (!value && !file) {
    if (prevValue || prevFile) {
      throw new MasterKeyConfigError(
        `the previous master key is set but there is no current one (${MASTER_KEY_ENV} or ${MASTER_KEY_FILE_ENV})`,
      );
    }
    return undefined;
  }
  const key = value ? parseMasterKeyValue(MASTER_KEY_ENV, value) : loadMasterKey(file!);
  const out: MasterKeys = {
    key,
    source: value ? "env" : "file",
    ...(file ? { file } : {}),
  };
  const previous = prevValue
    ? parseMasterKeyValue(PREVIOUS_KEY_ENV, prevValue)
    : prevFile
      ? loadMasterKey(prevFile)
      : undefined;
  // The same key twice is a rotation to itself: nothing to re-wrap.
  if (previous && !previous.equals(key)) out.previous = previous;
  return out;
}

/**
 * The master key for a command that runs on its own (`secret`, `oidc`, `github`, `audit`): a
 * `--master-key-file`, else the environment. Same rules as the server; deletes the variables.
 */
export function masterKeyForCommand(flagFile: string | undefined, env: Env = process.env): Buffer {
  if (flagFile) {
    if (set(env[MASTER_KEY_ENV])) {
      throw new MasterKeyConfigError(
        `--master-key-file and ${MASTER_KEY_ENV} are both given: use one`,
      );
    }
    delete env[MASTER_KEY_ENV];
    delete env[PREVIOUS_KEY_ENV];
    return loadMasterKey(flagFile);
  }
  const k = takeMasterKeys(env);
  if (!k) {
    throw new MasterKeyConfigError(
      `set ${MASTER_KEY_ENV} or ${MASTER_KEY_FILE_ENV}, or pass --master-key-file`,
    );
  }
  return k.key;
}

/**
 * Where the audit anchor state lives: next to the key file when there is one, else under the data
 * directory (a key from the environment has no file to sit next to).
 */
export const auditStateDir = (keys: MasterKeys, dataDir: string): string =>
  keys.file ? AuditAnchor.dirFor(keys.file) : join(dataDir, "audit-state");
