import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getDelivery, getInstallation, listProjects, setPreviousSecretExpiry } from "../src/db";
import { SECRET_WEBHOOK_PREVIOUS } from "../src/github/app-auth";
import {
  MAX_BODY_BYTES,
  WEBHOOK_PATH,
  createWebhookHandler,
  signatureMatches,
} from "../src/github/webhook";
import { WEBHOOK_SECRET, fakeFacts, inst, repo, setup, sign } from "./github-helpers";

async function harness() {
  const s = await setup();
  const f = fakeFacts();
  f.installations.set("100", inst("100"));
  f.repos.set("100", [repo("1", "api")]);
  let t = 1_700_000_000_000;
  const handler = createWebhookHandler({
    db: s.db,
    store: s.store,
    facts: f.facts,
    now: () => t,
    maxFailures: 3,
    log: () => {},
  });
  const post = (
    body: string | Uint8Array,
    h: {
      secret?: string | null;
      event?: string;
      guid?: string;
      sig?: string | null;
      xff?: string;
    } = {},
  ): Promise<Response | undefined> => {
    const headers: Record<string, string> = {
      "x-github-event": h.event ?? "installation",
      "x-github-delivery": h.guid ?? crypto.randomUUID(),
      "content-type": "application/json",
    };
    const sig = h.sig === undefined ? sign(h.secret ?? WEBHOOK_SECRET, body) : h.sig;
    if (sig !== null) headers["x-hub-signature-256"] = sig;
    if (h.xff) headers["x-forwarded-for"] = h.xff;
    return handler.handle(
      new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", headers, body }),
    );
  };
  return { ...s, f, handler, post, advance: (ms: number) => (t += ms) };
}

const installed = JSON.stringify({ action: "created", installation: { id: 100 } });

describe("signature", () => {
  test("signatureMatches is exact and rejects malformed headers", () => {
    const raw = new TextEncoder().encode("hello");
    expect(signatureMatches("s", raw, sign("s", raw))).toBe(true);
    expect(signatureMatches("s", raw, sign("t", raw))).toBe(false);
    expect(signatureMatches("s", raw, null)).toBe(false);
    expect(signatureMatches("s", raw, "sha256=zz")).toBe(false);
    expect(signatureMatches("s", raw, sign("s", raw).replace("sha256=", "sha1="))).toBe(false);
  });

  test("a forged signature is refused before anything is stored or parsed", async () => {
    const h = await harness();
    const guid = "forged-0001";
    const bad = await h.post(installed, { secret: "wrong-secret", guid });
    expect(bad?.status).toBe(401);
    expect((await h.post(installed, { sig: null, guid }))?.status).toBe(401);
    expect(await getDelivery(h.db, guid)).toBeUndefined();
    expect(h.f.calls.getInstallation).toBe(0);
    // Not even JSON: still 401 (signature first), never 400.
    expect((await h.post("not json", { secret: "wrong-secret" }))?.status).toBe(401);
  });

  test("a body changed after signing is refused", async () => {
    const h = await harness();
    const sig = sign(WEBHOOK_SECRET, installed);
    const res = await h.post(installed.replace("100", "101"), { sig });
    expect(res?.status).toBe(401);
  });

  test("repeated bad signatures are rate limited, valid signatures never are", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) await h.post(installed, { secret: "no", xff: "1.2.3.4" });
    expect((await h.post(installed, { secret: "no", xff: "1.2.3.4" }))?.status).toBe(429);
    // Without a trusted proxy every client shares one key, yet a correctly signed delivery
    // (GitHub's) still goes through: the limiter cannot be used to lock out real webhooks.
    expect((await h.post(installed, { xff: "1.2.3.4" }))?.status).toBe(202);
    expect((await h.post(installed, {}))?.status).toBe(202);
    h.advance(61_000);
    expect((await h.post(installed, { secret: "no", xff: "1.2.3.4" }))?.status).toBe(401);
  });

  test("a spoofed X-Forwarded-For is ignored unless a trusted proxy is configured", async () => {
    const h = await harness();
    // Rotating XFF values does not escape the limit: all share one key by default.
    for (let i = 0; i < 3; i += 1) await h.post(installed, { secret: "no", xff: `9.9.9.${i}` });
    expect((await h.post(installed, { secret: "no", xff: "8.8.8.8" }))?.status).toBe(429);
  });
});

describe("secret rotation overlap", () => {
  test("the previous secret verifies inside the window and stops after it", async () => {
    const h = await harness();
    await h.store.set(h.org.id, SECRET_PRIVATE_KEY_NAME, "x"); // unrelated secret is harmless
    await h.store.set(h.org.id, SECRET_WEBHOOK_PREVIOUS, "previous-secret-value");
    await setPreviousSecretExpiry(h.db, "42", Date.now() + 100_000_000_000);
    expect((await h.post(installed, { secret: "previous-secret-value" }))?.status).toBe(202);
    // Window over (the handler's clock is far earlier than the real one used above, so expire it).
    await setPreviousSecretExpiry(h.db, "42", 1);
    expect((await h.post(installed, { secret: "previous-secret-value" }))?.status).toBe(401);
    // The current one always works.
    expect((await h.post(installed))?.status).toBe(202);
  });
});

const SECRET_PRIVATE_KEY_NAME = "unrelated/secret";

describe("persistence, dedupe and routing", () => {
  test("the delivery is stored before the 202, the handler runs once, a replayed GUID is not rerun", async () => {
    const h = await harness();
    const guid = "delivery-0001";
    const res = await h.post(installed, { guid });
    expect(res?.status).toBe(202);
    // Stored by the time the response exists, before the handler finishes.
    expect(await getDelivery(h.db, guid)).toMatchObject({
      event: "installation",
      action: "created",
    });
    await h.handler.drain();
    expect(await getDelivery(h.db, guid)).toMatchObject({ status: "processed" });
    expect(await getInstallation(h.db, "100")).toMatchObject({ orgId: h.org.id, status: "active" });
    expect((await listProjects(h.db, { orgId: h.org.id })).map((p) => p.slug)).toEqual(["api"]);

    const calls = h.f.calls.getInstallation;
    const replay = await h.post(installed, { guid });
    expect(replay?.status).toBe(202);
    expect(await replay?.json()).toEqual({ status: "duplicate" });
    await h.handler.drain();
    expect(h.f.calls.getInstallation).toBe(calls);
  });

  test("unknown events are stored as ignored and acknowledged", async () => {
    const h = await harness();
    const res = await h.post(JSON.stringify({ zen: "hi" }), { event: "ping", guid: "ping-0001" });
    expect(res?.status).toBe(202);
    expect(await getDelivery(h.db, "ping-0001")).toMatchObject({
      status: "ignored",
      payload: null,
    });
    expect(h.f.calls.getInstallation).toBe(0);
  });

  test("a payload that names a foreign installation or other repos changes nothing the API does not confirm", async () => {
    const h = await harness();
    // Payload claims installation 200 and a repo list; the API says 200 belongs to another App.
    h.f.installations.set("200", inst("200", "999"));
    h.f.repos.set("200", [repo("9", "victim-repo", "victim")]);
    const body = JSON.stringify({
      action: "created",
      installation: { id: 200, account: { login: "victim" } },
      repositories: [{ id: 9, full_name: "victim/victim-repo" }],
    });
    expect((await h.post(body, { guid: "foreign-0001" }))?.status).toBe(202);
    await h.handler.drain();
    expect(await getDelivery(h.db, "foreign-0001")).toMatchObject({ status: "failed" });
    expect(await getInstallation(h.db, "200")).toBeUndefined();
    expect(await listProjects(h.db, { orgId: h.org.id })).toHaveLength(0);
  });

  test("an installation GitHub does not know is processed as unknown, and nothing is left unfinished", async () => {
    const h = await harness();
    h.f.installations.delete("100");
    expect((await h.post(installed, { guid: "gone-0001" }))?.status).toBe(202);
    await h.handler.drain();
    expect((await getDelivery(h.db, "gone-0001"))?.status).toBe("processed");
    expect(await h.handler.retryUnfinished()).toBe(0);
  });
});

describe("limits and routing", () => {
  test("an oversized body is refused by Content-Length and by streamed size", async () => {
    const h = await harness();
    const declared = await h.handler.handle(
      new Request(`http://x${WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "content-length": String(MAX_BODY_BYTES + 1),
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
        },
        body: "tiny",
      }),
    );
    expect(declared?.status).toBe(413);
    const big = new Uint8Array(MAX_BODY_BYTES + 1);
    const streamed = await h.post(big);
    expect(streamed?.status).toBe(413);
  });

  test("other paths fall through, other methods are refused, and no App means 503", async () => {
    const h = await harness();
    expect(await h.handler.handle(new Request("http://x/api/v1/runs"))).toBeUndefined();
    const get = await h.handler.handle(new Request(`http://x${WEBHOOK_PATH}`));
    expect(get?.status).toBe(405);
    const empty = createWebhookHandler({
      db: (await import("../src/db")).openDatabase(":memory:"),
      store: h.store,
      facts: h.f.facts,
    });
    const r = await empty.handle(
      new Request(`http://x${WEBHOOK_PATH}`, { method: "POST", body: "{}" }),
    );
    expect(r?.status).toBe(503);
  });

  test("missing delivery or event headers are rejected after the signature", async () => {
    const h = await harness();
    expect((await h.post(installed, { guid: "x" }))?.status).toBe(400);
    expect((await h.post(installed, { event: "Bad Event" }))?.status).toBe(400);
  });
});

// approver_is_author (#408) compares the approver with run.actor alone, which is only safe while
// runs come from poll ingest (actor = the PR author the trust decision judged). A webhook that
// created runs or recorded the event's sender would need that check to compare both (#416).
describe("webhooks create no runs and record no sender (#416)", () => {
  const src = readFileSync(new URL("../src/github/webhook.ts", import.meta.url), "utf8");
  test("webhook.ts never calls run creation", () => {
    expect(src).not.toMatch(/\bcreate(Polled)?Run\s*\(/);
    expect(src).not.toMatch(/\binsert\s*\(\s*runs\b/);
  });
  test("webhook.ts never reads the payload sender or sets an actor", () => {
    expect(src).not.toMatch(/\.sender\b|\[\s*["']sender["']\s*\]/);
    expect(src).not.toMatch(/\bactor\s*:/);
  });
});
