import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createOnboardingApi,
  type InstallationRepo,
  type PreviewWorkflow,
} from "../src/api/onboarding";
import type { WireRunDetail } from "../src/api/wire";
import { AgentSlot } from "../src/features/onboarding/agent-slot";
import { ContextList, FinishView, NoWorkflowsHint } from "../src/features/onboarding/finish-view";
import {
  BOUND_ELSEWHERE,
  InstallPanel,
  type InstallPanelProps,
  RETURN_PATH,
} from "../src/features/onboarding/install-modal";
import { WorkflowPreviewView } from "../src/features/onboarding/preview-view";
import { RepoTable } from "../src/features/onboarding/repo-table";
import { validateOnboardingSearch } from "../src/features/onboarding/wizard";
import {
  beginInstall,
  buildOnboardRows,
  CHECKS_MODE_LABELS,
  CHECKS_MODES,
  type ClaimOutcome,
  hasRunnableWorkflow,
  liveContexts,
  type MessageTarget,
  type PopupHandle,
  safeHttpUrl,
  watchClaim,
} from "../src/lib/onboarding";

const ORIGIN = "https://ci.example.test";

// ---- a fake window and clock for the claim watcher ----

function fakeWorld(getClaim: () => Promise<{ state: string; installation_id?: string }>) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const target: MessageTarget = {
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  let tick: (() => void) | null = null;
  let t = 0;
  const outcomes: ClaimOutcome[] = [];
  let reads = 0;
  const stop = watchClaim({
    claimId: "c1",
    target,
    origin: ORIGIN,
    getClaim: async () => {
      reads++;
      return (await getClaim()) as never;
    },
    onOutcome: (o) => void outcomes.push(o),
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
    now: () => t,
  });
  const post = (origin: string, data: unknown) => {
    for (const l of [...listeners]) l({ origin, data } as MessageEvent);
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    post,
    flush,
    outcomes,
    reads: () => reads,
    advance: (ms: number) => {
      t += ms;
      tick?.();
    },
    listeners,
    stop,
  };
}

const completed = async () => ({
  state: "completed",
  installation_id: "42",
  account_login: "acme",
});
const pending = async () => ({ state: "pending" });
const good = { type: "turntable.claim", claim_id: "c1", state: "completed" };

describe("claim watcher", () => {
  test("completes on a matching postMessage from our own origin", async () => {
    const w = fakeWorld(completed);
    w.post(ORIGIN, good);
    await w.flush();
    expect(w.outcomes).toEqual([{ kind: "completed", installationId: "42", accountLogin: "acme" }]);
    // done: the listener is gone
    expect(w.listeners.size).toBe(0);
  });

  test("a message from another origin is ignored (no outcome, no read)", async () => {
    const w = fakeWorld(completed);
    w.post("https://evil.example.test", good);
    w.post(`${ORIGIN}.evil.example.test`, good);
    await w.flush();
    expect(w.outcomes).toEqual([]);
    expect(w.reads()).toBe(0);
  });

  test("a message with another claim_id, another type or no object is ignored", async () => {
    const w = fakeWorld(completed);
    w.post(ORIGIN, { ...good, claim_id: "other" });
    w.post(ORIGIN, { ...good, type: "something.else" });
    w.post(ORIGIN, "turntable.claim");
    w.post(ORIGIN, null);
    await w.flush();
    expect(w.outcomes).toEqual([]);
    expect(w.reads()).toBe(0);
  });

  test("a message only triggers a read: the server's answer decides", async () => {
    const w = fakeWorld(pending);
    w.post(ORIGIN, good); // claims "completed", but the server says pending
    await w.flush();
    expect(w.reads()).toBe(1);
    expect(w.outcomes).toEqual([]);
  });

  test("completes on the installation_claim.updated event when a subscription exists", async () => {
    let emit: (e: { claim_id: string; state: string }) => void = () => {};
    let unsubscribed = false;
    const outcomes: ClaimOutcome[] = [];
    watchClaim({
      claimId: "c1",
      target: { addEventListener() {}, removeEventListener() {} },
      origin: ORIGIN,
      getClaim: completed as never,
      onOutcome: (o) => void outcomes.push(o),
      subscribe: (cb) => {
        emit = cb;
        return () => {
          unsubscribed = true;
        };
      },
      setInterval: () => 1,
      clearInterval: () => {},
    });
    emit({ claim_id: "other", state: "completed" });
    await new Promise((r) => setTimeout(r, 0));
    expect(outcomes).toEqual([]);
    emit({ claim_id: "c1", state: "completed" });
    await new Promise((r) => setTimeout(r, 0));
    expect(outcomes[0]?.kind).toBe("completed");
    expect(unsubscribed).toBe(true);
  });

  test("with no message, the poll completes it", async () => {
    let n = 0;
    const w = fakeWorld(async () => (++n < 3 ? { state: "pending" } : await completed()));
    w.advance(5_000);
    await w.flush();
    w.advance(5_000);
    await w.flush();
    expect(w.outcomes).toEqual([]);
    w.advance(5_000);
    await w.flush();
    expect(w.outcomes[0]?.kind).toBe("completed");
  });

  test("the poll gives up after two minutes", async () => {
    const w = fakeWorld(pending);
    for (let i = 0; i < 24; i++) {
      w.advance(5_000);
      await w.flush();
    }
    expect(w.outcomes).toEqual([{ kind: "timeout" }]);
    expect(w.reads()).toBe(23);
  });

  test("refused and expired claims end with their own outcome", async () => {
    const r = fakeWorld(async () => ({ state: "refused", reason: "not the owner" }));
    r.advance(5_000);
    await r.flush();
    expect(r.outcomes).toEqual([{ kind: "refused", reason: "not the owner" }]);
    const e = fakeWorld(async () => ({ state: "expired" }));
    e.advance(5_000);
    await e.flush();
    expect(e.outcomes).toEqual([{ kind: "expired" }]);
  });

  test("a failed read is retried by the next poll", async () => {
    let n = 0;
    const w = fakeWorld(async () => {
      if (++n === 1) throw new Error("network");
      return completed();
    });
    w.advance(5_000);
    await w.flush();
    expect(w.outcomes).toEqual([]);
    w.advance(5_000);
    await w.flush();
    expect(w.outcomes[0]?.kind).toBe("completed");
  });
});

describe("starting the install", () => {
  const popup = (): PopupHandle & { closedCalls: number } => {
    const p = {
      closed: false,
      closedCalls: 0,
      location: { href: "about:blank" },
      close() {
        p.closedCalls++;
      },
    };
    return p;
  };

  test("opens the popup before the claim round trip, then sends it to the URL", async () => {
    const order: string[] = [];
    const p = popup();
    const r = await beginInstall({
      open: () => {
        order.push("open");
        return p;
      },
      start: async () => {
        order.push("start");
        return {
          url: "https://github.com/apps/x/installations/new",
          expires_at: 1,
          claim_id: "c9",
        };
      },
    });
    expect(order).toEqual(["open", "start"]);
    expect(r.blocked).toBe(false);
    expect(r.claimId).toBe("c9");
    expect(p.location.href).toBe("https://github.com/apps/x/installations/new");
  });

  test("a blocked popup returns the URL for a same-tab link", async () => {
    const r = await beginInstall({
      open: () => null,
      start: async () => ({
        url: "https://github.com/apps/x/installations/new",
        expires_at: 1,
        claim_id: "c9",
      }),
    });
    expect(r).toEqual({
      blocked: true,
      claimId: "c9",
      url: "https://github.com/apps/x/installations/new",
    });
  });

  test("a failed start closes the blank popup and rethrows the server's text", async () => {
    const p = popup();
    await expect(
      beginInstall({
        open: () => p,
        start: async () => {
          throw new Error("installation claims are not configured");
        },
      }),
    ).rejects.toThrow("installation claims are not configured");
    expect(p.closedCalls).toBe(1);
  });

  test("a link that is not http(s) is never followed", async () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    const p = popup();
    await expect(
      beginInstall({
        open: () => p,
        start: async () => ({ url: "javascript:alert(1)", expires_at: 1, claim_id: "c" }),
      }),
    ).rejects.toThrow();
    expect(p.closedCalls).toBe(1);
    expect(p.location.href).toBe("about:blank");
  });
});

const panel = (over: Partial<InstallPanelProps> = {}): string =>
  renderToStaticMarkup(
    <InstallPanel
      configuring={false}
      phase={{ kind: "idle" }}
      error={null}
      onInstall={() => {}}
      onCheckAgain={() => {}}
      picker={{ open: false, installations: null, error: null }}
      onOpenPicker={() => {}}
      onPick={() => {}}
      bindingId={null}
      bindError={null}
      onClose={() => {}}
      {...over}
    />,
  );

describe("install modal body", () => {
  test("explains what is granted and offers the install", () => {
    const html = panel();
    expect(html).toContain("Checks: write");
    expect(html).toContain("Contents: read");
    expect(html).toContain("Metadata: read");
    expect(html).toContain("Pull requests: read");
    expect(html).toContain("Install on GitHub");
    expect(html).toContain("Already installed? Pick the installation");
  });

  test("a blocked popup shows a same-tab link and the way back to the repos step", () => {
    const html = panel({
      phase: { kind: "blocked", url: "https://github.com/apps/x/installations/new" },
    });
    expect(html).toContain("blocked the pop-up");
    expect(html).toContain('href="https://github.com/apps/x/installations/new"');
    expect(RETURN_PATH).toBe("/onboarding?step=repos");
    expect(html).toContain(`href="${RETURN_PATH}"`);
  });

  test("the picker disables other_org rows and says why; this_org and none are usable", () => {
    const html = panel({
      picker: {
        open: true,
        error: null,
        installations: [
          {
            installation_id: "1",
            account_login: "mine",
            account_type: "Organization",
            repository_selection: "all",
            bound: "none",
          },
          {
            installation_id: "2",
            account_login: "theirs",
            account_type: "User",
            repository_selection: "selected",
            bound: "other_org",
          },
          {
            installation_id: "3",
            account_login: "again",
            account_type: "User",
            repository_selection: "all",
            bound: "this_org",
          },
        ],
      },
    });
    expect(BOUND_ELSEWHERE).toBe("connected to a different Turntable org");
    expect(html).toContain("connected to a different Turntable org");
    const buttons = [
      ...html.matchAll(/<button[^>]*aria-label="Use the installation on ([^"]+)"[^>]*>/g),
    ];
    const disabled = Object.fromEntries(buttons.map((m) => [m[1], / disabled=""/.test(m[0])]));
    expect(disabled).toEqual({ mine: false, theirs: true, again: false });
  });

  test("a bind refusal is shown as the server wrote it", () => {
    const text =
      "this GitHub account is already connected to a different Turntable org; ask its owner";
    const html = panel({
      picker: { open: true, error: null, installations: [] },
      bindError: text,
    });
    expect(html).toContain(text);
  });

  test("waiting, ended and error states", () => {
    expect(panel({ phase: { kind: "waiting" } })).toContain("Waiting for GitHub");
    const ended = panel({
      phase: { kind: "ended", message: "Still waiting for GitHub.", canCheckAgain: true },
    });
    expect(ended).toContain("Check again");
    expect(panel({ error: "boom <b>" })).toContain("boom &lt;b&gt;");
  });

  test("configuring an existing installation hides the picker", () => {
    const html = panel({ configuring: true });
    expect(html).toContain("Grant more repositories");
    expect(html).not.toContain("Already installed?");
  });
});

// ---- the repo submit ----

const repo = (over: Partial<InstallationRepo>): InstallationRepo => ({
  repo: "acme/web",
  repo_id: "1",
  private: true,
  project: null,
  status: "new",
  mode: null,
  paused: false,
  ...over,
});

describe("repo table and submit", () => {
  const repos = [
    repo({ repo: "acme/new", repo_id: "1" }),
    repo({ repo: "acme/live", repo_id: "2", status: "in_org", project: "live", mode: "live" }),
    repo({
      repo: "acme/shadow",
      repo_id: "3",
      status: "in_org",
      project: "shadow",
      mode: "shadow",
    }),
    repo({
      repo: "acme/paused",
      repo_id: "4",
      status: "in_org",
      project: "paused",
      mode: "off",
      paused: true,
    }),
    repo({ repo: "acme/untouched-new", repo_id: "5" }),
  ];

  test("an untouched existing repo omits mode; a changed one sends it", () => {
    const rows = buildOnboardRows(repos, {
      "1": { ticked: true, mode: "off", modeTouched: false },
      "3": { ticked: true, mode: "live", modeTouched: true },
    });
    // 2 stays ticked as it was (enabled, untouched): no mode key at all
    const two = rows.find((r) => r.repo_id === "2");
    expect(two).toEqual({ repo_id: "2", enable: true });
    expect("mode" in (two ?? {})).toBe(false);
    expect(rows.find((r) => r.repo_id === "3")).toEqual({
      repo_id: "3",
      enable: true,
      mode: "live",
    });
    // a new repo ticked at the default goes with mode off
    expect(rows.find((r) => r.repo_id === "1")).toEqual({
      repo_id: "1",
      enable: true,
      mode: "off",
    });
    // a paused repo left unticked and a new repo left unticked are not sent
    expect(rows.find((r) => r.repo_id === "4")).toBeUndefined();
    expect(rows.find((r) => r.repo_id === "5")).toBeUndefined();
  });

  test("unticking an enabled existing repo pauses it, with no mode", () => {
    const rows = buildOnboardRows(repos, {
      "2": { ticked: false, mode: "live", modeTouched: false },
    });
    expect(rows.find((r) => r.repo_id === "2")).toEqual({ repo_id: "2", enable: false });
  });

  test("lifting a pause on an existing repo sends enable only", () => {
    const rows = buildOnboardRows(repos, {
      "4": { ticked: true, mode: "off", modeTouched: false },
    });
    expect(rows.find((r) => r.repo_id === "4")).toEqual({ repo_id: "4", enable: true });
  });

  test("the table marks new and existing repos and offers exactly the three labels", () => {
    const html = renderToStaticMarkup(<RepoTable repos={repos} choices={{}} onChange={() => {}} />);
    expect(html.match(/>new</g)?.length).toBe(2);
    expect(html.match(/already in this org/g)?.length).toBe(3);
    const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) =>
      (m[1] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
    );
    expect(new Set(options)).toEqual(new Set(CHECKS_MODES.map((m) => CHECKS_MODE_LABELS[m])));
    expect(options.length).toBe(repos.length * 3);
    // a new repo starts at Off
    expect(html).toContain('<option value="off" selected="">');
  });

  test("the labels equal core's CHECKS_MODE_LABELS", () => {
    const src = readFileSync(
      new URL("../../core/src/ops/onboarding-schemas.ts", import.meta.url),
      "utf8",
    );
    for (const m of CHECKS_MODES)
      expect(src).toContain(`${m}: ${JSON.stringify(CHECKS_MODE_LABELS[m])}`);
  });
});

// ---- the preview ----

describe("workflow preview rows", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const md = "**bold** [click](javascript:alert(1)) `code`";
  const wf = (over: Partial<PreviewWorkflow> = {}): PreviewWorkflow => ({
    path: ".github/workflows/ci.yml",
    name: hostile,
    triggers: ["push"],
    ingested: true,
    too_large: false,
    jobs: [
      { job_id: "a", name: hostile, verdict: "run" },
      { job_id: "b", name: md, verdict: "skip", reason: "if is false" },
      {
        job_id: "c",
        name: "mac",
        verdict: "fail",
        reason: `runs-on ${hostile}`,
        fix: `use ubuntu ${md}`,
      },
    ],
    ...over,
  });

  test("hostile and markdown names render as literal text", () => {
    const html = renderToStaticMarkup(
      <WorkflowPreviewView preview={{ sha: "abc", truncated: false, workflows: [wf()] }} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<strong");
    expect(html).not.toContain("<code");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("**bold** [click](javascript:alert(1)) `code`");
  });

  test("shows run, skip and fail with their reason and fix", () => {
    const html = renderToStaticMarkup(
      <WorkflowPreviewView preview={{ sha: "abc", truncated: false, workflows: [wf()] }} />,
    );
    for (const w of ["run", "skip", "fail"]) expect(html).toContain(`>${w}<`);
    expect(html).toContain("if is false");
    expect(html).toContain("Fix: use ubuntu");
  });

  test("shows the too-large row and the more-files note", () => {
    const html = renderToStaticMarkup(
      <WorkflowPreviewView
        preview={{
          sha: "abc",
          truncated: true,
          workflows: [wf({ too_large: true, jobs: [], ingested: false })],
        }}
      />,
    );
    expect(html).toContain("Too large to preview");
    expect(html).toContain("More workflow files not shown");
  });

  test("an empty preview says there are no workflow files", () => {
    const html = renderToStaticMarkup(
      <WorkflowPreviewView preview={{ sha: "abc", truncated: false, workflows: [] }} />,
    );
    expect(html).toContain("No workflow files");
    expect(hasRunnableWorkflow([])).toBe(false);
    expect(hasRunnableWorkflow([wf()])).toBe(true);
    expect(hasRunnableWorkflow([wf({ ingested: false })])).toBe(false);
  });
});

// ---- the finish screen ----

describe("finish screen", () => {
  const run = (state: string, jobs: WireRunDetail["jobs"] = []): WireRunDetail =>
    ({
      id: "r1",
      project: "web",
      state,
      jobs,
    }) as WireRunDetail;
  const job = (name: string, state: string, reason: string | null = null) =>
    ({ id: name, name, state, infra_error_reason: reason }) as WireRunDetail["jobs"][number];

  const view = (over: Partial<Parameters<typeof FinishView>[0]> = {}) =>
    renderToStaticMarkup(
      <FinishView
        project="acme/web"
        runLink={<a href="/acme/web/runs/r1">Open the live run</a>}
        run={run("failure", [
          job("build", "success"),
          job("<b>test</b>", "failure", "out of disk"),
        ])}
        refused={[
          { workflow: "ci.yml", name: "mac", reason: "macOS is not supported", fix: "use ubuntu" },
        ]}
        contexts={liveContexts(["build", "test (a, 1)", "build"])}
        mode="off"
        canGoLive
        goLive={{ busy: false, error: null, done: false }}
        onGoLive={() => {}}
        agentSlot={null}
        {...over}
      />,
    );

  test("shows the conclusion, failed jobs with their reason, and refused jobs with the fix", () => {
    const html = view();
    expect(html).toContain("Conclusion: ");
    expect(html).toContain("<strong>Failed</strong>");
    expect(html).toContain("&lt;b&gt;test&lt;/b&gt;");
    expect(html).not.toContain("<b>test</b>");
    expect(html).toContain("out of disk");
    expect(html).toContain("macOS is not supported");
    expect(html).toContain("Fix: use ubuntu");
    expect(html).toContain("Open the live run");
  });

  test("lists the exact turntable / <job> names, copyable, without duplicates", () => {
    const html = view();
    const names = [...html.matchAll(/data-testid="context-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(names).toEqual(["turntable / build", "turntable / test (a, 1)"]);
    expect(html).toContain('aria-label="Copy turntable / build"');
    expect(html).toContain('aria-label="Copy all check names"');
    expect(liveContexts(["a", "a", "b"])).toEqual(["turntable / a", "turntable / b"]);
  });

  test("next steps: go live, ruleset, invite; the agent slot is rendered where given", () => {
    const html = view({ agentSlot: <div data-slot="connect-agent">slot</div> });
    expect(html).toContain("Go live");
    expect(html).toContain("Require Turntable checks in your GitHub ruleset");
    expect(html).toContain("Invite teammates");
    expect(html).toContain('data-slot="connect-agent"');
  });

  test("a live project has no go live button; a running run shows its status", () => {
    expect(view({ mode: "live" })).toContain("posts live checks already");
    const html = view({ run: run("running") });
    expect(html).toContain("Status: ");
    expect(html).toContain("<strong>Running</strong>");
    expect(view({ run: null })).toContain("Waiting for the run...");
  });

  test("a go live refusal is shown plainly", () => {
    expect(
      view({ goLive: { busy: false, error: "locked by environment", done: false } }),
    ).toContain("locked by environment");
  });

  test("no workflows: a hint with a minimal sample", () => {
    const html = renderToStaticMarkup(<NoWorkflowsHint />);
    expect(html).toContain("Add a workflow");
    expect(html).toContain(".github/workflows/ci.yml");
    expect(html).toContain("runs-on: ubuntu-latest");
  });

  test("an empty context list explains itself", () => {
    expect(renderToStaticMarkup(<ContextList contexts={[]} />)).toContain("appear once");
  });
});

// ---- the client ----

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function make(handler: (url: URL, init: RequestInit) => Response, onUnauth?: () => void) {
  const calls: { url: URL; init: RequestInit; body: unknown }[] = [];
  const api = createOnboardingApi({
    ...(onUnauth ? { onUnauthenticated: onUnauth } : {}),
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({
        url,
        init,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { api, calls };
}

describe("onboarding client", () => {
  test("every call rides the session cookie, with no bearer token, and names the org", async () => {
    const { api, calls } = make((url) => {
      if (url.pathname.endsWith("/account/orgs")) return json({ orgs: [] });
      if (url.pathname.endsWith("/account/installations")) return json({ installations: [] });
      if (url.pathname.endsWith("/installation-repos"))
        return json({ repos: [], next_cursor: null });
      if (url.pathname.endsWith("/claim-1") || url.pathname.includes("installation-claims/"))
        return json({ state: "pending" });
      return json({ url: "https://github.com/x", expires_at: 1, claim_id: "claim-1" });
    });
    await api.listMyOrgs();
    await api.listUserInstallations();
    await api.listInstallationRepos({ org: "acme", installationId: "7" });
    await api.startClaim({ org: "acme", popup: true });
    await api.startClaim({ org: "acme", popup: true, installationId: "7" });
    await api.getClaim({ org: "acme", claimId: "claim-1" });
    for (const c of calls) {
      expect(c.init.credentials).toBe("same-origin");
      expect((c.init.headers as Record<string, string>).authorization).toBeUndefined();
    }
    expect(calls[2]?.url.searchParams.get("org")).toBe("acme");
    expect(calls[2]?.url.searchParams.get("installation_id")).toBe("7");
    expect(calls[3]?.body).toEqual({ org: "acme", popup: true });
    expect(calls[4]?.body).toEqual({ org: "acme", popup: true, installation_id: "7" });
    expect(calls[5]?.url.pathname).toBe("/api/v1/github/installation-claims/claim-1");
    expect(calls[5]?.url.searchParams.get("org")).toBe("acme");
    // the account operations name no org
    expect(calls[0]?.url.searchParams.has("org")).toBe(false);
    expect(calls[1]?.url.searchParams.has("org")).toBe(false);
  });

  test("onboard_repos sends the rows as given (no mode key added)", async () => {
    const { api, calls } = make(() => json({ projects: [] }));
    await api.onboardRepos({
      org: "acme",
      installationId: "7",
      repos: [{ repo_id: "2", enable: true }],
    });
    expect(calls[0]?.url.pathname).toBe("/api/v1/onboard-repos");
    expect(calls[0]?.body).toEqual({
      org: "acme",
      installation_id: "7",
      repos: [{ repo_id: "2", enable: true }],
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("mode");
  });

  test("create org and bind show the server's refusal text verbatim", async () => {
    const text = "self-serve org creation is not enabled for your account on this instance";
    const bound =
      "this GitHub account is already connected to a different Turntable org; ask its owner";
    const { api } = make((url) =>
      url.pathname.endsWith("/account/orgs")
        ? json({ error: { code: "forbidden", message: text } }, 403)
        : json({ error: { code: "conflict", message: bound } }, 409),
    );
    await expect(api.createOrg({ slug: "acme", displayName: "Acme" })).rejects.toThrow(text);
    await expect(api.bindInstallation({ org: "acme", installationId: "1" })).rejects.toThrow(bound);
  });

  test("a 401 reports the session gone", async () => {
    let gone = 0;
    const { api } = make(
      () => json({ error: { code: "unauthenticated", message: "no" } }, 401),
      () => void gone++,
    );
    await expect(api.listMyOrgs()).rejects.toThrow();
    expect(gone).toBe(1);
  });

  test("run_default_branch carries the onboarding id only when there is one", async () => {
    const { api, calls } = make(() =>
      json({ run_id: "r", sha: "s", trust_class: "protected", created: true }),
    );
    await api.runDefaultBranch({ org: "acme", project: "web" });
    await api.runDefaultBranch({ org: "acme", project: "web", onboardingId: "ob1" });
    expect(calls[0]?.body).toEqual({ org: "acme", project: "web" });
    expect(calls[1]?.body).toEqual({ org: "acme", project: "web", onboarding_id: "ob1" });
  });

  test("hasOperation reads the OpenAPI document once and answers false on any failure", async () => {
    let fetched = 0;
    const withOp = make((url) => {
      fetched++;
      expect(url.pathname).toBe("/openapi.json");
      return json({ paths: { "/x": { post: { operationId: "create_onboarding_agent_token" } } } });
    });
    expect(await withOp.api.hasOperation("create_onboarding_agent_token")).toBe(true);
    expect(await withOp.api.hasOperation("nope")).toBe(false);
    expect(fetched).toBe(1);
    const missing = make(() => json({ paths: {} }));
    expect(await missing.api.hasOperation("create_onboarding_agent_token")).toBe(false);
    const broken = make(() => new Response("no", { status: 500 }));
    expect(await broken.api.hasOperation("create_onboarding_agent_token")).toBe(false);
    const thrown = createOnboardingApi({
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await thrown.hasOperation("create_onboarding_agent_token")).toBe(false);
  });

  test("the connect-an-agent slot renders nothing until its operation is known", () => {
    const { api } = make(() => json({ paths: {} }));
    expect(renderToStaticMarkup(<AgentSlot api={api} org="acme" />)).toBe("");
  });
});

describe("route search", () => {
  test("keeps only well-formed step, org and installation", () => {
    expect(validateOnboardingSearch({ step: "repos", org: "acme", installation: "123" })).toEqual({
      step: "repos",
      org: "acme",
      installation: "123",
    });
    expect(validateOnboardingSearch({ step: "rm -rf", org: "../x", installation: "12a" })).toEqual(
      {},
    );
    expect(validateOnboardingSearch({ step: "agent" })).toEqual({});
  });
});
