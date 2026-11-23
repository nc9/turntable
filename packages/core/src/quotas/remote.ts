// `longshore quotas get`: read an org's quotas from a server over REST (get_quotas), with an
// org-level reader token read from a file. Setting them is not here: that is `quotas set` on the
// host. This command never opens the database.
import { createHttpClient, type SafeFetch } from "@longshore/net";
import { parseArgs } from "node:util";
import { baseString, parseBaseUrl } from "../channel/api";
import { readTokenFile } from "../mcp/stdio";

export type QuotaView = {
  limits: Record<string, number | null>;
  usage: {
    metric: string;
    used: number;
    limit: number | null;
    percent: number | null;
    held: string | null;
  }[];
};

export async function fetchQuotas(o: {
  baseUrl: URL;
  org: string;
  token: string;
  fetch?: SafeFetch;
}): Promise<QuotaView> {
  const f = o.fetch ?? createHttpClient({ allowHosts: [o.baseUrl.hostname] }).fetch;
  const url = new URL(`${baseString(o.baseUrl)}/api/v1/quotas`);
  url.searchParams.set("org", o.org);
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
  return (await res.json()) as QuotaView;
}

export function formatQuotas(v: QuotaView): string {
  return v.usage
    .map((u) => {
      const lim = u.limit === null ? "no limit" : String(u.limit);
      const pct = u.percent === null ? "" : ` (${u.percent}%)`;
      return `${u.metric.padEnd(16)} ${String(u.used).padStart(12)} of ${lim}${pct}${u.held ? `\n  held: ${u.held}` : ""}`;
    })
    .join("\n");
}

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

export async function quotasGet(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        url: { type: "string" },
        org: { type: "string" },
        "token-file": { type: "string" },
        "allow-insecure": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(`longshore quotas get: ${e instanceof Error ? e.message : "bad arguments"}`);
    return 2;
  }
  try {
    const url = values.url ?? env("LONGSHORE_URL");
    const org = values.org ?? env("LONGSHORE_ORG");
    const tokenFile = values["token-file"] ?? env("LONGSHORE_TOKEN_FILE");
    if (!url || !org || !tokenFile) throw new Error("--url, --org and a token file are required");
    const view = await fetchQuotas({
      baseUrl: parseBaseUrl(url, values["allow-insecure"]),
      org,
      token: readTokenFile(tokenFile),
    });
    console.log(values.json ? JSON.stringify(view, null, 2) : formatQuotas(view));
    return 0;
  } catch (e) {
    console.error(`longshore quotas get: ${e instanceof Error ? e.message : "failed"}`);
    return 1;
  }
}
