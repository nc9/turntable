// `turntable usage`: read sandbox time per UTC day (and per project) from a server over REST
// (`sandbox_usage`), with a reader token read from a file. It never opens the database. A token
// bound to one project sees only that project.
import { createHttpClient, type SafeFetch } from "@turntable/net";
import { parseArgs } from "node:util";
import { baseString, parseBaseUrl } from "../channel/api";
import { readTokenFile } from "../mcp/stdio";

export const USAGE_USAGE = `Usage: turntable usage --url <https://host> [--days <1-92>] [--by-project] [--json]
                       [--token-file <path>] [--allow-insecure]

Sandbox time per UTC day, from the provider's create to its confirmed destroy. --by-project adds
each project's own days and total. TURNTABLE_URL and TURNTABLE_TOKEN_FILE are read when the
flags are absent.`;

type Day = {
  day: string;
  sandbox_seconds: number;
  sandbox_minutes: number;
  attempts: number;
  estimated_attempts: number;
};
export type UsageView = {
  days: Day[];
  total_seconds: number;
  total_minutes: number;
  projects?: {
    project_slug: string;
    project_name: string;
    days: Day[];
    total_seconds: number;
    total_minutes: number;
  }[];
};

export async function fetchUsage(o: {
  baseUrl: URL;
  token: string;
  days?: number | undefined;
  byProject?: boolean;
  fetch?: SafeFetch;
}): Promise<UsageView> {
  const f = o.fetch ?? createHttpClient({ allowHosts: [o.baseUrl.hostname] }).fetch;
  const url = new URL(`${baseString(o.baseUrl)}/api/v1/usage/sandbox`);
  if (o.days !== undefined) url.searchParams.set("days", String(o.days));
  if (o.byProject) url.searchParams.set("group_by", "project");
  const res = await f(url, {
    method: "GET",
    headers: { authorization: `Bearer ${o.token}`, accept: "application/json" },
    redirect: "error",
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: { message?: string } };
      message = b.error?.message ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return (await res.json()) as UsageView;
}

const line = (label: string, d: Day): string =>
  `${label.padEnd(12)} ${d.sandbox_minutes.toFixed(1).padStart(10)} min  ${String(d.attempts).padStart(5)} attempts${d.estimated_attempts > 0 ? `  (${d.estimated_attempts} estimated)` : ""}`;

export function formatUsage(v: UsageView): string {
  const out = [
    ...v.days.map((d) => line(d.day, d)),
    `total        ${v.total_minutes.toFixed(1).padStart(10)} min`,
  ];
  for (const p of v.projects ?? []) {
    out.push("", `${p.project_slug} (${p.project_name})`);
    out.push(...p.days.map((d) => line(`  ${d.day}`, d)));
    out.push(`  total      ${p.total_minutes.toFixed(1).padStart(10)} min`);
  }
  return out.join("\n");
}

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

export async function usageCommand(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        url: { type: "string" },
        days: { type: "string" },
        "by-project": { type: "boolean", default: false },
        "token-file": { type: "string" },
        "allow-insecure": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(
      `turntable usage: ${e instanceof Error ? e.message : "bad arguments"}\n\n${USAGE_USAGE}`,
    );
    return 2;
  }
  try {
    const url = values.url ?? env("TURNTABLE_URL");
    const tokenFile = values["token-file"] ?? env("TURNTABLE_TOKEN_FILE");
    if (!url || !tokenFile) throw new Error("--url and a token file are required");
    let days: number | undefined;
    if (values.days !== undefined) {
      if (!/^\d{1,2}$/.test(values.days) || Number(values.days) < 1 || Number(values.days) > 92) {
        throw new Error("--days must be a whole number from 1 to 92");
      }
      days = Number(values.days);
    }
    const view = await fetchUsage({
      baseUrl: parseBaseUrl(url, values["allow-insecure"]),
      token: readTokenFile(tokenFile),
      days,
      byProject: values["by-project"],
    });
    console.log(values.json ? JSON.stringify(view, null, 2) : formatUsage(view));
    return 0;
  } catch (e) {
    console.error(`turntable usage: ${e instanceof Error ? e.message : "failed"}`);
    return 1;
  }
}
