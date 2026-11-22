// `longshore release init-key --name <key>`: creates the release lane's built-in signing key,
// sealed under the release master key in the lane's own data directory, and prints the public key
// (to pin outside the server, and to verify releases with `longshore verify`).
import { parseArgs } from "node:util";
import { LocalSigner } from "@longshore/signer";
import { loadMasterKey } from "../secrets/crypto";
import { releaseConfigFromEnv } from "../roles";
import { fileKeyVault } from "./key-vault";
import { keysDir } from "./serve";

export async function releaseCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "init-key") {
    console.error(
      "usage: longshore release init-key --name <key>\nRuns with the release role's environment (LONGSHORE_RELEASE_*).",
    );
    return 2;
  }
  const { values } = parseArgs({ args: rest, options: { name: { type: "string" } }, strict: true });
  if (!values.name) throw new Error("--name <key> is required");
  const cfg = releaseConfigFromEnv(process.env);
  const signer = new LocalSigner(
    fileKeyVault(keysDir(cfg.dataDir), loadMasterKey(cfg.masterKeyFile)),
  );
  const pub = await signer.ensureKey(values.name);
  console.error(
    `key ${values.name}: keyid ${pub.keyid}. Pin this public key; it is not stored anywhere else you control.`,
  );
  console.log(pub.publicKeyPem.trim());
  return 0;
}
