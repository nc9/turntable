// `turntable quotas show|set`: the instance operator's tool, on the host, against the data
// directory (like `token`, `policy` and `approvals`). Quotas limit tenants, so they are not
// settable over the API by the tenant's own tokens: only someone who can run this on the server,
// or hold an instance token (`set_quotas`, REST only), can change them. Reading them is `get_quotas` (REST and MCP, org-level reader token).
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../db";
import { getOrgBySlug, getOrgQuotas, quotaStatuses, quotaUsage, setOrgQuotas } from "../db/repos";

export const QUOTAS_USAGE = `Usage: turntable quotas show --org <slug> [--data-dir ./data]
       turntable quotas get --url <https://host> --org <slug> [--token-file <path>]
                            (remote read over REST with an org-level reader token)
       turntable quotas set --org <slug> [--data-dir ./data]
                            [--max-concurrent <n|none>] [--max-runs-per-hour <n|none>]
                            [--max-sandbox-minutes-per-day <n|none>] [--max-log-bytes <n|none>]
                            [--max-stored-bytes <n|none>]

Run on the server, as the instance operator. set changes only the limits you name ("none" removes
one). --max-concurrent can only lower an org's cap: the effective cap is the smaller of it and the
instance's per-org cap (--org-cap). An org's own tokens cannot set quotas.`;

const FLAGS = {
  "max-concurrent": "maxConcurrent",
  "max-runs-per-hour": "maxRunsPerHour",
  "max-sandbox-minutes-per-day": "maxSandboxMinutesPerDay",
  "max-log-bytes": "maxLogBytes",
  "max-stored-bytes": "maxStoredBytes",
} as const;

/** `5` is 5, `none` removes the limit; anything else is refused. */
export function parseLimit(flag: string, v: string): number | null {
  if (v === "none") return null;
  if (!/^\d{1,15}$/.test(v)) throw new Error(`--${flag} must be a whole number or "none"`);
  return Number(v);
}

export async function quotasCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "get") return (await import("./remote")).quotasGet(rest);
  if (sub !== "show" && sub !== "set") {
    console.error(QUOTAS_USAGE);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        org: { type: "string" },
        "data-dir": { type: "string", default: process.env.TURNTABLE_DATA_DIR ?? "./data" },
        ...Object.fromEntries(Object.keys(FLAGS).map((k) => [k, { type: "string" as const }])),
      },
      strict: true,
    }));
  } catch (e) {
    console.error(
      `turntable quotas: ${e instanceof Error ? e.message : "bad arguments"}\n\n${QUOTAS_USAGE}`,
    );
    return 2;
  }
  if (!values.org) {
    console.error(QUOTAS_USAGE);
    return 2;
  }
  const db = openDatabase(join(resolve(values["data-dir"]), "turntable.db"));
  try {
    const org = await getOrgBySlug(db, values.org);
    if (!org) {
      console.error(`no such org: ${values.org}`);
      return 1;
    }
    if (sub === "set") {
      const patch: Record<string, number | null> = {};
      for (const [flag, key] of Object.entries(FLAGS)) {
        const v = (values as unknown as Record<string, string | undefined>)[flag];
        if (v !== undefined) patch[key] = parseLimit(flag, v);
      }
      if (Object.keys(patch).length === 0) throw new Error("name at least one limit to set");
      await setOrgQuotas(db, org.id, patch, "cli", Date.now());
    }
    const q = await getOrgQuotas(db, org.id);
    const u = await quotaUsage(db, org.id, Date.now(), q);
    for (const st of quotaStatuses(q, u)) {
      const lim = st.limit === null ? "no limit" : String(st.limit);
      console.log(
        `${st.metric.padEnd(16)} ${(st.used === null ? "-" : String(st.used)).padStart(12)} of ${lim}${st.percent === null ? "" : ` (${st.percent}%)`}${st.held ? `\n  held: ${st.held}` : ""}`,
      );
    }
    return 0;
  } catch (e) {
    console.error(`turntable quotas: ${e instanceof Error ? e.message : "failed"}`);
    return 1;
  } finally {
    db.close();
  }
}
