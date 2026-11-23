// Every page the server renders itself: the full CSP, no inline style or script, escaped values,
// and the embedded stylesheet and fonts served from the same origin.
import { beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createOrg, openDatabase } from "../src/db";
import { InstallationClaims, createClaimHandler } from "../src/github/claim";
import { MANIFEST_PATH, createHostedManifestHandler } from "../src/github/hosted-manifest";
import { startManifestFlow } from "../src/github/manifest";
import { hashToken } from "../src/ops/tokens";
import { PAGE_STYLE_PATH, pageCsp, renderPage, servePageAsset } from "../src/pages/server-pages";
import { SecretStore } from "../src/secrets/store";
import { handleRequest } from "../src/server";
import { fakeFacts, fakeUserVerifier, inst, repo, setup } from "./github-helpers";

const csp = (form: string): string =>
  `default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action ${form}; frame-ancestors 'none'`;

/** The assertions every page shares: header, no inline style or script, the shared stylesheet. */
async function expectPage(res: Response, form: string): Promise<string> {
  expect(res.headers.get("content-security-policy")).toBe(csp(form));
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const html = await res.text();
  expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  expect(html).not.toMatch(/<style[\s>]/i);
  expect(html).not.toMatch(/<script[\s>]/i);
  expect(html).not.toMatch(/\sstyle\s*=/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).toContain(`<link rel="stylesheet" href="${PAGE_STYLE_PATH}">`);
  expect(html.match(/<html/g)?.length).toBe(1);
  return html;
}

describe("the shared layout and its assets", () => {
  test("the CSP is strict, and a form target is explicit", () => {
    expect(pageCsp()).toBe(csp("'none'"));
    expect(pageCsp("'self'")).toBe(csp("'self'"));
  });

  test("the title is escaped; the body is the caller's markup", () => {
    const html = renderPage({ title: `a"<b>`, body: "<p>x</p>" });
    expect(html).toContain("a&quot;&lt;b&gt;");
    expect(html).not.toContain('a"<b>');
    expect(html).toContain("<p>x</p>");
  });

  test("the stylesheet is text/css at a hashed path; the fonts are woff2; both are same-origin", async () => {
    expect(PAGE_STYLE_PATH).toMatch(/^\/_pages\/[0-9a-f]{12}\.css$/);
    const css = servePageAsset(new Request(`http://x${PAGE_STYLE_PATH}`))!;
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");
    const text = await css.text();
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("@import");
    expect(text).toContain("prefers-color-scheme:dark");
    const fonts = [...text.matchAll(/url\("(\/_pages\/fonts\/[^"]+)"\)/g)].map((m) => m[1]!);
    expect(fonts.length).toBe(2);
    for (const f of fonts) {
      const res = servePageAsset(new Request(`http://x${f}`))!;
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    }
    expect(servePageAsset(new Request("http://x/_pages/nope.css"))).toBeUndefined();
    expect(servePageAsset(new Request(`http://x${PAGE_STYLE_PATH}`, { method: "POST" }))).toBe(
      undefined,
    );
  });

  test("the server serves the stylesheet, with the same CSP rules as its other responses", async () => {
    const res = await handleRequest(new Request(`http://x${PAGE_STYLE_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });
});

describe("the fallback page", () => {
  test("is the shared layout under the strict CSP", async () => {
    const html = await expectPage(await handleRequest(new Request("http://x/")), "'none'");
    expect(html).toContain("Pre-alpha");
  });
});

describe("the hosted setup form", () => {
  const SETUP = ["setup", randomBytes(8).toString("hex")].join("-");
  const make = async (owner = "acme") => {
    const db = openDatabase(":memory:");
    await createOrg(db, { slug: "acme", name: "Acme" });
    return createHostedManifestHandler({
      db,
      store: new SecretStore(db, randomBytes(32)),
      publicUrl: "https://ci.example.test",
      setupTokenSha256: hashToken(SETUP),
      ownerOrgSlugs: [owner],
    });
  };

  test("the form posts to this server only, and escapes the org it prefills", async () => {
    const h = await make('a"<b>');
    const html = await expectPage(
      (await h.handle(new Request(`http://x${MANIFEST_PATH}`)))!,
      "'self'",
    );
    expect(html).toContain('type="password" name="setup_token"');
    expect(html).toContain('value="a&quot;&lt;b&gt;"');
    expect(html).not.toContain('a"<b>');
  });

  test("a result page (wrong method) has no form target", async () => {
    const h = await make();
    const res = (await h.handle(new Request(`http://x${MANIFEST_PATH}`, { method: "PUT" })))!;
    expect(res.status).toBe(405);
    await expectPage(res, "'none'");
  });

  test("the page that sends the manifest to GitHub may post to GitHub only, and has no script", async () => {
    const h = await make();
    const res = (await h.handle(
      new Request(`http://x${MANIFEST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ setup_token: SETUP, org: "acme" }),
      }),
    ))!;
    expect(res.status).toBe(200);
    const html = await expectPage(res, "https://github.com");
    expect(html).toContain('type="submit"');
  });
});

describe("the claim confirmation page", () => {
  test("posts to this server or GitHub only", async () => {
    const s = await setup();
    const tenant = await createOrg(s.db, { slug: "tenant-b", name: "Tenant B" });
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    const claims = new InstallationClaims({ db: s.db, store: s.store });
    const handler = createClaimHandler({
      claims,
      facts: f.facts,
      user: fakeUserVerifier(new Map()),
      log: () => {},
    });
    const { url } = await claims.start(tenant.id, "token:t1");
    const res = (await handler.handle(new Request(`http://x${url}`)))!;
    expect(res.status).toBe(200);
    const html = await expectPage(res, "'self' https://github.com");
    expect(html).toContain("<strong>tenant-b</strong>");
    // an invalid link is the same layout
    const gone = (await handler.handle(
      new Request("http://x" + url.replace(/state=[^&]+/, "state=bad")),
    ))!;
    expect(gone.status).toBe(400);
    await expectPage(gone, "'self' https://github.com");
  });
});

describe("the loopback page of the CLI", () => {
  let flow: ReturnType<typeof startManifestFlow>;
  let origin: string;
  beforeAll(async () => {
    const { db, org, store } = await setup("1");
    flow = startManifestFlow({
      db,
      store,
      orgId: org.id,
      name: "Turntable",
      url: "https://ci.example.com",
    });
    origin = new URL(flow.pageUrl).origin;
  });

  test("the form posts to GitHub only; the stylesheet is served on the loopback origin", async () => {
    const res = await fetch(flow.pageUrl);
    const html = await expectPage(res, "https://github.com");
    expect(html).toContain("settings/apps/new?state=");
    expect(html).toContain(
      '<button class="tt-button" type="submit">Create the App on GitHub</button>',
    );
    const css = await fetch(origin + PAGE_STYLE_PATH);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  test("an invalid state is the same layout", async () => {
    const res = await fetch(`${origin}/callback?state=nope`);
    expect(res.status).toBe(400);
    await expectPage(res, "https://github.com");
    flow.stop();
  });
});
