// `longshore doctor`: read-only readiness check for an operator before going live. It opens the
// database read-only, creates nothing and starts nothing. Exits 1 when any check fails (and with
// --strict when any warns), so a deploy script can gate on it.
import { parseArgs } from "node:util";
import { runDoctor } from "./checks";
import { realInputs } from "./real";
import type { DoctorReport } from "./types";

export const DOCTOR_USAGE = `Usage: longshore doctor [--data-dir ./data] [--provider docker|daytona] [--provider-config <file>] [--database-url postgres://...] [--hosted] [--json] [--strict]

Checks that this instance is ready to go live, and says what to fix: privileges and the data
directory, the master key, the database and its migrations, the GitHub App, the sandbox provider
(without creating a sandbox), the secrets proxy's TLS certificate, the https redirect, the release
channel and quotas. Reads the same LONGSHORE_* environment as \`longshore serve\`. Nothing is
changed and no secret value is printed. Exit status 1 when a check fails (--strict: or warns).`;

const MARK = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;

export function renderReport(r: DoctorReport): string {
  const out: string[] = [];
  for (const c of r.checks) {
    out.push(`${MARK[c.status]}  ${c.area}: ${c.summary}${c.detail ? ` (${c.detail})` : ""}`);
    if (c.fix && c.status !== "pass") out.push(`      fix: ${c.fix}`);
  }
  out.push("", `${r.counts.pass} passed, ${r.counts.warn} warning(s), ${r.counts.fail} failed`);
  return out.join("\n");
}

export async function doctorCommand(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "data-dir": { type: "string" },
      provider: { type: "string" },
      "provider-config": { type: "string" },
      "database-url": { type: "string" },
      hosted: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(DOCTOR_USAGE);
    return 0;
  }
  const { inputs, close } = realInputs({
    env,
    dataDir: values["data-dir"] ?? env.LONGSHORE_DATA_DIR?.trim() ?? "./data",
    hosted: values.hosted === true || env.LONGSHORE_HOSTED === "1",
    provider: values.provider,
    providerConfig: values["provider-config"],
  });
  try {
    const r = await runDoctor(inputs);
    console.log(values.json ? JSON.stringify(r, null, 2) : renderReport(r));
    return r.status === "fail" || (values.strict && r.status === "warn") ? 1 : 0;
  } finally {
    close();
  }
}
