import { afterAll, describe, expect, test } from "bun:test";
import { InfraError } from "@longshore/provider-sdk";
import { FakeWorld } from "@longshore/provider-sdk/testing";

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

  test("output ceiling kills with reason output_limit", async () => {
    const w = new FakeWorld({ exec: { tickSeconds: 1, maxOutputBytes: 50_000 } });
    try {
      const p = w.provider();
      const { id } = await p.create(spec);
      const { execId } = await p.exec.start(id, {
        argv: ["sh", "-c", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"],
        timeoutSeconds: 60,
      });
      let s = await p.exec.status(id, execId);
      for (let i = 0; i < 100 && s.state === "running"; i += 1) {
        await Bun.sleep(200);
        s = await p.exec.status(id, execId);
      }
      expect(s).toMatchObject({ state: "killed", reason: "output_limit", exitCode: 137 });
    } finally {
      w.dispose();
    }
  });

  test("ttl expiry reaps sandboxes", async () => {
    const p = world.provider();
    const { id } = await p.create({ ...spec, ttlSeconds: 1 });
    await Bun.sleep(1100);
    expect((await p.list({ labels: { a: "b" } })).map((s) => s.id)).not.toContain(id);
  });
});
