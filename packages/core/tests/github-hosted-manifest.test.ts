import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resetFailureThrottle } from "../src/audit/failures";
import { chainedAudit, createOrg, getGithubApp, openDatabase, type Db } from "../src/db";
import {
  SECRET_APP_ID,
  SECRET_CLIENT,
  SECRET_PRIVATE_KEY,
  SECRET_WEBHOOK,
} from "../src/github/app-auth";
import {
  createHostedManifestHandler,
  MANIFEST_CALLBACK_PATH,
  MANIFEST_COOKIE,
  MANIFEST_PATH,
  MANIFEST_TTL_MS,
  SECRET_MANIFEST_KEY,
  SETUP_FAILURES_PER_MINUTE,
  type HostedManifestHandler,
} from "../src/github/hosted-manifest";
import type { ManifestConversion } from "../src/github/manifest";
import { hashToken } from "../src/ops/tokens";
import { startServer } from "../src/server";
import { SecretStore } from "../src/secrets/store";
import { rsa } from "./github-helpers";

const BASE = "https://ci.example.test";
// Built at run time: a literal in this shape trips secret scanners.
const SETUP_TOKEN = ["setup", "token", randomBytes(12).toString("hex")].join("-");
const conv = (id: number): ManifestConversion => ({
  id,
  slug: `longshore-${id}`,
  name: "Longshore",
  owner: { login: "acme" },
  html_url: `https://github.com/apps/longshore-${id}`,
  client_id: `Iv1.client${id}`,
  client_secret: `client-secret-${id}-${randomBytes(6).toString("hex")}`,
  webhook_secret: `webhook-secret-${id}-${randomBytes(6).toString("hex")}`,
  pem: rsa.privateKey,
});

let db: Db;
let store: SecretStore;
let orgId: string;
let otherOrgId: string;
let now: number;
let handler: HostedManifestHandler;
let logs: string[];
let exchanged: string[];
let replacedCalls: number;
/** What GitHub says for each code. */
let answer: (code: string) => Response;
let first: ManifestConversion;

const make = (extra: { claimFlow?: boolean } = {}) =>
  createHostedManifestHandler({
    db,
    store,
    publicUrl: BASE,
    setupTokenSha256: hashToken(SETUP_TOKEN),
    now: () => now,
    log: (l) => logs.push(l),
    onReplaced: () => (replacedCalls += 1),
    fetch: (async (url: string | URL | Request) => {
      const code = /app-manifests\/([^/]+)\/conversions/.exec(String(url))?.[1] ?? "";
      exchanged.push(code);
      return answer(code);
    }) as never,
    ...extra,
  });

beforeEach(async () => {
  db = openDatabase(":memory:");
  store = new SecretStore(db, randomBytes(32));
  orgId = (await createOrg(db, { slug: "acme", name: "Acme" })).id;
  otherOrgId = (await createOrg(db, { slug: "other", name: "Other" })).id;
  now = 1_800_000_000_000;
  logs = [];
  exchanged = [];
  replacedCalls = 0;
  first = conv(4242);
  answer = () => Response.json(first, { status: 201 });
  resetFailureThrottle();
  handler = make();
});

const form = (fields: Record<string, string>) =>
  new Request(`${BASE}${MANIFEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
const asOperator = (fields: Record<string, string>) =>
  new Request(`${BASE}${MANIFEST_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Bearer ${SETUP_TOKEN}`,
    },
    body: new URLSearchParams(fields).toString(),
  });

/** Starts a flow and returns what GitHub would get back to us with. */
async function startFlow(
  fields: Record<string, string> = {},
  token: "bearer" | "field" = "bearer",
) {
  const body = { org: "acme", ...fields };
  const res = (await handler.handle(
    token === "bearer" ? asOperator(body) : form({ setup_token: SETUP_TOKEN, ...body }),
  ))!;
  const html = await res.text();
  const state = /state=([^"&]+)"/.exec(html)?.[1];
  const cookie = /ls_manifest=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  return {
    res,
    html,
    state: state ? decodeURIComponent(state) : undefined,
    cookie,
    manifest: /name="manifest" value="([^"]*)"/.exec(html)?.[1],
  };
}

const callback = (state: string | undefined, code: string, cookie?: string) =>
  handler.handle(
    new Request(
      `${BASE}${MANIFEST_CALLBACK_PATH}?code=${code}&state=${encodeURIComponent(state ?? "")}`,
      { headers: cookie ? { cookie: `${MANIFEST_COOKIE}=${cookie}` } : {} },
    ),
  ) as Promise<Response>;

const ops = async (org = orgId) =>
  (await chainedAudit(db, org, 0, 100)).map((r) => [r.op, r.outcome]);

describe("starting the flow", () => {
  test("the form is served to anyone and holds no secret; routes outside it are not ours", async () => {
    const res = (await handler.handle(new Request(`${BASE}${MANIFEST_PATH}`)))!;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('type="password" name="setup_token"');
    expect(html).not.toContain(SETUP_TOKEN);
    expect(await handler.handle(new Request(`${BASE}/api/v1/runs`))).toBeUndefined();
    expect(
      (await handler.handle(new Request(`${BASE}${MANIFEST_PATH}`, { method: "PUT" })))!.status,
    ).toBe(405);
  });

  test("a missing or wrong setup token is refused and audited; nothing is created", async () => {
    for (const token of [undefined, "wrong-token"]) {
      const res = (await handler.handle(
        form({ org: "acme", ...(token ? { setup_token: token } : {}) }),
      ))!;
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(await getGithubApp(db)).toBeUndefined();
    expect(await store.get(orgId, SECRET_MANIFEST_KEY)).toBeUndefined();
    // Refusals are audited (in the system chain: no org is known yet).
    const sys = (await db.run((h) =>
      h.orm.query.orgs.findFirst({ where: (o, { eq }) => eq(o.slug, "_system") }),
    ))!;
    expect(
      (await ops(sys.id)).some(
        ([op, out]) => op === "github_app_manifest_start" && out === "error:unauthenticated",
      ),
    ).toBe(true);
  });

  test("failed attempts are bounded for the whole instance", async () => {
    for (let i = 0; i < SETUP_FAILURES_PER_MINUTE; i++)
      expect((await handler.handle(form({ org: "acme", setup_token: `bad${i}` })))!.status).toBe(
        401,
      );
    // Even the right token waits out the window.
    expect((await handler.handle(asOperator({ org: "acme" })))!.status).toBe(429);
    now += 61_000;
    expect((await handler.handle(asOperator({ org: "acme" })))!.status).toBe(200);
  });

  test("the setup token works as a bearer header or a form field, and a good start gives the manifest page", async () => {
    for (const how of ["bearer", "field"] as const) {
      const f = await startFlow({}, how);
      expect(f.res.status).toBe(200);
      expect(f.state).toMatch(/^m1\./);
      expect(f.cookie).toBeTruthy();
      expect(f.html).toContain("https://github.com/settings/apps/new?state=");
    }
  });

  test("the manifest asks for least privilege and points back at this instance", async () => {
    const f = await startFlow({ gh_org: "acme-inc", name: "Longshore CI" });
    expect(f.html).toContain("https://github.com/organizations/acme-inc/settings/apps/new?state=");
    const m = JSON.parse(
      f
        .manifest!.replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">"),
    ) as Record<string, any>;
    expect(m.name).toBe("Longshore CI");
    expect(m.redirect_url).toBe(`${BASE}${MANIFEST_CALLBACK_PATH}`);
    expect(m.hook_attributes.url).toBe(`${BASE}/api/v1/webhooks/github`);
    expect(m.default_permissions).toEqual({
      checks: "write",
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    });
    expect(m.default_events).toEqual(["push", "pull_request", "check_run"]);
    expect(m.public).toBe(false);
    // Not set unless the claim flow is on.
    expect(m.setup_url).toBeUndefined();
    handler = make({ claimFlow: true });
    const claim = JSON.parse(
      (await startFlow()).manifest!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
    ) as Record<string, any>;
    expect(claim.setup_url).toBe(`${BASE}/api/v1/github/setup`);
    expect(claim.request_oauth_on_install).toBe(true);
  });

  test("the page may post only to GitHub, the cookie is HttpOnly, Lax and Secure, and nothing is cached", async () => {
    const f = await startFlow();
    expect(f.res.headers.get("content-security-policy")).toContain(
      "form-action https://github.com",
    );
    expect(f.res.headers.get("cache-control")).toBe("no-store");
    const cookie = f.res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${MANIFEST_TTL_MS / 1000}`);
  });

  test("bad input is refused before anything is stored", async () => {
    expect((await handler.handle(asOperator({ org: "Not A Slug" })))!.status).toBe(400);
    expect((await handler.handle(asOperator({ org: "nope" })))!.status).toBe(404);
    expect((await handler.handle(asOperator({ org: "acme", name: "x".repeat(40) })))!.status).toBe(
      400,
    );
    expect((await handler.handle(asOperator({ org: "acme", gh_org: "bad org!" })))!.status).toBe(
      400,
    );
    expect(await store.get(orgId, SECRET_MANIFEST_KEY)).toBeUndefined();
  });

  test("a start is audited in the owning org's chain, with no secret in it", async () => {
    await startFlow({ gh_org: "acme-inc" });
    const rows = await chainedAudit(db, orgId, 0, 100);
    const row = rows.find((r) => r.op === "github_app_manifest_start")!;
    expect(row.outcome).toBe("ok");
    expect(row.principalKind).toBe("setup-token");
    expect(JSON.stringify(rows)).not.toContain(SETUP_TOKEN);
  });
});

describe("the callback", () => {
  test("creates the App: credentials sealed, nothing in the response, audited", async () => {
    const f = await startFlow();
    const res = await callback(f.state, "good-code", f.cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    const c = first;
    for (const secret of [c.client_secret, c.webhook_secret, rsa.privateKey])
      expect(html).not.toContain(secret);
    expect(html).toContain("longshore-4242");
    expect(html).toContain("https://github.com/apps/longshore-4242/installations/new");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(exchanged).toEqual(["good-code"]);

    const app = (await getGithubApp(db))!;
    expect([app.appId, app.orgId, app.slug]).toEqual(["4242", orgId, "longshore-4242"]);
    expect(await store.get(orgId, SECRET_APP_ID)).toBe("4242");
    expect(await store.get(orgId, SECRET_PRIVATE_KEY)).toBe(rsa.privateKey);
    expect(await store.get(orgId, SECRET_WEBHOOK)).toBe(c.webhook_secret);
    expect(await store.get(orgId, SECRET_CLIENT)).toBe(c.client_secret);

    expect(await ops()).toContainEqual(["github_app_create", "ok"]);
    // Neither the audit chain nor the log ever holds a credential.
    const everything = JSON.stringify(await chainedAudit(db, orgId, 0, 100)) + logs.join("\n");
    for (const secret of [c.client_secret, c.webhook_secret, SETUP_TOKEN, "BEGIN"])
      expect(everything).not.toContain(secret);
  });

  test("a link is used once: a replay is refused and exchanges nothing", async () => {
    const f = await startFlow();
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
    exchanged = [];
    const again = await callback(f.state, "good-code", f.cookie);
    // The App exists now, so the replay is refused for that as well as for the nonce.
    expect(again.status).toBe(409);
    expect(exchanged).toEqual([]);
    expect(await ops()).toContainEqual(["github_app_manifest_callback", "error:app_exists"]);
  });

  test("the nonce alone refuses a replay when no App exists any more", async () => {
    const f = await startFlow();
    answer = () => new Response("nope", { status: 500 });
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(502);
    exchanged = [];
    // The conversion failed but the link was consumed: start again.
    const again = await callback(f.state, "good-code", f.cookie);
    expect(again.status).toBe(400);
    expect(exchanged).toEqual([]);
    expect(await ops()).toContainEqual(["github_app_manifest_callback", "error:nonce_used"]);
    expect(await getGithubApp(db)).toBeUndefined();
  });

  test("another browser cannot finish it: no cookie, or someone else's, is refused and burns nothing", async () => {
    const f = await startFlow();
    for (const cookie of [undefined, "forged-nonce"]) {
      const res = await callback(f.state, "good-code", cookie);
      expect(res.status).toBe(403);
    }
    expect(exchanged).toEqual([]);
    expect(await getGithubApp(db)).toBeUndefined();
    // The real browser still can.
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
    expect(await ops()).toContainEqual(["github_app_manifest_callback", "error:no_binding"]);
  });

  test("a forged, altered or foreign state is refused", async () => {
    const f = await startFlow();
    const [v, body, sig] = f.state!.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const edited = Buffer.from(JSON.stringify({ ...payload, o: otherOrgId })).toString("base64url");
    const longer = Buffer.from(JSON.stringify({ ...payload, r: true })).toString("base64url");
    for (const bad of [
      `${v}.${edited}.${sig}`,
      `${v}.${longer}.${sig}`,
      `${v}.${body}.${sig.slice(1)}x`,
      `${v}.${body}`,
      "nope",
      "",
      `v1.${body}.${sig}`,
    ]) {
      const res = await callback(bad, "good-code", f.cookie);
      expect(res.status).toBe(400);
    }
    expect(exchanged).toEqual([]);
    expect(await getGithubApp(db)).toBeUndefined();
  });

  test("a state expires after 15 minutes", async () => {
    const f = await startFlow();
    now += MANIFEST_TTL_MS + 1;
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(400);
    expect(exchanged).toEqual([]);
  });

  test("a malformed code never reaches GitHub", async () => {
    const f = await startFlow();
    const res = await callback(f.state, "../evil", f.cookie);
    expect(res.status).toBe(502);
    expect(exchanged).toEqual([]);
  });

  test("only GET reaches the callback", async () => {
    const res = (await handler.handle(
      new Request(`${BASE}${MANIFEST_CALLBACK_PATH}`, { method: "POST" }),
    ))!;
    expect(res.status).toBe(405);
  });
});

describe("a second create", () => {
  const createFirst = async () => {
    const f = await startFlow();
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
  };

  test("is refused unless a replace is asked for, and the refusal is audited", async () => {
    await createFirst();
    const res = (await handler.handle(asOperator({ org: "acme" })))!;
    expect(res.status).toBe(409);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await ops()).toContainEqual(["github_app_manifest_start", "error:app_exists"]);
    expect((await getGithubApp(db))!.appId).toBe("4242");
  });

  test("a replace needs the same owning org", async () => {
    await createFirst();
    const res = (await handler.handle(asOperator({ org: "other", rotate: "1" })))!;
    expect(res.status).toBe(409);
    expect((await getGithubApp(db))!.orgId).toBe(orgId);
  });

  test("a replace swaps the App and its credentials, drops cached tokens, and is audited", async () => {
    await createFirst();
    const old = first;
    const next = conv(7);
    answer = () => Response.json(next, { status: 201 });
    const f = await startFlow({ rotate: "1" });
    expect(f.res.status).toBe(200);
    expect((await callback(f.state, "second-code", f.cookie)).status).toBe(200);
    const app = (await getGithubApp(db))!;
    expect(app.appId).toBe("7");
    expect(await store.get(orgId, SECRET_APP_ID)).toBe("7");
    expect(await store.get(orgId, SECRET_WEBHOOK)).toBe(next.webhook_secret);
    expect(await store.get(orgId, SECRET_WEBHOOK)).not.toBe(old.webhook_secret);
    expect(replacedCalls).toBe(1);
    const row = (await chainedAudit(db, orgId, 0, 100)).find((r) => r.op === "github_app_replace")!;
    expect(row.outcome).toBe("ok");
    expect(String(row.input)).toContain("4242");
  });

  test("a link started for a first create cannot replace an App that appeared meanwhile", async () => {
    const f = await startFlow();
    // Another flow completes first.
    const g = await startFlow();
    expect((await callback(g.state, "good-code", g.cookie)).status).toBe(200);
    exchanged = [];
    answer = () => Response.json(conv(8), { status: 201 });
    const res = await callback(f.state, "late-code", f.cookie);
    expect(res.status).toBe(409);
    expect(exchanged).toEqual([]);
    expect((await getGithubApp(db))!.appId).toBe("4242");
  });
});

describe("construction", () => {
  test("a setup token hash that is not a sha256 is refused at start up", () => {
    expect(() =>
      createHostedManifestHandler({ db, store, publicUrl: BASE, setupTokenSha256: "not-a-hash" }),
    ).toThrow(/64 hex/);
  });

  test("over plain http the cookie is not marked Secure (local use), and still HttpOnly", async () => {
    handler = createHostedManifestHandler({
      db,
      store,
      publicUrl: "http://localhost:8080",
      setupTokenSha256: hashToken(SETUP_TOKEN),
      now: () => now,
    });
    const cookie = (await startFlow()).res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
  });
});

describe("through the server", () => {
  test("the routes are served by the real server, and only when the handler is configured", async () => {
    const on = startServer({
      port: 0,
      host: "127.0.0.1",
      db,
      appManifest: handler,
      transport: { trustForwardedProto: false } as never,
    });
    const off = startServer({ port: 0, host: "127.0.0.1", db });
    try {
      const form = await fetch(`http://127.0.0.1:${on.port}${MANIFEST_PATH}`);
      expect(form.status).toBe(200);
      expect(await form.text()).toContain("Create the Longshore GitHub App");
      const refused = await fetch(`http://127.0.0.1:${on.port}${MANIFEST_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      });
      expect(refused.status).toBe(401);
      const cb = await fetch(`http://127.0.0.1:${on.port}${MANIFEST_CALLBACK_PATH}?state=x&code=y`);
      expect(cb.status).toBe(400);
      // Not configured: the paths do not exist.
      expect((await fetch(`http://127.0.0.1:${off.port}${MANIFEST_PATH}`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${off.port}${MANIFEST_CALLBACK_PATH}`)).status).toBe(
        404,
      );
    } finally {
      on.stop(true);
      off.stop(true);
    }
  });
});
