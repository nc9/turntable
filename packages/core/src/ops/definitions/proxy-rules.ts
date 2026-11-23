import { z } from "zod";
import { compileRule, type Inject, RuleError } from "@turntable/proxy";
import {
  setPassthroughHost,
  deletePassthroughHost,
  deleteProxyRule,
  listPassthroughHosts,
  listProxyRules,
  type ProxyRuleRow,
  setProxyRule,
} from "../../db/repos";
import { normalizePolicy, VaultInputError } from "../../secrets/vault";
import { decodeCursor, encodeCursor, nextCursor, pageInput } from "../common";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";

const ruleView = z.object({
  name: z.string(),
  vault_key: z.string().describe("The vault secret's name; its value is never returned."),
  host: z.string(),
  port: z.int(),
  methods: z.array(z.string()),
  path_prefix: z.string(),
  inject: z.union([
    z.object({ type: z.literal("header"), name: z.string(), format: z.string().nullable() }),
    z.object({ type: z.literal("basic"), username: z.string() }),
  ]),
  created_by: z.string(),
  updated_at: z.int(),
});

export function viewOf(r: ProxyRuleRow): z.infer<typeof ruleView> {
  return {
    name: r.name,
    vault_key: r.secret,
    host: r.host,
    port: r.port,
    methods: JSON.parse(r.methods) as string[],
    path_prefix: r.pathPrefix,
    inject:
      r.injectType === "basic"
        ? { type: "basic", username: r.injectUsername ?? "" }
        : { type: "header", name: r.injectHeader ?? "", format: r.injectFormat },
    created_by: r.createdBy,
    updated_at: r.updatedAt,
  };
}

const actor = (ctx: OpContext): string => `${ctx.principal.kind}:${ctx.principal.id}`;

function requireProject(ctx: OpContext): string {
  if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
  return ctx.scope.projectId;
}

export const setProxyRuleOp = defineOp({
  name: "set_proxy_rule",
  // Decides where a secret may be sent: a limit-raising setter, not for an agent.
  mcp: false,
  summary:
    "Allow the secrets proxy to inject a secret into requests to one host (create or replace).",
  description:
    "Names where a project's jobs may have a vault secret attached by the secrets proxy: one " +
    "exact host, port, methods and path prefix, and how it is attached (a header with a format " +
    "such as `Bearer {secret}`, or HTTP Basic). The host must be one of the secret's " +
    "destination hosts. The job never sees the value. Jobs of class untrusted_pr never get " +
    "rules. Needs release_operator or admin; audited. Not available over MCP: it decides where a " +
    "secret may be sent, so a person sets it (REST or the CLI); removing a rule is available.",
  input: z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
    secret: z.string().min(1).max(128),
    host: z.string().min(1).max(253),
    port: z.int().min(1).max(65535).default(443),
    methods: z.array(z.string().max(10)).min(1).max(10),
    path_prefix: z.string().min(1).max(500),
    inject: z.union([
      z.object({
        type: z.literal("header"),
        name: z.string().min(1).max(64),
        format: z.string().max(200).optional(),
      }),
      z.object({ type: z.literal("basic"), username: z.string().min(1).max(100) }),
    ]),
  }),
  output: z.object({ created: z.boolean(), rule: ruleView }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/proxy-rules" },
  async handler(ctx, i) {
    const projectId = requireProject(ctx);
    const inject: Inject =
      i.inject.type === "header"
        ? {
            type: "header",
            name: i.inject.name,
            ...(i.inject.format === undefined ? {} : { format: i.inject.format }),
          }
        : i.inject;
    // The rule must compile (exact host, canonical prefix, allowed header) before it is stored.
    try {
      compileRule({
        id: i.name,
        host: i.host,
        port: i.port,
        methods: i.methods,
        pathPrefix: i.path_prefix,
        inject,
        secret: i.secret,
      });
    } catch (err) {
      if (err instanceof RuleError) throw new OpError("invalid_input", err.message);
      throw err;
    }
    if (!ctx.vault) {
      throw new OpError("unavailable", "the secrets vault is not configured");
    }
    if (!(await ctx.vault.canDeliver(ctx.scope.orgId, projectId, i.secret, i.host))) {
      throw new OpError(
        "invalid_input",
        "the host is not one of the secret's destinations (or there is no such secret)",
      );
    }
    const { row, created } = await setProxyRule(ctx.db, ctx.scope, actor(ctx), {
      name: i.name,
      secret: i.secret,
      host: i.host,
      port: i.port,
      methods: i.methods,
      pathPrefix: i.path_prefix,
      inject: i.inject,
    });
    return { created, rule: viewOf(row) };
  },
});

export const listProxyRulesOp = defineOp({
  name: "list_proxy_rules",
  summary: "List a project's secrets-proxy rules.",
  description:
    "Lists where the project's jobs may have secrets injected: host, methods, path prefix and " +
    "injection form. Never values. Needs release_operator or admin. Read-only.",
  input: z.object({ ...pageInput }),
  output: z.object({ rules: z.array(ruleView), next_cursor: nextCursor }),
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/proxy-rules" },
  async handler(ctx, i) {
    requireProject(ctx);
    const after = i.cursor === undefined ? undefined : decodeCursor(i.cursor);
    const all = (await listProxyRules(ctx.db, ctx.scope)).filter(
      (r) => after === undefined || r.name > after,
    );
    const page = all.slice(0, i.limit);
    const last = page.at(-1);
    return {
      rules: page.map(viewOf),
      next_cursor: all.length > i.limit && last ? encodeCursor(last.name) : null,
    };
  },
});

export const deleteProxyRuleOp = defineOp({
  name: "delete_proxy_rule",
  summary: "Delete a secrets-proxy rule.",
  description:
    "Removes the rule: new jobs no longer get that injection. Attempts already running keep the " +
    "rules they were registered with until they end. Needs release_operator or admin; audited.",
  input: z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) }),
  output: z.object({ deleted: z.boolean() }),
  effect: "destructive",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "DELETE", path: "/proxy-rules" },
  async handler(ctx, i) {
    requireProject(ctx);
    if (!(await deleteProxyRule(ctx.db, ctx.scope, i.name))) {
      throw new OpError("not_found", "no rule with that name");
    }
    return { deleted: true };
  },
});

const hostField = z
  .string()
  .min(1)
  .max(253)
  .describe("An exact host (github.com) or *.suffix for any subdomain (*.githubusercontent.com).");

/** The same host syntax the vault accepts for destinations (no bare wildcard, no `*.com`). */
function checkedHost(host: string): string {
  try {
    const [h] = normalizePolicy({ destinations: [host] }).destinations;
    return h!;
  } catch (err) {
    if (err instanceof VaultInputError) throw new OpError("invalid_input", err.message);
    throw err;
  }
}

export const addPassthroughHostOp = defineOp({
  name: "add_proxy_passthrough_host",
  // Widens the egress of secret-bearing jobs: a limit-raising setter, not for an agent.
  mcp: false,
  summary: "Allow a project's secret-bearing jobs a plain tunnel to one host (no injection).",
  description:
    "A job that has proxy rules is secret-bearing: through the secrets proxy it may reach rule " +
    "hosts and, with no other entry, nothing else. This lists hosts it may also open a plain TLS " +
    "tunnel to (nothing is injected, the job's own TLS runs end to end), for example github.com " +
    "and codeload.github.com for checkout, or registry.npmjs.org. Without entries, sources must " +
    "be pre-staged. Needs release_operator or admin; audited. Not available over MCP: it widens " +
    "what a secret-bearing job can reach, so a person sets it (REST); removing a host is available.",
  input: z.object({
    host: hostField,
    ports: z
      .array(z.int().min(1).max(65535))
      .min(1)
      .max(10)
      .default([443])
      .describe("Ports a tunnel to this host may use. Default [443]."),
  }),
  output: z.object({ added: z.boolean(), host: z.string(), ports: z.array(z.int()) }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/proxy-passthrough-hosts" },
  async handler(ctx, i) {
    requireProject(ctx);
    const host = checkedHost(i.host);
    const ports = [...new Set(i.ports)].toSorted((x, y) => x - y);
    return {
      added: await setPassthroughHost(ctx.db, ctx.scope, actor(ctx), host, ports),
      host,
      ports,
    };
  },
});

export const listPassthroughHostsOp = defineOp({
  name: "list_proxy_passthrough_hosts",
  summary: "List the hosts a project's secret-bearing jobs may tunnel to without injection.",
  description:
    "Lists the hosts a project's secret-bearing jobs may open a plain TLS tunnel to, with the " +
    "ports allowed for each (nothing is injected: the job's own TLS runs end to end). A job " +
    "that has proxy rules reaches only its rule hosts plus these, so use this to see why a " +
    "secret-bearing job can or cannot reach a host, for example github.com for checkout. " +
    "Needs release_operator or admin. Read-only.",
  input: z.object({ ...pageInput }),
  output: z.object({
    hosts: z.array(z.object({ host: z.string(), ports: z.array(z.int()) })),
    next_cursor: nextCursor,
  }),
  effect: "read",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/proxy-passthrough-hosts" },
  async handler(ctx, i) {
    requireProject(ctx);
    const after = i.cursor === undefined ? undefined : decodeCursor(i.cursor);
    const all = (await listPassthroughHosts(ctx.db, ctx.scope)).filter(
      (h) => after === undefined || h.host > after,
    );
    const page = all.slice(0, i.limit);
    const last = page.at(-1);
    return {
      hosts: page,
      next_cursor: all.length > i.limit && last ? encodeCursor(last.host) : null,
    };
  },
});

export const deletePassthroughHostOp = defineOp({
  name: "delete_proxy_passthrough_host",
  summary: "Remove a host from a project's passthrough list.",
  description:
    "New attempts no longer get a tunnel to that host. Needs release_operator or admin; audited.",
  input: z.object({ host: hostField }),
  output: z.object({ deleted: z.boolean() }),
  effect: "destructive",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "DELETE", path: "/proxy-passthrough-hosts" },
  async handler(ctx, i) {
    requireProject(ctx);
    if (!(await deletePassthroughHost(ctx.db, ctx.scope, checkedHost(i.host)))) {
      throw new OpError("not_found", "that host is not on the list");
    }
    return { deleted: true };
  },
});
