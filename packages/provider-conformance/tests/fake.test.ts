import { afterAll } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { runConformance } from "../src/index";

// FAKE_SHELL=/bin/dash exercises the wrapper under dash locally and in CI.
const cap = { head: 4096, tail: 16384, slack: 256 };
const world = new FakeWorld({
  ...(process.env.FAKE_SHELL ? { shell: process.env.FAKE_SHELL } : {}),
  exec: { ...cap, tickSeconds: 1, heartbeatEveryTicks: 2 },
});
afterAll(() => world.dispose());

runConformance(() => world.provider(), {
  name: `fake${process.env.FAKE_SHELL ? ` (${process.env.FAKE_SHELL})` : ""}`,
  silentGapSeconds: 1,
  cap,
  dropConnection: () => world.dropConnections(),
});
