// `longshore release init-key --name <key>`: creates the release lane's built-in signing key,
// sealed under the release master key in the lane's own data directory, and prints the public key
// (to pin outside the server, and to verify releases with `longshore verify`).
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LocalSigner } from "@longshore/signer";
import { getOrgBySlug, getProjectBySlug, openDatabase } from "../db";
import { loadMasterKey } from "../secrets/crypto";
import { releaseConfigFromEnv } from "../roles";
import { builtinKeyRef } from "../signing/service";
import { AttestationStore } from "./attest";
import { fileKeyVault } from "./key-vault";
import { keysDir } from "./serve";

export async function releaseCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "pin-repo") return pinRepo(rest);
  if (sub !== "init-key") {
    console.error(
      "usage:\n  longshore release init-key --org <slug> --name <key> [--data-dir ./data]\n  longshore release pin-repo --org <slug> --project <slug> --repo <owner/name> [--data-dir ./data]\nRuns with the release role's environment (LONGSHORE_RELEASE_*).",
    );
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      name: { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (!values.name || !values.org) throw new Error("--org <slug> and --name <key> are required");
  // The key is stored under the org's id: another org's project naming the same `builtin:<name>`
  // reaches its own key, never this one.
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  const org = await getOrgBySlug(db, values.org);
  db.close();
  if (!org) throw new Error(`no org with slug ${values.org}`);
  const cfg = releaseConfigFromEnv(process.env);
  const signer = new LocalSigner(
    fileKeyVault(keysDir(cfg.dataDir), loadMasterKey(cfg.masterKeyFile)),
  );
  const pub = await signer.ensureKey(builtinKeyRef(org.id, values.name));
  console.error(
    `key ${values.org}/${values.name}: keyid ${pub.keyid}. Pin this public key; it is not stored anywhere else you control.`,
  );
  console.log(pub.publicKeyPem.trim());
  return 0;
}

/**
 * Sets which repository a project releases from, in the lane's own file. The release lane asks
 * the forge about this repository only, and refuses a run whose row names another.
 */
async function pinRepo(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: "string" },
      project: { type: "string" },
      repo: { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (!values.org || !values.project || !values.repo) {
    throw new Error("--org, --project and --repo are required");
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name");
  const cfg = releaseConfigFromEnv(process.env);
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  try {
    const org = await getOrgBySlug(db, values.org);
    if (!org) throw new Error(`no org with slug ${values.org}`);
    const project = await getProjectBySlug(db, { orgId: org.id }, values.project);
    if (!project) throw new Error(`no project ${values.project} in org ${values.org}`);
    const attest = new AttestationStore(join(resolve(cfg.dataDir), "attested.db"));
    try {
      attest.pinRepo(org.id, project.id, values.repo, Date.now());
    } finally {
      attest.close();
    }
    console.log(`${values.org}/${values.project} releases from ${values.repo.toLowerCase()}`);
    return 0;
  } finally {
    db.close();
  }
}
