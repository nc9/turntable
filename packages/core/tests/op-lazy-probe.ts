// Run by onepassword.test.ts in a fresh process: loads the vault and the 1Password backend (with
// the real SDK factory) and prints whether any @1password module was loaded.
import { randomBytes } from "node:crypto";
import { OnePasswordBackend } from "../src/secrets/backends/onepassword";
import { SecretVault } from "../src/secrets/vault";

// No database needed: constructing the vault must not load the SDK either.
new SecretVault({ db: {} as never, masterKey: randomBytes(32) });
new OnePasswordBackend({
  config: {
    cacheTtlMs: 1000,
    canary: undefined,
    accounts: [
      {
        name: "ci",
        token: "x".repeat(16),
        vaults: ["ci"],
        orgs: ["o"],
        projects: [],
        trustClasses: ["protected"],
        hourlyReadLimit: undefined,
      },
    ],
  },
});
const loaded = Object.keys(require.cache ?? {}).some((k) => k.includes("@1password"));
console.log(`sdk-loaded=${loaded}`);
