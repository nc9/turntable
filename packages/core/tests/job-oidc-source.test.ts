import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import { planWorkflow, plannedIdToken, wantsIdTokenIn } from "@turntable/act-runner";
import { OidcIssuer } from "../src/oidc/issuer";
import { JobOidc } from "../src/oidc/job-delivery";
import { plannedIdToken as proxyPlannedIdToken } from "../src/proxy";
import { seedWorld } from "./ops-helpers";

const job = (perm: string): string =>
  `jobs:\n  a:\n    runs-on: x\n    ${perm}\n    steps:\n      - run: echo\n`;
const wf = (top: string, perm: string): string => `name: t\non: push\n${top}${job(perm)}`;

const CASES: { name: string; yaml: string; asks: boolean }[] = [
  { name: "no permissions", yaml: wf("", ""), asks: false },
  { name: "job id-token write", yaml: wf("", "permissions:\n      id-token: write"), asks: true },
  { name: "job id-token read", yaml: wf("", "permissions:\n      id-token: read"), asks: false },
  {
    name: "workflow id-token write",
    yaml: wf("permissions:\n  id-token: write\n", ""),
    asks: true,
  },
  {
    name: "job block replaces the workflow's",
    yaml: wf("permissions:\n  id-token: write\n", "permissions:\n      contents: read"),
    asks: false,
  },
  { name: "write-all", yaml: wf("permissions: write-all\n", ""), asks: true },
  { name: "read-all", yaml: wf("permissions: read-all\n", ""), asks: false },
];

describe("one source of truth for an ID token request", () => {
  test("the planner stores the answer the plan readers give", () => {
    for (const c of CASES) {
      expect(wantsIdTokenIn(parse(c.yaml), "a"), c.name).toBe(c.asks);
      const p = planWorkflow(
        c.yaml,
        { name: "push", ref: "refs/heads/main" },
        { readFile: () => undefined },
      );
      const planned = p.jobs.find((j) => j.id === "a");
      expect(plannedIdToken(planned), c.name).toBe(c.asks);
      expect(proxyPlannedIdToken(JSON.stringify(planned)), c.name).toBe(c.asks);
    }
  });

  test("the proxy and the scheduler are the same function and fail closed alike", () => {
    expect(proxyPlannedIdToken).toBe(plannedIdToken);
    for (const bad of [null, undefined, "", "{", "null", "[]", "3", '{"idToken":"true"}', "{}"])
      expect(proxyPlannedIdToken(bad), String(bad)).toBe(false);
  });

  test("JobOidc.issue follows the stored plan, and a missing plan gets nothing", async () => {
    const { db, a } = await seedWorld();
    const master = randomBytes(32);
    const issuer = new OidcIssuer({
      db,
      masterKey: master,
      baseUrl: "https://ci.example.test/oidc",
    });
    const jobOidc = new JobOidc({ db, issuer, masterKey: master });
    const r = (planned: string | null) =>
      jobOidc.issue({ orgId: a.orgId, attemptId: a.attemptId, klass: "protected", planned });
    for (const planned of [JSON.stringify({ id: "a", key: "a", idToken: true })])
      expect("none" in (await r(planned))).toBe(false);
    for (const planned of [null, "{", JSON.stringify({ id: "a", key: "a" })])
      expect(await r(planned)).toEqual({ none: "the job did not ask for it" });
  });
});
