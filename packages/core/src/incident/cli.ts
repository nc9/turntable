// `turntable incident freeze|unfreeze|status`: the local operator's way to stop an incident, with
// no token and no network. It acts as the local owner through the same operations the API has, so
// the audit log records it like any other freeze. It works on the data directory's database, so
// another process's server sees the flag at its next claim; the server's token cache lives in
// that process and is not reachable from here (GitHub tokens expire within an hour).
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../db";
import { getOrgBySlug } from "../db/repos";
import { dispatch, registry } from "../ops";

export const INCIDENT_USAGE = `Usage: turntable incident freeze --org <slug> [--project <slug>] --reason <text> [--data-dir ./data]
       turntable incident unfreeze --org <slug> [--project <slug>] [--data-dir ./data]
       turntable incident status --org <slug> [--project <slug>] [--data-dir ./data]

freeze   stops scheduling for the org (or one project), kills running jobs, drops cached tokens
         held by this process and flags every secret for rotation.
unfreeze resumes scheduling. Secrets stay flagged until they are rotated.`;

export async function incidentCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      org: { type: "string" },
      project: { type: "string" },
      reason: { type: "string" },
      "data-dir": { type: "string", default: "./data" },
    },
    strict: true,
  });
  const op = {
    freeze: "incident_freeze",
    unfreeze: "incident_unfreeze",
    status: "incident_status",
  }[sub ?? ""];
  if (!op || !values.org) {
    console.error(INCIDENT_USAGE);
    return 2;
  }
  if (sub === "freeze" && !values.reason) {
    console.error("--reason is required: it is shown to every user and recorded in the audit log");
    return 2;
  }
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    const org = await getOrgBySlug(db, values.org);
    if (!org) {
      console.error(`no such org: ${values.org}`);
      return 1;
    }
    const res = await dispatch(
      { registry, db },
      { kind: "principal", principal: { kind: "member", id: "cli", orgId: org.id, role: "owner" } },
      op,
      {
        org: values.org,
        ...(values.project ? { project: values.project } : {}),
        ...(sub === "freeze" ? { reason: values.reason } : {}),
      },
    );
    if (!res.ok) {
      console.error(`${res.error.code}: ${res.error.message}`);
      return 1;
    }
    console.log(JSON.stringify(res.output, null, 2));
    return 0;
  } finally {
    db.close();
  }
}
