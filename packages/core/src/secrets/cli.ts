// `longshore secret set|rotate|delete|list`. Local access to the data directory and the master
// key is the trust root, so this talks to the vault directly (no network). The value is read
// from a file or stdin, never from an argument, and is never printed or audited.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, getOrgBySlug, getProjectBySlug, openDatabase } from "../db";
import { appendAudit } from "../db/repos";
import { loadMasterKey } from "./crypto";
import { SecretVault, VaultInputError, type SecretView } from "./vault";

const USAGE = `usage:
  longshore secret set    --org <slug> [--project <slug>] --name <NAME> (--value-file <path> | --value-stdin)
                          [--environment <env>] [--ref <pattern>] [--class protected]... [--destination host]...
  longshore secret rotate --org <slug> [--project <slug>] --name <NAME> (--value-file <path> | --value-stdin)
                          [--environment <env>] [--ref <pattern>] [--overlap-seconds 0]
  longshore secret delete --org <slug> [--project <slug>] --name <NAME> [--environment <env>] [--ref <pattern>]
  longshore secret list   --org <slug> [--project <slug>]
Needs LONGSHORE_MASTER_KEY_FILE (or --master-key-file). The value is never taken from an argument,
so it cannot land in shell history or the process list; the default classes are protected and
release, and untrusted_pr can never be allowed.`;

const readValue = async (file: string | undefined, stdin: boolean | undefined): Promise<string> => {
  if (Boolean(file) === Boolean(stdin)) {
    throw new VaultInputError("give exactly one of --value-file and --value-stdin");
  }
  const raw = file ? readFileSync(file, "utf8") : await Bun.stdin.text();
  // One trailing newline is an artefact of `echo` and editors, not part of the value.
  return raw.replace(/\r?\n$/, "");
};

const show = (s: SecretView): void => {
  const v = s.versions.map(
    (x) =>
      `v${x.version}${x.valid_until === null ? "" : `(until ${new Date(x.valid_until).toISOString()})`}`,
  );
  console.log(
    [
      s.name,
      s.project_id ? `project=${s.project_id}` : "org-wide",
      s.environment ? `env=${s.environment}` : "",
      s.ref_pattern ? `ref=${s.ref_pattern}` : "",
      `classes=${s.trust_classes.join(",")}`,
      `dest=${s.destinations.length ? s.destinations.join(",") : "none"}`,
      `current=v${s.current_version}`,
      `versions=${v.join(",")}`,
      `last_used=${s.last_used_at ? new Date(s.last_used_at).toISOString() : "never"}`,
    ]
      .filter(Boolean)
      .join("  "),
  );
};

/** Returns the process exit code. */
export async function secretCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!["set", "rotate", "delete", "list"].includes(sub ?? "")) {
    console.error(USAGE);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        org: { type: "string" },
        project: { type: "string" },
        name: { type: "string" },
        environment: { type: "string" },
        ref: { type: "string" },
        class: { type: "string", multiple: true },
        destination: { type: "string", multiple: true },
        "value-file": { type: "string" },
        "value-stdin": { type: "boolean" },
        "overlap-seconds": { type: "string" },
        "master-key-file": { type: "string" },
        "data-dir": { type: "string", default: "./data" },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(`${String(e instanceof Error ? e.message : e)}\n${USAGE}`);
    return 2;
  }
  const keyFile = values["master-key-file"] ?? process.env.LONGSHORE_MASTER_KEY_FILE;
  if (!keyFile) throw new Error("set LONGSHORE_MASTER_KEY_FILE or pass --master-key-file");
  if (!values.org) throw new Error("--org <slug> is required");
  const db = openDatabase(join(resolve(values["data-dir"]), "longshore.db"));
  try {
    await ensureInstance(db);
    const org = await getOrgBySlug(db, values.org);
    if (!org) throw new Error(`no org with slug ${values.org}`);
    let projectId: string | null = null;
    if (values.project) {
      const p = await getProjectBySlug(db, { orgId: org.id }, values.project);
      if (!p) throw new Error(`no project ${values.project} in org ${values.org}`);
      projectId = p.id;
    }
    const vault = new SecretVault({ db, masterKey: loadMasterKey(keyFile) });
    const scope = {
      name: values.name ?? "",
      projectId,
      environment: values.environment ?? null,
      refPattern: values.ref ?? null,
    };
    const audit = (op: string, effect: string, detail: Record<string, unknown>) =>
      appendAudit(db, projectId ? { orgId: org.id, projectId } : { orgId: org.id }, {
        principalKind: "cli",
        principalId: "local",
        op,
        effect,
        outcome: "ok",
        input: {
          name: scope.name,
          environment: scope.environment,
          ref_pattern: scope.refPattern,
          ...detail,
        },
      });

    try {
      if (sub === "list") {
        for (const s of await vault.list(org.id, projectId ?? undefined)) show(s);
        return 0;
      }
      if (!values.name) throw new VaultInputError("--name is required");
      if (sub === "set") {
        const value = await readValue(values["value-file"], values["value-stdin"]);
        const r = await vault.set(org.id, "cli:local", scope, value, {
          trustClasses: values.class,
          destinations: values.destination,
        });
        await audit("set_secret", "write", {
          version: r.secret.current_version,
          trust_classes: r.secret.trust_classes,
          destinations: r.secret.destinations,
        });
        console.error(
          `${r.created ? "created" : "added a version to"} ${r.secret.name} (v${r.secret.current_version})`,
        );
        return 0;
      }
      if (sub === "rotate") {
        const value = await readValue(values["value-file"], values["value-stdin"]);
        const overlap = Number(values["overlap-seconds"] ?? "0");
        const r = await vault.rotate(org.id, "cli:local", scope, value, overlap * 1000);
        if (!r) throw new VaultInputError("no secret with that name and scope");
        await audit("rotate_secret", "write", {
          version: r.current_version,
          overlap_seconds: overlap,
        });
        console.error(`rotated ${r.name} to v${r.current_version}`);
        return 0;
      }
      const r = await vault.delete(org.id, scope);
      if (!r) throw new VaultInputError("no secret with that name and scope");
      await audit("delete_secret", "destructive", { versions_removed: r.versions.length });
      console.error(`deleted ${r.name} (${r.versions.length} versions)`);
      return 0;
    } catch (e) {
      if (e instanceof VaultInputError) {
        console.error(e.message);
        return 1;
      }
      throw e;
    }
  } finally {
    db.close();
  }
}
