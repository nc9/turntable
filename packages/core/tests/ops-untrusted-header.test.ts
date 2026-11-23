import { beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Db } from "../src/db";
import { registry } from "../src/ops";
import { createRestApi, DEPRECATED_UNTRUSTED_HEADER, UNTRUSTED_HEADER } from "../src/ops/rest";
import { mintToken, seedWorld } from "./ops-helpers";

let db: Db;
let token: string;
let api: ReturnType<typeof createRestApi>;

beforeEach(async () => {
  let a;
  ({ db, a } = await seedWorld());
  token = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
  api = createRestApi({ registry, db });
});

const get = async (path: string): Promise<Response> =>
  (await api(
    new Request(`http://x/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }),
  ))!;

test("the marker is sent under both names with the same value on every untrusted route we can reach", async () => {
  for (const path of ["/runs", "/events", "/orgs"]) {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get(UNTRUSTED_HEADER)).toBe("true");
    expect(res.headers.get(DEPRECATED_UNTRUSTED_HEADER)).toBe("true");
  }
});

test("the registry marks those routes untrusted, and a trusted route sends neither header", async () => {
  const untrusted = new Set(
    registry
      .tokenOps()
      .filter((o) => o.untrustedOutput)
      .map((o) => o.http.path),
  );
  for (const p of ["/runs", "/events", "/orgs"]) expect(untrusted.has(p)).toBe(true);
  const trusted = registry
    .tokenOps()
    .find(
      (o) =>
        !o.untrustedOutput &&
        o.http.method === "GET" &&
        !o.http.path.includes("{") &&
        o.auth.type === "token",
    );
  if (trusted) {
    const res = await get(trusted.http.path);
    expect(res.headers.get(UNTRUSTED_HEADER)).toBeNull();
    expect(res.headers.get(DEPRECATED_UNTRUSTED_HEADER)).toBeNull();
  }
});

test("rest.ts is the only place that sets the marker, so every untrusted route gets both names", () => {
  const dir = join(import.meta.dir, "../src");
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/untrusted-content/i.test(readFileSync(p, "utf8")))
        hits.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  expect(hits.sort()).toEqual(["ops/openapi.ts", "ops/rest.ts"]);
});
