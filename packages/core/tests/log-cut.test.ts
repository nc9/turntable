import { describe, expect, test } from "bun:test";
import { SecretRegistry } from "@longshore/redact";
import { LogPipe } from "../src/run/job-exec";

function pipe() {
  const stored: { at: number; text: string }[] = [];
  const cuts: { attemptId: string; atOffset: number; omittedBytes: number; reason: string }[] = [];
  const registry = new SecretRegistry();
  registry.register("sekret-value-1234");
  const env = {
    out: () => {},
    registry,
    store: {
      appendLog: async (_id: string, at: number, bytes: Uint8Array) => {
        stored.push({ at, text: new TextDecoder().decode(bytes) });
      },
      addCut: async (
        attemptId: string,
        c: { atOffset: number; omittedBytes: number; reason: string },
      ) => {
        cuts.push({ attemptId, ...c });
      },
    },
  };
  return { log: new LogPipe(env as never, "att1"), stored, cuts };
}

describe("LogPipe.cut (#56)", () => {
  test("a cut is metadata at the stored offset and adds nothing to the log text", async () => {
    const { log, stored, cuts } = pipe();
    log.push("before\n");
    log.cut(4096);
    log.push("after\n");
    await log.close();
    expect(stored.map((s) => s.text).join("")).toBe("before\nafter\n");
    expect(cuts).toEqual([
      { attemptId: "att1", atOffset: "before\n".length, omittedBytes: 4096, reason: "output cap" },
    ]);
    // The text after the cut starts where the text before it ended: no gap is invented.
    expect(stored.at(-1)!.at).toBe("before\n".length);
  });

  test("text that looks like the old marker, or like a cut record, is only text", async () => {
    const { log, stored, cuts } = pipe();
    log.push("[longshore: 4096 bytes of output omitted]\n");
    log.push('::tt-cut::{"bytes":1,"reason":"x"}\n');
    await log.close();
    expect(cuts).toEqual([]);
    expect(stored.map((s) => s.text).join("")).toContain(
      "[longshore: 4096 bytes of output omitted]",
    );
  });

  test("redaction does not join text across a cut: a secret split by the gap is not reassembled", async () => {
    const { log, stored } = pipe();
    log.push("token=sekret-val");
    log.cut(10);
    log.push("ue-1234 end\n");
    await log.close();
    const text = stored.map((s) => s.text).join("");
    // Each half is kept as written (neither half is the whole secret), and nothing is merged.
    expect(text).toContain("token=sekret-val");
    expect(text).toContain("ue-1234 end");
  });
});
