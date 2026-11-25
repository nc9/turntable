import { expect, test } from "bun:test";
import { projectSetup } from "../src/ops/project-setup";

const base = { ingestConfig: null, inStaticPoll: false, hasRuns: false, fromInstallation: true };

test("projectSetup: a sync-created project nobody set up is available", () => {
  expect(projectSetup(base)).toBe("available");
});

test("projectSetup: ingest settings, a static poll entry or a run make it active", () => {
  expect(projectSetup({ ...base, ingestConfig: "{}" })).toBe("active");
  expect(projectSetup({ ...base, inStaticPoll: true })).toBe("active");
  expect(projectSetup({ ...base, hasRuns: true })).toBe("active");
});

test("projectSetup: a project made on purpose (no installation binding) is active", () => {
  expect(projectSetup({ ...base, fromInstallation: false })).toBe("active");
});
