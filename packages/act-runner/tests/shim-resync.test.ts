import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_SHIMS_SH, SHIM_NAMES, STEP_SHIM } from "../src/step-env";

const root = mkdtempSync(join(tmpdir(), "ls-resync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
let shims = "";
let base = ""; // where bash lives: behind the shims
let late = ""; // a dir behind the shim dir, where an install lands
let early = ""; // a dir AHEAD of the shim dir, as GITHUB_PATH would put one

function tool(dir: string, name: string, out: string) {
  writeFileSync(join(dir, name), `#!/bin/sh\necho ${out}\n`);
  chmodSync(join(dir, name), 0o755);
}

// The system dir holds only the utilities the shim and install script need, so a real node,
// python or pwsh on the machine running the tests cannot leak into a case.
const sys = join(root, "sys");
mkdirSync(sys, { recursive: true });
for (const u of [
  "sh",
  "cat",
  "sleep",
  "mktemp",
  "mkfifo",
  "readlink",
  "dirname",
  "mkdir",
  "printf",
  "chmod",
  "rm",
  "ln",
  "mv",
  "perl",
  "env",
]) {
  const src = ["/usr/bin", "/bin"].map((d) => join(d, u)).find((f) => existsSync(f));
  if (src) symlinkSync(src, join(sys, u));
}
const pathWith = (...dirs: string[]) => [...dirs, sys].join(":");

async function sh(script: string, path: string, args: string[] = []) {
  const p = Bun.spawn(["/bin/sh", "-c", script, "tt", ...args], {
    env: { PATH: path, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out: out.trim(), err, code };
}

/** One shimmed step: the bash shim runs the fake bash, and resyncs at start and exit. */
const runShim = (path: string) => sh(`exec "${join(shims, "bash")}"`, path);

beforeEach(async () => {
  const d = join(root, `case${n++}`);
  shims = join(d, "shims");
  base = join(d, "base");
  late = join(d, "late");
  early = join(d, "early");
  for (const x of [base, late, early]) mkdirSync(x, { recursive: true });
  tool(base, "bash", "bash-ran");
  const r = await sh(INSTALL_SHIMS_SH, pathWith(base), [shims, STEP_SHIM, ...SHIM_NAMES]);
  expect(r.code).toBe(0);
});

describe("shim resync", () => {
  test("command -v fails and no shim exists before the tool is installed", async () => {
    const path = pathWith(shims, base, late);
    expect(existsSync(join(shims, "node"))).toBe(false);
    expect((await sh("command -v node", path)).code).not.toBe(0);
    // A shimmed step runs, the tool is still absent: still no shim, still honest.
    expect((await runShim(path)).out).toBe("bash-ran");
    expect(existsSync(join(shims, "node"))).toBe(false);
    expect((await sh("command -v node", path)).code).not.toBe(0);
  });

  test("a tool installed behind the shim dir is linked by the next shim run", async () => {
    const path = pathWith(shims, base, late);
    await runShim(path);
    tool(late, "node", "real-node");
    expect(existsSync(join(shims, "node"))).toBe(false);
    await runShim(path);
    expect(readlinkSync(join(shims, "node"))).toBe("step-shim");
    expect((await sh("command -v node", path)).out).toBe(join(shims, "node"));
    expect((await sh("node", path)).out).toBe("real-node");
  });

  test("a tool installed during the step is linked at the step's exit", async () => {
    const path = pathWith(shims, base, late);
    // The fake bash installs node and ends; the shim's exit resync links it.
    writeFileSync(
      join(base, "bash"),
      `#!/bin/sh\nprintf '#!/bin/sh\\necho real-node\\n' > "${late}/node"\nchmod 755 "${late}/node"\n`,
    );
    await runShim(path);
    expect(readlinkSync(join(shims, "node"))).toBe("step-shim");
  });

  test("a tool dir AHEAD of the shim dir gets no shim", async () => {
    const path = pathWith(early, shims, base, late);
    tool(early, "node", "early-node");
    await runShim(path);
    expect(existsSync(join(shims, "node"))).toBe(false);
    const r = await sh("command -v node; node", path);
    expect(r.out).toBe(`${join(early, "node")}\nearly-node`);
  });

  test("add-only: an existing link is kept when the real tool disappears", async () => {
    const path = pathWith(shims, base, late);
    tool(late, "node", "real-node");
    await runShim(path);
    rmSync(join(late, "node"));
    await runShim(path);
    expect(lstatSync(join(shims, "node")).isSymbolicLink()).toBe(true);
  });

  test("idempotent and concurrency-safe: parallel runs leave one whole link and no temp files", async () => {
    const path = pathWith(shims, base, late);
    for (const t of ["node", "pwsh", "python3"]) tool(late, t, t);
    const runs = await Promise.all(Array.from({ length: 12 }, () => runShim(path)));
    for (const r of runs) expect(r.out).toBe("bash-ran");
    for (const t of ["node", "pwsh", "python3"]) {
      expect(readlinkSync(join(shims, t))).toBe("step-shim");
    }
    expect(readdirSync(shims).filter((f) => f.startsWith("."))).toEqual([]);
    const before = readdirSync(shims).toSorted();
    await runShim(path);
    expect(readdirSync(shims).toSorted()).toEqual(before);
  });
});
