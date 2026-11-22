import { afterAll, describe, expect, test } from "bun:test";
import { InfraError } from "@turntable/provider-sdk";
import { FakeWorld } from "@turntable/provider-sdk/testing";

const world = new FakeWorld({ exec: { tickSeconds: 1 } });
afterAll(() => world.dispose());
const spec = {
  name: "f",
  labels: { a: "b" },
  ttlSeconds: 60,
  network: { egress: "none" },
} as const;

describe("fake scripted failures", () => {
  test("create fails with InfraError, then recovers", async () => {
    const p = world.provider();
    world.failNext("create", 2);
    await expect(p.create(spec)).rejects.toBeInstanceOf(InfraError);
    await expect(p.create(spec)).rejects.toBeInstanceOf(InfraError);
    const h = await p.create(spec);
    await p.destroy(h.id);
  });

  test("dropped connection kills old instances, new ones work", async () => {
    const old = world.provider();
    world.dropConnections();
    await expect(old.healthcheck()).rejects.toBeInstanceOf(InfraError);
    await world.provider().healthcheck();
  });

  test("lost exec reports lost", async () => {
    const p = world.provider();
    const { id } = await p.create(spec);
    const { execId } = await p.exec.start(id, { argv: ["sleep", "30"], timeoutSeconds: 60 });
    expect((await p.exec.status(id, execId)).state).toBe("running");
    world.loseExec(id, execId);
    expect((await p.exec.status(id, execId)).state).toBe("lost");
    await p.destroy(id);
  });

  test("ttl expiry reaps sandboxes", async () => {
    const p = world.provider();
    const { id } = await p.create({ ...spec, ttlSeconds: 1 });
    await Bun.sleep(1100);
    expect((await p.list({ labels: { a: "b" } })).map((s) => s.id)).not.toContain(id);
  });
});
