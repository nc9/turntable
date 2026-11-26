// Switchers and the activity feed (#559): the selection round-trips through the URL, projects are
// filtered by org, forge text renders inert, and avatars fall back to initials.
import { describe, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import { createFixture } from "../src/api/fixture/adapter";
import type { ActivityRun } from "../src/api/types";
import { Avatar } from "../src/components/avatar";
import { ActivityFeed, FeedTable } from "../src/features/shell/activity-feed";
import { ConnectButton, OrgChooser } from "../src/features/shell/home";
import { ConnectFooter, SwitcherList } from "../src/features/shell/switchers";
import {
  mergeFirstPage,
  parseFeedSearch,
  pollDelay,
  POLL_HIDDEN_MS,
  POLL_VISIBLE_MS,
  runPath,
  stateOf,
} from "../src/lib/activity";
import { initialsOf, safeAvatarUrl } from "../src/lib/avatar";
import {
  orgTarget,
  projectDisplayName,
  projectTarget,
  withLastFirst,
  filterValue,
} from "../src/lib/switcher";
import { routeTree } from "../src/router";

const HOSTILE =
  "<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1)) <script>alert(2)</script>";
const AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";

const row = (over: Partial<ActivityRun> = {}): ActivityRun => ({
  runId: "01HZZZZZZZZZZZZZZZZZZZZZZA",
  org: "acme",
  orgName: "Acme",
  orgAvatarUrl: null,
  project: "web",
  projectName: "Web",
  projectAvatarUrl: null,
  workflow: "CI",
  ref: "main",
  refType: "branch",
  sha: "0123456789abcdef0123456789abcdef01234567",
  event: "push",
  commitMessage: "fix things",
  actor: "octocat",
  actorAvatarUrl: null,
  state: "completed",
  conclusion: "success",
  createdAt: Date.now() - 120_000,
  startedAt: Date.now() - 100_000,
  finishedAt: Date.now() - 60_000,
  ...over,
});

/** Renders an element inside a router, since rows hold links. */
async function inRouter(el: ReactElement): Promise<string> {
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => el });
  const run = createRoute({
    getParentRoute: () => root,
    path: "/$org/$project/runs/$runId",
    component: () => null,
  });
  const r = createRouter({
    routeTree: root.addChildren([index, run]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await r.load();
  return renderToString(<RouterProvider router={r as never} />);
}

describe("the feed renders forge text as literal text", () => {
  test("hostile workflow, branch, commit message and actor are escaped, never markup", async () => {
    const html = await inRouter(
      <FeedTable
        rows={[row({ workflow: HOSTILE, ref: HOSTILE, commitMessage: HOSTILE, actor: HOSTILE })]}
      />,
    );
    // No element came out of the text.
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<strong>");
    expect(html).not.toMatch(/href="javascript:/);
    // The characters are there, escaped, in text nodes.
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("**bold**");
    expect(html).toContain("[x](javascript:alert(1))");
    // And the only link points at the run.
    expect(html).toContain('href="/acme/web/runs/01HZZZZZZZZZZZZZZZZZZZZZZA"');
  });

  test("a row shows icon state, short sha, age and duration, and links to the run", async () => {
    const html = await inRouter(<FeedTable rows={[row()]} />);
    expect(html).toContain("0123456");
    expect(html).not.toContain("0123456789abcdef");
    expect(html).toContain("40s");
    expect(html).toContain("2m ago".replace("2m ago", "")); // age text is locale formatted
    expect(html).toContain('aria-label="Success"');
    expect(html).toContain('data-run-row="01HZZZZZZZZZZZZZZZZZZZZZZA"');
  });

  test("a running row shows its in-progress state; a tag shows as a tag", async () => {
    const html = await inRouter(
      <FeedTable
        rows={[
          row({
            state: "running",
            conclusion: null,
            finishedAt: null,
            ref: "v1.2.3",
            refType: "tag",
          }),
        ]}
      />,
    );
    expect(html).toContain('aria-label="Running"');
    expect(html).toContain("v1.2.3");
    expect(html).toContain("lucide-tag");
  });
});

describe("avatars", () => {
  test("a GitHub avatar renders as an image; anything else falls back to initials", () => {
    const img = renderToString(<Avatar src={AVATAR} name="Octo Cat" />);
    expect(img).toContain(`src="${AVATAR}"`);
    expect(img).toContain('data-avatar="image"');
    expect(img).toContain('alt=""');
    expect(img).toContain("no-referrer");
    for (const src of [
      null,
      undefined,
      "",
      "https://evil.example/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AA",
    ]) {
      const out = renderToString(<Avatar src={src} name="Octo Cat" />);
      expect(out).toContain('data-avatar="initials"');
      expect(out).toContain(">OC<");
      expect(out).not.toContain("<img");
    }
  });

  test("initials come from names and logins; a hostile name stays text", () => {
    expect(initialsOf("Acme Corp")).toBe("AC");
    expect(initialsOf("octocat")).toBe("OC");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(null)).toBe("?");
    expect(renderToString(<Avatar src={null} name={HOSTILE} />)).not.toContain("<img src=x");
    expect(safeAvatarUrl(AVATAR)).toBe(AVATAR);
    expect(safeAvatarUrl("https://avatars.githubusercontent.com.evil.example/u/1")).toBeNull();
  });
});

describe("polling and paging helpers", () => {
  test("30 s while visible, 120 s while hidden", () => {
    expect(POLL_VISIBLE_MS).toBe(30_000);
    expect(POLL_HIDDEN_MS).toBe(120_000);
    expect(pollDelay(false)).toBe(30_000);
    expect(pollDelay(true)).toBe(120_000);
  });

  test("a refreshed first page leads and keeps the older pages below it", () => {
    const mk = (id: string, state: ActivityRun["state"] = "completed") => row({ runId: id, state });
    const shown = [mk("05"), mk("04", "running"), mk("03"), mk("02"), mk("01")];
    const fresh = [mk("06"), mk("05"), mk("04", "completed")];
    const merged = mergeFirstPage(shown, fresh);
    expect(merged.map((r) => r.runId)).toEqual(["06", "05", "04", "03", "02", "01"]);
    expect(merged.find((r) => r.runId === "04")!.state).toBe("completed");
  });

  test("state to draw, and the run's path", () => {
    expect(stateOf(row({ state: "queued", conclusion: null }))).toBe("queued");
    expect(stateOf(row({ state: "completed", conclusion: "failure" }))).toBe("failure");
    expect(runPath(row({ org: "a b", project: "p", runId: "R" }))).toBe("/a%20b/p/runs/R");
  });
});

describe("the switchers", () => {
  const names = (html: string) =>
    [...html.matchAll(/<span class="flex-1 truncate"(?: title="[^"]*")?>([^<]*)<\/span>/g)].map(
      (m) => m[1],
    );

  test("the selection round-trips through the URL", async () => {
    const r = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/acme/web"] }),
    });
    await r.load();
    const at = () => ({
      path: r.history.location.pathname,
      params: r.state.matches.at(-1)!.params as Record<string, string>,
    });
    expect(at().params).toMatchObject({ org: "acme", project: "web" });
    // What the app's navigate() does for a target, without a mounted router: build the location
    // from the same route table, push it, load it.
    const go = async (to: string) => {
      r.history.push(r.buildLocation({ to } as never).href);
      await r.load();
    };

    await go(orgTarget("beta"));
    expect(at().path).toBe("/beta");
    expect(at().params).toMatchObject({ org: "beta" });
    expect(at().params.project).toBeUndefined();

    await go(projectTarget("beta", "api"));
    expect(at().path).toBe("/beta/api");
    expect(at().params).toMatchObject({ org: "beta", project: "api" });

    // "All projects" goes back to the org; "All orgs" is home.
    await go(projectTarget("beta", null));
    expect(at().path).toBe("/beta");
    await go(orgTarget(null));
    expect(at().path).toBe("/");
    expect(at().params).toEqual({});
  });

  test("the feed's filters live in the URL, and a junk status is dropped", async () => {
    const r = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/?org=acme&project=web&status=failed"] }),
    });
    await r.load();
    expect(parseFeedSearch(r.state.matches.at(-1)!.search)).toEqual({
      org: "acme",
      project: "web",
      status: "failed",
    });
    const bad = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/?status=bogus&org="] }),
    });
    await bad.load();
    expect(parseFeedSearch(bad.state.matches.at(-1)!.search)).toEqual({});
  });

  test("the project list is the selected org's, and names stay text", async () => {
    const fx = createFixture({ latency: [0, 0], tickMs: 1_000_000, seed: "feed" });
    try {
      const orgs = await fx.api.listOrgs();
      expect(orgs.length).toBeGreaterThan(1);
      const [a, b] = orgs;
      const pa = await fx.api.listProjects(a!.id);
      const pb = await fx.api.listProjects(b!.id);
      expect(pa.length).toBeGreaterThan(0);
      expect(pa.every((p) => p.orgId === a!.id)).toBe(true);
      expect(pb.every((p) => p.orgId === b!.id)).toBe(true);
      const html = renderToString(
        <SwitcherList
          label="Project"
          allLabel="All projects"
          allSelected
          items={[...pa, { slug: "evil", name: HOSTILE }]}
          isSelected={() => false}
          icon={() => null}
          onPick={() => {}}
        />,
      );
      const shown = names(html);
      expect(shown[0]).toBe("All projects");
      for (const p of pa) expect(shown).toContain(p.name);
      for (const p of pb.filter((x) => !pa.some((y) => y.name === x.name))) {
        expect(shown).not.toContain(p.name);
      }
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    } finally {
      fx.stop();
    }
  });

  test("lists are filterable by name or slug, with the last choice first", () => {
    const items = [
      { slug: "acme", name: "Acme" },
      { slug: "beta", name: "Beta Labs" },
      { slug: "gamma", name: "Gamma" },
    ];
    expect(withLastFirst(items, "gamma").map((i) => i.slug)).toEqual(["gamma", "acme", "beta"]);
    expect(withLastFirst(items, "gone").map((i) => i.slug)).toEqual(["acme", "beta", "gamma"]);
    expect(withLastFirst(items, null)).toEqual(items);
    expect(filterValue(items[1]!)).toContain("Beta Labs");
    expect(filterValue(items[1]!)).toContain("beta");
  });
});

describe("the fixture feed", () => {
  test("spans orgs, newest first, filters by status and org, and pages", async () => {
    const fx = createFixture({ latency: [0, 0], tickMs: 1_000_000, seed: "feed" });
    try {
      const all = await fx.api.myActivityFeed({ limit: 1000 });
      expect(new Set(all.runs.map((r) => r.org)).size).toBeGreaterThan(1);
      const times = all.runs.map((r) => r.createdAt);
      expect(times).toEqual([...times].toSorted((a, b) => b - a));
      const failed = await fx.api.myActivityFeed({ status: "failed", limit: 1000 });
      expect(
        failed.runs.every((r) => r.conclusion === "failure" || r.conclusion === "infra_error"),
      ).toBe(true);
      const running = await fx.api.myActivityFeed({ status: "running", limit: 1000 });
      expect(running.runs.every((r) => r.state !== "completed")).toBe(true);
      const org = all.runs[0]!.org;
      const one = await fx.api.myActivityFeed({ org, limit: 1000 });
      expect(one.runs.every((r) => r.org === org)).toBe(true);
      const p1 = await fx.api.myActivityFeed({ limit: 5 });
      const p2 = await fx.api.myActivityFeed({ limit: 5, cursor: p1.nextCursor! });
      expect(p1.runs.map((r) => r.runId)).toEqual(all.runs.slice(0, 5).map((r) => r.runId));
      expect(p2.runs.map((r) => r.runId)).toEqual(all.runs.slice(5, 10).map((r) => r.runId));
    } finally {
      fx.stop();
    }
  });
});

describe("the onboarding entry points", () => {
  test("the feed header carries the connect button next to the title", async () => {
    const html = await inRouter(
      <ActivityFeed
        filter={{ status: "all" }}
        orgs={[{ slug: "acme", name: "Acme" }]}
        projects={[]}
        action={<ConnectButton variant="default" />}
        onFilter={() => {}}
      />,
    );
    const title = html.indexOf(">Activity</h1>");
    const connect = html.indexOf("Connect repositories");
    expect(title).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(title);
    expect(html).toContain('href="/onboarding"');
  });

  test("with no connected projects the empty state is the org chooser plus the connect button", async () => {
    const html = await inRouter(<OrgChooser data={[{ id: "o1", slug: "acme", name: "Acme" }]} />);
    expect(html).toContain("Choose an organization");
    expect(html).toContain("Acme");
    expect(html).toContain("Connect repositories");
    expect(html).not.toContain(">Activity</h1>");
  });

  test("the org switcher menu ends with Connect repositories, after the list", async () => {
    const html = await inRouter(
      <>
        <SwitcherList
          label="Organization"
          allLabel="All orgs"
          allSelected
          items={[{ slug: "acme", name: "Acme" }]}
          isSelected={() => false}
          icon={() => null}
          onPick={() => {}}
        />
        <ConnectFooter close={() => {}} go={() => {}} />
      </>,
    );
    expect(html.indexOf("Acme")).toBeLessThan(html.indexOf("Connect repositories"));
    expect(html).toMatch(/Connect repositories<\/button><\/div>(<!--\/\$-->)?$/);
  });
});

describe("project display name (#653)", () => {
  test("drops the owner from a single-slash name only", () => {
    expect(projectDisplayName("acme/web")).toBe("web");
    expect(projectDisplayName("web")).toBe("web");
    expect(projectDisplayName("a/b/c")).toBe("a/b/c");
    expect(projectDisplayName("/web")).toBe("/web");
    expect(projectDisplayName("acme/")).toBe("acme/");
  });

  test("the list shows the short name and keeps the full one in title", () => {
    const html = renderToString(
      <SwitcherList
        label="Project"
        allLabel="All projects"
        allSelected={false}
        items={[{ slug: "web", name: "acme/web" }]}
        isSelected={() => false}
        icon={() => null}
        onPick={() => {}}
        display={projectDisplayName}
      />,
    );
    expect(html).toContain('title="acme/web"');
    expect(html).toContain(">web<");
  });
});
