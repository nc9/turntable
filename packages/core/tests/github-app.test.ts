import { createVerify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getGithubApp, getInstallation, openDatabase } from "../src/db";
import { githubFacts } from "../src/github/api";
import {
  AppAuth,
  REFRESH_MARGIN_MS,
  SECRET_CLIENT,
  SECRET_PRIVATE_KEY,
  SECRET_WEBHOOK,
  SECRET_WEBHOOK_PREVIOUS,
  signAppJwt,
} from "../src/github/app-auth";
import {
  buildManifest,
  convertManifest,
  manifestPage,
  startManifestFlow,
  storeApp,
  type ManifestConversion,
} from "../src/github/manifest";
import { rotateWebhookSecret } from "../src/github/rotation";
import { WEBHOOK_PATH } from "../src/github/webhook";
import { rsa, setup } from "./github-helpers";

const b64uJson = (s: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

describe("App JWT", () => {
  test("RS256, iss is the app id, 9 minutes of life, verifies with the public key", () => {
    const now = 1_700_000_000_000;
    const jwt = signAppJwt("42", rsa.privateKey, now);
    const [h, p, sig] = jwt.split(".") as [string, string, string];
    expect(b64uJson(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = b64uJson(p) as { iat: number; exp: number; iss: string };
    expect(claims.iss).toBe("42");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBe(now / 1000 - 60);
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(rsa.publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("installation tokens (the single mint function)", () => {
  function fakeGithub() {
    const calls: { url: string; body: unknown; auth: string }[] = [];
    let n = 0;
    let expiresIn = 3_600_000;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: String((init?.headers as Record<string, string> | undefined)?.["authorization"]),
      });
      n += 1;
      return Response.json(
        { token: `ghs_token_${n}`, expires_at: new Date(clock.now + expiresIn).toISOString() },
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    return { impl, calls, setExpiry: (ms: number) => (expiresIn = ms) };
  }
  const clock = { now: 1_700_000_000_000 };

  test("scopes the token down per call, signs with an App JWT, and caches until 5 minutes before expiry", async () => {
    const { db, store } = await setup();
    const g = fakeGithub();
    const auth = new AppAuth({ db, store, fetch: g.impl, now: () => clock.now });
    const scope = {
      repositories: ["api"],
      permissions: { contents: "read", metadata: "read" },
    } as const;
    const a = await auth.mint("100", scope);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]?.url).toBe("https://api.github.com/app/installations/100/access_tokens");
    expect(g.calls[0]?.body).toEqual({
      repositories: ["api"],
      permissions: { contents: "read", metadata: "read" },
    });
    expect(g.calls[0]?.auth.startsWith("Bearer ey")).toBe(true);

    expect(
      (
        await auth.mint("100", {
          repositories: ["api"],
          permissions: { metadata: "read", contents: "read" },
        })
      ).token,
    ).toBe(a.token);
    expect(g.calls).toHaveLength(1);
    // Different scope, different token.
    expect((await auth.mint("100", { repositories: ["web"] })).token).not.toBe(a.token);
    expect(g.calls).toHaveLength(2);
    // Near expiry it refreshes.
    clock.now += 3_600_000 - REFRESH_MARGIN_MS + 1000;
    const b = await auth.mint("100", scope);
    expect(b.token).not.toBe(a.token);
    expect(g.calls).toHaveLength(3);
  });

  test("a GitHub failure surfaces without leaking anything, and no App means a clear error", async () => {
    const { db, store } = await setup();
    const bad = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(new AppAuth({ db, store, fetch: bad }).mint("100")).rejects.toThrow("HTTP 403");
    const empty = openDatabase(":memory:");
    await expect(new AppAuth({ db: empty, store }).mint("100")).rejects.toThrow(/no GitHub App/);
  });

  test("the API facts reader pages repositories and reads installation facts", async () => {
    const { db, store } = await setup();
    const reqs: string[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      reqs.push(u);
      if (u.endsWith("/access_tokens")) {
        return Response.json(
          { token: "ghs_x", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      }
      if (u.includes("/installation/repositories")) {
        const page = Number(new URL(u).searchParams.get("page"));
        const repos = Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({
          id: page * 1000 + i,
          name: `r${page}-${i}`,
          full_name: `acme/r${page}-${i}`,
          owner: { login: "acme" },
        }));
        return Response.json({ repositories: repos });
      }
      expect(
        String((init?.headers as Record<string, string>)?.authorization).startsWith("Bearer ey"),
      ).toBe(true);
      return Response.json({
        id: 100,
        app_id: 42,
        account: { login: "acme", id: 7, type: "Organization" },
        repository_selection: "all",
        suspended_at: null,
      });
    }) as unknown as typeof fetch;
    const facts = githubFacts(new AppAuth({ db, store, fetch: impl }), impl);
    expect(await facts.getInstallation("100")).toMatchObject({
      id: "100",
      appId: "42",
      suspended: false,
    });
    expect(await facts.listInstallationRepos("100")).toHaveLength(103);
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(
      await githubFacts(new AppAuth({ db, store }), notFound).getInstallation("1"),
    ).toBeUndefined();
  });
});

describe("manifest", () => {
  test("least privilege, the webhook URL, and no unsubscribable events", () => {
    const m = buildManifest({
      name: "Turntable",
      url: "https://ci.example.com/",
      redirectUrl: "http://127.0.0.1:9/callback",
    }) as {
      hook_attributes: { url: string };
      default_permissions: Record<string, string>;
      default_events: string[];
      public: boolean;
    };
    expect(m.hook_attributes.url).toBe(`https://ci.example.com${WEBHOOK_PATH}`);
    expect(m.default_permissions).toEqual({
      checks: "write",
      contents: "read",
      metadata: "read",
      pull_requests: "read",
    });
    expect(m.default_events).toEqual(["push", "pull_request", "check_run"]);
    expect(m.public).toBe(false);
  });

  test("public follows the claim flow", () => {
    const o = { name: "Turntable", url: "https://ci.example.com", redirectUrl: "http://x/cb" };
    expect(buildManifest(o).public).toBe(false);
    expect(buildManifest({ ...o, claimFlow: false }).public).toBe(false);
    expect(buildManifest({ ...o, claimFlow: true }).public).toBe(true);
  });

  test("the page posts the manifest to GitHub with the state, and escapes it", () => {
    const html = manifestPage({ name: 'a"<b>' }, "st4te", "my-org");
    expect(html).toContain(
      'action="https://github.com/organizations/my-org/settings/apps/new?state=st4te"',
    );
    expect(html).not.toContain('a"<b>');
    expect(manifestPage({}, "s")).toContain(
      'action="https://github.com/settings/apps/new?state=s"',
    );
  });

  const conv: ManifestConversion = {
    id: 4242,
    slug: "turntable-x",
    name: "Turntable",
    owner: { login: "acme" },
    html_url: "https://github.com/apps/turntable-x",
    client_id: "Iv1.client",
    client_secret: "client-secret-value-123",
    webhook_secret: "webhook-secret-value-123",
    pem: rsa.privateKey,
  };
  const convertImpl = ((url: string | URL | Request) => {
    expect(String(url)).toBe("https://api.github.com/app-manifests/good-code/conversions");
    return Promise.resolve(Response.json(conv, { status: 201 }));
  }) as unknown as typeof fetch;

  test("conversion rejects malformed codes and incomplete responses", async () => {
    await expect(convertManifest("../evil", convertImpl)).rejects.toThrow(/malformed/);
    const incomplete = (async () => Response.json({ id: 1 })) as unknown as typeof fetch;
    await expect(convertManifest("abc", incomplete)).rejects.toThrow(/incomplete/);
    expect((await convertManifest("good-code", convertImpl)).id).toBe(4242);
  });

  test("storing keeps every secret encrypted and returns none", async () => {
    const { db, org, store } = await setup("1");
    const out = await storeApp(db, store, org.id, conv);
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out).toEqual({
      appId: "4242",
      slug: "turntable-x",
      htmlUrl: conv.html_url,
      replaced: [],
      retired: { installations: 0, repos: 0 },
    });
    expect(await store.get(org.id, SECRET_PRIVATE_KEY)).toBe(conv.pem);
    expect(await store.get(org.id, SECRET_WEBHOOK)).toBe(conv.webhook_secret);
    expect(await store.get(org.id, SECRET_CLIENT)).toBe(conv.client_secret);
    expect((await store.list(org.id)).every((n) => n.startsWith("github-app/"))).toBe(true);
  });

  test("the loopback flow: form page, state check, one use, and the App is stored", async () => {
    const { db, org, store } = await setup("1");
    const flow = startManifestFlow({
      db,
      store,
      orgId: org.id,
      name: "Turntable",
      url: "https://ci.example.com",
      fetch: convertImpl,
    });
    const base = new URL(flow.pageUrl);
    const page = await fetch(flow.pageUrl);
    const html = await page.text();
    expect(html).toContain("settings/apps/new?state=");
    const state = /state=([0-9a-f]+)"/.exec(html)?.[1] as string;
    expect(html).toContain(
      `http://127.0.0.1:${base.port}/callback`.replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
    );

    // Wrong state: refused, nothing stored.
    const bad = await fetch(`${flow.pageUrl}callback?code=good-code&state=nope`);
    expect(bad.status).toBe(400);
    // A foreign Host header is refused (DNS rebinding).
    const rebinding = await fetch(flow.pageUrl, { headers: { host: "evil.example:80" } });
    expect(rebinding.status).toBe(400);

    const ok = await fetch(`${flow.pageUrl}callback?code=good-code&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await flow.done).toEqual({ appId: "4242", slug: "turntable-x", htmlUrl: conv.html_url });
    expect((await getGithubApp(db))?.appId).toBeDefined();
    expect(await store.get(org.id, SECRET_PRIVATE_KEY)).toBe(conv.pem);
    // The code works once: the state is spent.
    const again = await fetch(`${flow.pageUrl}callback?code=good-code&state=${state}`).catch(
      () => undefined,
    );
    expect(again === undefined || again.status === 400).toBe(true);
  });
});

describe("webhook secret rotation", () => {
  test("old becomes previous with an overlap window, new is pushed to GitHub", async () => {
    const { db, org, store } = await setup();
    const sent: { url: string; body: string }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const auth = new AppAuth({ db, store });
    const before = (await store.get(org.id, SECRET_WEBHOOK)) as string;
    const r = await rotateWebhookSecret(db, store, auth, {
      fetch: impl,
      now: () => 1000,
      overlapMs: 5000,
    });
    expect(r.overlapUntil).toBe(6000);
    expect(await store.get(org.id, SECRET_WEBHOOK_PREVIOUS)).toBe(before);
    const fresh = (await store.get(org.id, SECRET_WEBHOOK)) as string;
    expect(fresh).not.toBe(before);
    expect(sent[0]?.url).toBe("https://api.github.com/app/hook/config");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({ secret: fresh });
    expect((await getGithubApp(db))?.previousSecretExpiresAt).toBe(6000);
  });

  test("if GitHub refuses, nothing changes", async () => {
    const { db, org, store } = await setup();
    const before = (await store.get(org.id, SECRET_WEBHOOK)) as string;
    const refuse = (async () => new Response("no", { status: 422 })) as unknown as typeof fetch;
    await expect(
      rotateWebhookSecret(db, store, new AppAuth({ db, store }), { fetch: refuse }),
    ).rejects.toThrow(/HTTP 422/);
    expect(await store.get(org.id, SECRET_WEBHOOK)).toBe(before);
    expect((await getGithubApp(db))?.previousSecretExpiresAt).toBeNull();
    expect(await getInstallation(db, "x")).toBeUndefined();
  });
});
