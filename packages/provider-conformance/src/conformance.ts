import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  OUTPUT_HEAD_BYTES,
  OUTPUT_SLACK_BYTES,
  OUTPUT_TAIL_BYTES,
  SpecError,
  type ExecStatus,
  type Labels,
  type Provider,
  type SandboxSpec,
} from "@longshore/provider-sdk";

export interface ConformanceOptions {
  /** Suite name shown in test output. */
  name: string;
  /** Fields merged into every SandboxSpec (image, resources, network ...). */
  spec?: Partial<SandboxSpec>;
  /** Seconds of silence inside the long-gap log test. Keep tiny for fakes. Default 2. */
  silentGapSeconds?: number;
  /** Per-test timeout. Default 120 s. */
  testTimeoutMs?: number;
  /** Poll interval for status and logs. Default 100 ms. */
  pollIntervalMs?: number;
  /** Called to break the control connection. Default: just discard the provider instance. */
  dropConnection?: () => void | Promise<void>;
  /** Output retention the provider was configured with. Default: the SDK constants. */
  cap?: { head: number; tail: number; slack: number };
  /** Command that must FAIL (non-zero, not 127) under egress `none`. Default: busybox wget. */
  egressProbe?: string[];
  /**
   * Most sandboxes the provider may have live at once (a cost or account cap). Sandboxes are
   * destroyed after each test either way; with a cap below 3 the labels test uses two sandboxes
   * instead of three. Default: unlimited.
   */
  maxConcurrentSandboxes?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/**
 * Reads everything via offsets, in chunks of `chunk` bytes. Cut regions come back as data:
 * `cuts` holds each one with the position in the returned bytes where it belongs.
 */
const readAll = async (p: Provider, id: string, execId: string, chunk = 1 << 20) => {
  const parts: Uint8Array[] = [];
  const cuts: { atOffset: number; omittedBytes: number }[] = [];
  let stored = 0;
  let off = 0;
  for (let i = 0; i < 1_000_000; i += 1) {
    const r = await p.exec.logs(id, execId, { fromOffset: off, maxBytes: chunk });
    expect(r.nextOffset).toBeGreaterThanOrEqual(off);
    if (r.cut) {
      // A reply is bytes or a cut, never both, and the cut advances the logical offset by
      // exactly what it omitted.
      expect(r.bytes.length).toBe(0);
      expect(r.nextOffset - off).toBe(r.cut.omittedBytes);
      cuts.push({ atOffset: stored, omittedBytes: r.cut.omittedBytes });
    }
    parts.push(r.bytes);
    stored += r.bytes.length;
    off = r.nextOffset;
    if (r.eof) return { bytes: concat(parts), offset: off, cuts };
  }
  throw new Error("logs did not reach eof");
};

/**
 * Registers bun tests that any Provider must pass. Call from a `*.test.ts` file:
 *
 *   runConformance(() => new MyProvider(), { name: "my" });
 *
 * `makeProvider` must return a NEW instance each call with no shared in-memory state. The suite
 * relies on that to model controller restarts.
 */
export function runConformance(
  makeProvider: () => Provider | Promise<Provider>,
  opts: ConformanceOptions,
): void {
  const gap = opts.silentGapSeconds ?? 2;
  const poll = opts.pollIntervalMs ?? 100;
  const timeout = opts.testTimeoutMs ?? 120_000;
  const cap = opts.cap ?? {
    head: OUTPUT_HEAD_BYTES,
    tail: OUTPUT_TAIL_BYTES,
    slack: OUTPUT_SLACK_BYTES,
  };
  const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const runLabels: Labels = { tt_conformance: runId };
  let seq = 0;
  // Isolated by default when the provider can do it; the suite never needs outbound network.
  let egressDefault: SandboxSpec["network"]["egress"] = "open";

  const spec = (extra: Labels = {}): SandboxSpec => ({
    name: `tt-conf-${runId}-${(seq += 1)}`,
    labels: { ...runLabels, ...extra },
    ttlSeconds: 1800,
    network: { egress: egressDefault },
    ...opts.spec,
  });

  /** Sandboxes made by the running test; destroyed afterwards so capped providers never fill up. */
  const made: string[] = [];
  const sandbox = async (p: Provider, extra: Labels = {}): Promise<string> => {
    const id = (await p.create({ ...spec(extra), labels: { ...runLabels, ...extra } })).id;
    made.push(id);
    return id;
  };

  const waitDone = async (
    p: Provider,
    id: string,
    execId: string,
    maxMs = 60_000,
  ): Promise<ExecStatus> => {
    const end = Date.now() + maxMs;
    for (;;) {
      const s = await p.exec.status(id, execId);
      if (s.state !== "running") return s;
      if (Date.now() > end) throw new Error(`exec still running after ${maxMs} ms`);
      await Bun.sleep(poll);
    }
  };

  const run = async (p: Provider, id: string, argv: string[], timeoutSeconds = 60) => {
    const { execId } = await p.exec.start(id, { argv, timeoutSeconds });
    return { execId, status: await waitDone(p, id, execId) };
  };

  describe(`provider conformance: ${opts.name}`, () => {
    let p: Provider;
    beforeAll(async () => {
      p = await makeProvider();
      if (p.info.network.egressPolicy.includes("none")) egressDefault = "none";
    });
    afterEach(async () => {
      const cleaner = await makeProvider();
      for (const id of made.splice(0)) await cleaner.destroy(id).catch(() => {});
    });
    afterAll(async () => {
      const cleaner = await makeProvider();
      await cleaner.destroyByLabels(runLabels);
    });
    const t = (name: string, fn: () => Promise<void>): void => void test(name, fn, timeout);

    t("healthcheck resolves and info declares detached exec", async () => {
      await p.healthcheck();
      expect(["container", "gvisor", "microvm", "vm"]).toContain(p.info.isolation);
      expect(p.info.exec.detached).toBe(true);
      expect(p.info.exec.logsByOffset).toBe(true);
    });

    t("create rejects an invalid spec with SpecError", async () => {
      await expect(p.create({ ...spec(), ttlSeconds: 0 })).rejects.toBeInstanceOf(SpecError);
    });

    t("create and destroy are idempotent", async () => {
      const id = await sandbox(p);
      expect(await p.count({ labels: runLabels })).toBeGreaterThanOrEqual(1);
      await p.destroy(id);
      await p.destroy(id);
      await p.destroy(`tt-conf-nonexistent-${runId}`);
      const left = await p.list({ labels: runLabels });
      expect(left.map((s) => s.id)).not.toContain(id);
    });

    t("exit code fidelity: 0, 1, 137, 143, and signal deaths", async () => {
      const id = await sandbox(p);
      const cases: [string, number][] = [
        ["exit 0", 0],
        ["exit 1", 1],
        ["exit 137", 137],
        ["exit 143", 143],
        ["kill -9 $$", 137],
        ["kill -15 $$", 143],
      ];
      for (const [script, code] of cases) {
        const { status } = await run(p, id, ["sh", "-c", script]);
        expect(status.state).toBe("exited");
        expect(status.exitCode).toBe(code);
        expect(status.endedAt).toBeGreaterThan(0);
      }
      const nf = await run(p, id, ["tt-no-such-binary-xyz"]);
      expect(nf.status.exitCode).toBe(127);
    });

    t("exec.kill and timeoutSeconds produce state killed", async () => {
      const id = await sandbox(p);
      for (const [sig, code] of [
        ["TERM", 143],
        ["KILL", 137],
      ] as const) {
        const { execId } = await p.exec.start(id, { argv: ["sleep", "300"], timeoutSeconds: 600 });
        expect((await p.exec.status(id, execId)).state).toBe("running");
        await p.exec.kill(id, execId, sig);
        const s = await waitDone(p, id, execId, 30_000);
        expect(s.state).toBe("killed");
        expect(s.reason).toBe("killed");
        expect(s.exitCode).toBe(code);
        await p.exec.kill(id, execId, sig); // idempotent after exit
      }
      const { execId } = await p.exec.start(id, { argv: ["sleep", "300"], timeoutSeconds: 1 });
      const s = await waitDone(p, id, execId, 30_000);
      expect(s.state).toBe("killed");
      expect(s.reason).toBe("timeout");
      expect(s.exitCode).toBe(143);
    });

    t("egress none really blocks outbound connections", async () => {
      if (!p.info.network.egressPolicy.includes("none")) return;
      const id = await sandbox(p);
      const probe = opts.egressProbe ?? [
        "wget",
        "-T",
        "3",
        "-q",
        "-O",
        "/dev/null",
        "http://1.1.1.1",
      ];
      const { status } = await run(p, id, probe);
      expect(status.state).toBe("exited");
      expect(status.exitCode).not.toBe(0);
      expect(status.exitCode).not.toBe(127);
    });

    t("exec waits for the real command: sleep then exit 7", async () => {
      const id = await sandbox(p);
      const started = Date.now();
      const { execId } = await p.exec.start(id, {
        argv: ["sh", "-c", `sleep ${Math.max(gap, 2)}; exit 7`],
        timeoutSeconds: 60,
      });
      expect((await p.exec.status(id, execId)).state).toBe("running");
      const s = await waitDone(p, id, execId);
      expect(s).toMatchObject({ state: "exited", exitCode: 7 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(Math.max(gap, 2) * 1000 - 200);
    });

    t("unknown execId reports lost", async () => {
      const id = await sandbox(p);
      const s = await p.exec.status(id, "tt1-" + "0".repeat(24));
      expect(s.state).toBe("lost");
    });

    t("detached exec survives a dropped control connection", async () => {
      const id = await sandbox(p);
      const { execId } = await p.exec.start(id, {
        argv: ["sh", "-c", `sleep ${gap}; echo survived; exit 7`],
        timeoutSeconds: 60,
      });
      await (opts.dropConnection ? opts.dropConnection() : undefined);
      const fresh = await makeProvider();
      p = fresh; // the old instance may be dead after the drop
      const s = await waitDone(fresh, id, execId);
      expect(s).toMatchObject({ state: "exited", exitCode: 7 });
      expect(dec.decode((await readAll(fresh, id, execId)).bytes)).toBe("survived\n");
    });

    t("result is recoverable by a fresh instance after the exec finished", async () => {
      const id = await sandbox(p);
      const { execId, status } = await run(p, id, ["sh", "-c", "echo hello; exit 3"]);
      expect(status.exitCode).toBe(3);
      const fresh = await makeProvider();
      expect(await fresh.exec.status(id, execId)).toMatchObject({ state: "exited", exitCode: 3 });
      expect(dec.decode((await readAll(fresh, id, execId)).bytes)).toBe("hello\n");
    });

    t("logs by offset: no lost or duplicate bytes across a long silent gap", async () => {
      const id = await sandbox(p);
      const { execId } = await p.exec.start(id, {
        argv: ["sh", "-c", `echo a; sleep ${gap}; echo b; sleep ${gap}; echo c`],
        timeoutSeconds: 60,
      });
      const parts: Uint8Array[] = [];
      let off = 0;
      let eof = false;
      const end = Date.now() + 60_000;
      while (!eof) {
        const r = await p.exec.logs(id, execId, { fromOffset: off, maxBytes: 1 << 20 });
        expect(r.bytes.length).toBe(r.nextOffset - off);
        parts.push(r.bytes);
        off = r.nextOffset;
        eof = r.eof;
        if (Date.now() > end) throw new Error("timed out reading logs");
        if (!eof) await Bun.sleep(poll);
      }
      expect(dec.decode(concat(parts))).toBe("a\nb\nc\n");
      // Re-reading from a past offset is stable, and reading at the end is empty.
      const again = await p.exec.logs(id, execId, { fromOffset: 2, maxBytes: 1 << 20 });
      expect(dec.decode(again.bytes)).toBe("b\nc\n");
      const tailRead = await p.exec.logs(id, execId, { fromOffset: off, maxBytes: 10 });
      expect(tailRead).toMatchObject({ nextOffset: off, eof: true });
      expect(tailRead.bytes.length).toBe(0);
    });

    t("logs by offset: tiny chunks reconstruct the exact output", async () => {
      const id = await sandbox(p);
      const script = 'i=0; while [ $i -lt 60 ]; do echo "line-$i-xxxxxxxx"; i=$((i+1)); done';
      const { execId } = await run(p, id, ["sh", "-c", script]);
      let expected = "";
      for (let i = 0; i < 60; i += 1) expected += `line-${i}-xxxxxxxx\n`;
      const got = await readAll(p, id, execId, 7);
      expect(dec.decode(got.bytes)).toBe(expected);
      expect(got.offset).toBe(enc.encode(expected).length);
    });

    t(
      "output beyond head + tail + slack is cut and reported as data, offsets stay logical",
      async () => {
        const id = await sandbox(p);
        const total = cap.head + cap.tail + cap.slack + 1000;
        const pat = "0123456789abcdef\n";
        const { execId, status } = await run(p, id, [
          "sh",
          "-c",
          `yes 0123456789abcdef | head -c ${total}`,
        ]);
        expect(status.exitCode).toBe(0);
        const at = (n: number, len: number): Uint8Array =>
          enc.encode(Array.from({ length: len }, (_, i) => pat[(n + i) % pat.length]).join(""));
        const got = await readAll(p, id, execId, 256 * 1024);
        // The bytes are the head and the tail and nothing else: no marker text is injected.
        const expected = concat([at(0, cap.head), at(total - cap.tail, cap.tail)]);
        expect(got.bytes.length).toBe(expected.length);
        expect(Buffer.from(got.bytes).equals(Buffer.from(expected))).toBe(true);
        // The cut is a record: where in the bytes, and how much was dropped.
        expect(got.cuts).toEqual([
          { atOffset: cap.head, omittedBytes: total - cap.head - cap.tail },
        ]);
        expect(got.offset).toBe(total);
      },
    );

    t("files: binary round trip and byte caps", async () => {
      const id = await sandbox(p);
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      await p.files.put(id, "/tmp/tt-conf/blob.bin", bytes);
      const back = await p.files.get(id, "/tmp/tt-conf/blob.bin", 1024);
      expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
      await expect(p.files.get(id, "/tmp/tt-conf/blob.bin", 255)).rejects.toBeInstanceOf(SpecError);
      const max = p.info.files.maxBytes;
      if (max !== undefined) {
        await expect(
          p.files.put(id, "/tmp/tt-conf/big.bin", new Uint8Array(max + 1)),
        ).rejects.toBeInstanceOf(SpecError);
      }
    });

    t("labels: list, count and destroyByLabels", async () => {
      const grp = `g${runId}`;
      const capped = opts.maxConcurrentSandboxes !== undefined && opts.maxConcurrentSandboxes < 3;
      const a = await sandbox(p, { grp, k: "1" });
      // With a cap of two, the group has one member; otherwise two.
      const b = capped ? undefined : await sandbox(p, { grp, k: "2" });
      const c = await sandbox(p, { grp: `other${runId}` });
      const members = [a, ...(b ? [b] : [])];
      const ids = async (labels: Labels) => (await p.list({ labels })).map((s) => s.id).toSorted();
      expect(await ids({ grp })).toEqual(members.toSorted());
      expect(await p.count({ labels: { grp } })).toBe(members.length);
      expect(await ids({ ...runLabels, k: "1" })).toEqual([a]);
      await expect(p.destroyByLabels({})).rejects.toBeInstanceOf(SpecError);
      expect(await p.destroyByLabels({ grp })).toBe(members.length);
      expect(await ids({ grp })).toEqual([]);
      expect((await ids(runLabels)).includes(c)).toBe(true);
      const info = (await p.list({ labels: { grp: `other${runId}` } }))[0];
      expect(info?.labels.grp).toBe(`other${runId}`);
    });

    t("no env leakage: controller env vars are absent in the sandbox", async () => {
      const name = `TT_CONFORMANCE_CANARY_${runId}`;
      const value = `canary-${crypto.randomUUID()}`;
      process.env[name] = value;
      try {
        const id = await sandbox(p);
        const { execId, status } = await run(p, id, ["env"]);
        expect(status.exitCode).toBe(0);
        const out = dec.decode((await readAll(p, id, execId)).bytes);
        expect(out).not.toContain(name);
        expect(out).not.toContain(value);
        const benign = new Set(
          "PATH HOME PWD OLDPWD SHLVL _ TERM LANG LC_ALL TMPDIR USER LOGNAME SHELL HOSTNAME".split(
            " ",
          ),
        );
        // A leak is the controller's value showing up under the same name in the sandbox; the
        // same name with a different value is the sandbox's own variable.
        const inSandbox = new Map<string, string>();
        for (const l of out.split("\n")) {
          const eq = l.indexOf("=");
          if (eq > 0) inSandbox.set(l.slice(0, eq), l.slice(eq + 1));
        }
        const leaked = Object.entries(process.env).filter(
          ([n, v]) => !benign.has(n) && inSandbox.get(n) === v,
        );
        expect(leaked.map(([n]) => n)).toEqual([]);
      } finally {
        delete process.env[name];
      }
    });
  });
}
