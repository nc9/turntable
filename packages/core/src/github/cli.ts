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
import { SecretStore } from "../secrets/store";
import { SecretVault } from "../secrets/vault";
import { AppAuth } from "./app-auth";
import { startManifestFlow } from "./manifest";
import { rotateWebhookSecret } from "./rotation";

const dbPath = (dataDir: string): string => join(resolve(dataDir), "longshore.db");

function keyFile(explicit: string | undefined, dataDir?: string): string {
  const f =
    explicit ??
    process.env.LONGSHORE_MASTER_KEY_FILE ??
    (dataDir ? join(resolve(dataDir), "master.key") : undefined);
  if (!f) throw new Error("set LONGSHORE_MASTER_KEY_FILE or pass --master-key-file");
  return f;
}

/** `longshore keys init [--file <path>] [--data-dir ./data]` */
export async function keysCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "init" && sub !== "reseal") {
    throw new Error(
      "usage: longshore keys init [--file <path>] [--data-dir ./data]\n       longshore keys reseal --org <slug> [--file <path>] [--data-dir ./data]",
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
    return resealOrg(values.org, keyFile(values.file, values["data-dir"]), values["data-dir"]);
  const path = resolve(keyFile(values.file, values["data-dir"]));
  initMasterKey(path);
  console.error(
    `created master key file ${path} (mode 0600). Point LONGSHORE_MASTER_KEY_FILE at it. Back it up: without it stored secrets cannot be decrypted. It is never printed.`,
  );
}

/**
 * `longshore keys reseal --org <slug>`: re-seals everything an org has sealed (secret store,
 * OIDC keys, vault secrets, the audit anchor state) under the org's own key-encryption key. The
 * values do not change. Run it once per org after upgrading, then set LONGSHORE_REQUIRE_ORG_KEYS=1.
 */
async function resealOrg(
  slug: string | undefined,
  keyPath: string,
  dataDir: string,
): Promise<void> {
  if (!slug) throw new Error("--org <slug> is required");
  const master = loadMasterKey(resolve(keyPath));
  const db = openDatabase(dbPath(dataDir));
  try {
    const org = await getOrgBySlug(db, slug);
    if (!org) throw new Error(`no org with slug ${slug}`);
    const store = await new SecretStore(db, master).reseal(org.id);
    const vault = await new SecretVault({ db, masterKey: master }).reseal(org.id);
    const anchor = new AuditAnchor(AuditAnchor.dirFor(resolve(keyPath)), master).reseal(org.id);
    console.error(
      `resealed org ${slug}: ${store} store records, ${vault} vault versions, anchor state ${anchor ? "yes" : "no change"}`,
    );
  } finally {
    db.close();
  }
}

/** `longshore github-app <create|rotate-webhook-secret|status> ...` */
export async function githubAppCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: "string" },
      org: { type: "string" },
      name: { type: "string", default: "Longshore" },
      "longshore-org": { type: "string", default: "local" },
      port: { type: "string", default: "0" },
      "master-key-file": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (sub !== "create" && sub !== "rotate-webhook-secret" && sub !== "status") {
    throw new Error("usage: longshore github-app <create|rotate-webhook-secret|status> [flags]");
  }
  const db = openDatabase(dbPath(values["data-dir"]));
  try {
    await ensureInstance(db);
    const store = new SecretStore(db, loadMasterKey(keyFile(values["master-key-file"])));

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
    const slug = values["longshore-org"];
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
