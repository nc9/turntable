import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCKER_ENV_PASSTHROUGH, scrubbedEnv } from "@turntable/provider-sdk";

const source = {
  PATH: "/usr/bin",
  HOME: "/home/x",
  LANG: "C",
  TURNTABLE_MASTER_KEY_FILE: "/secret/master.key",
  TURNTABLE_BOOTSTRAP_TOKEN_SHA256: "abc",
  GITHUB_TOKEN: "ghs_x",
  AWS_SECRET_ACCESS_KEY: "k",
  DAYTONA_API_KEY: "d",
  DOCKER_HOST: "unix:///var/run/docker.sock",
  RANDOM_THING: "1",
};

test("a child gets the allowlist and nothing else", () => {
  const env = scrubbedEnv({}, [], source);
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", LANG: "C" });
});

test("named extras pass; explicit values win; credentials and Turntable settings are refused", () => {
  expect(scrubbedEnv({}, DOCKER_ENV_PASSTHROUGH, source).DOCKER_HOST).toBe(
    "unix:///var/run/docker.sock",
  );
  expect(scrubbedEnv({ HOME: "/work" }, [], source).HOME).toBe("/work");
  for (const name of [
    "TURNTABLE_MASTER_KEY_FILE",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DAYTONA_API_KEY",
  ]) {
    expect(() => scrubbedEnv({}, [name], source)).toThrow(/refusing/);
  }
  expect(() => scrubbedEnv({ TURNTABLE_X: "1" }, [], source)).toThrow(/refusing/);
});

/**
 * Source guard: every process the server starts gets an explicit environment, and none spreads
 * process.env. Lexical, like the net and tenancy guards: it catches the accidental inherit.
 */
const PACKAGES = join(import.meta.dir, "../..");
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "node_modules" || e.name === "dist"
        ? []
        : walk(join(dir, e.name))
      : e.name.endsWith(".ts") || e.name.endsWith(".tsx")
        ? [join(dir, e.name)]
        : [],
  );
}

test("every spawn in package sources passes an explicit env, and nothing spreads process.env", () => {
  const problems: string[] = [];
  const srcDirs = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(PACKAGES, d.name, "src"))
    .filter((d) => {
      try {
        return readdirSync(d).length > 0;
      } catch {
        return false;
      }
    });
  for (const dir of srcDirs) {
    for (const file of walk(dir)) {
      const text = readFileSync(file, "utf8");
      const rel = relative(PACKAGES, file);
      if (/from "node:child_process"|require\("child_process"\)/.test(text)) {
        problems.push(`${rel}: imports child_process; use Bun.spawn with an explicit env`);
      }
      if (/\.\.\.process\.env\b/.test(text)) problems.push(`${rel}: spreads process.env`);
      for (const m of text.matchAll(/\bBun\.spawn(Sync)?\(/g)) {
        const window = text.slice(m.index, m.index + 700);
        const env = /\benv:\s*([^\n]*)/.exec(window);
        if (!env) problems.push(`${rel}: Bun.spawn without env`);
        else if (/process\.env/.test(env[1]!) && !/scrubbedEnv/.test(env[1]!)) {
          problems.push(`${rel}: Bun.spawn env reads process.env directly`);
        }
      }
    }
  }
  expect(problems).toEqual([]);
});
