// The Slack format of an outbound webhook (#611): fixed text, ids only, nothing else sent.
import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { appendEvent, type Db } from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { slackText, type WebhookEnvelope } from "../src/webhooks/slack";
import { WebhookService } from "../src/webhooks/service";
import { seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let svc: WebhookService;
let env: DispatchEnv;
let sent: { headers: Headers; body: string }[];
const clock = 1_800_000_000_000;
const URL_OK = "https://chat.example.test/hook";

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  sent = [];
  svc = new WebhookService({
    db,
    masterKey: randomBytes(32),
    now: () => clock,
    fetch: async (_url, init) => {
      sent.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response("ok", { status: 200 });
    },
  });
  env = { registry, db, now: () => clock, webhooks: svc };
});

const envelope = (over: Partial<WebhookEnvelope>): WebhookEnvelope => ({
  cursor: 1,
  id: "e1",
  type: "run.finished",
  org: "acme",
  project: "web",
  run_id: "01HABC",
  job_id: null,
  attempt_id: null,
  payload: { status: "failure" },
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("slackText", () => {
  test("fixed templates per kind, and nothing for other events", () => {
    expect(slackText(envelope({}))).toBe(":x: Run failed in acme/web (run 01HABC)");
    expect(slackText(envelope({ payload: { status: "success" } }))).toBeNull();
    expect(slackText(envelope({ type: "infra.error", run_id: null }))).toBe(
      ":warning: Infrastructure error in acme/web",
    );
    expect(
      slackText(
        envelope({ type: "quota.reached", project: null, payload: { metric: "runs_per_hour" } }),
      ),
    ).toBe(":hourglass: Work is held in acme: quota reached (runs_per_hour)");
    expect(slackText(envelope({ type: "approval.required" }))).toBe(
      ":lock: Approval waiting in acme/web (run 01HABC)",
    );
    expect(slackText(envelope({ type: "run.queued" }))).toBeNull();
  });
  test("nothing from the payload or a hostile name reaches the text", () => {
    const t = slackText(
      envelope({
        org: "<!channel>",
        project: "a|b",
        run_id: "x<y",
        payload: { status: "failure", commit_message: "<!here> MARK-9" },
      }),
    )!;
    expect(t).not.toContain("MARK-9");
    expect(t).not.toMatch(/[<>|]/);
    expect(t).toBe(":x: Run failed in ?/?");
  });
});

describe("a slack endpoint", () => {
  test("defaults to the notification events, sends {text} and skips the rest", async () => {
    const as = { kind: "principal" as const, principal: a.admin };
    const r = await dispatch(env, as, "create_webhook", { url: URL_OK, format: "slack" });
    if (!r.ok) throw new Error(r.error.message);
    const out = r.output as { webhook: { format: string; event_types: string[] } };
    expect(out.webhook.format).toBe("slack");
    expect(out.webhook.event_types).toEqual([
      "run.finished",
      "infra.error",
      "quota.reached",
      "approval.required",
    ]);
    await appendEvent(db, a.scope, {
      type: "run.finished",
      runId: a.runId,
      payload: { status: "failure" },
    });
    await appendEvent(db, a.scope, {
      type: "run.finished",
      runId: a.runId,
      payload: { status: "success" },
    });
    await svc.tick();
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["text"]);
    expect(String(body.text)).toContain("Run failed in ");
  });
});
