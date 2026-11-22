// Remote composite actions can contain `uses:` of their own. With network access act would fetch
// those by TAG itself, bypassing pinning. So after the top-level actions are pinned, each remote
// action is read at its sha: a composite's nested actions are resolved, checked and delivered
// locally the same way (recursively, depth-capped), a docker action is refused, and anything
// that cannot be resolved refuses the plan.
import { parse } from "yaml";
import type { ActionFetcher } from "./act-install";
import { fetchActionTarball } from "./act-install";
import {
  PlanError,
  rebuildArgv,
  type ActionRefResolver,
  type JobPlan,
  type PlannedAction,
} from "./plan";

export const MAX_NESTED_DEPTH = 5;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

async function tar(args: string[], stdin: Uint8Array): Promise<{ code: number; out: Uint8Array }> {
  const p = Bun.spawn(["tar", ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).bytes(), p.exited]);
  return { code, out };
}

/** Reads `<subpath>/action.yml` (or .yaml) from a GitHub source tarball, or undefined. */
export async function readActionYml(tgz: Uint8Array, subpath: string): Promise<string | undefined> {
  const listed = await tar(["tzf", "-"], tgz);
  if (listed.code !== 0)
    throw new PlanError("nested-action", "an action tarball could not be read");
  const names = new TextDecoder().decode(listed.out).split("\n");
  const want = subpath ? `${subpath.replace(/\/+$/, "")}/` : "";
  for (const file of ["action.yml", "action.yaml"]) {
    const member = names.find((n) => {
      const rest = n.replace(/^[^/]+\//, "");
      return n.includes("/") && rest === `${want}${file}`;
    });
    if (member) {
      const r = await tar(["xzOf", "-", member], tgz);
      if (r.code === 0) return new TextDecoder().decode(r.out);
    }
  }
  return undefined;
}

export interface NestedHooks {
  /** Resolves a nested tag or branch to a sha (the pin-aware resolver). */
  resolve: ActionRefResolver;
  /** Fetches a source tarball by sha. Defaults to codeload. */
  fetchTarball?: ActionFetcher;
  /**
   * Called once for each nested action, with its sha known, before it is accepted. Throw to
   * refuse (allowlist, impostor check ...).
   */
  check?: (a: PlannedAction) => Promise<void>;
  maxDepth?: number;
}

const USES = /^([^/@\s]+\/[^/@\s]+)((?:\/[^@\s]+)?)@(\S+)$/;

/**
 * Walks every remote action of a pinned plan and adds the actions its composites use, to any
 * depth up to the cap. Returns a new plan whose command maps every one of them to a local,
 * sha-delivered directory.
 */
export async function expandNestedActions(plan: JobPlan, h: NestedHooks): Promise<JobPlan> {
  const fetchTarball = h.fetchTarball ?? fetchActionTarball;
  const maxDepth = h.maxDepth ?? MAX_NESTED_DEPTH;
  const actions: PlannedAction[] = [...plan.actions];
  const tarballs = new Map<string, Uint8Array>();
  const checkoutRefs = [...plan.checkoutRefs];
  const stubDirs = [...plan.stubDirs];

  const visit = async (a: PlannedAction, depth: number): Promise<void> => {
    if (a.kind !== "remote") return;
    if (!a.sha) throw new PlanError("nested-action", `${a.uses} is not resolved to a sha`);
    const key = `${a.repo}@${a.sha}`;
    let tgz = tarballs.get(key);
    if (!tgz) {
      tgz = await fetchTarball(a.repo, a.sha);
      tarballs.set(key, tgz);
    }
    const yml = await readActionYml(tgz, a.subpath);
    if (yml === undefined) {
      throw new PlanError("nested-action", `${a.uses} has no action.yml at ${a.sha}`);
    }
    let doc: unknown;
    try {
      doc = parse(yml, { merge: true });
    } catch (e) {
      throw new PlanError(
        "nested-action",
        `${a.uses}: action.yml is not valid YAML: ${(e as Error).message}`,
      );
    }
    const runs = isObj(doc) ? doc.runs : undefined;
    if (!isObj(runs))
      throw new PlanError("nested-action", `${a.uses}: action.yml has no runs section`);
    if (runs.using === "docker") {
      throw new PlanError("docker:// action", `${a.uses} is a docker action, which is unsupported`);
    }
    if (runs.using !== "composite" || !Array.isArray(runs.steps)) return;
    if (depth >= maxDepth) {
      throw new PlanError("nested-depth", `${a.uses} nests actions deeper than ${maxDepth} levels`);
    }
    for (const step of runs.steps) {
      if (!isObj(step) || typeof step.uses !== "string") continue;
      const uses = step.uses.trim();
      if (uses.startsWith("./") || uses.startsWith("../")) continue;
      if (uses.startsWith("docker://")) {
        throw new PlanError("docker:// action", `${a.uses} uses ${uses}, which is unsupported`);
      }
      const m = USES.exec(uses);
      if (!m)
        throw new PlanError("nested-action", `${a.uses} has an unparsable nested action "${uses}"`);
      const [, repo = "", sub = "", ref = ""] = m;
      if (
        actions.some(
          (x) => x.repo === repo && x.ref === ref && x.subpath === sub.replace(/^\//, ""),
        )
      ) {
        continue;
      }
      const kind = uses.startsWith("actions/checkout@") ? "checkout" : "remote";
      const dir = `${plan.layout.stubs}/${kind === "checkout" ? "checkout" : "action"}-${actions.length}`;
      const [owner = "", name = ""] = repo.split("/");
      const nested: PlannedAction = {
        uses,
        repo,
        subpath: sub.replace(/^\//, ""),
        ref,
        sha: /^[0-9a-f]{40}$/.test(ref) ? ref : await h.resolve(owner, name, ref),
        kind,
        dir,
        nestedIn: a.uses,
      };
      await h.check?.(nested);
      actions.push(nested);
      if (kind === "checkout") {
        checkoutRefs.push(uses);
        stubDirs.push(dir);
      } else {
        await visit(nested, depth + 1);
      }
    }
  };

  for (const a of plan.actions) await visit(a, 1);
  return rebuildArgv({ ...plan, actions, checkoutRefs, stubDirs });
}
