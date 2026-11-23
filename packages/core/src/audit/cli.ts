import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, getOrgById, getOrgBySlug, openDatabase, type Db } from "../db";
import { orgsWithAudit } from "../db/repos";
import { auditStateDir, masterKeyForCommand } from "../secrets/master-key";
import { SecretStore } from "../secrets/store";
import { AuditAnchor } from "./anchor";
import {
  AuditAlreadyInitialised,
  AuditRefusal,
  auditedOrgIds,
  adoptAuditKey,
  createCheckpoint,
  initAuditKey,
  loadAuditKey,
  parsePublicKeyFile,
  publicKeyFile,
} from "./checkpoint";
import { exportOrg, jsonlSink, webhookSink, type AuditSink } from "./export";
import { verifyAudit, type AnchorCheckpoint } from "./verify";

const USAGE = `usage:
  turntable audit verify [--org <slug>] [--pubkey <file>]... [--anchors <file>]... [--data-dir ./data]
  turntable audit init-key --org <slug> --out <file>
  turntable audit adopt --org <slug>
  turntable audit checkpoint [--org <slug>]
  turntable audit export-key --org <slug> --out <file>
  turntable audit export [--org <slug>] (--dir <path> | --webhook <url> [--webhook-secret-file <path>])
init-key is the only thing that ever creates an org's signing key (the checkpointer never does),
and writes the public key file to keep off this server. adopt is for an org that signed
checkpoints before the sealed anchor existed: it trusts the chain as it is, once, after it verifies.
init-key, adopt, checkpoint and export-key need TURNTABLE_MASTER_KEY_FILE or TURNTABLE_MASTER_KEY (or --master-key-file).
Keep the export-key file and the exported checkpoints OFF this server. verify --pubkey rejects
checkpoints signed by any other key; verify --anchors (an export file, the bodies the anchor sink received, or a saved checkpoint)
fails if the database lacks a checkpoint the anchor has. Without them, verify says
"unanchored: integrity only", which an attacker with database and secret store access can defeat.`;

/** Returns the process exit code. */
export async function auditCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!["verify", "checkpoint", "export", "export-key", "init-key", "adopt"].includes(sub ?? "")) {
    console.error(USAGE);
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      pubkey: { type: "string", multiple: true },
      anchor: { type: "string", multiple: true },
      anchors: { type: "string", multiple: true },
      out: { type: "string" },
      "master-key-file": { type: "string" },
      "data-dir": { type: "string", default: "./data" },
      dir: { type: "string" },
      webhook: { type: "string" },
      "webhook-secret-file": { type: "string" },
    },
    strict: true,
  });
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    await ensureInstance(db);
    const keyFile = values["master-key-file"] ?? process.env.TURNTABLE_MASTER_KEY_FILE;
    const haveKey = Boolean(keyFile || process.env.TURNTABLE_MASTER_KEY?.trim());
    const masterKey = haveKey ? masterKeyForCommand(values["master-key-file"]) : undefined;
    const store = masterKey ? new SecretStore(db, masterKey) : undefined;
    const anchor = masterKey
      ? new AuditAnchor(
          auditStateDir(keyFile ? { file: keyFile } : undefined, resolve(values["data-dir"])),
          masterKey,
        )
      : undefined;
    const orgs = await resolveOrgs(db, values.org, anchor);

    if (sub === "export-key") {
      if (!store)
        throw new Error(
          "set TURNTABLE_MASTER_KEY_FILE or TURNTABLE_MASTER_KEY, or pass --master-key-file",
        );
      const org = orgs[0];
      if (!org || !values.org || !values.out)
        throw new Error("--org <slug> and --out <file> are required");
      const key = await loadAuditKey(store, org.id);
      if (!key)
        throw new Error(`org ${org.slug} has no signing key; run: turntable audit init-key`);
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

    if (sub === "init-key" || sub === "adopt") {
      if (!store || !anchor)
        throw new Error(
          "set TURNTABLE_MASTER_KEY_FILE or TURNTABLE_MASTER_KEY, or pass --master-key-file",
        );
      const org = orgs[0];
      if (!org || !values.org) throw new Error("--org <slug> is required");
      try {
        if (sub === "adopt") {
          const st = await adoptAuditKey(db, store, anchor, org.id);
          console.log(`${org.slug}: adopted; last signed entry ${st.lastSeq}`);
          return 0;
        }
        if (!values.out)
          throw new Error("--out <file> is required: the public key file to keep off this server");
        const key = await initAuditKey(db, store, anchor, org.id);
        writeFileSync(
          values.out,
          `${JSON.stringify(publicKeyFile(org.id, org.slug, key), null, 2)}\n`,
          { mode: 0o644, flag: "wx" },
        );
        console.log(
          `${org.slug}: created key ${key.keyId}; wrote ${values.out}; keep it off this server`,
        );
        return 0;
      } catch (e) {
        if (e instanceof AuditAlreadyInitialised || e instanceof AuditRefusal) {
          console.error(e.message);
          return 1;
        }
        throw e;
      }
    }

    if (sub === "checkpoint") {
      if (!store || !anchor)
        throw new Error(
          "set TURNTABLE_MASTER_KEY_FILE or TURNTABLE_MASTER_KEY, or pass --master-key-file",
        );
      let refused = false;
      for (const o of orgs) {
        try {
          const cp = await createCheckpoint(db, store, anchor, o.id);
          console.log(
            cp
              ? `${o.slug}: signed checkpoint at entry ${cp.seq}`
              : `${o.slug}: already covered, or signing is not set up (audit init-key)`,
          );
        } catch (e) {
          if (!(e instanceof AuditRefusal)) throw e;
          console.log(`${o.slug}: REFUSED (${e.reason}): ${e.message}`);
          refused = true;
        }
      }
      return refused ? 1 : 0;
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
    const anchors = [...(values.anchor ?? []), ...(values.anchors ?? [])].flatMap((f) =>
      readAnchorFile(f),
    );
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

/**
 * Checkpoints from an export file (JSONL, entries ignored), the bodies an anchor sink received
 * (v2 `{version: 2, org_id, sequence, head_hash, time, key_id, signature}` per line, or the keyless v1 body without `key_id`, or the `{org, lines}` of the audit export), or a saved single checkpoint.
 */
export function readAnchorFile(path: string): AnchorCheckpoint[] {
  const out: AnchorCheckpoint[] = [];
  const take = (o: Partial<AnchorCheckpoint> & { type?: string; lines?: unknown }): void => {
    if (Array.isArray(o.lines)) {
      for (const l of o.lines) take(l as Partial<AnchorCheckpoint> & { type?: string });
      return;
    }
    const ex = o as {
      org_id?: unknown;
      sequence?: unknown;
      head_hash?: unknown;
      time?: unknown;
      version?: unknown;
      key_id?: unknown;
    };
    if (typeof ex.org_id === "string" && typeof ex.sequence === "number" && o.signature) {
      // v2 names its key and is checked under it alone. A v1 body has none (keyId ""): verify
      // tries the trusted keys and accepts it only at or before the org's v2 cutover. A v2 body
      // without a key id is not read as v1, or stripping the id would downgrade it.
      if (ex.version === 2 && (typeof ex.key_id !== "string" || ex.key_id === "")) {
        throw new Error(`${path}: a v2 anchor body needs a key_id`);
      }
      out.push({
        orgId: ex.org_id,
        seq: ex.sequence,
        hash: String(ex.head_hash),
        signedAt: Number(ex.time),
        keyId: ex.version === 2 ? String(ex.key_id) : "",
        signature: o.signature,
      });
      return;
    }
    const isCp = o.type === "checkpoint" || (o.type === undefined && o.signature !== undefined);
    if (isCp && o.orgId && typeof o.seq === "number" && o.hash && o.keyId && o.signature) {
      out.push(o as AnchorCheckpoint);
    }
  };
  const text = readFileSync(path, "utf8");
  // One pretty-printed JSON document, else one JSON value per line.
  try {
    take(JSON.parse(text));
    return out;
  } catch {
    out.length = 0;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t !== "") take(JSON.parse(t));
  }
  return out;
}

async function resolveOrgs(
  db: Db,
  slug: string | undefined,
  anchor?: AuditAnchor,
): Promise<{ id: string; slug: string }[]> {
  if (slug) {
    const o = await getOrgBySlug(db, slug);
    if (!o) throw new Error(`no org with slug ${slug}`);
    return [{ id: o.id, slug: o.slug }];
  }
  const out: { id: string; slug: string }[] = [];
  // With the master key, also the orgs whose rows are all gone but that have a state file or a key.
  const ids = anchor ? await auditedOrgIds(db, anchor) : await orgsWithAudit(db);
  for (const id of ids) {
    const o = await getOrgById(db, id);
    if (o) out.push({ id: o.id, slug: o.slug });
  }
  return out;
}
