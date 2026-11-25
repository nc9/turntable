import { describe, expect, test } from "bun:test";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { createHttpApi } from "../src/api/http-adapter";
import type { Project } from "../src/api/types";
import { AvailableRepositories } from "../src/features/runs/org-page";

const project = (slug: string): Project => ({
  id: slug,
  orgId: "acme",
  slug,
  name: slug,
  repo: `acme/${slug}`,
  setup: "available",
});

async function render(projects: Project[]): Promise<string> {
  const root = createRootRoute();
  const org = createRoute({
    getParentRoute: () => root,
    path: "/$org",
    component: () => <AvailableRepositories projects={projects} orgSlug="acme" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([org]),
    history: createMemoryHistory({ initialEntries: ["/acme"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("org page: available repositories", () => {
  test("shows the count and a Set up link for each", async () => {
    const html = await render([project("a"), project("b")]);
    expect(html).toContain("Available repositories (2)");
    expect(html.match(/Set up/g)?.length).toBe(2);
  });
  test("renders no link when every project is set up", async () => {
    expect(await render([])).not.toContain("Available repositories");
  });
});

describe("http adapter", () => {
  test("asks for the available projects too and carries setup", async () => {
    let url = "";
    const api = createHttpApi({
      org: () => "acme",
      token: () => "tt_secret",
      fetch: (async (input: RequestInfo | URL) => {
        url = String(input);
        return new Response(
          JSON.stringify({
            projects: [
              { id: "1", slug: "a", name: "a", setup: "available", repos: [] },
              { id: "2", slug: "b", name: "b", setup: "active", repos: [] },
            ],
            next_cursor: null,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const ps = await api.listProjects("acme");
    expect(url).toContain("include_available=true");
    expect(ps.map((p) => p.setup)).toEqual(["available", "active"]);
  });
});
