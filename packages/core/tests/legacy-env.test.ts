// LONGSHORE_* (formerly Longshore) is still read, as TURNTABLE_*, with one warning per variable.
import { describe, expect, test } from "bun:test";
import { applyLegacyEnv } from "../src/legacy-env";
import { serveDefaults } from "../src/serve-config";

const run = (env: Record<string, string | undefined>) => {
  const warnings: string[] = [];
  const moved = applyLegacyEnv(env, (m) => warnings.push(m));
  return { env, moved, warnings };
};

describe("applyLegacyEnv", () => {
  test("an old variable is read as the new name, and one warning names it", () => {
    const { env, moved, warnings } = run({ LONGSHORE_PORT_X: "1", LONGSHORE_DATA_DIR: "/data", PATH: "/bin" });
    expect(env).toEqual({ TURNTABLE_PORT_X: "1", TURNTABLE_DATA_DIR: "/data", PATH: "/bin" });
    expect(moved.toSorted()).toEqual(["LONGSHORE_DATA_DIR", "LONGSHORE_PORT_X"]);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("LONGSHORE_DATA_DIR") && w.includes("TURNTABLE_DATA_DIR"))).toBe(true);
  });

  test("when both are set the new name wins, with a warning, and the old one is removed", () => {
    const { env, warnings } = run({ LONGSHORE_HOST: "0.0.0.0", TURNTABLE_HOST: "127.0.0.1" });
    expect(env).toEqual({ TURNTABLE_HOST: "127.0.0.1" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("LONGSHORE_HOST is ignored");
  });

  test("a value is never logged", () => {
    const { warnings } = run({ LONGSHORE_MASTER_KEY_FILE: "/very/secret/path", LONGSHORE_X: "hunter2" });
    expect(warnings.join("\n")).not.toContain("hunter2");
    expect(warnings.join("\n")).not.toContain("/very/secret/path");
  });

  test("with nothing old set it does nothing, and it is idempotent", () => {
    const { env, moved, warnings } = run({ TURNTABLE_HOST: "h" });
    expect(moved).toEqual([]);
    expect(warnings).toEqual([]);
    expect(applyLegacyEnv(env, () => {})).toEqual([]);
  });

  test("the settings the server reads come through, so a deployment with old variables still boots the same", () => {
    const { env } = run({
      LONGSHORE_HOST: "0.0.0.0",
      LONGSHORE_DATA_DIR: "/data",
      LONGSHORE_WORKER: "1",
      LONGSHORE_PROVIDER: "daytona",
      LONGSHORE_HOSTED: "0",
    });
    const d = serveDefaults(env);
    expect(d.host).toBe("0.0.0.0");
    expect(d.dataDir).toBe("/data");
    expect(d.worker).toBe(true);
    expect(d.provider).toBe("daytona");
    expect(d.hosted).toBe(false);
  });
});

describe("the boot hook", () => {
  test("importing it moves the environment of the process, with a warning on stderr", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import ${JSON.stringify(new URL("../src/legacy-env-boot", import.meta.url).pathname)};
         console.log(JSON.stringify({ n: process.env.TURNTABLE_DATA_DIR, o: process.env.LONGSHORE_DATA_DIR ?? null }));`,
      ],
      { env: { PATH: process.env.PATH ?? "", LONGSHORE_DATA_DIR: "/d" }, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    expect(JSON.parse(out)).toEqual({ n: "/d", o: null });
    expect(err).toContain("LONGSHORE_DATA_DIR is deprecated");
  });

  test("main.ts imports it before anything else reads the environment", async () => {
    const main = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
    expect(main.split("\n")[0]).toBe('import "./legacy-env-boot";');
  });
});
