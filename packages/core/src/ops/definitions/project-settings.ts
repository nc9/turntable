import { z } from "zod";
import {
  appendAudit,
  createProject,
  getOrgBySlug,
  getProjectBySlug,
  getProjectSandboxSettings,
  setProjectSandboxSettings,
  SNAPSHOT_NAME,
} from "../../db/repos";
import { UNTRUSTED_RUN_APPROVALS } from "../../db/schema";
import { SYSTEM_ORG_SLUG } from "../../audit/failures";
import { HUMAN_MODE_UNAVAILABLE } from "../approval-policy";
import { defineOp } from "../define";
import { OpError } from "../errors";

const settingsShape = z.object({
  sandbox_snapshot: z
    .string()
    .nullable()
    .describe("The provider snapshot this project's sandboxes start from; null is the default."),
  max_concurrent: z
    .int()
    .nullable()
    .describe("Most attempts of this project running at once; null is no project limit."),
  untrusted_run_approval: z
    .enum(UNTRUSTED_RUN_APPROVALS)
    .describe(
      "Who may approve a run held for an untrusted author: human (an enrolled approver's signature only), no_agents (default: not over MCP, not with an agent token) or any.",
    ),
});

export const getProjectSettings = defineOp({
  name: "get_project_settings",
  summary: "A project's sandbox snapshot, concurrency cap and untrusted-run approval policy.",
  description:
    "The settings the instance operator gave one project: `sandbox_snapshot` (the provider " +
    "snapshot its sandboxes start from; it beats a size class's snapshot and the provider's " +
    "default) and `max_concurrent` (most of its attempts running at once; it can only lower the " +
    "org's and the instance's caps). Null means not set. `untrusted_run_approval` says who may " +
    "approve a run held for an untrusted author (human, no_agents or any; default no_agents): " +
    "read it to know whether `approve_run` will be refused for you. Pass the project. Read-only. They are " +
    "set by the instance operator (`set_project_settings`, or `turntable policy set` on the " +
    "host), never by the project's own tokens.",
  input: z.object({}),
  output: z.object({ project: z.string(), ...settingsShape.shape }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "GET", path: "/project-settings" },
  async handler(ctx) {
    if (!ctx.scope.projectId) throw new OpError("invalid_input", "a project is required");
    const s = await getProjectSandboxSettings(ctx.db, ctx.scope);
    return {
      project: ctx.scope.projectId,
      sandbox_snapshot: s.sandboxSnapshot,
      max_concurrent: s.maxConcurrent,
      untrusted_run_approval: s.untrustedRunApproval,
    };
  },
});

export const setProjectSettings = defineOp({
  name: "set_project_settings",
  summary: "Set a project's sandbox snapshot and concurrency cap (instance administrator only).",
  description:
    "Changes the sandbox settings of one project, naming only the ones to change (null removes " +
    "one). `sandbox_snapshot` is the name of an existing provider snapshot: the project's " +
    "sandboxes start from it instead of the size class's or the provider's default. " +
    "`max_concurrent` caps the project's running attempts and can only lower the instance's " +
    "per-org cap (`--org-cap`): a value above it is refused. Both are operator controls and a " +
    "tenant must not choose its own image or lift its own cap, so only the instance " +
    "administrator can call it: an org's own tokens, of any role, never can. " +
    "`untrusted_run_approval` (no_agents or any; `human` is not selectable yet, #324) says who may approve a run held for an " +
    "untrusted author; raising it to `any` lets agents approve, so it is audited with the old " +
    "and new value like every change here and is never an MCP call. The change is " +
    "audited in the system org's chain and in the target org's own. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    target_project: z.string().min(1).max(64).describe("Slug of the project."),
    sandbox_snapshot: z.string().min(1).max(128).nullable().optional(),
    max_concurrent: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    untrusted_run_approval: z.enum(UNTRUSTED_RUN_APPROVALS).optional(),
  }),
  output: z.object({ project: z.string(), ...settingsShape.shape }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/project-settings" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such project");
    const project = await getProjectBySlug(ctx.db, { orgId: org.id }, i.target_project);
    if (!project) throw new OpError("not_found", "no such project");
    if (
      i.sandbox_snapshot === undefined &&
      i.max_concurrent === undefined &&
      i.untrusted_run_approval === undefined
    )
      throw new OpError("invalid_input", "name at least one setting to set");
    if (typeof i.sandbox_snapshot === "string" && !SNAPSHOT_NAME.test(i.sandbox_snapshot))
      throw new OpError(
        "invalid_input",
        "a snapshot name is letters, digits, . _ - (up to 128, starting alphanumeric)",
      );
    const cap = ctx.instanceOrgCap;
    if (typeof i.max_concurrent === "number" && cap !== undefined && i.max_concurrent > cap) {
      throw new OpError(
        "invalid_input",
        `max_concurrent ${i.max_concurrent} is above the instance's per-org cap of ${cap}; it can only lower it`,
      );
    }
    if (i.untrusted_run_approval === "human")
      throw new OpError("invalid_input", HUMAN_MODE_UNAVAILABLE);
    const scope = { orgId: org.id, projectId: project.id };
    const from = await getProjectSandboxSettings(ctx.db, scope);
    const to = await setProjectSandboxSettings(ctx.db, scope, {
      ...(i.sandbox_snapshot !== undefined ? { sandboxSnapshot: i.sandbox_snapshot } : {}),
      ...(i.max_concurrent !== undefined ? { maxConcurrent: i.max_concurrent } : {}),
      ...(i.untrusted_run_approval !== undefined
        ? { untrustedRunApproval: i.untrusted_run_approval }
        : {}),
    });
    if (!to) throw new OpError("not_found", "no such project");
    // The org's own chain says it too: its operators should see who changed their project.
    await appendAudit(ctx.db, scope, {
      principalKind: "instance",
      principalId: ctx.principal.id,
      op: "set_project_settings",
      effect: "write",
      outcome: "ok",
      input: { target_org: org.slug, target_project: project.slug, from, to },
    });
    return {
      project: project.id,
      sandbox_snapshot: to.sandboxSnapshot,
      max_concurrent: to.maxConcurrent,
      untrusted_run_approval: to.untrustedRunApproval,
    };
  },
});

const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const createProjectOp = defineOp({
  name: "create_project",
  summary: "Create a project in an org (instance administrator only).",
  description:
    "Creates an empty project in an existing org: a slug (lower-case letters, digits and `-`, " +
    "up to 63) and a display name. A project is what a repo is ingested into, what carries a " +
    "sandbox snapshot and a concurrency cap (`set_project_settings`) and the policy of its " +
    "runs, so it is made by the instance operator: on a hosted instance with no shell this is " +
    "how a second repo gets its own project. A slug already used in the org is a conflict. " +
    "Audited in the system org's chain and the org's own. Not an MCP tool.",
  input: z.object({
    target_org: z.string().min(1).max(64).describe("Slug of the org."),
    slug: z.string().min(1).max(63).describe("Slug of the new project."),
    name: z.string().min(1).max(120).describe("Display name. Untrusted text elsewhere."),
  }),
  output: z.object({ org: z.string(), project: z.string(), id: z.string(), name: z.string() }),
  effect: "write",
  auth: { type: "instance", minRole: "admin" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/instance/projects" },
  mcp: false,
  async handler(ctx, i) {
    const org = await getOrgBySlug(ctx.db, i.target_org);
    if (!org || org.slug === SYSTEM_ORG_SLUG) throw new OpError("not_found", "no such org");
    if (!PROJECT_SLUG.test(i.slug))
      throw new OpError(
        "invalid_input",
        "a project slug is lower-case letters, digits and - (up to 63, starting alphanumeric)",
      );
    if (await getProjectBySlug(ctx.db, { orgId: org.id }, i.slug))
      throw new OpError("conflict", "a project with that slug already exists in the org");
    const project = await createProject(ctx.db, { orgId: org.id }, { slug: i.slug, name: i.name });
    await appendAudit(
      ctx.db,
      { orgId: org.id, projectId: project.id },
      {
        principalKind: "instance",
        principalId: ctx.principal.id,
        op: "create_project",
        effect: "write",
        outcome: "ok",
        input: { target_org: org.slug, slug: i.slug },
      },
    );
    return { org: org.slug, project: project.slug, id: project.id, name: project.name };
  },
});
