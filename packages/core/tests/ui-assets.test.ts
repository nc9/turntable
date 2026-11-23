import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/server";
import { registerUiAssets, uiCsp } from "../src/ui-assets";

afterEach(() => registerUiAssets(null));

function fixture(): void {
  const dir = mkdtempSync(join(tmpdir(), "tt-ui-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>UI</title>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  registerUiAssets({
    "/index.html": join(dir, "index.html"),
    "/assets/app-1.js": join(dir, "app.js"),
  });
}

const get = (path: string, method = "GET") =>
  handleRequest(new Request(`http://localhost${path}`, { method }));

test("serves the app shell at / and for client-side routes, with a strict CSP", async () => {
  fixture();
  for (const path of ["/", "/acme/api/runs/01ABC"]) {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(uiCsp("localhost"));
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>UI</title>");
  }
  const csp = uiCsp("localhost");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("frame-ancestors 'none'");
  // WebSocket is allowed for the page's own host only, and a bad Host header adds nothing.
  expect(csp).toContain("connect-src 'self' ws://localhost wss://localhost;");
  expect(uiCsp("evil.example:8080/x y")).toContain("connect-src 'self';");
});

test("assets are typed and immutable; unknown files and API paths stay 404", async () => {
  fixture();
  const js = await get("/assets/app-1.js");
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect(js.headers.get("cache-control")).toContain("immutable");
  expect((await get("/assets/missing.js")).status).toBe(404);
  expect((await get("/api/runs")).status).toBe(404);
  expect((await get("/healthz")).status).toBe(200);
});

test("HEAD has no body and other methods are still rejected", async () => {
  fixture();
  const head = await get("/", "HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect((await get("/", "POST")).status).toBe(405);
});

test("without a registered UI the placeholder remains", async () => {
  const res = await get("/");
  expect(await res.text()).toContain("web UI is not built yet");
  expect((await get("/some/route")).status).toBe(404);
});

test("the policy leaves WebAuthn working: no permissions policy blocks it, and the CSP needs no WebAuthn source", async () => {
  fixture();
  const res = await get("/");
  // WebAuthn (navigator.credentials) is allowed on a top-level page unless a Permissions-Policy
  // turns publickey-credentials-get/create off; none is sent. The CSP has no directive that
  // gates it, so it needs no change for the approval pages.
  expect(res.headers.get("permissions-policy")).toBeNull();
  const csp = uiCsp("localhost");
  expect(csp).not.toMatch(/publickey|webauthn/i);
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
});

// ---- dev mode: a built bundle served straight from a directory, from source only ----

import { mkdirSync, symlinkSync } from "node:fs";
import { compiledBinary, enableDevUi, hasUi } from "../src/ui-assets";

function devFixture(): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), "tt-uidev-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>DEV</title>");
  writeFileSync(join(dist, "assets", "app-1.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "top secret");
  return { root, dist };
}

test("dev mode serves the bundle from a directory, the shell for routes, and sees a rebuild", async () => {
  const { dist } = devFixture();
  expect(enableDevUi({ LONGSHORE_UI_DIR: dist }, { compiled: false })).toMatchObject({
    source: "env",
  });
  expect(hasUi()).toBe(true);
  expect((await get("/")).status).toBe(200);
  const asset = await get("/assets/app-1.js");
  expect(asset.headers.get("content-type")).toContain("javascript");
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect(await (await get("/acme/runs/1")).text()).toContain("DEV");
  expect((await get("/assets/missing.js")).status).toBe(404);
  // read per request: a file built after startup is served without a restart
  writeFileSync(join(dist, "assets", "app-2.js"), "console.log(2)");
  expect(await (await get("/assets/app-2.js")).text()).toBe("console.log(2)");
});

test("dev mode defaults to the source tree's dist when it has an index.html", () => {
  const { dist } = devFixture();
  expect(enableDevUi({}, { compiled: false, sourceDist: dist })).toMatchObject({
    source: "source",
  });
  registerUiAssets(null);
  // no index.html there: dev mode stays off and the placeholder shows
  expect(enableDevUi({}, { compiled: false, sourceDist: join(dist, "assets") })).toBeUndefined();
  expect(enableDevUi({}, { compiled: false, sourceDist: "/nonexistent/dist" })).toBeUndefined();
  expect(hasUi()).toBe(false);
});

test("the compiled binary never reads the UI from disk, whatever the environment says", async () => {
  const { dist } = devFixture();
  expect(enableDevUi({ LONGSHORE_UI_DIR: dist }, { compiled: true })).toBeUndefined();
  expect(hasUi()).toBe(false);
  expect(await (await get("/")).text()).toContain("not built yet");
  expect(compiledBinary("/$bunfs/root/longshore")).toBe(true);
  expect(compiledBinary("B:/~BUN/root/longshore.exe")).toBe(true);
  expect(compiledBinary("/repo/packages/core/src/main.ts")).toBe(false);
});

test("an embedded UI wins: dev mode does not replace a registered bundle", () => {
  const { dist } = devFixture();
  fixture();
  expect(enableDevUi({ LONGSHORE_UI_DIR: dist }, { compiled: false })).toBeUndefined();
});

test("no request can reach a file outside the directory", async () => {
  const { root, dist } = devFixture();
  symlinkSync(join(root, "secret.txt"), join(dist, "assets", "link.txt"));
  symlinkSync(root, join(dist, "assets", "up"));
  enableDevUi({ LONGSHORE_UI_DIR: dist }, { compiled: false });
  const attempts = [
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/assets/link.txt",
    "/assets/up/secret.txt",
    "/assets/%00.js",
    "/assets/..%5c..%5csecret.txt",
  ];
  for (const path of attempts) {
    const res = await get(path);
    const body = await res.text();
    expect(body).not.toContain("top secret");
  }
  // the symlinks and the traversals are not files the UI answers for
  expect((await get("/assets/link.txt")).status).toBe(404);
  expect((await get("/assets/up/secret.txt")).status).toBe(404);
  expect((await get("/../secret.txt")).status).toBe(404);
});
