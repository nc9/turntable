import { z } from "zod";
import { systemOrgId } from "../../audit/failures";
import { appendAudit } from "../../db";
import { processNetwork } from "../../network";
import { iso } from "../common";
import { defineOp } from "../define";

const windowShape = z.object({
  start: z.string().describe("When the instance entered degraded (ISO 8601)."),
  end: z.string().nullable().describe("When it recovered, or null while still degraded."),
});

const baseOutput = z.object({
  state: z.enum(["healthy", "degraded"]),
  since: z.string().nullable().describe("When the current state began, or null since boot."),
  windows: z
    .array(windowShape)
    .describe("Recent degraded windows since this process started, oldest first."),
});

type Base = z.infer<typeof baseOutput>;

function view(): Base {
  const s = processNetwork.snapshot();
  return {
    state: s.state,
    since: iso(s.since),
    windows: s.windows.map((w) => ({ start: iso(w.start)!, end: iso(w.end) })),
  };
}

const DESCRIPTION =
  "The instance's outbound network state (#698). A probe every 15 s resolves and HEADs the forge " +
  "and the sandbox provider; two failures in a row mean `degraded`, two successes mean " +
  "`healthy`. While degraded no new attempt is claimed, an attempt that failed before its " +
  "sandbox existed is re-queued without using its retry, and check posts wait. The state and " +
  "the windows live in the server process and reset on a restart. ";

export const networkStatusOp = defineOp({
  name: "network_status",
  summary: "Whether the instance's outbound network is healthy, and its recent degraded windows.",
  description:
    DESCRIPTION +
    "Use it to tell why queued work is waiting. No probe detail is returned. Read-only and cheap.",
  input: z.object({}),
  output: baseOutput,
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/network/status" },
  async handler() {
    return view();
  },
});

export const instanceNetworkStatusOp = defineOp({
  name: "instance_network_status",
  summary: "The instance's network state, recent degraded windows and the last probe's timings.",
  description:
    DESCRIPTION +
    "For the instance administrator it adds the consecutive failure count, the last probe time " +
    "and, per probe target (a fixed label, never a URL), the DNS and HEAD timings and the error " +
    "code. The read is audited in the system chain. Only the instance administrator can call " +
    "it. Read-only. Not an MCP tool.",
  input: z.object({}),
  output: baseOutput.extend({
    consecutive_failures: z.int(),
    last_probe_at: z.string().nullable(),
    targets: z.array(
      z.object({
        target: z.string(),
        ok: z.boolean(),
        dns_ms: z.int().nullable(),
        http_ms: z.int().nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/instance/network" },
  mcp: false,
  async handler(ctx) {
    await appendAudit(
      ctx.db,
      { orgId: await systemOrgId(ctx.db) },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "instance_network_status",
        effect: "read",
        outcome: "ok",
        input: {},
      },
    );
    const s = processNetwork.snapshot();
    return {
      ...view(),
      consecutive_failures: s.consecutive_failures,
      last_probe_at: iso(s.last_probe_at),
      targets: (s.last_probe?.targets ?? []).map((t) => ({
        target: t.target,
        ok: t.ok,
        dns_ms: t.dnsMs ?? null,
        http_ms: t.httpMs ?? null,
        error: t.error ?? null,
      })),
    };
  },
});
