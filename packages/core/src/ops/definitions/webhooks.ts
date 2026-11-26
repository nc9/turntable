import { z } from "zod";
import {
  getOutboundEndpoint,
  listOutboundEndpoints,
  listWebhookDeliveries,
  setOutboundEndpointState,
  type OutboundEndpoint,
} from "../../db/repos";
import {
  EVENT_TYPES,
  WEBHOOK_DELIVERY_STATES,
  WEBHOOK_FORMATS,
  type EventType,
} from "../../db/schema";
import { SLACK_EVENT_TYPES } from "../../webhooks/slack";
import { WebhookUrlError, type WebhookService } from "../../webhooks/service";
import { iso } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";

const need = (svc: WebhookService | undefined): WebhookService => {
  if (!svc) {
    throw new OpError(
      "unavailable",
      "outbound webhooks are not configured: start the server with TURNTABLE_MASTER_KEY_FILE",
    );
  }
  return svc;
};

const endpointOut = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string(),
  project_id: z
    .string()
    .nullable()
    .describe("Set when the endpoint only gets one project's events."),
  event_types: z.array(z.enum(EVENT_TYPES)).nullable().describe("null means every type."),
  format: z.enum(WEBHOOK_FORMATS).describe("`json`: the signed event. `slack`: a Slack message."),
  state: z.enum(["active", "disabled"]),
  disabled_reason: z.string().nullable(),
  consecutive_failures: z.int(),
  cursor: z.int().describe("The last event id handed to this endpoint's delivery queue."),
  created_at: z.string(),
});

const shape = (e: OutboundEndpoint): z.infer<typeof endpointOut> => ({
  id: e.id,
  url: e.url,
  description: e.description,
  project_id: e.projectId,
  event_types: e.eventTypes ? (JSON.parse(e.eventTypes) as EventType[]) : null,
  format: e.format as (typeof WEBHOOK_FORMATS)[number],
  state: e.state as "active" | "disabled",
  disabled_reason: e.disabledReason,
  consecutive_failures: e.consecutiveFailures,
  cursor: e.cursor,
  created_at: iso(e.createdAt)!,
});

const HOW_IT_SIGNS =
  "Each delivery is a POST of one event as JSON, signed in `Longshore-Signature: t=<unix " +
  "seconds>,v1=<hex>`: v1 is HMAC-SHA256 over `<t>.<raw body>` with the org's signing secret, so " +
  "the timestamp is part of what is signed (reject a `t` older than a few minutes). During a " +
  "secret rotation overlap the header carries two v1 values; accept either. `Longshore-Delivery` " +
  "is stable per endpoint and event, for deduplication; delivery is at least once.";

export const createWebhookOp = defineOp({
  name: "create_webhook",
  summary: "Send this org's events to a URL, signed.",
  description:
    "Creates an outbound webhook endpoint for the org (or one project, pass project). It starts " +
    "at the tip of the event feed unless from_start is true. The URL must be https and a public " +
    "address: private, loopback and metadata addresses are refused, and redirects are never " +
    "followed. If this is the org's first webhook the response carries `secret`, the signing " +
    "secret, shown once; later endpoints share the org's secret (rotate_webhook_secret shows a " +
    "new one). " +
    HOW_IT_SIGNS +
    " Org admins only (no agent token). Writes and is audited.",
  input: z.object({
    url: z.string().min(1).max(2048),
    description: z.string().max(200).default(""),
    types: z
      .array(z.enum(EVENT_TYPES))
      .max(EVENT_TYPES.length)
      .optional()
      .describe("Only these event types. Default: all."),
    format: z
      .enum(WEBHOOK_FORMATS)
      .default("json")
      .describe(
        '`slack` posts `{"text": ...}` of fixed text (run failed, infrastructure error, work held, ' +
          "approval waiting; ids and slugs only) for a Slack incoming webhook URL, and `types` " +
          "defaults to those events. Other events are not sent.",
      ),
    from_start: z.boolean().default(false).describe("Deliver the whole feed, not just new events."),
  }),
  output: z.object({
    webhook: endpointOut,
    secret: z
      .string()
      .nullable()
      .describe("The org's signing secret, only when this call created it. Shown once."),
  }),
  oneTimeSecretFields: ["secret"],
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/webhooks" },
  async handler(ctx, input) {
    const svc = need(ctx.webhooks);
    if (ctx.principal.kind !== "member") {
      throw new OpError("forbidden", "only org members can manage webhooks");
    }
    let endpoint;
    try {
      const secret = (await svc.ensureSecret(ctx.scope.orgId)) ?? null;
      endpoint = await svc.createEndpoint(ctx.scope, {
        url: input.url,
        description: input.description,
        eventTypes: input.types ?? (input.format === "slack" ? [...SLACK_EVENT_TYPES] : null),
        format: input.format,
        createdBy: `${ctx.principal.kind}:${ctx.principal.id}`,
        fromStart: input.from_start,
      });
      return { webhook: shape(endpoint), secret };
    } catch (e) {
      if (e instanceof WebhookUrlError) throw new OpError("invalid_input", e.message);
      throw e;
    }
  },
});

export const webhookEndpointsOp = defineOp({
  name: "webhook_endpoints",
  summary: "List this org's webhook endpoints.",
  description:
    "Lists the org's outbound webhook endpoints with their state, failure count and cursor. " +
    "Never returns the signing secret. Org admins only.",
  input: z.object({}),
  output: z.object({ webhooks: z.array(endpointOut) }),
  effect: "read",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "GET", path: "/webhooks" },
  async handler(ctx) {
    need(ctx.webhooks);
    return { webhooks: (await listOutboundEndpoints(ctx.db, ctx.scope)).map(shape) };
  },
});

export const rotateWebhookSecretOp = defineOp({
  name: "rotate_webhook_secret",
  summary: "Make a new webhook signing secret; the old one keeps signing for 24 hours.",
  description:
    "Creates a new signing secret for the org, returned once in `secret`. The previous secret " +
    "keeps signing until `overlap_ends_at` (24 hours), so every delivery in that time carries " +
    "two v1 signatures and a receiver can switch without a missed delivery. " +
    HOW_IT_SIGNS +
    " Org admins only. Writes and is audited.",
  input: z.object({}),
  output: z.object({
    secret: z.string().describe("The new signing secret. Shown once."),
    overlap_ends_at: z.string().describe("When the previous secret stops signing."),
  }),
  oneTimeSecretFields: ["secret"],
  effect: "write",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/webhooks/rotate-secret" },
  async handler(ctx) {
    const svc = need(ctx.webhooks);
    const secret = await svc.rotate(ctx.scope.orgId);
    return {
      secret,
      overlap_ends_at: new Date(ctx.now() + svc.overlapMs).toISOString(),
    };
  },
});

const stateOp = (name: "disable_webhook" | "enable_webhook") => {
  const disable = name === "disable_webhook";
  return defineOp({
    name,
    summary: disable
      ? "Stop sending to a webhook endpoint."
      : "Resume a disabled webhook endpoint.",
    description: disable
      ? "Disables an endpoint: nothing more is sent, and its queued deliveries wait. Re-enable " +
        "with enable_webhook. Org admins only. Writes and is audited."
      : "Re-enables a disabled endpoint (including one disabled after repeated failures) and " +
        "clears its failure count. Its waiting deliveries are sent and it picks up the feed where " +
        "it left off. Org admins only. Writes and is audited.",
    input: z.object({ webhook_id: z.string().min(1).max(64) }),
    output: z.object({ webhook: endpointOut }),
    effect: "write",
    auth: { type: "token", minRole: "admin" },
    untrustedOutput: false,
    scope: "org",
    http: { method: "POST", path: `/webhooks/{webhook_id}/${disable ? "disable" : "enable"}` },
    async handler(ctx, input) {
      need(ctx.webhooks);
      const row = await setOutboundEndpointState(
        ctx.db,
        ctx.scope,
        input.webhook_id,
        disable ? "disabled" : "active",
        disable ? "manual" : null,
        ctx.now(),
      );
      if (!row) throw new OpError("not_found", "no such webhook");
      return { webhook: shape(row) };
    },
  });
};
export const disableWebhookOp = stateOp("disable_webhook");
export const enableWebhookOp = stateOp("enable_webhook");

export const webhookDeliveriesOp = defineOp({
  name: "webhook_deliveries",
  summary: "The delivery log of a webhook endpoint.",
  description:
    "Newest first: each delivery's event cursor, state (pending, delivered or abandoned), attempt " +
    "count, last HTTP status or error, and the start of the receiver's answer. Page back with " +
    "`before` (an event cursor). The receiver's answer is untrusted text. Org admins only.",
  input: z.object({
    webhook_id: z.string().max(64).optional(),
    state: z.enum(WEBHOOK_DELIVERY_STATES).optional(),
    before: z.int().min(1).optional(),
    limit: z.int().min(1).max(200).default(50),
  }),
  output: z.object({
    deliveries: z.array(
      z.object({
        id: z.string(),
        webhook_id: z.string(),
        cursor: z.int().describe("The event's cursor."),
        state: z.enum(WEBHOOK_DELIVERY_STATES),
        attempts: z.int(),
        next_attempt_at: z.string().nullable(),
        last_status: z.int().nullable(),
        last_error: z.string().nullable(),
        last_response: z.string().nullable(),
        created_at: z.string(),
        delivered_at: z.string().nullable(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "admin" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/webhook-deliveries" },
  async handler(ctx, input) {
    need(ctx.webhooks);
    if (input.webhook_id && !(await getOutboundEndpoint(ctx.db, ctx.scope, input.webhook_id))) {
      throw new OpError("not_found", "no such webhook");
    }
    const rows = await listWebhookDeliveries(ctx.db, ctx.scope, {
      endpointId: input.webhook_id,
      state: input.state,
      before: input.before,
      limit: input.limit,
    });
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        webhook_id: d.endpointId,
        cursor: d.eventId,
        state: d.state as (typeof WEBHOOK_DELIVERY_STATES)[number],
        attempts: d.attempts,
        next_attempt_at: d.state === "pending" ? iso(d.nextAttemptAt) : null,
        last_status: d.lastStatus,
        last_error: d.lastError,
        last_response: d.lastResponse,
        created_at: iso(d.createdAt)!,
        delivered_at: iso(d.deliveredAt),
      })),
    };
  },
});
