import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureInstance, getOrgBySlug, getProjectBySlug, openDatabase } from "../db";
import { getActionPolicy, setActionPolicy } from "../db/repos";

/** `turntable policy <show|set> --org <slug> --project <slug> [...]` (local trust root). */
export async function policyCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string", default: "local" },
      project: { type: "string", default: "local" },
      "require-sha-pins": { type: "string" },
      "allow-owners": { type: "string" },
      "clear-allowlist": { type: "boolean", default: false },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  if (sub !== "show" && sub !== "set") {
    throw new Error(
      "usage: turntable policy <show|set> [--org local] [--project local] [--require-sha-pins true|false] [--allow-owners a,b | --clear-allowlist]",
    );
  }
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    await ensureInstance(db);
    const org = await getOrgBySlug(db, values.org);
    if (!org) throw new Error(`no org with slug ${values.org}`);
    const project = await getProjectBySlug(db, { orgId: org.id }, values.project);
    if (!project) throw new Error(`no project ${values.project} in org ${values.org}`);
    const scope = { orgId: org.id, projectId: project.id };
    if (sub === "set") {
      const patch: { requireShaPins?: boolean; allowedOwners?: string[] | null } = {};
      const req = values["require-sha-pins"];
      if (req !== undefined) {
        if (req !== "true" && req !== "false")
          throw new Error("--require-sha-pins must be true or false");
        patch.requireShaPins = req === "true";
      }
      if (values["clear-allowlist"]) patch.allowedOwners = null;
      else if (values["allow-owners"] !== undefined) {
        patch.allowedOwners = values["allow-owners"]
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean);
      }
      if (Object.keys(patch).length === 0) throw new Error("nothing to set");
      await setActionPolicy(db, scope, patch);
    }
    const p = await getActionPolicy(db, scope);
    console.log(
      `require_sha_pins: ${p.requireShaPins}\nallowed action owners (org): ${p.allowedOwners ? p.allowedOwners.join(", ") || "(none)" : "any (no allowlist)"}`,
    );
  } finally {
    db.close();
  }
}
