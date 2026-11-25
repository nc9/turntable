import { expect, test } from "bun:test";
import { GATE_TIMEOUT_MESSAGE, GATE_TIMEOUT_MS, waitForGate, type GateDeps } from "./cd/gate";

function fake(responses: (() => Response | Promise<Response>)[]) {
  let clock = 0;
  let i = 0;
  const urls: string[] = [];
  const deps: GateDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: async (url) => {
      urls.push(url);
      return (responses[Math.min(i++, responses.length - 1)] as () => Response)();
    },
  };
  return { deps, urls };
}
const gate =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const busy = gate({ safe: false, reason: "release_in_flight" });

test("proceeds at once when the gate is open", async () => {
  const f = fake([gate({ safe: true, reason: "ok" })]);
  const r = await waitForGate(f.deps, { baseUrl: "https://tt.example/" });
  expect(r).toEqual({ ok: true, waitedMs: 0 });
  expect(f.urls).toEqual(["https://tt.example/api/v1/deploy-gate"]);
});

test("waits while a release is in flight or a drain is on, then proceeds", async () => {
  const f = fake([
    busy,
    busy,
    gate({ safe: false, reason: "draining" }),
    gate({ safe: true, reason: "ok" }),
  ]);
  const r = await waitForGate(f.deps, { baseUrl: "https://t", pollMs: 1000 });
  expect(r).toEqual({ ok: true, waitedMs: 3000 });
  expect(f.urls.length).toBe(4);
});

test("fails and pages after 6 h of waiting", async () => {
  const f = fake([busy]);
  const r = await waitForGate(f.deps, { baseUrl: "https://t", pollMs: 60_000 });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.page).toBe(true);
  expect(r.reason).toBe(GATE_TIMEOUT_MESSAGE);
  expect(r.waitedMs).toBeGreaterThanOrEqual(GATE_TIMEOUT_MS);
});

test("an unreachable gate, a 429, a 503 and a malformed body never open it", async () => {
  const f = fake([
    () => Promise.reject(new Error("down")),
    gate({ error: "rate_limited" }, 429),
    gate({ safe: true }, 503),
    gate({ safe: "true" }),
    gate({}),
    gate({ safe: true, reason: "ok" }),
  ]);
  const r = await waitForGate(f.deps, { baseUrl: "https://t", pollMs: 10 });
  expect(r).toEqual({ ok: true, waitedMs: 50 });
});
