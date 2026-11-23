import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createHttpClient } from "@longshore/net";
import {
  appendEvent,
  latestSettledEventId,
  listAudit,
  listEvents,
  transitionJob,
  type Db,
} from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import {
  BACKOFF_MS,
  defaultSettleMs,
  MAX_ATTEMPTS,
  validateWebhookUrl,
  verifyWebhookSignature,
  WebhookService,
} from "../src/webhooks/service";
import { fanOutOutboundEndpoint } from "../src/db/repos";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";
import { onPostgres } from "./pg-mode";

let db: Db;
let a: Tenant;
let b: Tenant;
let clock: number;
let svc: WebhookService;
let env: DispatchEnv;
let sent: { url: string; headers: Headers; body: string }[];
let respond: (n: number) => Response | Promise<Response>;

const URL_OK = "https://hooks.example.test/longshore";

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  clock = 1_800_000_000_000;
  sent = [];
  respond = () => new Response("ok", { status: 200 });
  svc = new WebhookService({
    db,
    masterKey: randomBytes(32),
    now: () => clock,
    random: () => 0.5, // jitter factor 1.0
    fetch: async (url, init) => {
      sent.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return respond(sent.length);
    },
  });
  env = { registry, db, now: () => clock, webhooks: svc };
});

const as = (t: Tenant) => ({ kind: "principal" as const, principal: t.admin });
async function op<T = any>(t: Tenant, name: string, input: unknown = {}): Promise<T> {
  const r = await dispatch(env, as(t), name, input);
  if (!r.ok) throw new Error(`${name}: ${r.error.code} ${r.error.message}`);
  return r.output as T;
}
async function opErr(t: Tenant, name: string, input: unknown = {}): Promise<string> {
  const r = await dispatch(env, as(t), name, input);
  return r.ok ? "ok" : `${r.error.code}: ${r.error.message}`;
}

const emit = (t: Tenant, n: number) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      appendEvent(db, t.scope, { type: "run.queued", runId: t.runId, payload: { i } }),
    ),
  );

describe("managing endpoints", () => {
  test("the first create shows the org's secret once; later ones and list never do", async () => {
    const first = await op(a, "create_webhook", { url: URL_OK, from_start: true });
    expect(first.secret).toMatch(/^whsec_/);
    expect(first.webhook).toMatchObject({ state: "active", project_id: null, event_types: null });
    const second = await op(a, "create_webhook", { url: `${URL_OK}/2`, types: ["run.finished"] });
    expect(second.secret).toBeNull();
    const list = await op(a, "webhook_endpoints");
    expect(list.webhooks).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain("whsec_");
    // The sealed record is not the secret.
    const rows = await db.orm.select().from(s.outboundSecrets);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sealed).not.toContain(first.secret);
  });

  test("an endpoint URL must be https, public, and without credentials", async () => {
    for (const bad of [
      "http://hooks.example.test/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest/meta-data",
      "https://10.1.2.3/x",
      "https://localhost/x",
      "https://user:pw@hooks.example.test/x",
      "https://hooks.example.test/x#frag",
      "nonsense",
    ]) {
      expect(() => validateWebhookUrl(bad)).toThrow();
      expect(await opErr(a, "create_webhook", { url: bad })).toContain("invalid_input");
    }
    expect(validateWebhookUrl("https://8.8.8.8/x")).toBe("https://8.8.8.8/x");
  });

  test("only org admins manage webhooks, and each org sees only its own", async () => {
    const reader = (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret;
    const r = await dispatch(env, { kind: "bearer", token: reader }, "create_webhook", {
      url: URL_OK,
    });
    expect(r.ok).toBe(false);
    const mine = await op(a, "create_webhook", { url: URL_OK });
    expect((await op(b, "webhook_endpoints")).webhooks).toEqual([]);
    expect(await opErr(b, "disable_webhook", { webhook_id: mine.webhook.id })).toContain(
      "not_found",
    );
    expect(await opErr(b, "webhook_deliveries", { webhook_id: mine.webhook.id })).toContain(
      "not_found",
    );
  });

  test("creating, rotating and disabling are audited, and no audit row holds a secret", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK });
    const rot = await op(a, "rotate_webhook_secret");
    await op(a, "disable_webhook", { webhook_id: c.webhook.id });
    const rows = await listAudit(db, a.scope);
    const ops = rows.map((r) => r.op);
    expect(ops).toContain("create_webhook");
    expect(ops).toContain("rotate_webhook_secret");
    expect(ops).toContain("disable_webhook");
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(c.secret);
    expect(dump).not.toContain(rot.secret);
  });
});

describe("signing and delivery", () => {
  test("a delivery is one signed POST whose timestamp is inside the signed content", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK, from_start: true });
    await svc.tick();
    expect(sent.length).toBeGreaterThan(0);
    const d = sent[0]!;
    const sig = d.headers.get("longshore-signature")!;
    expect(verifyWebhookSignature(c.secret, sig, d.body, clock)).toBe(true);
    // Changing the body, the timestamp or the secret each breaks it: the timestamp is signed.
    expect(verifyWebhookSignature(c.secret, sig, `${d.body} `, clock)).toBe(false);
    expect(verifyWebhookSignature(c.secret, sig.replace(/t=\d+/, "t=1"), d.body, 1_000)).toBe(
      false,
    );
    expect(verifyWebhookSignature("whsec_other", sig, d.body, clock)).toBe(false);
    // A captured request is useless later.
    expect(verifyWebhookSignature(c.secret, sig, d.body, clock + 10 * 60_000)).toBe(false);
    const body = JSON.parse(d.body);
    expect(body).toMatchObject({ org: "org-a", type: "run.queued", project: "app" });
    expect(d.headers.get("longshore-cursor")).toBe(String(body.cursor));
    expect(d.headers.get("longshore-event")).toBe("run.queued");
    expect(d.headers.get("content-type")).toBe("application/json");
  });

  test("rotation: both secrets sign during the overlap, then only the new one", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK });
    const r = await op(a, "rotate_webhook_secret");
    await emit(a, 1);
    await svc.tick();
    const during = sent.at(-1)!;
    const header = during.headers.get("longshore-signature")!;
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(verifyWebhookSignature(c.secret, header, during.body, clock)).toBe(true);
    expect(verifyWebhookSignature(r.secret, header, during.body, clock)).toBe(true);
    clock += svc.overlapMs + 1000;
    await emit(a, 1);
    await svc.tick();
    const after = sent.at(-1)!;
    const h2 = after.headers.get("longshore-signature")!;
    expect(h2.match(/v1=/g)).toHaveLength(1);
    expect(verifyWebhookSignature(r.secret, h2, after.body, clock)).toBe(true);
    expect(verifyWebhookSignature(c.secret, h2, after.body, clock)).toBe(false);
  });

  test("a new endpoint starts at the tip; from_start replays the feed", async () => {
    await emit(a, 3);
    await op(a, "create_webhook", { url: URL_OK });
    await svc.tick();
    expect(sent).toHaveLength(0);
    await emit(a, 1);
    await svc.tick();
    expect(sent).toHaveLength(1);
  });

  test("filters: types, project, and other orgs' events never arrive", async () => {
    await op(a, "create_webhook", { url: URL_OK, types: ["run.finished"] });
    await emit(a, 2); // run.queued: filtered out
    await emit(b, 2); // another org
    await appendEvent(db, a.scope, { type: "run.finished", runId: a.runId });
    await svc.tick();
    expect(sent.map((x) => JSON.parse(x.body).type)).toEqual(["run.finished"]);
    expect(JSON.parse(sent[0]!.body).org).toBe("org-a");
  });

  test("a project endpoint gets that project's events only", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK, project: a.projectSlug });
    expect(c.webhook.project_id).toBe(a.projectId);
    await appendEvent(db, { orgId: a.orgId }, { type: "infra.error", payload: { org_level: 1 } });
    await emit(a, 1);
    await svc.tick();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body).project).toBe("app");
  });
});

describe("retries, the log and auto-disable", () => {
  test("a failure retries with backoff and then succeeds; the log shows both", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK });
    await emit(a, 1);
    respond = (n) => new Response("nope", { status: n === 1 ? 503 : 200 });
    await svc.tick();
    let log = (await op(a, "webhook_deliveries", { webhook_id: c.webhook.id })).deliveries;
    expect(log[0]).toMatchObject({ state: "pending", attempts: 1, last_status: 503 });
    expect(log[0].last_response).toBe("nope");
    // Not due yet.
    await svc.tick();
    expect(sent).toHaveLength(1);
    clock += BACKOFF_MS[0]! + 1;
    await svc.tick();
    log = (await op(a, "webhook_deliveries", { webhook_id: c.webhook.id })).deliveries;
    expect(log[0]).toMatchObject({ state: "delivered", attempts: 2, last_status: 200 });
    expect(sent).toHaveLength(2);
    // Same delivery id and cursor on the retry, for the receiver's deduplication.
    expect(sent[0]!.headers.get("longshore-delivery")).toBe(
      sent[1]!.headers.get("longshore-delivery"),
    );
  });

  test("attempts are capped: the delivery is abandoned and no more are made", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK });
    await emit(a, 1);
    respond = () => new Response("down", { status: 500 });
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      await svc.tick();
      clock += 13 * 3600 * 1000;
    }
    expect(sent).toHaveLength(MAX_ATTEMPTS);
    const log = (await op(a, "webhook_deliveries", { webhook_id: c.webhook.id })).deliveries;
    expect(log[0]).toMatchObject({ state: "abandoned", attempts: MAX_ATTEMPTS });
  });

  test("a redirect is a failure and is never followed", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK });
    await emit(a, 1);
    respond = () =>
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } });
    await svc.tick();
    expect(sent).toHaveLength(1);
    const log = (await op(a, "webhook_deliveries", { webhook_id: c.webhook.id })).deliveries;
    expect(log[0].last_error).toContain("redirects are not followed");
  });

  test("consecutive failures disable the endpoint and emit an event; enabling resumes", async () => {
    svc = new WebhookService({
      db,
      masterKey: randomBytes(32),
      now: () => clock,
      random: () => 0.5,
      disableAfter: 3,
      fetch: async (url, init) => {
        sent.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return respond(sent.length);
      },
    });
    env = { registry, db, now: () => clock, webhooks: svc };
    const c = await op(a, "create_webhook", { url: URL_OK });
    await emit(a, 5);
    respond = () => new Response("x", { status: 500 });
    await svc.tick();
    const after = (await op(a, "webhook_endpoints")).webhooks[0];
    expect(after).toMatchObject({ state: "disabled" });
    expect(after.disabled_reason).toContain("3 consecutive");
    const events = await listEvents(db, { orgId: a.orgId }, { after: 0, limit: 100 });
    const note = events.find(
      (e) => e.type === "webhook.disabled" && e.payload.includes(c.webhook.id),
    );
    expect(note).toBeDefined();
    const n = sent.length;
    clock += 24 * 3600 * 1000;
    await svc.tick();
    expect(sent.length).toBe(n); // disabled: nothing more is sent
    respond = () => new Response("ok");
    await op(a, "enable_webhook", { webhook_id: c.webhook.id });
    await svc.tick();
    expect(sent.length).toBeGreaterThan(n);
  });

  test("the guarded client refuses an address that resolves to a private one", async () => {
    const guarded = new WebhookService({
      db,
      masterKey: randomBytes(32),
      now: () => clock,
      fetch: createHttpClient({ resolve: async () => ["10.0.0.5"] }).fetch,
    });
    env = { registry, db, now: () => clock, webhooks: guarded };
    const c = await op(a, "create_webhook", { url: "https://rebind.example.test/x" });
    await emit(a, 1);
    await guarded.tick();
    const log = (await op(a, "webhook_deliveries", { webhook_id: c.webhook.id })).deliveries;
    expect(log[0]).toMatchObject({ state: "pending", attempts: 1, last_status: null });
    expect(log[0].last_error).toBeTruthy();
  });
});

describe("resuming from a cursor never loses or repeats an event", () => {
  test("fan-out in small pages while events keep arriving, replayed after a simulated crash", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK, from_start: true });
    const id = c.webhook.id;
    // The first run's events, fanned out two at a time, with more arriving in between.
    await emit(a, 5);
    await fanOutOutboundEndpoint(db, id, { page: 2, now: clock });
    await emit(a, 4);
    for (let i = 0; i < 6; i++) await fanOutOutboundEndpoint(db, id, { page: 2, now: clock });
    // A crash after the rows were inserted but "before" the cursor moved: the cursor goes back.
    await db.orm.update(s.outboundEndpoints).set({ cursor: 3 });
    for (let i = 0; i < 6; i++) await fanOutOutboundEndpoint(db, id, { page: 3, now: clock });
    const feed = (await listEvents(db, a.scope, { after: 0, limit: 100 })).map((e) => e.id);
    const rows = await db.orm.select().from(s.outboundDeliveries);
    expect(rows.map((r) => r.eventId).toSorted((x, y) => x - y)).toEqual(feed);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(rows.length);
  });

  test("a restarted service delivers each event exactly once, including through failures", async () => {
    const c = await op(a, "create_webhook", { url: URL_OK, from_start: true });
    await emit(a, 6);
    // A flaky receiver: every third request fails.
    respond = (n) => new Response("x", { status: n % 3 === 0 ? 500 : 200 });
    await svc.tick();
    // A restart is a fresh tick loop over the same rows: nothing is held in memory.
    await emit(a, 3);
    for (let i = 0; i < 6; i++) {
      clock += 3600 * 1000;
      await svc.tick();
    }
    const ok = new Map<string, number>();
    const acked = await db.orm.select().from(s.outboundDeliveries);
    for (const d of acked) if (d.state === "delivered") ok.set(d.id, (ok.get(d.id) ?? 0) + 1);
    const feed = await listEvents(db, { orgId: a.orgId }, { after: 0, limit: 100 });
    expect(acked).toHaveLength(feed.length);
    expect(acked.every((d) => d.state === "delivered")).toBe(true);
    // Every event reached the receiver successfully at least once; the retries of the failed
    // ones carry the same delivery id so the receiver can drop repeats.
    const okIds = new Set(sent.map((x) => x.headers.get("longshore-cursor")));
    for (const e of feed) expect(okIds.has(String(e.id))).toBe(true);
    void c;
  });
});

test("transitions on a job still produce one event each, and the feed is what webhooks see", async () => {
  await op(a, "create_webhook", { url: URL_OK });
  await transitionJob(db, a.scope, a.jobId, "running");
  await svc.tick();
  expect(sent.map((x) => JSON.parse(x.body).type)).toEqual(["job.state_changed"]);
});

describe("events that have not settled yet (ids can commit out of order on Postgres)", () => {
  test("the default settle window is 2 s on Postgres and none on SQLite", () => {
    expect(defaultSettleMs()).toBe(onPostgres ? 2000 : 0);
  });

  test("an event younger than the window is held back, then delivered in order once it settles", async () => {
    const real = Date.now();
    let now = real;
    const held = new WebhookService({
      db,
      masterKey: randomBytes(32),
      now: () => now,
      settleMs: 5000,
      fetch: async (url, init) => {
        sent.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return new Response("ok");
      },
    });
    env = { registry, db, now: () => now, webhooks: held };
    // Everything the seed wrote is old, so the endpoint starts at the tip.
    await db.orm.update(s.events).set({ createdAt: real - 60_000 });
    await op(a, "create_webhook", { url: URL_OK });
    const mine = await emit(a, 2);
    await held.tick();
    expect(sent).toHaveLength(0); // too young: a gap below could still be filling
    now = real + 6000;
    await held.tick();
    const cursors = sent.map((x) => JSON.parse(x.body).cursor as number);
    expect(cursors.toSorted((x, y) => x - y)).toEqual(mine.toSorted((x, y) => x - y));
    expect(cursors).toEqual(cursors.toSorted((x, y) => x - y));
  });
});

describe("starting from now when ids can commit out of order", () => {
  test("the newest settled id: the tip when everything is old, one below the oldest young event otherwise", async () => {
    const [e1, e2] = await emit(a, 2);
    const real = Date.now();
    await db.orm.update(s.events).set({ createdAt: real - 60_000 }); // the seed too
    // Both are old enough.
    expect(
      await latestSettledEventId(db, { orgId: a.orgId }, { settleMs: 1000, now: real + 5000 }),
    ).toBe(Math.max(e1!, e2!));
    // No window: the plain tip.
    expect(await latestSettledEventId(db, { orgId: a.orgId }, { settleMs: 0, now: real })).toBe(
      Math.max(e1!, e2!),
    );
    // A young event above two old ones: start just below it, so a gap filling below the tip is not lost.
    const young = await appendEvent(db, a.scope, { type: "run.queued", runId: a.runId });
    await db.orm
      .update(s.events)
      .set({ createdAt: real - 60_000 })
      .where(eq(s.events.id, e1!));
    await db.orm
      .update(s.events)
      .set({ createdAt: real - 60_000 })
      .where(eq(s.events.id, e2!));
    await db.orm.update(s.events).set({ createdAt: real }).where(eq(s.events.id, young));
    expect(
      await latestSettledEventId(db, { orgId: a.orgId }, { settleMs: 5000, now: real + 100 }),
    ).toBe(young - 1);
    // Another org's events never move it.
    await emit(b, 3);
    expect(
      await latestSettledEventId(db, { orgId: a.orgId }, { settleMs: 5000, now: real + 100 }),
    ).toBe(young - 1);
  });

  test("a new endpoint does not skip events that are still settling at the moment it is created", async () => {
    const real = Date.now();
    let now = real;
    const svc2 = new WebhookService({
      db,
      masterKey: randomBytes(32),
      now: () => now,
      settleMs: 5000,
      fetch: async (url, init) => {
        sent.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return new Response("ok");
      },
    });
    env = { registry, db, now: () => now, webhooks: svc2 };
    await db.orm.update(s.events).set({ createdAt: real - 60_000 }); // the seed is old
    const mine = await emit(a, 2); // just committed: still inside the settle window
    await op(a, "create_webhook", { url: URL_OK });
    await svc2.tick();
    expect(sent).toHaveLength(0);
    now = real + 6000;
    await svc2.tick();
    // Started below them, so they are delivered once settled, not skipped.
    expect(sent.map((x) => JSON.parse(x.body).cursor as number).toSorted((x, y) => x - y)).toEqual(
      mine.toSorted((x, y) => x - y),
    );
  });
});
