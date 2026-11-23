import { afterAll } from "bun:test";
import { runConformance } from "@turntable/provider-conformance";
import { DaytonaProvider } from "../src/index";
import { MOCK_KEY, startMock } from "../src/testing/mock-daytona";

// The full provider conformance suite against the in-process Daytona stand-in. Commands run for
// real in scratch directories, so this checks the exec wrapper, framing, files and the account
// rules together. It is not a substitute for the live run (see live-check.ts): the mock cannot
// enforce egress, so the probe is a stand-in that always fails.
const mock = startMock();
afterAll(() => mock.stop());

runConformance(
  () =>
    new DaytonaProvider({
      apiKey: () => MOCK_KEY,
      baseUrl: mock.url,
      maxLive: 2,
      pollMs: 20,
      sleep: (ms) => Bun.sleep(Math.min(ms, 20)),
    }),
  {
    name: "daytona (mock)",
    maxConcurrentSandboxes: 2,
    egressProbe: ["false"],
    testTimeoutMs: 180_000,
  },
);
