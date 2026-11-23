import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resetFailureThrottle } from "../src/audit/failures";
import {
  bindRepo,
  chainedAudit,
  consumeInstallationClaim,
  consumeManifestNonce,
  createInstallationClaim,
  createManifestNonce,
  createOrg,
  createProject,
  getGithubApp,
  getInstallationClaim,
  listInstallationBindings,
  openDatabase,
  setGithubApp,
  upsertInstallation,
  getInstallation,
  type Db,
} from "../src/db";
import * as schema from "../src/db/schema";
import { eq } from "drizzle-orm";
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
  MAX_BODY_BYTES,
  SECRET_MANIFEST_KEY,
  SETUP_FAILURES_PER_MINUTE,
  type HostedManifestHandler,
} from "../src/github/hosted-manifest";
import { AppStateError, storeApp, type ManifestConversion } from "../src/github/manifest";
import { hashToken } from "../src/ops/tokens";
import { startServer } from "../src/server";
import { SecretStore } from "../src/secrets/store";
import { rsa } from "./github-helpers";

const BASE = "https://ci.example.test";
// Built at run time: a literal in this shape trips secret scanners.
const SETUP_TOKEN = ["setup", "token", randomBytes(12).toString("hex")].join("-");
const conv = (id: number): ManifestConversion => ({
  id,
  slug: `turntable-${id}`,
  name: "Turntable CI",
  owner: { login: "acme" },
  html_url: `https://github.com/apps/turntable-${id}`,
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
/** What the App's own webhook config says when read back with its credentials. */
let hookUrl: string;
let hookReads: number;
/** What GitHub says about the new App (GET /app), unless a test changes it. */
let appOverride: ((app: Record<string, unknown>) => Record<string, unknown>) | undefined;
let lastConv: ManifestConversion | undefined;

const make = (extra: { claimFlow?: boolean } = {}) =>
  createHostedManifestHandler({
    db,
    store,
    publicUrl: BASE,
    setupTokenSha256: hashToken(SETUP_TOKEN),
    now: () => now,
    log: (l) => logs.push(l),
    ownerOrgSlugs: ["acme"],
    onReplaced: () => (replacedCalls += 1),
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith("/app")) {
        const c = lastConv!;
        const info = {
          name: c.name,
          slug: c.slug,
          owner: { login: c.owner.login },
          permissions: {
            checks: "write",
            contents: "read",
            metadata: "read",
            pull_requests: "read",
          },
          events: ["push", "pull_request", "check_run"],
        };
        return Response.json(appOverride ? appOverride(info) : info);
      }
      if (String(url).endsWith("/app/hook/config")) {
        hookReads += 1;
        return hookUrl === ""
          ? new Response("no", { status: 403 })
          : Response.json({ url: hookUrl });
      }
      const code = /app-manifests\/([^/]+)\/conversions/.exec(String(url))?.[1] ?? "";
      exchanged.push(code);
      const r = answer(code);
      lastConv = (await r
        .clone()
        .json()
        .catch(() => undefined)) as ManifestConversion | undefined;
      return r;
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
  hookUrl = `${BASE}/api/v1/webhooks/github`;
  hookReads = 0;
  appOverride = undefined;
  lastConv = undefined;
  first = conv(4242);
  answer = () => Response.json(first, { status: 201 });
  resetFailureThrottle();
  handler = make();
});

/** Marks the open flow finished, as a callback would, so another may start. */
const releaseFlow = () => db.orm.update(schema.installationClaims).set({ usedAt: now });

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

  test("failed attempts are bounded per client, and a correct token is never throttled", async () => {
    const bad = (i: number, from: string) =>
      handler.handle(form({ org: "acme", setup_token: `bad${i}` }), from);
    for (let i = 0; i < SETUP_FAILURES_PER_MINUTE; i++)
      expect((await bad(i, "198.51.100.1"))!.status).toBe(401);
    // That client is now throttled...
    expect((await bad(99, "198.51.100.1"))!.status).toBe(429);
    // ...but the operator, with the right token, is not, even from the saturated address,
    expect((await handler.handle(asOperator({ org: "acme" }), "198.51.100.1"))!.status).toBe(200);
    // and noise from one address cannot lock out another.
    expect((await bad(0, "198.51.100.2"))!.status).toBe(401);
    now += 61_000;
    expect((await bad(100, "198.51.100.1"))!.status).toBe(401);
  });

  test("a forwarded-for header does not move a client to a fresh budget unless its proxy is trusted", async () => {
    for (let i = 0; i < SETUP_FAILURES_PER_MINUTE; i++)
      await handler.handle(form({ org: "acme", setup_token: `bad${i}` }), "198.51.100.1");
    const spoof = new Request(`${BASE}${MANIFEST_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "192.0.2.77",
      },
      body: "org=acme&setup_token=bad",
    });
    expect((await handler.handle(spoof, "198.51.100.1"))!.status).toBe(429);
  });

  test("the setup token works as a bearer header or a form field, and a good start gives the manifest page", async () => {
    for (const how of ["bearer", "field"] as const) {
      const f = await startFlow({}, how);
      expect(f.res.status).toBe(200);
      expect(f.state).toMatch(/^m1\./);
      expect(f.cookie).toBeTruthy();
      expect(f.html).toContain("https://github.com/settings/apps/new?state=");
      await releaseFlow();
    }
  });

  test("the manifest asks for least privilege and points back at this instance", async () => {
    const f = await startFlow({ gh_org: "acme-inc", name: "Turntable CI" });
    expect(f.html).toContain("https://github.com/organizations/acme-inc/settings/apps/new?state=");
    const m = JSON.parse(
      f
        .manifest!.replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">"),
    ) as Record<string, any>;
    expect(m.name).toBe("Turntable CI");
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
    await releaseFlow();
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
    // An org outside the allowed list is refused; an allowed slug with no org is not found.
    expect((await handler.handle(asOperator({ org: "nope" })))!.status).toBe(403);
    const open = createHostedManifestHandler({
      db,
      store,
      publicUrl: BASE,
      setupTokenSha256: hashToken(SETUP_TOKEN),
      now: () => now,
    });
    expect((await open.handle(asOperator({ org: "nope" })))!.status).toBe(404);
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
    expect(html).toContain("turntable-4242");
    expect(html).toContain("https://github.com/apps/turntable-4242/installations/new");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(exchanged).toEqual(["good-code"]);

    const app = (await getGithubApp(db))!;
    expect([app.appId, app.orgId, app.slug]).toEqual(["4242", orgId, "turntable-4242"]);
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

  test("a stolen state is not enough: the nonce in it is not the cookie secret", async () => {
    const f = await startFlow();
    const body = f.state!.split(".")[1]!;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      n: string;
      k: string;
    };
    // Everything an eavesdropper on the URL sees: the state, and so the nonce and the MAC.
    for (const guess of [payload.n, payload.k, f.state!]) {
      const res = await callback(f.state, "attacker-code", guess);
      expect(res.status).toBe(403);
    }
    expect(f.state).not.toContain(f.cookie!);
    expect(exchanged).toEqual([]);
    expect(await getGithubApp(db)).toBeUndefined();
    expect(await ops()).toContainEqual(["github_app_manifest_callback", "error:no_binding"]);
    // The link was not burned by the failed guesses: the real browser finishes.
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
  });

  test("each flow has its own cookie secret, and one flow's cookie does not open another's state", async () => {
    const a = await startFlow();
    const b = await startFlow();
    expect(a.cookie).not.toBe(b.cookie);
    expect((await callback(a.state, "good-code", b.cookie)).status).toBe(403);
    expect(exchanged).toEqual([]);
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
    // The route also closes after a success, so open it again to test the App check itself.
    expect(res.status).toBe(410);
    handler = make();
    const again = (await handler.handle(asOperator({ org: "acme" })))!;
    expect(again.status).toBe(409);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(await ops()).toContainEqual(["github_app_manifest_start", "error:app_exists"]);
    expect((await getGithubApp(db))!.appId).toBe("4242");
  });

  test("a replace needs the same owning org", async () => {
    await createFirst();
    handler = createHostedManifestHandler({
      db,
      store,
      publicUrl: BASE,
      setupTokenSha256: hashToken(SETUP_TOKEN),
      now: () => now,
      ownerOrgSlugs: ["acme", "other"],
    });
    const res = (await handler.handle(asOperator({ org: "other", rotate: "1" })))!;
    expect(res.status).toBe(409);
    expect((await getGithubApp(db))!.orgId).toBe(orgId);
  });

  test("a replace swaps the App and its credentials, drops cached tokens, and is audited", async () => {
    await createFirst();
    handler = make();
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

  test("a replace retires the old App's installations and bindings, audits the count and says so", async () => {
    await createFirst();
    const project = await createProject(db, { orgId }, { slug: "web", name: "Web" });
    await upsertInstallation(
      db,
      { orgId },
      {
        installationId: "900",
        appId: "4242",
        accountLogin: "acme",
        accountId: "1",
        accountType: "Organization",
        repositorySelection: "all",
        status: "active",
      },
    );
    await bindRepo(
      db,
      { orgId, projectId: project.id },
      {
        forge: "github",
        owner: "acme",
        repo: "web",
        installationId: "900",
      },
    );
    handler = make();
    const next = conv(8);
    answer = () => Response.json(next, { status: 201 });
    const f = await startFlow({ rotate: "1" });
    const res = await callback(f.state, "second-code", f.cookie);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(
      "1 installation(s) of it were marked deleted and 1 repository binding(s)",
    );
    expect((await getInstallation(db, "900"))?.status).toBe("deleted");
    expect(await listInstallationBindings(db, { orgId }, "900")).toEqual([]);
    const row = (await chainedAudit(db, orgId, 0, 100)).find((r) => r.op === "github_app_replace")!;
    expect(String(row.input)).toContain('"retired_installations":1');
    expect(String(row.input)).toContain('"unbound_repositories":1');
  });

  test("a link started for a first create cannot replace an App that appeared meanwhile", async () => {
    const f = await startFlow();
    // Another way of creating one (the CLI) finishes first.
    await setGithubApp(
      db,
      { orgId },
      {
        appId: "99",
        slug: "other-app",
        name: "x",
        ownerLogin: "acme",
        htmlUrl: "https://github.com/apps/other-app",
        clientId: "Iv1.x",
      },
    );
    const res = await callback(f.state, "late-code", f.cookie);
    expect(res.status).toBe(409);
    expect(exchanged).toEqual([]);
    expect((await getGithubApp(db))!.appId).toBe("99");
  });
});

describe("storing is one transaction, rechecked inside it", () => {
  test("an App that exists is refused inside the transaction even if the caller's check was stale", async () => {
    await setGithubApp(
      db,
      { orgId },
      {
        appId: "99",
        slug: "other-app",
        name: "x",
        ownerLogin: "acme",
        htmlUrl: "https://github.com/apps/other-app",
        clientId: "Iv1.x",
      },
    );
    const c = conv(5);
    await expect(storeApp(db, store, orgId, c, { existing: "refuse" })).rejects.toBeInstanceOf(
      AppStateError,
    );
    await expect(
      storeApp(db, store, otherOrgId, c, { existing: "replace" }),
    ).rejects.toBeInstanceOf(AppStateError);
    expect((await getGithubApp(db))!.appId).toBe("99");
    expect(await store.get(orgId, SECRET_APP_ID)).toBeUndefined();
  });

  test("a failure part way leaves nothing: no App row, no secret, the old App untouched", async () => {
    await setGithubApp(
      db,
      { orgId },
      {
        appId: "99",
        slug: "other-app",
        name: "x",
        ownerLogin: "acme",
        htmlUrl: "https://github.com/apps/other-app",
        clientId: "Iv1.x",
      },
    );
    await store.set(orgId, SECRET_APP_ID, "99");
    let sets = 0;
    const failing = {
      set: (o: string, n: string, v: string) => {
        sets += 1;
        if (sets === 3) return Promise.reject(new Error("disk full"));
        return store.set(o, n, v);
      },
    } as unknown as SecretStore;
    await expect(storeApp(db, failing, orgId, conv(5), { existing: "replace" })).rejects.toThrow(
      "disk full",
    );
    expect((await getGithubApp(db))!.appId).toBe("99");
    expect(await store.get(orgId, SECRET_APP_ID)).toBe("99");
    expect(await store.get(orgId, SECRET_PRIVATE_KEY)).toBeUndefined();
  });

  test("two concurrent callbacks never mix one App's key with another's id", async () => {
    // Two flows cannot be open at once, so race the callbacks of two sequential-but-overlapping
    // starts by finishing each state's nonce row by hand and calling both callbacks together.
    const a = await startFlow({ rotate: "1" });
    await releaseFlow();
    // releaseFlow marked a's nonce used, so a is refused; a fresh flow is the one that lands.
    const b = await startFlow({ rotate: "1" });
    const c7 = conv(7);
    answer = () => Response.json(c7, { status: 201 });
    const [ra, rb] = await Promise.all([
      callback(a.state, "code-a", a.cookie),
      callback(b.state, "code-b", b.cookie),
    ]);
    expect([ra.status, rb.status].toSorted()).toEqual([200, 400]);
    const app = (await getGithubApp(db))!;
    expect(app.appId).toBe("7");
    expect(await store.get(orgId, SECRET_APP_ID)).toBe("7");
    expect(await store.get(orgId, SECRET_WEBHOOK)).toBe(c7.webhook_secret);
    expect(
      (
        await db.run((h) =>
          h.orm.select().from(schema.githubApps).where(eq(schema.githubApps.orgId, orgId)),
        )
      ).length,
    ).toBe(1);
  });
});

describe("the route is guarded", () => {
  test("only the system or bootstrap org may own the App, never a customer org", async () => {
    const res = (await handler.handle(asOperator({ org: "other" })))!;
    expect(res.status).toBe(403);
    expect(await store.get(otherOrgId, SECRET_MANIFEST_KEY)).toBeUndefined();
  });

  test("the form prefills the owning org", async () => {
    const html = await (await handler.handle(new Request(`${BASE}${MANIFEST_PATH}`)))!.text();
    expect(html).toContain('value="acme"');
  });

  test("one flow at a time: a second start waits for the first to finish or expire", async () => {
    expect((await startFlow()).res.status).toBe(200);
    const second = (await handler.handle(asOperator({ org: "acme" })))!;
    expect(second.status).toBe(409);
    expect(await ops()).toContainEqual(["github_app_manifest_start", "error:flow_in_progress"]);
    now += MANIFEST_TTL_MS + 1;
    expect((await handler.handle(asOperator({ org: "acme" })))!.status).toBe(200);
  });

  test("it closes after the first success, until restart", async () => {
    const f = await startFlow();
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
    for (const req of [
      asOperator({ org: "acme", rotate: "1" }),
      new Request(`${BASE}${MANIFEST_PATH}`),
    ]) {
      expect((await handler.handle(req))!.status).toBe(410);
    }
    // A restart (a new handler) opens it again.
    expect((await make().handle(new Request(`${BASE}${MANIFEST_PATH}`)))!.status).toBe(200);
  });

  test("it closes a few hours after start up even if nothing was created", async () => {
    handler = createHostedManifestHandler({
      db,
      store,
      publicUrl: BASE,
      setupTokenSha256: hashToken(SETUP_TOKEN),
      now: () => now,
      openForMs: 60_000,
    });
    expect((await handler.handle(asOperator({ org: "acme" })))!.status).toBe(200);
    now += 61_000;
    expect((await handler.handle(asOperator({ org: "acme" })))!.status).toBe(410);
    expect((await handler.handle(new Request(`${BASE}${MANIFEST_PATH}`)))!.status).toBe(410);
  });

  test("the body is capped before it is parsed and before the token is looked at", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const withLength = new Request(`${BASE}${MANIFEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `setup_token=bad&pad=${big}`,
    });
    expect((await handler.handle(withLength))!.status).toBe(413);
    // No declared length: a stream is cut off as soon as it is over the cap.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 1024;
        c.enqueue(new TextEncoder().encode("a".repeat(1024)));
        if (sent > 1024 * 64) c.close();
      },
    });
    const chunked = new Request(`${BASE}${MANIFEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await handler.handle(chunked))!.status).toBe(413);
    expect(sent).toBeLessThan(1024 * 16);
    // Not counted as a failed token attempt: the operator is not throttled afterwards.
    for (let i = 0; i < SETUP_FAILURES_PER_MINUTE + 2; i++)
      await handler.handle(
        new Request(`${BASE}${MANIFEST_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `setup_token=bad&pad=${big}`,
        }),
      );
    expect((await handler.handle(asOperator({ org: "acme" })))!.status).toBe(200);
  });

  test("a state with a malformed org id or nonce is refused before any key is read", async () => {
    let reads = 0;
    const spy = {
      get: (o: string, n: string) => {
        reads += 1;
        return store.get(o, n);
      },
      set: store.set.bind(store),
    } as unknown as SecretStore;
    const h = createHostedManifestHandler({
      db,
      store: spy,
      publicUrl: BASE,
      setupTokenSha256: hashToken(SETUP_TOKEN),
      now: () => now,
    });
    const good = await startFlow();
    reads = 0;
    const body = good.state!.split(".")[1]!;
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    for (const bad of [
      { ...p, o: "../x" },
      { ...p, o: 7 },
      { ...p, n: "short" },
      { ...p, k: "x" },
      { ...p, m: "<script>" },
      { ...p, g: "a b" },
    ]) {
      const b = Buffer.from(JSON.stringify(bad)).toString("base64url");
      const res = (await h.handle(
        new Request(`${BASE}${MANIFEST_CALLBACK_PATH}?code=c&state=m1.${b}.${"A".repeat(43)}`),
      ))!;
      expect(res.status).toBe(400);
    }
    expect(reads).toBe(0);
  });
});

describe("the App that comes back must be the one that was asked for", () => {
  const refused = async (fields: Record<string, string> = {}) => {
    const f = await startFlow(fields);
    const res = await callback(f.state, "good-code", f.cookie);
    expect(res.status).toBe(502);
    expect(await getGithubApp(db)).toBeUndefined();
    for (const name of [SECRET_APP_ID, SECRET_PRIVATE_KEY, SECRET_WEBHOOK, SECRET_CLIENT])
      expect(await store.get(orgId, name)).toBeUndefined();
    expect(await ops()).toContainEqual(["github_app_manifest_callback", "error:app_mismatch"]);
    return res;
  };

  test("a code for an App whose webhook points somewhere else stores nothing", async () => {
    hookUrl = "https://attacker.example.test/hook";
    await refused();
    expect(hookReads).toBe(1);
  });

  test("an unreadable webhook config stores nothing", async () => {
    hookUrl = "";
    await refused();
  });

  test("an App owned by another account than the requested organization stores nothing", async () => {
    first = { ...conv(4242), owner: { login: "someone-else" } };
    await refused({ gh_org: "acme-inc" });
  });

  test("an owner that matches the requested organization is accepted, whatever the case", async () => {
    first = { ...conv(4242), owner: { login: "ACME-Inc" } };
    const f = await startFlow({ gh_org: "acme-inc" });
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
  });

  test("a name other than the requested one stores nothing", async () => {
    first = { ...conv(4242), name: "Something Else" };
    await refused({ name: "Turntable" });
  });

  test("the name is compared without regard to case or edge spaces", async () => {
    first = { ...conv(4242), name: " turntable ci " };
    const f = await startFlow({ name: "Turntable CI" });
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
  });

  test("permissions broader than the manifest's store nothing, narrower or equal are fine", async () => {
    appOverride = (a) => ({
      ...a,
      permissions: { checks: "write", contents: "write", metadata: "read" },
    });
    await refused();
    await releaseFlow();
    appOverride = (a) => ({ ...a, permissions: { checks: "write", administration: "read" } });
    await refused();
    await releaseFlow();
    appOverride = (a) => ({ ...a, permissions: { contents: "read", checks: "read" } });
    const f = await startFlow();
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
  });

  test("events beyond the manifest's store nothing", async () => {
    appOverride = (a) => ({ ...a, events: ["push", "pull_request", "check_run", "issues"] });
    await refused();
  });

  test("an owner that GitHub reports differently from the conversion stores nothing", async () => {
    appOverride = (a) => ({ ...a, owner: { login: "someone-else" } });
    await refused();
  });

  test("an App page that is not on github.com stores nothing", async () => {
    first = { ...conv(4242), html_url: "https://evil.example.test/apps/turntable-4242" };
    await refused();
  });

  test("a failed exchange or store audits a class, never the error text", async () => {
    handler = createHostedManifestHandler({
      db,
      store,
      publicUrl: BASE,
      setupTokenSha256: hashToken(SETUP_TOKEN),
      now: () => now,
      ownerOrgSlugs: ["acme"],
      log: (l) => logs.push(l),
      fetch: (async () => {
        throw new Error("leaky-detail-pem-and-secret-123");
      }) as never,
    });
    const f = await startFlow();
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(502);
    const everything = JSON.stringify(await chainedAudit(db, orgId, 0, 100)) + logs.join("\n");
    expect(everything).not.toContain("leaky-detail");
    expect(await ops()).toContainEqual(["github_app_manifest_callback", "error:exchange_failed"]);
  });

  test("the credentials of a refused App are not in the audit chain or the log", async () => {
    hookUrl = "https://attacker.example.test/hook";
    await refused();
    const everything = JSON.stringify(await chainedAudit(db, orgId, 0, 100)) + logs.join("\n");
    for (const secret of [first.client_secret, first.webhook_secret, "BEGIN"])
      expect(everything).not.toContain(secret);
  });

  test("the read-back is made with the new App's own JWT, never with a stored credential", async () => {
    const seen: string[] = [];
    handler = createHostedManifestHandler({
      db,
      store,
      publicUrl: BASE,
      setupTokenSha256: hashToken(SETUP_TOKEN),
      now: () => now,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/app/hook/config")) {
          const hdrs = (init?.headers ?? {}) as Record<string, string>;
          seen.push(String(hdrs.authorization));
          return Response.json({ url: `${BASE}/api/v1/webhooks/github` });
        }
        return Response.json(first, { status: 201 });
      }) as never,
    });
    const f = await startFlow();
    expect((await callback(f.state, "good-code", f.cookie)).status).toBe(200);
    expect(seen).toHaveLength(1);
    const [h, p] = seen[0]!.replace("Bearer ", "").split(".") as [string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p, "base64url").toString()).iss).toBe("4242");
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
      expect(await form.text()).toContain("Create the Turntable GitHub App");
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

describe("manifest nonces and installation claims never consume each other", () => {
  const gh = { userId: "1", login: "acme" };

  test("an app-manifest: nonce row cannot be consumed or read as an installation claim", async () => {
    await createManifestNonce(
      db,
      { orgId },
      { nonce: "m-nonce", startedBy: "u", expiresAt: now + 1000 },
    );
    expect(await getInstallationClaim(db, "m-nonce")).toBeUndefined();
    expect(await consumeInstallationClaim(db, "m-nonce", "99", now, gh)).toBeUndefined();
    // Untouched: the manifest flow can still consume it.
    expect(await consumeManifestNonce(db, "m-nonce", now)).toBe(true);
  });

  test("an installation claim row cannot be consumed as a manifest nonce", async () => {
    await createInstallationClaim(
      db,
      { orgId },
      { nonce: "c-nonce", startedBy: "u", expiresAt: now + 1000 },
    );
    expect(await consumeManifestNonce(db, "c-nonce", now)).toBe(false);
    expect((await consumeInstallationClaim(db, "c-nonce", "99", now, gh))?.nonce).toBe("c-nonce");
  });
});
