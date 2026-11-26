import { beforeEach, expect, test } from "bun:test";
import {
  type Db,
  ensureLocalTenant,
  getRun,
  listAudit,
  listJobs,
  listRuns,
  openDatabase,
  putStoredSetting,
  type Scope,
} from "../src/db";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { judgeLabelEvent } from "../src/poll/label-approval";
import type { PrTimeline } from "../src/poll/github";
import type { PrNoticeWriter } from "../src/poll/pr-notices";
import { parseTrust } from "../src/db/repos";

const REPO = "acme/web";
const LABEL = "ci:approved";
const WORKFLOW = `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
const SHA = (c: string) => c.repeat(40);

type Ev =
  | {
      event: "labeled";
      id: number;
      at: number;
      login: string | null;
      type?: string;
      label?: string;
    }
  | { event: "committed"; at: number }
  | { event: "head_ref_force_pushed"; at: number };

function fake() {
  const state = {
    headSha: SHA("b"),
    labels: [] as string[],
    author: "stranger",
    timeline: [] as Ev[],
    permission: new Map<string, string>(),
    permissionUnknown: false,
    writes: [] as string[],
  };
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      state.writes.push(`${method} ${u.pathname}`);
      return new Response("{}", { status: 200 });
    }
    if (u.pathname === `/repos/${REPO}/commits/main`) {
      return Response.json({
        sha: SHA("a"),
        commit: { message: "m" },
        author: { login: "octocat" },
      });
    }
    const commit = /\/commits\/([0-9a-f]{40})$/.exec(u.pathname);
    if (commit) {
      return Response.json({
        sha: commit[1],
        commit: { message: "m" },
        author: { login: "octocat" },
      });
    }
    if (u.pathname === `/repos/${REPO}/events`) return Response.json([]);
    if (u.pathname === `/repos/${REPO}/branches/main`) return Response.json({ protected: true });
    if (u.pathname === `/repos/${REPO}/pulls`) {
      return Response.json([
        {
          number: 7,
          title: "PR 7",
          user: { login: state.author, type: "User" },
          labels: state.labels.map((name) => ({ name })),
          head: { sha: state.headSha, ref: "topic", repo: { full_name: "stranger/web" } },
          base: { repo: { full_name: REPO } },
        },
      ]);
    }
    if (/\/repos\/acme\/web\/pulls\/7$/.test(u.pathname)) return Response.json({ state: "open" });
    if (u.pathname === `/repos/${REPO}/issues/7/timeline`) {
      return Response.json(
        state.timeline.map((e) =>
          e.event === "labeled"
            ? {
                event: "labeled",
                id: e.id,
                created_at: new Date(e.at).toISOString(),
                actor: e.login === null ? null : { login: e.login, type: e.type ?? "User" },
                label: { name: e.label ?? LABEL },
              }
            : e.event === "committed"
              ? { event: "committed", committer: { date: new Date(e.at).toISOString() } }
              : { event: e.event, created_at: new Date(e.at).toISOString() },
        ),
      );
    }
    const perm = /\/collaborators\/([^/]+)\/permission$/.exec(u.pathname);
    if (perm) {
      if (state.permissionUnknown) return new Response("no", { status: 403 });
      const role = state.permission.get(decodeURIComponent(perm[1]!)) ?? "none";
      return Response.json({ permission: role, role_name: role });
    }
    if (u.pathname.startsWith(`/repos/${REPO}/contents/`)) return new Response(WORKFLOW);
    return new Response("unexpected", { status: 500 });
  };
  return { state, fetch: fetchStub };
}

let db: Db;
let scope: Required<Scope>;

beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  await putStoredSetting(
    db,
    { kind: "project", id: scope.projectId, orgId: scope.orgId },
    "pr_approval_label",
    LABEL,
    "test",
    Date.now(),
  );
});

const cfg = pollConfigSchema.parse({
  allowUnauthenticated: true,
  repos: [
    {
      repo: REPO,
      workflow: ".github/workflows/ci.yml",
      defaultBranch: "main",
      prMode: "approval",
      prBaseline: false,
      authors: ["octocat"],
    },
  ],
}).repos[0]!;

function writer(log: string[]): PrNoticeWriter {
  return {
    removeLabel: async (_r, pr, label) => void log.push(`remove ${pr} ${label}`),
    comment: async (_r, pr, body) => void log.push(`comment ${pr} ${body.slice(0, 20)}`),
  };
}

async function poll(gh: ReturnType<typeof fake>, notices?: string[]) {
  return pollRepo(
    {
      db,
      github: new GithubClient({
        fetch: gh.fetch,
        baseUrl: "https://api.github.com",
        token: "test-token",
      }),
      provider: "docker",
      ...(notices ? { notices: async () => writer(notices) } : {}),
    },
    cfg,
  );
}

/** Polls once so the head's run exists and waits; returns it and its creation time. */
async function waitingRun(gh: ReturnType<typeof fake>) {
  await poll(gh);
  const run = (await listRuns(db, scope)).find(
    (r) => r.event === "pull_request" && r.sha === gh.state.headSha,
  )!;
  expect(run.status).toBe("awaiting_approval");
  return run;
}

test("a write+ human who is not the author releases exactly that sha, as untrusted_pr", async () => {
  const gh = fake();
  const run = await waitingRun(gh);
  gh.state.permission.set("maint", "maintain");
  gh.state.labels = [LABEL];
  gh.state.timeline = [
    { event: "committed", at: run.createdAt - 5_000 },
    { event: "labeled", id: 99, at: run.createdAt + 1_000, login: "maint" },
  ];
  const res = await poll(gh);
  expect(res.released).toEqual([run.id]);
  const after = (await getRun(db, scope, run.id))!;
  expect(after.status).toBe("queued");
  expect(after.sha).toBe(SHA("b"));
  // still untrusted: the approval never touches the class
  expect(parseTrust(after)?.class).toBe("untrusted_pr");
  expect(JSON.parse(after.approval!)).toMatchObject({
    by: "@maint",
    head_sha: SHA("b"),
    via: { kind: "label", label: LABEL, event_id: "99" },
  });
  expect((await listJobs(db, scope, run.id)).every((j) => j.state === "queued")).toBe(true);
  // audit entry
  const entry = (await listAudit(db, scope)).find((a) => a.op === "approval.label")!;
  expect(entry.principalId).toBe("maint");
  expect(entry.outcome).toBe("approved");
  expect(JSON.parse(entry.input)).toMatchObject({
    login: "maint",
    sha: SHA("b"),
    label_event_id: "99",
  });
});

test("a triage or read user, a Bot, and the author do not release", async () => {
  const gh = fake();
  const run = await waitingRun(gh);
  gh.state.labels = [LABEL];
  const label = (login: string, type = "User") => [
    { event: "labeled" as const, id: 5, at: run.createdAt + 1_000, login, type },
  ];
  gh.state.permission.set("triager", "triage");
  gh.state.permission.set("reader", "read");
  gh.state.permission.set("stranger", "write"); // the author has write, still may not approve
  gh.state.permission.set("ci-bot[bot]", "admin");
  for (const [login, type] of [
    ["triager", "User"],
    ["reader", "User"],
    ["stranger", "User"],
    ["ci-bot[bot]", "Bot"],
  ] as const) {
    gh.state.timeline = label(login, type);
    expect((await poll(gh)).released).toBeUndefined();
    expect((await getRun(db, scope, run.id))!.status).toBe("awaiting_approval");
  }
  // a permission the forge will not tell: nobody is approved
  gh.state.permission.set("maint", "admin");
  gh.state.permissionUnknown = true;
  gh.state.timeline = label("maint");
  expect((await poll(gh)).released).toBeUndefined();
  expect((await listAudit(db, scope)).some((a) => a.op === "approval.label")).toBe(false);
});

test("only the latest labeled event counts", async () => {
  const gh = fake();
  const run = await waitingRun(gh);
  gh.state.labels = [LABEL];
  gh.state.permission.set("maint", "write");
  gh.state.timeline = [
    { event: "labeled", id: 1, at: run.createdAt + 1_000, login: "maint" },
    { event: "labeled", id: 2, at: run.createdAt + 2_000, login: "stranger" },
  ];
  expect((await poll(gh)).released).toBeUndefined();
});

test("a push after the label: the new head waits, the old approval does not apply, the label is removed and one comment is posted", async () => {
  const gh = fake();
  const first = await waitingRun(gh);
  gh.state.permission.set("maint", "write");
  gh.state.labels = [LABEL];
  gh.state.timeline = [{ event: "labeled", id: 1, at: first.createdAt + 1_000, login: "maint" }];
  expect((await poll(gh)).released).toEqual([first.id]);
  // the contributor pushes again; the label is still on the PR
  gh.state.headSha = SHA("c");
  gh.state.timeline.push({ event: "committed", at: first.createdAt + 5_000 });
  const notices: string[] = [];
  await poll(gh, notices);
  const second = (await listRuns(db, scope)).find((r) => r.sha === SHA("c"))!;
  expect(second.status).toBe("awaiting_approval");
  expect(second.approval).toBeNull();
  expect(notices.filter((n) => n.startsWith("remove"))).toEqual([`remove 7 ${LABEL}`]);
  expect(notices.filter((n) => n.startsWith("comment"))).toHaveLength(1);
  // the label is still shown by the stale list (removal is best-effort): no second comment
  await poll(gh, notices);
  await poll(gh, notices);
  expect(notices.filter((n) => n.startsWith("comment"))).toHaveLength(1);
  expect((await getRun(db, scope, second.id))!.status).toBe("awaiting_approval");
});

test("a label closer to the run than the head's push (older event) does not release", async () => {
  const gh = fake();
  const run = await waitingRun(gh);
  gh.state.labels = [LABEL];
  gh.state.permission.set("maint", "write");
  // The labeled event is after the run was created but before a force push of the same head
  gh.state.timeline = [
    { event: "labeled", id: 1, at: run.createdAt + 1_000, login: "maint" },
    { event: "head_ref_force_pushed", at: run.createdAt + 2_000 },
  ];
  expect((await poll(gh)).released).toBeUndefined();
  // a commit dated before the label but a label before the run: also refused
  gh.state.timeline = [{ event: "labeled", id: 2, at: run.createdAt - 1, login: "maint" }];
  expect((await poll(gh)).released).toBeUndefined();
  expect((await getRun(db, scope, run.id))!.status).toBe("awaiting_approval");
});

test("the setting off, or a different label, releases nothing", async () => {
  const gh = fake();
  const run = await waitingRun(gh);
  gh.state.permission.set("maint", "write");
  gh.state.labels = ["other"];
  gh.state.timeline = [
    { event: "labeled", id: 1, at: run.createdAt + 1_000, login: "maint", label: "other" },
  ];
  expect((await poll(gh)).released).toBeUndefined();
  await putStoredSetting(
    db,
    { kind: "project", id: scope.projectId, orgId: scope.orgId },
    "pr_approval_label",
    "",
    "test",
    Date.now(),
  );
  gh.state.labels = [LABEL];
  gh.state.timeline = [{ event: "labeled", id: 2, at: run.createdAt + 1_000, login: "maint" }];
  expect((await poll(gh)).released).toBeUndefined();
});

test("judgeLabelEvent decides to the millisecond", () => {
  const facts = { label: LABEL, author: "stranger", runCreatedAt: 1_000 };
  const tl = (at: number, lastPush: number | undefined): PrTimeline => ({
    labeled: [{ id: "1", at, actor: { login: "maint", type: "User" }, label: LABEL }],
    lastPush,
  });
  expect(judgeLabelEvent(tl(2_001, 2_000), facts).ok).toBe(true);
  expect(judgeLabelEvent(tl(2_000, 2_000), facts)).toMatchObject({ ok: false, stale: true });
  expect(judgeLabelEvent(tl(1_000, undefined), facts)).toMatchObject({ ok: false, stale: true });
  expect(judgeLabelEvent(tl(1_001, undefined), facts).ok).toBe(true);
  expect(judgeLabelEvent({ labeled: [], lastPush: undefined }, facts).ok).toBe(false);
});

test("under untrusted_run_approval = human a label never approves", async () => {
  const gh = fake();
  const run = await waitingRun(gh);
  await putStoredSetting(
    db,
    { kind: "project", id: scope.projectId, orgId: scope.orgId },
    "untrusted_run_approval",
    "human",
    "test",
    Date.now(),
  );
  gh.state.permission.set("maint", "admin");
  gh.state.labels = [LABEL];
  gh.state.timeline = [{ event: "labeled", id: 1, at: run.createdAt + 1_000, login: "maint" }];
  expect((await poll(gh)).released).toBeUndefined();
  expect((await getRun(db, scope, run.id))!.status).toBe("awaiting_approval");
});
