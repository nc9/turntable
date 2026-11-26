import { afterAll, describe, expect, test } from "bun:test";
import { SecretRegistry } from "@turntable/redact";
import { drain, watchExec, type RunEvent } from "@turntable/act-runner";
import type { Provider } from "@turntable/provider-sdk";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { LogPipe } from "../src/run/job-exec";

// Small caps so the fake provider's real wrapper cuts cheaply. 8 KiB kept at the head, 32 KiB at
// the tail, 1 KiB slack.
const HEAD = 8 * 1024;
const TAIL = 32 * 1024;
const world = new FakeWorld({
  exec: { tickSeconds: 1, head: HEAD, tail: TAIL, slack: 1024 },
});
afterAll(() => world.dispose());

const spec = {
  name: "l",
  labels: { a: "b" },
  ttlSeconds: 120,
  network: { egress: "none" },
} as const;

function pipe() {
  const stored: { at: number; bytes: Uint8Array }[] = [];
  const cuts: { atOffset: number; omittedBytes: number; reason: string }[] = [];
  const env = {
    out: () => {},
    registry: new SecretRegistry(),
    store: {
      appendLog: async (_id: string, at: number, bytes: Uint8Array) => {
        stored.push({ at, bytes });
      },
      addCut: async (
        _id: string,
        c: { atOffset: number; omittedBytes: number; reason: string },
      ) => {
        cuts.push(c);
      },
    },
  };
  const log = new LogPipe(env as never, "att1");
  const text = (): string => stored.map((s) => new TextDecoder().decode(s.bytes)).join("");
  return { log, stored, cuts, text };
}

/** Feeds the same events job-exec does: log text through the pipe, cuts as cuts. */
function consume(log: LogPipe): (e: RunEvent) => void {
  const dec = new TextDecoder();
  return (e) => {
    if (e.kind === "log") log.push(dec.decode(e.bytes));
    else if (e.kind === "cut") log.cut(e.omittedBytes);
  };
}

async function exited(p: Provider, id: string, execId: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if ((await p.exec.status(id, execId)).state !== "running") return;
    await Bun.sleep(50);
  }
  throw new Error("exec did not end");
}

describe("a range the provider dropped is never a silent gap (#690)", () => {
  test("output beyond the sandbox's caps, read late, gives the marker line, a cut and a byte count", async () => {
    const p = world.provider();
    const { id } = await p.create(spec);
    const total = 400_000;
    const { execId } = await p.exec.start(id, {
      argv: ["sh", "-c", `yes 0123456789abcdef | head -c ${total}`],
      timeoutSeconds: 60,
    });
    await exited(p, id, execId);
    const { log, cuts, text } = pipe();
    await drain(watchExec(p, id, execId, { pollMs: 1 }), consume(log));
    await log.close();
    const omitted = total - HEAD - TAIL;
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.omittedBytes).toBe(omitted);
    const t = text();
    const marker = new RegExp(
      `^\\[turntable\\] ${omitted} bytes of output from \\d\\d:\\d\\d:\\d\\d to \\d\\d:\\d\\d:\\d\\d could not be retrieved: .+$`,
      "m",
    );
    expect(t).toMatch(marker);
    // The marker sits at the cut: the stored offset the cut records is where the marker starts (after a newline when the output stopped mid-line).
    expect(t.slice(cuts[0]!.atOffset)).toMatch(/^\n?\[turntable\] /);
    await p.destroy(id);
  });

  test("the marker starts on its own line even when the output stopped mid-line", async () => {
    const { log, text } = pipe();
    log.push("partial line with no newline");
    log.cut(10);
    log.push("tail\n");
    await log.close();
    expect(text()).toMatch(/^partial line with no newline\n\[turntable\] 10 bytes of output from /);
    expect(text()).toMatch(/could not be retrieved: .+\ntail\n$/);
  });
});

describe("a sustained high-volume step is stored completely (#690)", () => {
  test("several MB over several seconds, read in realistic pages while it runs, loses nothing", async () => {
    const p = world.provider();
    const { id } = await p.create(spec);
    // About 4 MB in 40 bursts of 100 KB, 0.1 s apart (far over head + tail: only a reader that
    // keeps up sees all of it).
    const script =
      'i=0; while [ $i -lt 40 ]; do yes "line-$i-0123456789abcdefghij" | head -c 100000; i=$((i+1)); sleep 0.1; done';
    const { execId } = await p.exec.start(id, {
      argv: ["sh", "-c", script],
      timeoutSeconds: 120,
    });
    const events: RunEvent[] = [];
    await drain(watchExec(p, id, execId, { pollMs: 20, logChunkBytes: 64 * 1024 }), (e) =>
      events.push(e),
    );
    const bytes = events.filter((e) => e.kind === "log").reduce((n, e) => n + e.bytes.length, 0);
    expect(events.filter((e) => e.kind === "cut")).toEqual([]);
    expect(bytes).toBe(4_000_000);
    await p.destroy(id);
  }, 60_000);
});
