import type { KeyVault } from "@turntable/signer";
import type { SecretStore } from "../secrets/store";

/** The built-in signer's keys, sealed in the org's secret store (the system domain). */
export function secretStoreVault(store: SecretStore, orgId: string): KeyVault {
  return {
    get: (name) => store.get(orgId, name),
    set: (name, value) => store.set(orgId, name, value),
  };
}
