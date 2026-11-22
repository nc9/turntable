import { createRng, type Rng } from "./prng";

export type LogKind = "setup" | "lint" | "typecheck" | "test" | "build" | "e2e" | "huge" | "deploy";
export type LogOutcome = "success" | "failure" | "infra_error";

export type LogPlan = {
  kind: LogKind;
  outcome: LogOutcome;
  seed: string;
  startedAt: number;
  durationMs: number;
};

export type GeneratedLog = {
  bytes: Uint8Array;
  /** Cumulative byte offset after each line (lineEnds[i] is the end of line i, incl. newline). */
  lineEnds: Uint32Array;
  lineCount: number;
};

const ESC = "\u001b";
const c = (code: string, s: string): string => `${ESC}[${code}m${s}${ESC}[0m`;
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const cyan = (s: string) => c("36", s);

type Draft = { text: string; weight: number };

class Builder {
  readonly drafts: Draft[] = [];
  private step = 0;
  readonly rng: Rng;
  constructor(rng: Rng) {
    this.rng = rng;
  }
  line(text: string, weight = 1): void {
    this.drafts.push({ text, weight });
  }
  startStep(name: string): number {
    this.step += 1;
    this.line(`::tt-step::${JSON.stringify({ phase: "start", index: this.step, name })}`, 0.3);
    return this.step;
  }
  endStep(index: number, result: "success" | "failure" | "skipped"): void {
    this.line(`::tt-step::${JSON.stringify({ phase: "end", index, result })}`, 0.1);
  }
  group(title: string, body: string[]): void {
    this.line(`::group::${title}`);
    for (const l of body) this.line(l);
    this.line("::endgroup::", 0.1);
  }
}

const PACKAGES = [
  "react",
  "zod",
  "hono",
  "drizzle-orm",
  "pino",
  "undici",
  "ulid",
  "yaml",
  "esbuild",
  "vitest",
];
const FILES = [
  "src/queue/run-queue.ts",
  "src/scheduler/dispatch.ts",
  "src/api/runs.ts",
  "src/db/repos/jobs.ts",
  "src/providers/daytona.ts",
  "src/log/redact.ts",
  "src/auth/session.ts",
  "src/webhooks/github.ts",
];

function setupSteps(b: Builder, withInstall: boolean): void {
  const s1 = b.startStep("Set up job");
  b.line(`Current runner version: '2.321.0'`);
  b.group("Runner image", [
    `Image: turntable/ubuntu-24.04`,
    `Provider: ${b.rng.pick(["daytona", "docker", "e2b"])}`,
    `Sandbox: sbx_${b.rng.int(100000, 999999).toString(36)}`,
  ]);
  b.line(`Secret source: ${dim("proxy (values never enter the sandbox)")}`);
  b.endStep(s1, "success");

  const s2 = b.startStep("Checkout");
  b.line(`${cyan("$")} git init .`);
  b.line(
    `${cyan("$")} git fetch --depth=1 origin +${Array.from({ length: 40 }, () => b.rng.int(0, 15).toString(16)).join("")}`,
  );
  b.line(dim(`remote: Enumerating objects: ${b.rng.int(80, 900)}, done.`));
  b.line(
    dim(
      `Receiving objects: 100% (${b.rng.int(80, 900)}/${b.rng.int(80, 900)}), 1.2 MiB | 18.4 MiB/s, done.`,
    ),
  );
  b.endStep(s2, "success");

  if (withInstall) {
    const s3 = b.startStep("Install dependencies");
    b.line(`${cyan("$")} bun install --frozen-lockfile`);
    b.line(dim(`bun install v1.4.5 (c7a1e2d4)`));
    for (let i = 0; i < 6; i++)
      b.line(
        `${green("+")} ${b.rng.pick(PACKAGES)}@${b.rng.int(1, 9)}.${b.rng.int(0, 20)}.${b.rng.int(0, 9)}`,
      );
    b.line(`${b.rng.int(140, 600)} packages installed ${dim(`[${b.rng.int(800, 4200)}.00ms]`)}`);
    b.endStep(s3, "success");
  }
}

function testBody(b: Builder, failing: boolean, size: number): void {
  const idx = b.startStep("Run tests");
  b.line(`${cyan("$")} bun test`);
  b.line(dim("bun test v1.4.5 (c7a1e2d4)"));
  let fail = false;
  for (let f = 0; f < size; f++) {
    const file = `tests/${b.rng.pick(["queue", "scheduler", "db", "auth", "log", "provider", "webhook"])}-${f}.test.ts`;
    b.line(`${bold(file)}:`);
    const tests = b.rng.int(3, 12);
    for (let t = 0; t < tests; t++) {
      const name = b.rng.pick([
        "dispatches queued jobs",
        "retries infra errors once",
        "redacts secrets in chunks",
        "rejects cross-org lookups",
        "resumes from offset",
        "caps log views",
        "verifies webhook signatures",
      ]);
      const ms = (b.rng.next() * 40).toFixed(2);
      if (failing && !fail && f === Math.floor(size * 0.6) && t === 2) {
        fail = true;
        b.line(`${red("✗")} ${name} ${dim(`[${ms}ms]`)}`);
        b.line(red(`error: expect(received).toEqual(expected)`));
        b.line(``);
        b.line(`Expected: ${green('"success"')}`);
        b.line(`Received: ${red('"failure"')}`);
        b.line(`      at ${FILES[2]}:${b.rng.int(20, 200)}:${b.rng.int(5, 40)}`);
        b.line(
          `::error file=${FILES[2]},line=${b.rng.int(20, 200)},col=11,title=Assertion failed::${name}: expected "success" but received "failure"`,
        );
      } else {
        b.line(`${green("✓")} ${name} ${dim(`[${ms}ms]`)}`);
      }
    }
    if (f % 9 === 3)
      b.line(
        `::warning file=${b.rng.pick(FILES)},line=${b.rng.int(1, 300)}::Test is slow (${b.rng.int(800, 2400)}ms)`,
      );
  }
  b.line(``);
  b.line(` ${green(String(size * 6))} pass`);
  if (failing) b.line(` ${red("1")} fail`);
  b.line(
    ` ${size * 6 + (failing ? 1 : 0)} tests across ${size} files. ${dim(`[${b.rng.int(2, 40)}.${b.rng.int(10, 99)}s]`)}`,
  );
  if (failing) {
    b.line(`::error title=Process completed::Process completed with exit code 1.`);
    b.endStep(idx, "failure");
  } else {
    b.endStep(idx, "success");
  }
}

function genericBody(b: Builder, name: string, cmd: string, failing: boolean, lines: number): void {
  const idx = b.startStep(name);
  b.line(`${cyan("$")} ${cmd}`);
  for (let i = 0; i < lines; i++) {
    if (i % 7 === 0) b.line(`${dim(`[${i + 1}/${lines}]`)} ${b.rng.pick(FILES)} ${green("ok")}`);
    else
      b.line(
        `${dim("  ")}${b.rng.pick(["checking", "compiling", "bundling", "linting"])} ${b.rng.pick(FILES)}`,
      );
    if (i === Math.floor(lines / 3))
      b.line(`::notice title=Cache::Restored cache from key bun-${b.rng.int(1000, 9999)}`);
    if (i === Math.floor(lines / 2))
      b.line(
        `::warning file=${b.rng.pick(FILES)},line=${b.rng.int(1, 300)},col=3::Unused variable 'tmp'`,
      );
  }
  if (failing) {
    b.line(red(`error TS2322: Type 'string' is not assignable to type 'number'.`));
    b.line(
      `::error file=${FILES[4]},line=${b.rng.int(10, 120)},col=7,title=TS2322::Type 'string' is not assignable to type 'number'.`,
    );
    b.line(`::error title=Process completed::Process completed with exit code 2.`);
    b.endStep(idx, "failure");
  } else {
    b.line(green(`Done in ${b.rng.int(1, 40)}.${b.rng.int(10, 99)}s`));
    b.endStep(idx, "success");
  }
}

function hugeBody(b: Builder): void {
  const idx = b.startStep("Run end-to-end suite");
  b.line(`${cyan("$")} bun run e2e --reporter=verbose`);
  const total = 126_000;
  for (let i = 0; i < total; i++) {
    if (i === 62_000) {
      b.line(`::tt-cut::${JSON.stringify({ bytes: 3_405_772, reason: "middle" })}`);
      continue;
    }
    if (i % 5000 === 0) b.line(`::group::Shard ${i / 5000 + 1}`);
    b.line(
      `${dim(String(i).padStart(6, "0"))} ${green("PASS")} scenario-${b.rng.int(1, 900)} step ${b.rng.int(1, 40)} ${dim(`${b.rng.int(1, 900)}ms`)}`,
    );
    if (i % 5000 === 4999) b.line("::endgroup::", 0.1);
    if (i % 31_000 === 777)
      b.line(`::warning title=Flaky::scenario-${b.rng.int(1, 900)} needed a retry`);
  }
  b.endStep(idx, "success");
}

function build(plan: LogPlan): Draft[] {
  const rng = createRng(plan.seed);
  const b = new Builder(rng);
  const failing = plan.outcome === "failure";
  switch (plan.kind) {
    case "setup":
      setupSteps(b, true);
      break;
    case "lint":
      setupSteps(b, true);
      genericBody(b, "Run oxlint", "bun run lint", failing, rng.int(60, 160));
      break;
    case "typecheck":
      setupSteps(b, true);
      genericBody(b, "Run tsgo", "bun run typecheck", failing, rng.int(80, 220));
      break;
    case "test":
      setupSteps(b, true);
      testBody(b, failing, rng.int(20, 60));
      break;
    case "build":
      setupSteps(b, true);
      genericBody(b, "Build binary", "bun run build", failing, rng.int(120, 400));
      break;
    case "e2e":
      setupSteps(b, true);
      testBody(b, failing, rng.int(180, 320));
      break;
    case "huge":
      setupSteps(b, true);
      hugeBody(b);
      break;
    case "deploy":
      setupSteps(b, false);
      genericBody(b, "Deploy", "bun run deploy", failing, rng.int(30, 80));
      break;
  }
  if (plan.outcome === "infra_error") {
    // Sandbox disappears mid-step: cut the script and leave the open step without an end marker.
    const keep = Math.max(8, Math.floor(b.drafts.length * (0.3 + rng.next() * 0.4)));
    b.drafts.length = keep;
    while (b.drafts.length > 0 && b.drafts[b.drafts.length - 1]?.text.startsWith("::endgroup"))
      b.drafts.pop();
  }
  return b.drafts;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");
function iso(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}Z`;
}

const cache = new Map<string, GeneratedLog>();

/** Builds the full log for an attempt once; live attempts reveal a growing prefix of it. */
export function generateLog(plan: LogPlan): GeneratedLog {
  const hit = cache.get(plan.seed);
  if (hit) return hit;
  const drafts = build(plan);
  const enc = new TextEncoder();
  const totalWeight = drafts.reduce((a, d) => a + d.weight, 0);
  const parts: Uint8Array[] = [];
  const lineEnds = new Uint32Array(drafts.length);
  let t = plan.startedAt;
  let off = 0;
  const msPerWeight = plan.durationMs / Math.max(1, totalWeight);
  drafts.forEach((d, i) => {
    t += d.weight * msPerWeight;
    const bytes = enc.encode(`${iso(Math.floor(t))} ${d.text}\n`);
    parts.push(bytes);
    off += bytes.length;
    lineEnds[i] = off;
  });
  const all = new Uint8Array(off);
  let p = 0;
  for (const part of parts) {
    all.set(part, p);
    p += part.length;
  }
  const out = { bytes: all, lineEnds, lineCount: drafts.length };
  cache.set(plan.seed, out);
  if (cache.size > 40) cache.delete(cache.keys().next().value as string);
  return out;
}
