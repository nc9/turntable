// Containers and networks started before the rename (formerly Longshore) carry longshore.* labels.
// The provider must still list, count, destroy and reap them, or a deploy orphans live sandboxes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerProvider } from "../src/docker-provider";

// A stand-in for the docker CLI: containers and networks are JSON files in a state directory. It
// understands only what the provider runs here (ps, inspect, rm, network ls|inspect|rm).
const FAKE = (dir: string): string => `#!/usr/bin/env bun
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const load = (kind: string) =>
  readdirSync(dir + "/" + kind).map((f) => JSON.parse(readFileSync(dir + "/" + kind + "/" + f, "utf8")));
const log = (line: string) => appendFileSync(dir + "/calls.log", line + "\\n");
log(args.join(" "));
const filters = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a.replace(/^label=/, "")] : []));
const matches = (o: { labels: Record<string, string> }) =>
  filters.every((f) => { const [k, v] = [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)]; return o.labels[k] === v; });
const expand = (tpl: string, labels: Record<string, string>, name: string) =>
  tpl
    .replace(/\\{\\{or \\(index \\S+ "([^"]+)"\\) \\(index \\S+ "([^"]+)"\\)\\}\\}/g, (_m, a, b) => labels[a] || labels[b] || "")
    .replace("{{.Name}}", name);
if (args[0] === "ps") {
  for (const c of load("containers")) if (matches(c)) console.log(c.id);
} else if (args[0] === "inspect" && args[2] === "{{json .}}") {
  const ids = args.slice(args.indexOf("--") + 1);
  for (const c of load("containers")) if (ids.includes(c.id))
    console.log(JSON.stringify({ Id: c.id, Name: "/" + c.name, Created: "2026-01-01T00:00:00Z", Config: { Labels: c.labels } }));
} else if (args[0] === "inspect") {
  const id = args[args.indexOf("--") + 1];
  const c = load("containers").find((x) => x.id === id);
  if (!c) { console.error("No such container"); process.exit(1); }
  console.log(expand(args[2]!, c.labels, c.name));
} else if (args[0] === "rm") {
  const id = args[args.indexOf("--") + 1];
  for (const c of load("containers")) if (c.id === id || c.name === id) rmSync(dir + "/containers/" + c.id + ".json");
} else if (args[0] === "network" && args[1] === "ls") {
  for (const n of load("networks")) if (matches(n)) console.log(n.id);
} else if (args[0] === "network" && args[1] === "inspect") {
  const id = args[args.length - 1];
  const n = load("networks").find((x) => x.id === id)!;
  console.log(expand(args[args.indexOf("--format") + 1]!, n.labels, n.name));
} else if (args[0] === "network" && args[1] === "rm") {
  const name = args[2];
  for (const n of load("networks")) if (n.name === name) rmSync(dir + "/networks/" + n.id + ".json");
}
`;

let dir = "";
let bin = "";
const put = (kind: "containers" | "networks", id: string, name: string, labels: Record<string, string>) =>
  writeFileSync(join(dir, kind, `${id}.json`), JSON.stringify({ id, name, labels }));
const left = (kind: string): string[] => readdirSync(join(dir, kind)).map((f) => f.replace(".json", "")).toSorted();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-legacy-docker-"));
  for (const k of ["containers", "networks"]) Bun.spawnSync(["mkdir", join(dir, k)]);
  bin = join(dir, "docker");
  writeFileSync(bin, FAKE(dir));
  chmodSync(bin, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sandboxes labelled before the rename", () => {
  test("list and count see both label sets, and report only the caller's labels", async () => {
    put("containers", "old1", "old-job", { "longshore.managed": "1", "longshore.expires-at": "9", "longshore.run": "r1" });
    put("containers", "new1", "new-job", { "turntable.managed": "1", "turntable.expires-at": "9", "turntable.run": "r2" });
    put("containers", "other", "not-ours", { app: "x" });
    const p = new DockerProvider({ docker: bin });
    const all = await p.list({});
    expect(all.map((s) => s.id).toSorted()).toEqual(["new1", "old1"]);
    expect(await p.count({})).toBe(2);
    // The provider's own bookkeeping labels never leak out; the caller's do.
    expect(all.find((s) => s.id === "old1")!.labels).toEqual({ "longshore.run": "r1" });
    expect(all.find((s) => s.id === "new1")!.labels).toEqual({ "turntable.run": "r2" });
    expect(await p.count({ labels: { "longshore.run": "r1" } })).toBe(1);
  });

  test("destroyByLabels removes a container the old binary started", async () => {
    const p = new DockerProvider({ docker: bin });
    expect(await p.destroyByLabels({ "longshore.run": "r1" })).toBe(1);
    expect(left("containers")).toEqual(["new1", "other"]);
  });

  test("destroy removes the relay and network named by the old labels", async () => {
    put("containers", "old2", "old-proxied", {
      "longshore.managed": "1",
      "longshore.expires-at": "9",
      "longshore.relay": "old-relay",
      "longshore.net": "old-net",
    });
    put("containers", "old-relay", "old-relay", { "longshore.relay": "old-proxied" });
    put("networks", "n1", "old-net", { "longshore.managed": "1", "longshore.expires-at": "9" });
    const p = new DockerProvider({ docker: bin });
    await p.destroy("old2");
    expect(left("containers")).toEqual(["new1", "other"]);
    expect(left("networks")).toEqual([]);
  });

  test("an expired network with the old labels is reaped; a live one and a new-label one follow the same rule", async () => {
    put("networks", "gone", "gone-net", { "longshore.managed": "1", "longshore.expires-at": "1" });
    put("networks", "live", "live-net", { "longshore.managed": "1", "longshore.expires-at": String(Date.now() + 3_600_000) });
    put("networks", "gone2", "gone2-net", { "turntable.managed": "1", "turntable.expires-at": "1" });
    const p = new DockerProvider({ docker: bin });
    await (p as unknown as { reapExpired(): Promise<void> }).reapExpired();
    expect(left("networks")).toEqual(["live"]);
  });

  test("the fake saw docker asked for both managed labels", () => {
    const calls = readFileSync(join(dir, "calls.log"), "utf8");
    expect(calls).toContain("label=turntable.managed=1");
    expect(calls).toContain("label=longshore.managed=1");
  });
});
