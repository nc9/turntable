import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, getOrgById, getOrgBySlug, openDatabase, type Db } from "../db";
import { orgsWithAudit } from "../db/repos";
import { loadMasterKey } from "../secrets/crypto";
import { SecretStore } from "../secrets/store";
import {
  AUDIT_KEY_SECRET,
  createCheckpoint,
  ensureAuditKey,
  keyFromPrivatePem,
} from "./checkpoint";
import { exportOrg, jsonlSink, webhookSink, type AuditSink } from "./export";
import { verifyAudit } from "./verify";
import { createPublicKey, createHash } from "node:crypto";

const USAGE = `usage:
  longshore audit verify [--org <slug>] [--public-key <file>] [--data-dir ./data]
  longshore audit checkpoint [--org <slug>]
  longshore audit export [--org <slug>] (--dir <path> | --webhook <url> [--webhook-secret-file <path>])
  longshore audit public-key --org <slug>
Signing and key lookups need LONGSHORE_MASTER_KEY_FILE (or --master-key-file). verify does not,
when you pass --public-key (a key you saved earlier, kept outside the server).`;

/** Returns the process exit code. */
export async function auditCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!["verify", "checkpoint", "export", "public-key"].includes(sub ?? "")) {
    console.error(USAGE);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      "public-key": { type: "string" },
      "master-key-file": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
      dir: { type: "string" },
      webhook: { type: "string" },
      "webhook-secret-file": { type: "string" },
    },
    strict: true,
  });
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  try {
    await ensureInstance(db);
    const keyFile = values["master-key-file"] ?? process.env.LONGSHORE_MASTER_KEY_FILE;
    const store = keyFile ? new SecretStore(db, loadMasterKey(keyFile)) : undefined;
    const orgs = await resolveOrgs(db, values.org);

    if (sub === "public-key") {
      if (!store) throw new Error("set LONGSHORE_MASTER_KEY_FILE or pass --master-key-file");
      const org = orgs[0];
      if (!org || !values.org) throw new Error("--org <slug> is required");
      console.log((await ensureAuditKey(store, org.id)).publicKeyPem.trim());
      return 0;
    }

    if (sub === "checkpoint") {
      if (!store) throw new Error("set LONGSHORE_MASTER_KEY_FILE or pass --master-key-file");
      for (const o of orgs) {
        const cp = await createCheckpoint(db, store, o.id);
        console.log(
          cp ? `${o.slug}: signed checkpoint at entry ${cp.seq}` : `${o.slug}: already covered`,
        );
      }
      return 0;
    }

    if (sub === "export") {
      const sinks: AuditSink[] = [];
      if (values.dir) sinks.push(jsonlSink(resolve(values.dir)));
      if (values.webhook) {
        const secret = values["webhook-secret-file"]
          ? readFileSync(values["webhook-secret-file"], "utf8").trim()
          : undefined;
        sinks.push(webhookSink(values.webhook, secret ? { secret } : {}));
      }
      if (sinks.length === 0) throw new Error("give --dir or --webhook");
      for (const o of orgs) {
        for (const sink of sinks) {
          const n = await exportOrg(db, sink, o);
          console.log(`${o.slug}: exported ${n} entries to ${sink.name}`);
        }
      }
      return 0;
    }

    // verify
    const keys = new Map<string, string>();
    if (values["public-key"]) {
      const pem = readFileSync(values["public-key"], "utf8");
      keys.set(keyIdOfPublic(pem), pem);
    }
    let failed = false;
    for (const o of orgs) {
      const perOrg = new Map(keys);
      if (store) {
        const priv = await store.get(o.id, AUDIT_KEY_SECRET);
        if (priv) {
          const k = keyFromPrivatePem(priv);
          perOrg.set(k.keyId, k.publicKeyPem);
        }
      }
      const r = await verifyAudit(db, o.id, perOrg);
      console.log(
        `${o.slug}: ${r.ok ? "ok" : "FAILED"}: ${r.entries} entries, ${r.checkpoints} checkpoints, head ${r.headSeq}, last checkpoint ${r.lastCheckpointSeq}${r.unsignedTail > 0 ? `, ${r.unsignedTail} entries after it not yet signed` : ""}`,
      );
      for (const p of r.problems) console.log(`  - ${p}`);
      if (!r.ok) failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}

const keyIdOfPublic = (pem: string): string =>
  createHash("sha256")
    .update(createPublicKey(pem).export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16);

async function resolveOrgs(
  db: Db,
  slug: string | undefined,
): Promise<{ id: string; slug: string }[]> {
  if (slug) {
    const o = await getOrgBySlug(db, slug);
    if (!o) throw new Error(`no org with slug ${slug}`);
    return [{ id: o.id, slug: o.slug }];
  }
  const out: { id: string; slug: string }[] = [];
  for (const id of await orgsWithAudit(db)) {
    const o = await getOrgById(db, id);
    if (o) out.push({ id: o.id, slug: o.slug });
  }
  return out;
}
