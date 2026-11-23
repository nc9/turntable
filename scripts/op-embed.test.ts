import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildShim,
  CORE_WASM_SHA256,
  type CoreFiles,
  onePasswordEmbedPlugin,
  readInstalledCore,
  SDK_CORE_VERSION,
  TARGET_LINE,
} from "./op-embed";

const root = join(import.meta.dir, "..");
const coreDir = join(root, "packages/core");

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const sha = createHash("sha256").update(wasm).digest("hex");
const fake = (over: Partial<CoreFiles> = {}): CoreFiles => ({
  version: "9.9.9",
  coreJs: `before\n${TARGET_LINE}\nafter\n`,
  wasm,
  wasmPath: "/abs/core_bg.wasm",
  ...over,
});
const pin = { version: "9.9.9", sha256: sha };

describe("the embed shim", () => {
  test("replaces the one disk read with a require of the wasm", () => {
    const out = buildShim(fake(), pin);
    expect(out).not.toContain(TARGET_LINE);
    expect(out).toContain(`const path = require("/abs/core_bg.wasm");`);
    expect(out).toContain("before\n");
  });

  test("fails loudly when the target line is missing or appears twice", () => {
    expect(() => buildShim(fake({ coreJs: "nothing here" }), pin)).toThrow("found 0");
    expect(() => buildShim(fake({ coreJs: `${TARGET_LINE}\n${TARGET_LINE}` }), pin)).toThrow(
      "found 2",
    );
  });

  test("fails loudly when the wasm is not the pinned binary", () => {
    expect(() => buildShim(fake({ wasm: new Uint8Array([1, 2, 3]) }), pin)).toThrow("sha256");
  });

  test("fails loudly when the installed version is not the pinned one", () => {
    expect(() => buildShim(fake({ version: "9.9.10" }), pin)).toThrow("pinned to 9.9.9");
  });

  test("the installed @1password/sdk-core is the pinned version with the pinned wasm", () => {
    const core = readInstalledCore(coreDir);
    expect(core.version).toBe(SDK_CORE_VERSION);
    expect(createHash("sha256").update(core.wasm).digest("hex")).toBe(CORE_WASM_SHA256);
    expect(() => buildShim(core)).not.toThrow();
  });

  test("the SDK packages are exact-pinned, never a range", () => {
    const deps = (
      JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies;
    expect(deps["@1password/sdk"]).toBe("0.5.0");
    expect(deps["@1password/sdk-core"]).toBe("0.5.0");
  });
});

// Gated (TT_OP_EMBED=1, `bun run test:op-embed`): compiles a binary and runs it from an empty
// directory. It takes a while and writes a ~120 MB file, so it is not in the default suites.
describe.skipIf(process.env.TT_OP_EMBED !== "1")("the compiled binary", () => {
  test("carries the wasm core and runs from an empty directory", async () => {
    const work = mkdtempSync(join(tmpdir(), "op-embed-test-"));
    const empty = mkdtempSync(join(tmpdir(), "op-embed-empty-"));
    try {
      const outfile = join(work, "probe");
      const result = await Bun.build({
        entrypoints: [join(coreDir, "tests/op-embed-entry.ts")],
        compile: { outfile },
        plugins: [onePasswordEmbedPlugin(coreDir)],
      });
      expect(result.success).toBe(true);
      const bin = readFileSync(outfile);
      const core = readInstalledCore(coreDir);
      // The whole core is inside the binary, not a path to it.
      expect(bin.includes(Buffer.from(core.wasm.subarray(0, 4096)))).toBe(true);
      const p = Bun.spawn([outfile], { cwd: empty, env: {}, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      expect(out).toContain("invalid service account token");
      expect(out).not.toContain("ENOENT");
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  }, 180_000);
});
