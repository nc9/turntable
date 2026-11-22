// Child process for the re-attach test: claims one attempt and records the sandbox and exec the
// parent gave it (standing in for a worker that started act), then hangs so the parent can
// kill -9 it while the job keeps running elsewhere.
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { openDatabase } from "../../src/db";
import { Scheduler } from "../../src/scheduler";

const [dbPath, leaseMs, sandboxId, execId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const db = openDatabase(dbPath);
const scheduler = new Scheduler({
  db,
  providers: () => new FakeWorld().provider(),
  leaseMs: Number(leaseMs),
  heartbeatMs: 100_000,
  runner: async (ctx) => {
    await ctx.store.setExec({ sandboxId });
    await ctx.store.setExec({ execId });
    await ctx.store.appendLog(0, new TextEncoder().encode("partial output from the dead worker\n"));
    console.log(`claimed ${ctx.attempt.id}`);
    return new Promise(() => {});
  },
});
await scheduler.tick();
await new Promise(() => {});
