// `turntable release init-key --name <key>`: creates the release lane's built-in signing key,
// sealed under the release master key in the lane's own data directory, and prints the public key
// (to pin outside the server, and to verify releases with `turntable verify`).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getOrgBySlug, getProjectBySlug, openDatabase } from "../db";
import { releaseConfigFromEnv, releaseMasterKey } from "../roles";
import { AttestationStore } from "./attest";
import { LaneConfig, validateRepo, validateTargetKey } from "./config";
import { initReleaseKey } from "./init-key";
import { fileKeyVault } from "./key-vault";
import { keysDir } from "./serve";

export async function releaseCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "pin-repo") return pinRepo(rest);
  if (sub === "publish-target") return publishTarget(rest);
  if (sub === "cosign-key") return cosignKey(rest);
  if (sub !== "init-key") {
    console.error(
      "usage:\n  turntable release init-key --org <slug> --name <key> [--data-dir ./data]\n  turntable release pin-repo --org <slug> --project <slug> --repo <owner/name> [--data-dir ./data]\n  turntable release cosign-key set|remove|list --org <slug> --project <slug> [--name <key>] [...] (see docs/release-lane)\n  turntable release publish-target set|remove|list --org <slug> --project <slug> [--key <name>] [...] (see docs/release-lane)\nRuns with the release role's environment (TURNTABLE_RELEASE_*).",
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
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  const org = await getOrgBySlug(db, values.org);
  db.close();
  if (!org) throw new Error(`no org with slug ${values.org}`);
  const cfg = releaseConfigFromEnv(process.env);
  // The CLI stays idempotent (a second run prints the existing public key); the op refuses.
  const pub = await initReleaseKey({
    vault: fileKeyVault(keysDir(cfg.dataDir), releaseMasterKey(cfg)),
    orgId: org.id,
    name: values.name,
    refuseExisting: false,
  });
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
  validateRepo(values.repo);
  const cfg = releaseConfigFromEnv(process.env);
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    const org = await getOrgBySlug(db, values.org);
    if (!org) throw new Error(`no org with slug ${values.org}`);
    const project = await getProjectBySlug(db, { orgId: org.id }, values.project);
    if (!project) throw new Error(`no project ${values.project} in org ${values.org}`);
    const attest = new AttestationStore(join(resolve(cfg.dataDir), "attested.db"));
    try {
      const pinned = new LaneConfig({ attest }).pinRepo(org.id, project.id, values.repo);
      console.log(`${values.org}/${values.project} releases from ${pinned}`);
    } finally {
      attest.close();
    }
    return 0;
  } finally {
    db.close();
  }
}

const PUBLISH_USAGE = `usage:
  turntable release publish-target set --org <slug> --project <slug> --key <name> --kind npm \
      --package <name> --artifact <tarball artifact> --secret <vault secret> [--tag latest] \
      [--access public|restricted] --accept-long-lived-token
  turntable release publish-target set --org <slug> --project <slug> --key <name> --kind github-release \
      [--assets <a,b,...>] [--asset-artifacts <a,b,...>] [--provenance-asset <name>|none]
  turntable release publish-target set --org <slug> --project <slug> --key <name> --kind oci-image \
      --registry ghcr.io --repository <owner/name> --manifest <manifest artifact> --tags v1,latest \
      --username <registry user> --secret <vault secret> [--realm-host <token host>]
  (npm and github-release also take --mode strict|compat; an image is always compat)
  turntable release publish-target remove --org <slug> --project <slug> --key <name>
  turntable release publish-target list --org <slug> --project <slug>
Targets are stored in the release lane's own file, never in the workflow. An npm target uses a
long-lived registry token (npm has no tokenless path for a self-hosted issuer), so it needs
--accept-long-lived-token.`;

/** Sets, removes or lists the project's publish declaration in the lane's own file. */
async function publishTarget(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      project: { type: "string" },
      key: { type: "string" },
      kind: { type: "string" },
      package: { type: "string" },
      artifact: { type: "string" },
      secret: { type: "string" },
      tag: { type: "string" },
      access: { type: "string" },
      assets: { type: "string" },
      "asset-artifacts": { type: "string" },
      "provenance-asset": { type: "string" },
      "accept-long-lived-token": { type: "boolean" },
      mode: { type: "string" },
      registry: { type: "string" },
      repository: { type: "string" },
      manifest: { type: "string" },
      tags: { type: "string" },
      username: { type: "string" },
      "realm-host": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (!["set", "remove", "list"].includes(action ?? "") || !values.org || !values.project) {
    console.error(PUBLISH_USAGE);
    return 2;
  }
  const cfg = releaseConfigFromEnv(process.env);
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    const org = await getOrgBySlug(db, values.org);
    if (!org) throw new Error(`no org with slug ${values.org}`);
    const project = await getProjectBySlug(db, { orgId: org.id }, values.project);
    if (!project) throw new Error(`no project ${values.project} in org ${values.org}`);
    const attest = new AttestationStore(join(resolve(cfg.dataDir), "attested.db"));
    try {
      if (action === "list") {
        for (const [k, t] of Object.entries(attest.publishTargets(org.id, project.id))) {
          console.log(`${k}: ${JSON.stringify(t)}`);
        }
        return 0;
      }
      const config = new LaneConfig({ attest });
      const key = validateTargetKey(values.key);
      if (action === "remove") {
        const gone = config.removeTarget(org.id, project.id, key);
        console.log(gone ? `removed ${key}` : `no target ${key}`);
        return gone ? 0 : 1;
      }
      const list = (v: string | undefined): string[] =>
        (v ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      const target = config.setTarget(org.id, project.id, key, {
        kind: values.kind,
        mode: values.mode,
        package: values.package,
        artifact: values.artifact,
        secret: values.secret,
        tag: values.tag,
        access: values.access,
        assets: list(values.assets),
        asset_artifacts: list(values["asset-artifacts"]),
        provenance_asset: values["provenance-asset"],
        accept_long_lived_token: values["accept-long-lived-token"],
        registry: values.registry,
        repository: values.repository,
        manifest: values.manifest,
        tags: list(values.tags),
        username: values.username,
        realm_host: values["realm-host"],
      });
      console.log(`${values.org}/${values.project}: ${key} = ${JSON.stringify(target)}`);
      return 0;
    } finally {
      attest.close();
    }
  } finally {
    db.close();
  }
}

const COSIGN_USAGE = `usage:
  turntable release cosign-key set --org <slug> --project <slug> --name <key> --public-key-file <pem> \
      --signs <file> --output-name <asset name> [--format detached-der-p256-sha256] \
      [--manifest-binaries]
  turntable release cosign-key remove --org <slug> --project <slug> --name <key>
  turntable release cosign-key list --org <slug> --project <slug>
A thin client of the release_cosign_key_* operations (the same LaneConfig code the web app's
Release lane page calls). Public keys only, stored in the release lane's own file. A configured key means every release of
the project needs a valid co-signature from it, verified by the lane.`;

/** Sets, removes or lists the project's co-signing keys (public material) in the lane's own file. */
async function cosignKey(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      project: { type: "string" },
      name: { type: "string" },
      "public-key-file": { type: "string" },
      signs: { type: "string" },
      "output-name": { type: "string" },
      format: { type: "string" },
      "manifest-binaries": { type: "boolean" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (!["set", "remove", "list"].includes(action ?? "") || !values.org || !values.project) {
    console.error(COSIGN_USAGE);
    return 2;
  }
  const cfg = releaseConfigFromEnv(process.env);
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    const org = await getOrgBySlug(db, values.org);
    if (!org) throw new Error(`no org with slug ${values.org}`);
    const project = await getProjectBySlug(db, { orgId: org.id }, values.project);
    if (!project) throw new Error(`no project ${values.project} in org ${values.org}`);
    const attest = new AttestationStore(join(resolve(cfg.dataDir), "attested.db"));
    try {
      const config = new LaneConfig({ attest });
      if (action === "list") {
        for (const k of config.listCosignKeys(org.id, project.id)) {
          // The fingerprint, never the key.
          console.log(
            `${k.name}: key_id ${k.key_id} signs ${k.signs} -> ${k.output_name} (${k.format}${k.manifest ? ", manifest of binaries" : ""})`,
          );
        }
        return 0;
      }
      if (!values.name) throw new Error("--name is required");
      if (action === "remove") {
        const gone = config.removeCosignKey(org.id, project.id, values.name);
        console.log(gone ? `removed ${values.name}` : `no co-signing key ${values.name}`);
        return gone ? 0 : 1;
      }
      if (!values["public-key-file"]) throw new Error("--public-key-file is required");
      const key = config.setCosignKey(org.id, project.id, {
        name: values.name,
        public_key_pem: readFileSync(values["public-key-file"], "utf8"),
        signs: values.signs,
        output_name: values["output-name"],
        format: values.format ?? "detached-der-p256-sha256",
        ...(values["manifest-binaries"] ? { manifest: { shape: "binaries-map" } } : {}),
      });
      console.log(
        `${values.org}/${values.project}: ${key.name} key_id ${key.key_id} signs ${key.signs} -> ${key.output_name}`,
      );
      return 0;
    } finally {
      attest.close();
    }
  } finally {
    db.close();
  }
}
