import { expect, test } from "bun:test";
import { handleRequest } from "../src/server";
import { VERSION } from "../src/version";

test("GET /healthz returns ok and version", async () => {
  const res = await handleRequest(new Request("http://localhost/healthz"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: VERSION });
});

test("GET / returns placeholder html", async () => {
  const res = await handleRequest(new Request("http://localhost/"));
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("Turntable");
});

test("unknown path is 404 and non-GET is 405", async () => {
  expect((await handleRequest(new Request("http://localhost/nope"))).status).toBe(404);
  expect(
    (await handleRequest(new Request("http://localhost/healthz", { method: "POST" }))).status,
  ).toBe(405);
});
