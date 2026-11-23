// `turntable artifacts list|check`: a REST client for get_artifacts and check_artifact_consumption.
// A reader token is enough; it is read from a file, never the command line. This command never
// opens the database.
import { createHttpClient, type SafeFetch } from "@turntable/net";
import { parseArgs } from "node:util";
import { baseString, parseBaseUrl } from "../channel/api";
import { readTokenFile } from "../mcp/stdio";

export const ARTIFACTS_USAGE = `Usage: turntable artifacts list --run <run id> --project <slug> --url <https://host> --org <slug>
                              [--token-file <path>] [--json]
       turntable artifacts check (--consumer <run id> | --consumer-class <class>)
                              --source <run id>:<name> [--source ...]
                              [--quarantine <run id>:<name> ...] --project <slug> --url <https://host>
                              --org <slug> [--token-file <path>] [--json]

list shows each artifact a run recorded: its trust class, digest (and whether the control plane
computed it), commit and size. check says, per source artifact, whether the consumer run may take
it: allow, quarantine (a lower class that you named with --quarantine) or deny. The consumer is a
run, or a class by name ("may a release build take this?"). A release consumer is denied anything
below the release class. The token is read from --token-file or TURNTABLE_TOKEN_FILE
(mode 0600); --url and --org also read TURNTABLE_URL and TURNTABLE_ORG.`;

export type ArtifactRow = {
  name: string;
  size: number;
  sha256: string;
  digest_source: string;
  trust_class: string;
  run_sha: string | null;
  attempt_id: string;
  created_at: string;
};
export type CheckRow = {
  run_id: string;
  name: string;
  decision: string;
  reason: string | null;
  trust_class: string | null;
  sha256: string | null;
};

/** `<run id>:<name>`: the run id has no colon, the name may contain one. */
export function parseSource(text: string): { run_id: string; name: string } {
  const i = text.indexOf(":");
  if (i < 1 || i === text.length - 1)
    throw new Error(`expected <run id>:<name>, got ${JSON.stringify(text)}`);
  return { run_id: text.slice(0, i), name: text.slice(i + 1) };
}

async function request<T>(o: {
  baseUrl: URL;
  token: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  fetch?: SafeFetch;
}): Promise<T> {
  const f = o.fetch ?? createHttpClient({ allowHosts: [o.baseUrl.hostname] }).fetch;
  const url = new URL(`${baseString(o.baseUrl)}/api/v1${o.path}`);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const res = await f(url, {
    method: o.method,
    headers: {
      authorization: `Bearer ${o.token}`,
      accept: "application/json",
      ...(o.body ? { "content-type": "application/json" } : {}),
    },
    redirect: "error",
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
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
  return (await res.json()) as T;
}

export function formatArtifacts(rows: readonly ArtifactRow[]): string {
  if (rows.length === 0) return "no artifacts";
  return rows
    .map(
      (a) =>
        `${a.name}\n  class ${a.trust_class}, sha256 ${a.sha256} (${a.digest_source}), commit ${a.run_sha?.slice(0, 12) ?? "unknown"}, ${a.size} bytes`,
    )
    .join("\n");
}

export function formatChecks(rows: readonly CheckRow[]): string {
  return rows
    .map(
      (r) =>
        `${r.decision.padEnd(10)} ${r.run_id}:${r.name}${r.trust_class ? ` (${r.trust_class})` : ""}${r.reason ? `\n           ${r.reason}` : ""}`,
    )
    .join("\n");
}

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

export async function artifactsCommand(args: string[], fetchImpl?: SafeFetch): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "list" && sub !== "check") {
    console.error(ARTIFACTS_USAGE);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        url: { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        run: { type: "string" },
        consumer: { type: "string" },
        "consumer-class": { type: "string" },
        source: { type: "string", multiple: true },
        quarantine: { type: "string", multiple: true },
        "token-file": { type: "string" },
        "allow-insecure": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (e) {
    console.error(
      `turntable artifacts: ${e instanceof Error ? e.message : "bad arguments"}\n\n${ARTIFACTS_USAGE}`,
    );
    return 2;
  }
  try {
    const url = values.url ?? env("TURNTABLE_URL");
    const org = values.org ?? env("TURNTABLE_ORG");
    const tokenFile = values["token-file"] ?? env("TURNTABLE_TOKEN_FILE");
    if (!url || !org || !tokenFile || !values.project)
      throw new Error("--url, --org, --project and a token file are required");
    const baseUrl = parseBaseUrl(url, values["allow-insecure"]);
    const token = readTokenFile(tokenFile);
    const common = { baseUrl, token, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
    if (sub === "list") {
      if (!values.run) throw new Error("--run is required");
      const r = await request<{ artifacts: ArtifactRow[] }>({
        ...common,
        method: "GET",
        path: `/runs/${encodeURIComponent(values.run)}/artifacts`,
        query: { org, project: values.project },
      });
      console.log(values.json ? JSON.stringify(r, null, 2) : formatArtifacts(r.artifacts));
      return 0;
    }
    if (!values.source?.length) throw new Error("at least one --source is required");
    if ((values.consumer === undefined) === (values["consumer-class"] === undefined))
      throw new Error("give exactly one of --consumer and --consumer-class");
    const r = await request<{ results: CheckRow[] }>({
      ...common,
      method: "POST",
      path: "/artifacts/check-consumption",
      body: {
        org,
        project: values.project,
        ...(values.consumer ? { consumer_run_id: values.consumer } : {}),
        ...(values["consumer-class"] ? { consumer_class: values["consumer-class"] } : {}),
        sources: values.source.map(parseSource),
        ...(values.quarantine?.length ? { quarantine: values.quarantine.map(parseSource) } : {}),
      },
    });
    console.log(values.json ? JSON.stringify(r, null, 2) : formatChecks(r.results));
    // A denied source is a non-zero exit, so a script can gate on it.
    return r.results.some((x) => x.decision === "deny") ? 3 : 0;
  } catch (e) {
    console.error(`turntable artifacts: ${e instanceof Error ? e.message : "failed"}`);
    return 1;
  }
}
