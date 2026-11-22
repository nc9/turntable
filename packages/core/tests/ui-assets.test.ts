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
