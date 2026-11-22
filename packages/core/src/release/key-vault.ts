// The built-in signer's keys for the release lane: one sealed file per key, in the lane's own
// data directory, sealed with the release master key. The main process has neither the directory
// nor the key.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyVault } from "@longshore/signer";
import { open, seal } from "../secrets/crypto";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function fileKeyVault(dir: string, masterKey: Buffer): KeyVault {
  const file = (name: string): string => {
    if (!NAME.test(name) || name.includes("..")) throw new Error("invalid key name");
    return join(dir, `${name.replaceAll("/", "__")}.sealed`);
  };
  const aad = (name: string): Buffer => Buffer.from(`longshore:release-key:${name}`, "utf8");
  return {
    async get(name) {
      const f = file(name);
      return existsSync(f)
        ? open(masterKey, readFileSync(f, "utf8"), aad(name), "system")
        : undefined;
    },
    async set(name, value) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const f = file(name);
      if (existsSync(f)) throw new Error(`refusing to overwrite the signing key ${name}`);
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, seal(masterKey, value, aad(name), "system"), { mode: 0o600 });
      renameSync(tmp, f);
    },
  };
}
