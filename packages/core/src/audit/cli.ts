import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, getOrgById, getOrgBySlug, openDatabase, type Db } from "../db";
import { orgsWithAudit } from "../db/repos";
import { loadMasterKey } from "../secrets/crypto";
import { SecretStore } from "../secrets/store";
import {
  createCheckpoint,
  ensureAuditKey,
  loadAuditKey,
  parsePublicKeyFile,
  publicKeyFile,
} from "./checkpoint";
import { exportOrg, jsonlSink, webhookSink, type AuditSink } from "./export";
import { verifyAudit, type AnchorCheckpoint } from "./verify";

const USAGE = `usage:
  longshore audit verify [--org <slug>] [--pubkey <file>]... [--anchor <file>]... [--data-dir ./data]
  longshore audit checkpoint [--org <slug>]
  longshore audit export-key --org <slug> --out <file>
  longshore audit export [--org <slug>] (--dir <path> | --webhook <url> [--webhook-secret-file <path>])
checkpoint and export-key need LONGSHORE_MASTER_KEY_FILE (or --master-key-file).
Keep the export-key file and the exported checkpoints OFF this server. verify --pubkey rejects
checkpoints signed by any other key; verify --anchor (an export file or a saved checkpoint)
fails if the database lacks a checkpoint the anchor has. Without them, verify says
"unanchored: integrity only", which an attacker with database and secret store access can defeat.`;

/** Returns the process exit code. */
export async function auditCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!["verify", "checkpoint", "export", "export-key"].includes(sub ?? "")) {
    console.error(USAGE);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      pubkey: { type: "string", multiple: true },
      anchor: { type: "string", multiple: true },
      out: { type: "string" },
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

    if (sub === "export-key") {
      if (!store) throw new Error("set LONGSHORE_MASTER_KEY_FILE or pass --master-key-file");
      const org = orgs[0];
      if (!org || !values.org || !values.out)
        throw new Error("--org <slug> and --out <file> are required");
      const key = await ensureAuditKey(db, store, org.id);
      writeFileSync(
        values.out,
        `${JSON.stringify(publicKeyFile(org.id, org.slug, key), null, 2)}\n`,
        {
          mode: 0o644,
          flag: "wx",
        },
      );
      console.log(`${org.slug}: wrote key ${key.keyId} to ${values.out}; keep it off this server`);
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
    const pinned = (values.pubkey ?? []).map((f) => parsePublicKeyFile(readFileSync(f, "utf8")));
    const anchors = (values.anchor ?? []).flatMap((f) => readAnchorFile(f));
    let failed = false;
    for (const o of orgs) {
      const keys = new Map<string, string>();
      const mine = pinned.filter((k) => k.orgId === o.id);
      for (const k of mine) keys.set(k.keyId, k.publicKey);
      if (mine.length === 0 && store) {
        const k = await loadAuditKey(store, o.id);
        if (k) keys.set(k.keyId, k.publicKeyPem);
      }
      const r = await verifyAudit(db, o.id, keys, {
        keyPinned: mine.length > 0,
        anchors,
      });
      const how =
        !r.keyPinned && !r.anchored
          ? "unanchored: integrity only (pass --pubkey and --anchor from outside this server)"
          : [
              r.keyPinned ? "key pinned" : "key NOT pinned",
              r.anchored ? "checkpoints anchored" : "checkpoints NOT anchored",
            ].join(", ");
      console.log(
        `${o.slug}: ${r.ok ? "ok" : "FAILED"}: ${r.entries} entries, ${r.checkpoints} checkpoints, head ${r.headSeq}, last checkpoint ${r.lastCheckpointSeq}${r.unsignedTail > 0 ? `, ${r.unsignedTail} entries after it not yet signed` : ""}; ${how}`,
      );
      for (const p of r.problems) console.log(`  - ${p}`);
      if (!r.ok) failed = true;
    }
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}

/** Checkpoints from an export file (JSONL, entries ignored) or a saved single checkpoint. */
function readAnchorFile(path: string): AnchorCheckpoint[] {
  const out: AnchorCheckpoint[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    const o = JSON.parse(t) as Partial<AnchorCheckpoint> & { type?: string };
    const isCp = o.type === "checkpoint" || (o.type === undefined && o.signature !== undefined);
    if (isCp && o.orgId && typeof o.seq === "number" && o.hash && o.keyId && o.signature) {
      out.push(o as AnchorCheckpoint);
    }
  }
  return out;
}

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
