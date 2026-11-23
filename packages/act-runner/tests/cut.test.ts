import { describe, expect, test } from "bun:test";
import type { ExecLogs, ExecStatus, Provider } from "@longshore/provider-sdk";
import { drain, watchExec, type RunEvent } from "../src/index";

const enc = new TextEncoder();
const line = (o: object): string => `${JSON.stringify(o)}\n`;

/** A provider whose exec.logs replies are scripted, offset by offset. */
function scripted(replies: ExecLogs[]): Provider {
  let i = 0;
  const status: ExecStatus = { state: "exited", exitCode: 0, endedAt: 1 };
  return {
    exec: {
      status: async () => status,
      logs: async () => replies[Math.min(i++, replies.length - 1)]!,
    },
  } as unknown as Provider;
}

describe("a cut in the exec output (#56)", () => {
  const start = line({
    jobID: "j",
    level: "info",
    msg: "⭐ Run Main build",
    step: "build",
    stepid: ["0"],
    time: "t",
  });
  const partial = '{"jobID":"j","raw_output":true,"msg":"half a li';
  const end = line({ jobID: "j", jobResult: "success", msg: "ok", time: "t" });

  test("is reported as a record at the logical offset; the cut line never joins the tail, and no marker text appears", async () => {
    const head = enc.encode(start + partial);
    const provider = scripted([
      { bytes: head, nextOffset: head.length, eof: false },
      {
        bytes: new Uint8Array(0),
        nextOffset: head.length + 5000,
        eof: false,
        cut: { omittedBytes: 5000 },
      },
      // The tail starts mid-line: its first, partial line must not parse as an event.
      {
        bytes: enc.encode(`ne of output"}\n${end}`),
        nextOffset: head.length + 5000 + 100,
        eof: true,
      },
    ]);
    const events: RunEvent[] = [];
    const result = await drain(watchExec(provider, "sb", "ex", { pollMs: 1 }), (e) =>
      events.push(e),
    );
    expect(result.state).toBe("success");
    const cuts = events.filter((e) => e.kind === "cut");
    expect(cuts).toEqual([{ kind: "cut", offset: head.length, omittedBytes: 5000 }]);
    // Nothing in the log bytes the runner saw is marker text.
    const text = events
      .filter((e) => e.kind === "log")
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("");
    expect(text).not.toMatch(/omitted/);
    // The half line before the cut produced no output event, and the tail's partial line neither.
    const outputs = events.flatMap((e) =>
      e.kind === "act" && e.event.type === "output" ? [e.event.text] : [],
    );
    expect(outputs.join("")).not.toContain("half a li");
    expect(outputs.join("")).not.toContain("ne of output");
  });

  test("marker text printed by the job is an ordinary output event and creates no cut", async () => {
    const marker = line({
      jobID: "j",
      raw_output: true,
      msg: "\n[longshore: 99999 bytes of output omitted]\n",
      step: "build",
      stepid: ["0"],
      time: "t",
    });
    const body = enc.encode(start + marker + end);
    const provider = scripted([{ bytes: body, nextOffset: body.length, eof: true }]);
    const events: RunEvent[] = [];
    await drain(watchExec(provider, "sb", "ex", { pollMs: 1 }), (e) => events.push(e));
    expect(events.some((e) => e.kind === "cut")).toBe(false);
    const outputs = events.flatMap((e) =>
      e.kind === "act" && e.event.type === "output" ? [e.event.text] : [],
    );
    expect(outputs.join("")).toContain("[longshore: 99999 bytes of output omitted]");
  });
});
