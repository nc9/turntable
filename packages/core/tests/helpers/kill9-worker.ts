// Child process for the kill -9 test: claims one attempt, tells the parent, then hangs forever
// (a runner that never finishes), so the parent can kill -9 it mid-run.
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { openDatabase } from "../../src/db";
import { Scheduler } from "../../src/scheduler";

const [dbPath, leaseMs] = process.argv.slice(2) as [string, string];
const db = openDatabase(dbPath);
const scheduler = new Scheduler({
  db,
  providers: () => new FakeWorld().provider(),
  leaseMs: Number(leaseMs),
  heartbeatMs: 100_000, // never beats before it is killed: the lease alone decides
  runner: async (ctx) => {
    await ctx.store.setExec({ sandboxId: "sb-never-existed" });
    console.log(`claimed ${ctx.attempt.id}`);
    return new Promise(() => {}); // hang
  },
});
await scheduler.tick();
await new Promise(() => {});
