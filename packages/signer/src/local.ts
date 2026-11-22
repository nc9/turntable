// The built-in backend: an Ed25519 key sealed in the system secret domain. For self-hosters and
// tests. The private key lives only in the vault and, briefly, in this process's memory while it
// signs; no method returns it.
import crypto from "node:crypto";
import { publicKeyFromPem, publicKeyFromSpki } from "./keys";
import { type KeyVault, type PublicKey, type Signer, SignerError } from "./types";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const vaultName = (keyRef: string): string => {
  if (!NAME.test(keyRef)) throw new SignerError("a key name is 1 to 64 plain characters");
  return `signing/${keyRef}`;
};

export class LocalSigner implements Signer {
  readonly #vault: KeyVault;

  constructor(vault: KeyVault) {
    this.#vault = vault;
  }

  /** Creates the key if there is none. Returns its public half; the private half goes to the vault. */
  async ensureKey(keyRef: string): Promise<PublicKey> {
    const name = vaultName(keyRef);
    const existing = await this.#vault.get(name);
    if (existing === undefined) {
      const pair = crypto.generateKeyPairSync("ed25519");
      await this.#vault.set(
        name,
        pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      );
      return publicKeyFromSpki(pair.publicKey.export({ type: "spki", format: "der" }) as Buffer);
    }
    return this.publicKey(keyRef);
  }

  async #private(keyRef: string): Promise<crypto.KeyObject> {
    const pem = await this.#vault.get(vaultName(keyRef));
    if (pem === undefined) throw new SignerError(`no signing key ${keyRef}`);
    return crypto.createPrivateKey(pem);
  }

  async publicKey(keyRef: string): Promise<PublicKey> {
    const pub = crypto.createPublicKey(await this.#private(keyRef));
    return publicKeyFromPem(pub.export({ type: "spki", format: "pem" }) as string);
  }

  async sign(message: Uint8Array, keyRef: string): Promise<Uint8Array> {
    return new Uint8Array(crypto.sign(null, Buffer.from(message), await this.#private(keyRef)));
  }
}
