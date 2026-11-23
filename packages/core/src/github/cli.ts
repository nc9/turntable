import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  ensureInstance,
  ensureLocalTenant,
  getOrgBySlug,
  listInstallations,
  openDatabase,
} from "../db";
import { AuditAnchor } from "../audit/anchor";
import { getGithubApp } from "../db/repos";
import { initMasterKey, loadMasterKey } from "../secrets/crypto";
import {
  auditStateDir,
  MASTER_KEY_ENV,
  MASTER_KEY_FILE_ENV,
  PREVIOUS_KEY_ENV,
  PREVIOUS_KEY_FILE_ENV,
  masterKeyForCommand,
  masterKeysForCommand,
  type MasterKeys,
} from "../secrets/master-key";
import { SecretStore } from "../secrets/store";
import { SecretVault } from "../secrets/vault";
import { AppAuth } from "./app-auth";
import { startManifestFlow } from "./manifest";
import { rotateWebhookSecret } from "./rotation";

const dbPath = (dataDir: string): string => join(resolve(dataDir), "turntable.db");

function keyFile(explicit: string | undefined, dataDir?: string): string {
  const f =
    explicit ??
    process.env.TURNTABLE_MASTER_KEY_FILE ??
    (dataDir ? join(resolve(dataDir), "master.key") : undefined);
  if (!f) throw new Error("set TURNTABLE_MASTER_KEY_FILE or pass --master-key-file");
  return f;
}

/**
 * The keys for `keys reseal`: the server's rules (one of the variable, the file variable or
 * `--file`; the variables are read once and deleted). With none given it falls back to the data
 * directory's `master.key`, as before.
 */
function resealKeys(flagFile: string | undefined, dataDir: string): MasterKeys {
  const given =
    flagFile ||
    process.env[MASTER_KEY_ENV]?.trim() ||
    process.env[MASTER_KEY_FILE_ENV]?.trim() ||
    process.env[PREVIOUS_KEY_ENV]?.trim() ||
    process.env[PREVIOUS_KEY_FILE_ENV]?.trim();
  return masterKeysForCommand(given ? flagFile : keyFile(undefined, dataDir));
}

/** `turntable keys init [--file <path>] [--data-dir ./data]` */
export async function keysCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "init" && sub !== "reseal") {
    throw new Error(
      "usage: turntable keys init [--file <path>] [--data-dir ./data]\n       turntable keys reseal --org <slug> [--file <path>] [--data-dir ./data]",
    );
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      file: { type: "string" },
      org: { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (sub === "reseal")
    return resealOrg(values.org, resealKeys(values.file, values["data-dir"]), values["data-dir"]);
  const path = resolve(keyFile(values.file, values["data-dir"]));
  initMasterKey(path);
  console.error(
    `created master key file ${path} (mode 0600). Point TURNTABLE_MASTER_KEY_FILE at it. Back it up: without it stored secrets cannot be decrypted. It is never printed.`,
  );
}

/**
 * `turntable keys reseal --org <slug>`: re-seals everything an org has sealed (secret store,
 * OIDC keys, vault secrets, the audit anchor state) under the org's own key-encryption key. The
 * values do not change. Run it once per org after upgrading, then set TURNTABLE_REQUIRE_ORG_KEYS=1.
 */
async function resealOrg(
  slug: string | undefined,
  keys: MasterKeys,
  dataDir: string,
): Promise<void> {
  if (!slug) throw new Error("--org <slug> is required");
  const master = keys.key;
  if (keys.previous) {
    console.error(
      "a previous master key is set: it is not used here. Rotation happens when the server boots with it; reseal only moves records under the org's own key.",
    );
  }
  const db = openDatabase(dbPath(dataDir));
  try {
    const org = await getOrgBySlug(db, slug);
    if (!org) throw new Error(`no org with slug ${slug}`);
    const store = await new SecretStore(db, master).reseal(org.id);
    const vault = await new SecretVault({ db, masterKey: master }).reseal(org.id);
    const anchor = new AuditAnchor(auditStateDir(keys, resolve(dataDir)), master).reseal(org.id);
    console.error(
      `resealed org ${slug}: ${store} store records, ${vault} vault versions, anchor state ${anchor ? "yes" : "no change"}`,
    );
  } finally {
    db.close();
  }
}

/** `turntable github-app <create|rotate-webhook-secret|status> ...` */
export async function githubAppCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: "string" },
      org: { type: "string" },
      name: { type: "string", default: "Turntable CI" },
      "turntable-org": { type: "string" },
      "longshore-org": { type: "string" }, // rename-keep: the pre-rename flag still works
      port: { type: "string", default: "0" },
      "master-key-file": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (sub !== "create" && sub !== "rotate-webhook-secret" && sub !== "status") {
    throw new Error("usage: turntable github-app <create|rotate-webhook-secret|status> [flags]");
  }
  const db = openDatabase(dbPath(values["data-dir"]));
  try {
    await ensureInstance(db);
    const masterKey = process.env.TURNTABLE_MASTER_KEY?.trim()
      ? masterKeyForCommand(values["master-key-file"])
      : loadMasterKey(keyFile(values["master-key-file"]));
    const store = new SecretStore(db, masterKey);

    if (sub === "status") {
      const app = await getGithubApp(db);
      if (!app) {
        console.log("no GitHub App is configured");
        return;
      }
      console.log(`app ${app.slug} (id ${app.appId}) owned by ${app.ownerLogin}, ${app.htmlUrl}`);
      for (const i of await listInstallations(db, { orgId: app.orgId })) {
        console.log(
          `installation ${i.installationId} ${i.accountLogin} (${i.accountType}) ${i.status}`,
        );
      }
      return;
    }

    if (sub === "rotate-webhook-secret") {
      const r = await rotateWebhookSecret(db, store, new AppAuth({ db, store }));
      console.error(
        `webhook secret rotated; the previous one also verifies until ${new Date(r.overlapUntil).toISOString()}`,
      );
      return;
    }

    if (!values.url) throw new Error("--url <public base url> is required");
    const url = new URL(values.url);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new Error("--url must be http(s)");
    const slug = values["turntable-org"] ?? values["longshore-org"] ?? "local"; // rename-keep
    if (slug === "local" && !(await getOrgBySlug(db, "local"))) await ensureLocalTenant(db);
    const org = await getOrgBySlug(db, slug);
    if (!org) throw new Error(`no org with slug ${slug}`);
    const port = Number(values.port);
    const flow = startManifestFlow({
      db,
      store,
      orgId: org.id,
      name: values.name,
      url: values.url,
      ...(values.org ? { ghOrg: values.org } : {}),
      port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 0,
    });
    console.error(`Open ${flow.pageUrl} in a browser and approve the App on GitHub. Waiting...`);
    const timer = setTimeout(() => flow.stop(), 15 * 60_000);
    try {
      const app = await Promise.race([
        flow.done,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("timed out waiting for GitHub")), 15 * 60_000),
        ),
      ]);
      console.error(
        `created GitHub App ${app.slug} (id ${app.appId}); its credentials are in the encrypted store and were not printed.\nInstall it on your repositories: ${app.htmlUrl}/installations/new`,
      );
    } finally {
      clearTimeout(timer);
      flow.stop();
    }
  } finally {
    db.close();
  }
}
