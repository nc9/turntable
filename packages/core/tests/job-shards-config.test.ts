// The operator's split rules: validated in the poll config and the ingest settings, set and
// audited with `policy set --ingest on --splits-json`, never read from the repository.
import { beforeEach, expect, test } from "bun:test";
import { bindRepo, createOrg, createProject, listAudit, openDatabase, type Db } from "../src/db";
import { setIngestPolicy, showIngest } from "../src/ops/policy-cli";
import { pollConfigSchema } from "../src/poll";
import { ingestSettingsSchema, splitsSchema } from "../src/poll/config";

const TWO = [{ job: "tests", shards: [{ steps: ["A"] }, { steps: ["B", "#4"] }] }];

test("valid rules pass; a bad one is refused, whole", () => {
  expect(splitsSchema.safeParse(TWO).success).toBe(true);
  const bad: unknown[] = [
    [{ job: "tests", shards: [{ steps: ["A"] }] }], // one shard
    [{ job: "tests", shards: Array.from({ length: 9 }, (_, i) => ({ steps: [`s${i}`] })) }],
    [{ job: "tests", shards: [{ steps: [] }, { steps: ["B"] }] }],
    [{ job: "tests", shards: [{ steps: ["A"] }, { steps: ["A"] }] }], // a step in two shards
    [{ job: "tests", shards: [{ steps: ["#0"] }, { steps: ["B"] }] }],
    [{ job: "bad job", shards: [{ steps: ["A"] }, { steps: ["B"] }] }],
    [{ job: "tests", shards: [{ steps: ["A"] }, { steps: ["B"] }], extra: 1 }],
    [...TWO, ...TWO], // two rules for one job
    [{ job: "tests", shards: [{ steps: ["A"] }, { steps: ["x".repeat(201)] }] }],
  ];
  for (const b of bad)
    expect(splitsSchema.safeParse(b).success, JSON.stringify(b).slice(0, 70)).toBe(false);
});

test("the poll config and the ingest settings take splits", () => {
  const repo = { repo: "acme/web", workflow: ".github/workflows/ci.yml", defaultBranch: "main" };
  const cfg = pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [{ ...repo, splits: TWO }],
  });
  expect(cfg.repos[0]!.splits).toEqual(TWO);
  expect(ingestSettingsSchema.parse({ defaultBranch: "main", splits: TWO }).splits).toEqual(TWO);
  expect(() =>
    pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [{ ...repo, splits: [{ job: "t", shards: [{ steps: ["A"] }] }] }],
    }),
  ).toThrow();
});

let db: Db;
beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
  await bindRepo(
    db,
    { orgId: org.id, projectId: project.id },
    { forge: "github", owner: "acme", repo: "web" },
  );
});

test("policy set --ingest on stores the rules, audits them and shows them; an invalid rule is refused", async () => {
  const r = await setIngestPolicy(db, "acme", "web", "on", { defaultBranch: "main", splits: TWO });
  expect(r.to?.splits).toEqual(TWO);
  expect((await showIngest(db, "acme"))[0]?.ingest?.splits).toEqual(TWO);
  const org = (await db.run((h) => h.orm.query.orgs.findFirst()))!;
  const audit = JSON.stringify(await listAudit(db, { orgId: org.id }, { limit: 20 }));
  expect(audit).toContain("tests");
  await expect(
    setIngestPolicy(db, "acme", "web", "on", {
      defaultBranch: "main",
      splits: [{ job: "tests", shards: [{ steps: ["A"] }] }],
    }),
  ).rejects.toThrow(/invalid ingest settings/);
  // replacing without splits clears them (the settings are replaced as a whole)
  const again = await setIngestPolicy(db, "acme", "web", "on", { defaultBranch: "main" });
  expect(again.to?.splits).toBeUndefined();
});

test("shard paths: workflow path-filter globs are accepted; an empty list or a bad glob is a config error", () => {
  const rule = (paths: unknown) => [
    { job: "tests", shards: [{ steps: ["A"], paths }, { steps: ["B"] }] },
  ];
  expect(splitsSchema.safeParse(rule(["src/**", "!src/docs/**"])).success).toBe(true);
  for (const bad of [[], [""], ["!"], ["a[b"], ["!only/**"], "src/**", [1], Array(51).fill("a/**")])
    expect(splitsSchema.safeParse(rule(bad)).success, JSON.stringify(bad)).toBe(false);
  const empty = splitsSchema.safeParse(rule([]));
  expect(JSON.stringify(empty.error?.issues)).toContain("empty paths list");
  // the poll config and the ingest settings reject it when they load
  expect(() =>
    pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        {
          repo: "acme/web",
          workflow: ".github/workflows/ci.yml",
          defaultBranch: "main",
          splits: rule(["a[b"]),
        },
      ],
    }),
  ).toThrow();
  expect(ingestSettingsSchema.safeParse({ defaultBranch: "main", splits: rule([]) }).success).toBe(
    false,
  );
});
