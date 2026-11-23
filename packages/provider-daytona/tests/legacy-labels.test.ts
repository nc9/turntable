// Sandboxes created before the rename (formerly Longshore) carry the old run label, and a fleet is
// configuration: `longshore-shadow` keeps working, `turntable-shadow` is accepted next to it. The
// live fleet must still be counted, listed and swept, or a deploy orphans it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RUN_LABEL, parseFleetName } from "../src/policy";
import { DaytonaProvider, type DaytonaProviderOptions } from "../src/index";
import { MOCK_KEY, startMock } from "../src/testing/mock-daytona";

let mock: ReturnType<typeof startMock>;
beforeEach(() => {
  mock = startMock();
});
afterEach(async () => {
  await mock.stop();
});

const make = (o: Partial<DaytonaProviderOptions> = {}) =>
  new DaytonaProvider({
    apiKey: () => MOCK_KEY,
    baseUrl: mock.url,
    pollMs: 5,
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    ...o,
  });

describe("fleets and labels from before the rename", () => {
  test("new sandboxes get the new run label, and both fleet spellings are valid names", () => {
    expect(RUN_LABEL).toBe("turntable-run");
    expect(parseFleetName("longshore-shadow")).toBe("longshore-shadow");
    expect(parseFleetName("turntable-shadow")).toBe("turntable-shadow");
    expect(() => parseFleetName("other-shadow")).toThrow(RangeError);
  });

  test("a sandbox the old binary created is counted, listed, and swept by the same fleet", async () => {
    const old = mock.addForeign("longshore-shadow-job-1", {
      "longshore-shadow": "1",
      "longshore-run": "run-old",
      grp: "g",
    });
    const mine = make({ fleet: "longshore-shadow" });
    expect(await mine.count({})).toBe(1);
    expect((await mine.list({ labels: { grp: "g" } })).map((s) => s.id)).toEqual([old]);
    expect(await mine.destroyByLabels({ grp: "g" })).toBe(1);
    expect(mock.sandboxes.has(old)).toBe(false);
  });

  test("a turntable- fleet and a longshore- fleet in one account never see each other", async () => {
    const a = make({ fleet: "longshore-shadow" });
    const b = make({ fleet: "turntable-shadow" });
    const ha = await a.create({
      name: "x",
      labels: { grp: "g" },
      ttlSeconds: 600,
      network: { egress: "open" },
    });
    const hb = await b.create({
      name: "y",
      labels: { grp: "g" },
      ttlSeconds: 600,
      network: { egress: "open" },
    });
    expect(mock.sandboxes.get(ha.id)!.name.startsWith("longshore-shadow-")).toBe(true);
    expect(mock.sandboxes.get(hb.id)!.name.startsWith("turntable-shadow-")).toBe(true);
    expect(mock.sandboxes.get(hb.id)!.labels["turntable-run"]).toBeDefined();
    expect(await a.count({})).toBe(1);
    expect(await b.count({})).toBe(1);
    expect(await a.destroyByLabels({ grp: "g" })).toBe(1);
    expect(mock.sandboxes.has(hb.id)).toBe(true);
    await b.destroy(hb.id);
  });
});
