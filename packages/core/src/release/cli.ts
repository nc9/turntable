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
import { parseTarget, TARGET_KEY } from "./publish/config";
import { fileKeyVault } from "./key-vault";
import { keysDir } from "./serve";

export async function releaseCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "pin-repo") return pinRepo(rest);
  if (sub === "publish-target") return publishTarget(rest);
  if (sub !== "init-key") {
    console.error(
      "usage:\n  longshore release init-key --org <slug> --name <key> [--data-dir ./data]\n  longshore release pin-repo --org <slug> --project <slug> --repo <owner/name> [--data-dir ./data]\n  longshore release publish-target set|remove|list --org <slug> --project <slug> [--key <name>] [...] (see docs/release-lane)\nRuns with the release role's environment (LONGSHORE_RELEASE_*).",
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

const PUBLISH_USAGE = `usage:
  longshore release publish-target set --org <slug> --project <slug> --key <name> --kind npm \
      --package <name> --artifact <tarball artifact> --secret <vault secret> [--tag latest] \
      [--access public|restricted] --accept-long-lived-token
  longshore release publish-target set --org <slug> --project <slug> --key <name> --kind github-release \
      --assets <a,b,...> [--provenance-asset <name>|none]
  longshore release publish-target set --org <slug> --project <slug> --key <name> --kind oci-image \
      --registry ghcr.io --repository <owner/name> --manifest <manifest artifact> --tags v1,latest \
      --username <registry user> --secret <vault secret> [--realm-host <token host>]
  (npm and github-release also take --mode strict|compat; an image is always compat)
  longshore release publish-target remove --org <slug> --project <slug> --key <name>
  longshore release publish-target list --org <slug> --project <slug>
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
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
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
      if (!values.key || !TARGET_KEY.test(values.key)) {
        throw new Error("--key must be a short lower-case name (letters, digits, dashes)");
      }
      if (action === "remove") {
        const gone = attest.removePublishTarget(org.id, project.id, values.key);
        console.log(gone ? `removed ${values.key}` : `no target ${values.key}`);
        return gone ? 0 : 1;
      }
      const mode = values.mode ? { mode: values.mode } : {};
      const raw =
        values.kind === "npm"
          ? {
              kind: "npm",
              ...mode,
              package: values.package,
              artifact: values.artifact,
              secret: values.secret,
              ...(values.tag ? { tag: values.tag } : {}),
              ...(values.access ? { access: values.access } : {}),
            }
          : values.kind === "github-release"
            ? {
                kind: "github-release",
                ...mode,
                assets: (values.assets ?? "")
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
                ...(values["provenance-asset"] !== undefined
                  ? {
                      provenanceAsset:
                        values["provenance-asset"] === "none" ? null : values["provenance-asset"],
                    }
                  : {}),
              }
            : values.kind === "oci-image"
              ? {
                  kind: "oci-image",
                  mode: values.mode ?? "compat",
                  registry: values.registry,
                  repository: values.repository,
                  manifest: values.manifest,
                  tags: (values.tags ?? "")
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                  username: values.username,
                  ...(values["realm-host"] !== undefined
                    ? { realmHost: values["realm-host"] }
                    : {}),
                  secret: values.secret,
                }
              : undefined;
      if (!raw) throw new Error("--kind must be npm, github-release or oci-image");
      if (raw.kind === "npm" && !values["accept-long-lived-token"]) {
        throw new Error(
          "publishing to npm uses a long-lived registry token (a granular, package-scoped, publish-only one); pass --accept-long-lived-token to say you accept that",
        );
      }
      const target = parseTarget(raw);
      attest.setPublishTarget(org.id, project.id, values.key, target, Date.now());
      console.log(`${values.org}/${values.project}: ${values.key} = ${JSON.stringify(target)}`);
      return 0;
    } finally {
      attest.close();
    }
  } finally {
    db.close();
  }
}
