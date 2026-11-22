import { expect, test } from "bun:test";
import { join } from "node:path";
import type {
  WireAttempt,
  WireChecks,
  WireCancel,
  WireJob,
  WireLog,
  WireRun,
} from "../src/api/wire";

// Keeps the hand-written wire types honest: if docs/openapi.json drops or renames a field the
// adapter reads, this fails. Regenerate the spec with the core's openapi script after API changes.

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  maximum?: number;
};
type Param = { name: string; in: string; schema: Schema };
type Op = {
  operationId: string;
  parameters?: Param[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<string, { content?: { "application/json": { schema: Schema } } }>;
};
const spec = (await Bun.file(join(import.meta.dir, "../../../docs/openapi.json")).json()) as {
  paths: Record<string, Record<string, Op>>;
};

const op = (path: string, method: string): Op => {
  const o = spec.paths[path]?.[method];
  if (!o) throw new Error(`spec has no ${method} ${path}`);
  return o;
};
const ok = (o: Op): Schema => o.responses["200"]!.content!["application/json"].schema;

/** Property names the adapter reads must exist in the spec (and be required). */
function expectKeys(schema: Schema, keys: string[]): void {
  const props = Object.keys(schema.properties ?? {});
  for (const k of keys) expect(props).toContain(k);
  for (const k of keys) expect(schema.required ?? []).toContain(k);
}

const keysOf = <T>(sample: Record<keyof T, true>): string[] => Object.keys(sample);

test("list_runs: path, params and run fields", () => {
  const o = op("/runs", "get");
  expect(o.operationId).toBe("list_runs");
  const names = (o.parameters ?? []).map((p) => p.name);
  for (const n of ["org", "project", "state", "branch", "event", "limit", "cursor"])
    expect(names).toContain(n);
  expect((o.parameters ?? []).find((p) => p.name === "limit")?.schema.maximum).toBe(100);
  const body = ok(o);
  expectKeys(body, ["runs", "next_cursor"]);
  expectKeys(
    body.properties!.runs!.items!,
    keysOf<WireRun>({
      id: true,
      project: true,
      workflow_path: true,
      event: true,
      ref: true,
      sha: true,
      state: true,
      created_at: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
    }),
  );
});

test("get_run: run, job and attempt fields", () => {
  const body = ok(op("/runs/{run_id}", "get"));
  expectKeys(body, ["id", "project", "state", "created_at", "jobs"]);
  const job = body.properties!.jobs!.items!;
  expectKeys(
    job,
    keysOf<WireJob>({
      id: true,
      job_key: true,
      name: true,
      state: true,
      exit_code: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
      infra_error_reason: true,
      attempts: true,
      log_path: true,
    }),
  );
  expectKeys(
    job.properties!.attempts!.items!,
    keysOf<WireAttempt>({
      id: true,
      attempt: true,
      state: true,
      provider: true,
      exit_code: true,
      error_class: true,
      started_at: true,
      finished_at: true,
      duration_ms: true,
    }),
  );
});

test("job_log: offset range reads fit the adapter's page size", () => {
  const o = op("/jobs/{job_id}/log", "get");
  const params = Object.fromEntries((o.parameters ?? []).map((p) => [p.name, p]));
  for (const n of ["job_id", "attempt", "mode", "offset", "max_bytes", "org"])
    expect(params[n]).toBeDefined();
  expect(params.max_bytes!.schema.maximum).toBeGreaterThanOrEqual(262_144);
  expectKeys(
    ok(o),
    keysOf<WireLog>({
      job_id: true,
      attempt: true,
      mode: true,
      text: true,
      offset: true,
      bytes: true,
      total_bytes: true,
      next_offset: true,
      truncated: true,
    }),
  );
});

test("checks_for_sha and cancel", () => {
  expectKeys(
    ok(op("/checks/{sha}", "get")),
    keysOf<WireChecks>({ sha: true, state: true, counts: true, runs: true }),
  );
  const cancel = op("/runs/{run_id}/cancel", "post");
  expectKeys(
    ok(cancel),
    keysOf<WireCancel>({ run_id: true, state: true, cancelled_jobs: true, unchanged_jobs: true }),
  );
  expect(Object.keys(cancel.requestBody!.content["application/json"].schema.properties!)).toContain(
    "org",
  );
});

test("the spec has no operation the UI expects but cannot find (rerun, orgs, projects are known gaps)", () => {
  const ids = Object.values(spec.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
  // events, job_steps and job_cuts exist now; the adapter wires them in #30.
  for (const known of [
    "list_runs",
    "get_run",
    "job_log",
    "checks_for_sha",
    "cancel",
    "events",
    "job_steps",
    "job_cuts",
  ])
    expect(ids).toContain(known);
  // When these appear, wire them into the adapter and flip the matching capability.
  for (const gap of ["rerun", "list_orgs", "list_projects"]) expect(ids).not.toContain(gap);
});
