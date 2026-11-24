// A random HMAC key kept sealed in the secret store, created on first use. Creation is
// insert-if-absent, then the stored value is ALWAYS re-read and used, so two concurrent first uses
// (two requests, two processes over one database) end up with the same key: the loser's insert is
// a no-op and it reads the winner's value. Key material is never logged or returned to a caller
// outside this process.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "./store";

/** The stored key, creating it when absent. Always the value the store holds. */
export async function ensureKey(store: SecretStore, orgId: string, name: string): Promise<Buffer> {
  let k = await store.get(orgId, name);
  if (k === undefined) {
    await store.setIfAbsent(orgId, name, randomBytes(32).toString("base64url"));
    k = await store.get(orgId, name);
  }
  if (k === undefined) throw new Error(`the key ${name} could not be stored`);
  return Buffer.from(k, "base64url");
}

/**
 * A per-process cache of one named key per org. It holds only a value read back from the store.
 * Concurrent first uses in a process share one creation; a failed creation is not cached.
 */
export class KeyCache {
  readonly #store: SecretStore;
  readonly #name: string;
  readonly #m = new Map<string, Promise<Buffer>>();

  constructor(store: SecretStore, name: string) {
    this.#store = store;
    this.#name = name;
  }

  get(orgId: string): Promise<Buffer> {
    let p = this.#m.get(orgId);
    if (!p) {
      p = ensureKey(this.#store, orgId, this.#name);
      this.#m.set(orgId, p);
      p.catch(() => this.#m.delete(orgId));
    }
    return p;
  }

  /** Drops the cached value and reads the store again. */
  refresh(orgId: string): Promise<Buffer> {
    this.#m.delete(orgId);
    return this.get(orgId);
  }

  /**
   * True when `check` accepts the cached key or, failing that, the stored key when it differs (a
   * stale cache): the store is re-read once before refusing and the cache is refreshed.
   */
  async verify(orgId: string, check: (key: Buffer) => boolean): Promise<boolean> {
    const cached = await this.get(orgId);
    if (check(cached)) return true;
    const fresh = await this.refresh(orgId);
    if (fresh.length === cached.length && timingSafeEqual(fresh, cached)) return false;
    return check(fresh);
  }
}
