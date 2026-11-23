import { useState } from "react";
import { getInstanceApi, type CreatedProject, type ProjectSettings } from "@/api/instance";
import { Button } from "@/components/ui/button";
import { sanitize } from "@/log/parser";
import { OrgSelect, Page, PageHeader, Refusal, TextField } from "./parts";
import { parseLimit, useAction } from "./use-action";

function Create({ onCreated }: { onCreated: (p: CreatedProject) => void }) {
  const api = getInstanceApi();
  const [org, setOrg] = useState("");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const create = useAction((o: string, s: string, n: string) =>
    api.createProject({ org: o, slug: s, name: n }),
  );
  const [made, setMade] = useState<CreatedProject | null>(null);
  return (
    <form
      className="space-y-4 rounded-xl border border-line p-4"
      aria-label="Create a project"
      onSubmit={(e) => {
        e.preventDefault();
        void create.run(org, slug.trim(), name.trim()).then((p) => {
          if (!p) return;
          setMade(p);
          setSlug("");
          setName("");
          onCreated(p);
        });
      }}
    >
      <h2 className="text-sm font-semibold">Create a project</h2>
      <OrgSelect id="create-org" value={org} onChange={setOrg} />
      <TextField id="create-slug" label="Slug" mono value={slug} onChange={setSlug} />
      <TextField id="create-name" label="Name" value={name} onChange={setName} />
      <Button type="submit" disabled={create.busy || !org || !slug.trim() || !name.trim()}>
        {create.busy ? "Creating" : "Create project"}
      </Button>
      <Refusal message={create.error} />
      {made ? (
        <p role="status" data-result="created">
          Created{" "}
          <span className="font-mono">
            {sanitize(made.org)}/{sanitize(made.project)}
          </span>
          .
        </p>
      ) : null}
    </form>
  );
}

function Settings({ known }: { known: CreatedProject[] }) {
  const api = getInstanceApi();
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const [cap, setCap] = useState("");
  const [now, setNow] = useState<ProjectSettings | null>(null);
  const save = useAction((patch: Parameters<typeof api.setProjectSettings>[0]["patch"]) =>
    api.setProjectSettings({ org, project: project.trim(), patch }),
  );
  return (
    <form
      className="space-y-4 rounded-xl border border-line p-4"
      aria-label="Project sandbox settings"
      onSubmit={(e) => {
        e.preventDefault();
        const patch: Parameters<typeof api.setProjectSettings>[0]["patch"] = {};
        const s = snapshot.trim();
        if (s !== "") patch.sandboxSnapshot = s.toLowerCase() === "none" ? null : s;
        const c = parseLimit(cap);
        if (c !== undefined) patch.maxConcurrent = c as number | null;
        void save.run(patch).then((r) => {
          if (!r) return;
          setNow(r);
          setSnapshot("");
          setCap("");
        });
      }}
    >
      <h2 className="text-sm font-semibold">Sandbox snapshot and concurrency cap</h2>
      <p className="text-xs text-dim">
        Leave a field blank to keep it, or type <span className="font-mono">none</span> to remove
        it. The cap can only lower the instance's per-org cap.
      </p>
      <OrgSelect id="proj-org" value={org} onChange={setOrg} />
      <TextField
        id="proj-slug"
        label="Project slug"
        mono
        list="instance-known-projects"
        value={project}
        onChange={setProject}
        hint="The server has no instance-wide project list: type the slug."
      />
      <datalist id="instance-known-projects">
        {known
          .filter((p) => p.org === org)
          .map((p) => (
            <option key={p.id} value={p.project} />
          ))}
      </datalist>
      <TextField
        id="proj-snapshot"
        label="Sandbox snapshot"
        mono
        placeholder="unchanged"
        value={snapshot}
        onChange={setSnapshot}
      />
      <TextField
        id="proj-cap"
        label="Max concurrent attempts"
        mono
        placeholder="unchanged"
        value={cap}
        onChange={setCap}
      />
      <Button type="submit" disabled={save.busy || !org || !project.trim()}>
        {save.busy ? "Saving" : "Save project settings"}
      </Button>
      <Refusal message={save.error} />
      {now ? (
        <dl data-result="project-settings" className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
          <dt className="text-dim">Sandbox snapshot</dt>
          <dd className="font-mono">
            {now.sandboxSnapshot === null ? "default" : sanitize(now.sandboxSnapshot)}
          </dd>
          <dt className="text-dim">Max concurrent</dt>
          <dd className="font-mono">
            {now.maxConcurrent === null ? "no project limit" : now.maxConcurrent}
          </dd>
        </dl>
      ) : null}
    </form>
  );
}

/** Projects: `create_project`, and a project's snapshot and cap through `set_project_settings`. */
export function InstanceProjectsPage() {
  const [known, setKnown] = useState<CreatedProject[]>([]);
  return (
    <Page>
      <PageHeader title="Projects">
        A project is what a repo is ingested into. Its snapshot and cap are the operator's to set.
      </PageHeader>
      <div className="mt-6 space-y-6">
        <Create onCreated={(p) => setKnown((k) => [...k, p])} />
        <Settings known={known} />
      </div>
    </Page>
  );
}
