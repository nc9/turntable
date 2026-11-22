import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/server";
import { registerUiAssets, UI_CSP } from "../src/ui-assets";

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
    const res = get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(UI_CSP);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>UI</title>");
  }
  expect(UI_CSP).toContain("script-src 'self';");
  expect(UI_CSP).toContain("frame-ancestors 'none'");
});

test("assets are typed and immutable; unknown files and API paths stay 404", async () => {
  fixture();
  const js = get("/assets/app-1.js");
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect(js.headers.get("cache-control")).toContain("immutable");
  expect(get("/assets/missing.js").status).toBe(404);
  expect(get("/api/runs").status).toBe(404);
  expect(get("/healthz").status).toBe(200);
});

test("HEAD has no body and other methods are still rejected", async () => {
  fixture();
  const head = get("/", "HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(get("/", "POST").status).toBe(405);
});

test("without a registered UI the placeholder remains", async () => {
  const res = get("/");
  expect(await res.text()).toContain("web UI is not built yet");
  expect(get("/some/route").status).toBe(404);
});
