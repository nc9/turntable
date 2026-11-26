import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createOnboardingApi, type InstallationRepo } from "../src/api/onboarding";
import {
  addableRepos,
  AddRepositoriesView,
  capToSend,
  DEFAULT_NEW_PROJECT_CAP,
} from "../src/features/onboarding/add-repositories";
import { RemoveProjectPanel } from "../src/features/runs/remove-project";

const repo = (id: string, name: string, status: "new" | "in_org"): InstallationRepo => ({
  repo: `acme/${name}`,
  repo_id: id,
  private: id === "1",
  project: status === "in_org" ? name : null,
  status,
  mode: status === "in_org" ? "off" : null,
  paused: false,
});

describe("Add repositories", () => {
  test("only repos the org has not added are offered", () => {
    const all = [repo("1", "api", "new"), repo("2", "web", "in_org"), repo("3", "docs", "new")];
    expect(addableRepos(all).map((r) => r.repo)).toEqual(["acme/api", "acme/docs"]);
  });

  test("renders one Add button per addable repo and none for an added one", () => {
    const html = renderToStaticMarkup(
      <AddRepositoriesView
        repos={[repo("1", "api", "new"), repo("2", "web", "in_org")]}
        busyRepo={null}
        error={null}
        added={[]}
        onAdd={() => {}}
      />,
    );
    expect(html).toContain("acme/api");
    expect(html).toContain('aria-label="Add acme/api"');
    expect(html).not.toContain("acme/web");
  });

  test("shows an editable cap per repo, defaulting to 2", () => {
    const html = renderToStaticMarkup(
      <AddRepositoriesView
        repos={[repo("1", "api", "new"), repo("3", "docs", "new")]}
        busyRepo={null}
        error={null}
        added={[]}
        onAdd={() => {}}
      />,
    );
    expect(DEFAULT_NEW_PROJECT_CAP).toBe(2);
    expect(html).toContain('aria-label="Max concurrent runs for acme/api"');
    expect(html).toContain('aria-label="Max concurrent runs for acme/docs"');
    expect(html.match(/value="2"/g)?.length).toBe(2);
  });

  test("the cap passes through only when changed; junk disables nothing it can send", () => {
    expect(capToSend(undefined)).toBeUndefined();
    expect(capToSend("5")).toBe(5);
    expect(capToSend("0")).toBe(0);
    expect(capToSend("")).toBeNull();
    expect(capToSend("-1")).toBeNull();
    expect(capToSend("1.5")).toBeNull();
  });

  test("says so when everything is added, shows an error and what was just added", () => {
    const html = renderToStaticMarkup(
      <AddRepositoriesView
        repos={[repo("2", "web", "in_org")]}
        busyRepo={null}
        error="boom"
        added={["acme/api"]}
        onAdd={() => {}}
      />,
    );
    expect(html).toContain("Every repository is already added");
    expect(html).toContain("boom");
    expect(html).toContain("Added acme/api");
  });
});

describe("Remove project panel", () => {
  const panel = (role: "owner" | "admin", confirmDelete = false) =>
    renderToStaticMarkup(
      <RemoveProjectPanel
        project="api"
        busy={false}
        error={null}
        done={null}
        role={role}
        confirmDelete={confirmDelete}
        onConfirmDelete={() => {}}
        onRemove={() => {}}
        onDelete={() => {}}
      />,
    );

  test("anyone who can see it may unbind and keep history; only an owner sees the delete", () => {
    expect(panel("admin")).toContain("Remove, keep history");
    expect(panel("admin")).not.toContain("Delete project and history");
    expect(panel("owner")).toContain("Delete project and history");
  });

  test("the delete stays disabled until the person confirms", () => {
    const off = panel("owner", false);
    const on = panel("owner", true);
    const button = (h: string) => /<button[^>]*>Delete project and history/.exec(h)![0];
    expect(button(off)).toContain(' disabled=""');
    expect(button(on)).not.toContain(' disabled=""');
  });
});

describe("the onboarding client's project calls", () => {
  function client(answer: unknown) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const api = createOnboardingApi({
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({
          method: init.method ?? "GET",
          url,
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        return new Response(JSON.stringify(answer), { status: 200 });
      }) as unknown as typeof fetch,
    });
    return { api, calls };
  }

  test("addProject posts the installation, repo and optional project slug", async () => {
    const { api, calls } = client({ project: "api", repo: "acme/api", created: true });
    await api.addProject({ org: "acme", installationId: "100", repo: "acme/api", project: "api" });
    expect(calls[0]).toEqual({
      method: "POST",
      url: "/api/v1/projects",
      body: { org: "acme", installation_id: "100", repo: "acme/api", project: "api" },
    });
  });

  test("addProject sends max_concurrent only when given", async () => {
    const { api, calls } = client({ project: "api", repo: "acme/api", created: true });
    await api.addProject({
      org: "acme",
      installationId: "100",
      repo: "acme/api",
      maxConcurrent: 4,
    });
    await api.addProject({ org: "acme", installationId: "100", repo: "acme/api" });
    expect(calls[0]!.body).toEqual({
      org: "acme",
      installation_id: "100",
      repo: "acme/api",
      max_concurrent: 4,
    });
    expect(calls[1]!.body).toEqual({ org: "acme", installation_id: "100", repo: "acme/api" });
  });

  test("removeProject sends delete_history and the step-up only when asked", async () => {
    const { api, calls } = client({ project: "api", unbound: [], deleted: false });
    await api.removeProject({ org: "acme", project: "api" });
    expect(calls[0]!.body).toEqual({ org: "acme", project: "api" });
    const proof = {
      id: "x".repeat(20),
      approver: "a",
      signature: {
        credential_id: "c",
        client_data_json: "d",
        authenticator_data: "e",
        signature: "f",
      },
    };
    await api.removeProject({ org: "acme", project: "api", deleteHistory: true, stepUp: proof });
    expect(calls[1]!.url).toBe("/api/v1/remove-project");
    expect(calls[1]!.body).toEqual({
      org: "acme",
      project: "api",
      delete_history: true,
      step_up: proof,
    });
  });

  test("the passkey challenge is for remove_project with exactly the call's input", async () => {
    const { api, calls } = client({
      step_up_id: "id",
      challenge: "ch",
      rp_id: "ci.example.test",
      passkeys: [{ approver: "a", passkey_id: "p" }],
    });
    const c = await api.removeProjectChallenge({ org: "acme", project: "api" });
    expect(calls[0]!.url).toBe("/api/v1/session/step-up");
    expect(calls[0]!.body).toEqual({
      org: "acme",
      action: "remove_project",
      input: { org: "acme", project: "api", delete_history: true },
    });
    expect(c).toEqual({
      id: "id",
      challenge: "ch",
      rpId: "ci.example.test",
      passkeys: [{ approver: "a", passkeyId: "p" }],
    });
  });

  test("listOrgInstallations keeps active installations only", async () => {
    const { api } = client({
      installations: [
        { installation_id: "1", account_login: "acme", status: "active", repos: [] },
        { installation_id: "2", account_login: "old", status: "deleted", repos: [] },
      ],
    });
    expect((await api.listOrgInstallations({ org: "acme" })).map((i) => i.installation_id)).toEqual(
      ["1"],
    );
  });
});
