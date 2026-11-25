// Creating and reading the release lane's built-in signing keys, in one place: `turntable release
// init-key` and the lane's config channel (the `release_init_key` and `release_public_key` ops) both
// call this. A key is generated inside the lane, sealed under the release master key in the lane's
// own directory, and never leaves it: nothing here returns, logs or exports the private half.
import { LocalSigner } from "@turntable/signer";
import { builtinKeyRef } from "../signing/service";
import type { FileKeyVault } from "./key-vault";

/** A key name: plain characters, short, so it is a safe file name and a safe `builtin:<name>`. */
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A refusal that says what is wrong; never carries key material. */
export class ReleaseKeyError extends Error {}

export type ReleaseKeyInfo = {
  keyid: string;
  publicKeyPem: string;
  /** Epoch milliseconds the key was sealed. */
  createdAt: number;
};

export function validateKeyName(name: string): string {
  if (!KEY_NAME.test(name)) {
    throw new ReleaseKeyError("a key name is 1 to 64 plain characters (letters, digits, . _ -)");
  }
  return name;
}

/**
 * Creates the org's key `name` in the lane's vault and returns its public half. With
 * `refuseExisting` a key that is already there is refused (no overwrite, no silent reuse: rotation
 * is a separate act); without it the existing key's public half is returned, as the CLI always did.
 */
export async function initReleaseKey(o: {
  vault: FileKeyVault;
  orgId: string;
  name: string;
  refuseExisting: boolean;
}): Promise<ReleaseKeyInfo> {
  validateKeyName(o.name);
  const ref = builtinKeyRef(o.orgId, o.name);
  const signer = new LocalSigner(o.vault);
  const vaultName = `signing/${ref}`;
  if (o.refuseExisting && o.vault.createdAt(vaultName) !== undefined) {
    throw new ReleaseKeyError(`a release key named ${o.name} already exists for this org`);
  }
  let pub;
  try {
    pub = await signer.ensureKey(ref);
  } catch (e) {
    // The vault refuses to overwrite: a racing second init lands here, never on the first key.
    if (o.refuseExisting)
      throw new ReleaseKeyError(`a release key named ${o.name} already exists for this org`);
    throw e;
  }
  return { ...pub, createdAt: o.vault.createdAt(vaultName) ?? Date.now() };
}

/** The public half of the org's key `name`, or undefined when there is none. */
export async function readReleaseKey(o: {
  vault: FileKeyVault;
  orgId: string;
  name: string;
}): Promise<ReleaseKeyInfo | undefined> {
  validateKeyName(o.name);
  const ref = builtinKeyRef(o.orgId, o.name);
  const createdAt = o.vault.createdAt(`signing/${ref}`);
  if (createdAt === undefined) return undefined;
  const pub = await new LocalSigner(o.vault).publicKey(ref);
  return { ...pub, createdAt };
}
