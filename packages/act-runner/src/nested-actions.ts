// Remote composite actions can contain `uses:` of their own. With network access act would fetch
// those by TAG itself, bypassing pinning. So after the top-level actions are pinned, each remote
// action is read at its sha: a composite's nested actions are resolved, checked and delivered
// locally the same way (recursively, depth-capped), a docker action is refused, and anything
// that cannot be resolved refuses the plan.
import { parse } from "yaml";
import type { ActionFetcher } from "./act-install";
import { fetchActionTarball } from "./act-install";
import { classifyActionRuntime } from "./action-runtime";
import { readTarGz } from "./tar";
import {
  PlanError,
  localActionDir,
  rebuildArgv,
  type ActionRefResolver,
  type JobPlan,
  type PlanFile,
  type PlannedAction,
} from "./plan";

export const MAX_NESTED_DEPTH = 5;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads `<subpath>/action.yml` (or .yaml) from a GitHub source tarball, or undefined. */
export async function readActionYml(tgz: Uint8Array, subpath: string): Promise<string | undefined> {
  let entries;
  try {
    entries = readTarGz(tgz, { maxBytes: ACTION_TAR_MAX_BYTES });
  } catch {
    throw new PlanError("nested-action", "an action tarball could not be read");
  }
  const want = subpath ? `${subpath.replace(/\/+$/, "")}/` : "";
  for (const file of ["action.yml", "action.yaml"]) {
    const member = entries.find((e) => {
      if (e.type !== "file" || !e.path.includes("/")) return false;
      const rest = e.path.replace(/^[^/]+\//, "");
      return rest === `${want}${file}`;
    });
    if (member) return new TextDecoder().decode(member.data);
  }
  return undefined;
}

/** An action's source tarball, unpacked, is at most this large. */
const ACTION_TAR_MAX_BYTES = 256 * 1024 * 1024;

export interface NestedHooks {
  /** Resolves a nested tag or branch to a sha (the pin-aware resolver). */
  resolve: ActionRefResolver;
  /** Fetches a source tarball by sha. Defaults to codeload. */
  fetchTarball?: ActionFetcher;
  /**
   * Reads a file of the workspace (the caller's repo, path relative to its root), through the
   * safe reader. A `./` action inside a remote composite resolves against the workspace.
   */
  readFile: (path: string) => string | undefined;
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
 * depth up to the cap. A `./x` inside a remote composite is a real action of the caller's
 * workspace (act and GitHub resolve it there), so it is read through the safe reader and walked
 * the same way. Returns a new plan whose command maps every remote one to a local, sha-delivered
 * directory, and whose files include the workspace actions reached this way.
 */
export async function expandNestedActions(plan: JobPlan, h: NestedHooks): Promise<JobPlan> {
  const fetchTarball = h.fetchTarball ?? fetchActionTarball;
  const maxDepth = h.maxDepth ?? MAX_NESTED_DEPTH;
  const actions: PlannedAction[] = [...plan.actions];
  const files: PlanFile[] = [...plan.files];
  const tarballs = new Map<string, Uint8Array>();
  const checkoutRefs = [...plan.checkoutRefs];
  const stubDirs = [...plan.stubDirs];
  const seenLocal = new Set<string>();
  for (const f of plan.files) seenLocal.add(f.path);

  const parseYaml = (text: string, label: string): unknown => {
    try {
      return parse(text, { merge: true });
    } catch (e) {
      throw new PlanError(
        "nested-action",
        `${label}: action.yml is not valid YAML: ${(e as Error).message}`,
      );
    }
  };

  /** Handles the `uses:` of every step of a composite found in `from`. */
  const walkSteps = async (from: string, steps: unknown[], depth: number): Promise<void> => {
    if (depth > maxDepth) {
      throw new PlanError("nested-depth", `${from} nests actions deeper than ${maxDepth} levels`);
    }
    for (const step of steps) {
      if (!isObj(step) || typeof step.uses !== "string") continue;
      const uses = step.uses.trim();
      if (uses.startsWith("docker://")) {
        throw new PlanError("docker:// action", `${from} uses ${uses}, which is unsupported`);
      }
      if (uses.startsWith("./") || uses.startsWith("../")) {
        await walkLocal(from, uses, depth);
        continue;
      }
      const m = USES.exec(uses);
      if (!m)
        throw new PlanError("nested-action", `${from} has an unparsable nested action "${uses}"`);
      const [, repo = "", sub = "", ref = ""] = m;
      const subpath = sub.replace(/^\//, "");
      if (actions.some((x) => x.repo === repo && x.ref === ref && x.subpath === subpath)) continue;
      const kind = uses.startsWith("actions/checkout@") ? "checkout" : "remote";
      const dir = `${plan.layout.stubs}/${kind === "checkout" ? "checkout" : "action"}-${actions.length}`;
      const [owner = "", name = ""] = repo.split("/");
      const nested: PlannedAction = {
        uses,
        repo,
        subpath,
        ref,
        sha: /^[0-9a-f]{40}$/.test(ref) ? ref : await h.resolve(owner, name, ref),
        kind,
        dir,
        nestedIn: from,
      };
      await h.check?.(nested);
      actions.push(nested);
      if (kind === "checkout") {
        checkoutRefs.push(uses);
        stubDirs.push(dir);
      } else {
        await walkRemote(nested, depth + 1);
      }
    }
  };

  /** A `./x` inside a remote composite: an action of the caller's workspace. */
  const walkLocal = async (from: string, uses: string, depth: number): Promise<void> => {
    const dir = localActionDir(uses);
    if (dir === undefined) {
      throw new PlanError("local action", `${from} uses "${uses}", a path outside the workspace`);
    }
    if (seenLocal.has(dir)) return;
    seenLocal.add(dir);
    for (const name of ["action.yml", "action.yaml"]) {
      const path = dir === "" ? name : `${dir}/${name}`;
      const text = h.readFile(path);
      if (text === undefined) continue;
      files.push({ path, source: text, text });
      const rt = classifyActionRuntime(
        (parseYaml(text, `local action ${path}`) as Obj | undefined)?.runs,
        `local action ${path}`,
      );
      if (rt.kind === "composite") await walkSteps(`./${dir}`, rt.steps, depth + 1);
      return;
    }
    throw new PlanError(
      "local action",
      `${from} uses "${uses}", which has no action.yml in the workspace`,
    );
  };

  const walkRemote = async (a: PlannedAction, depth: number): Promise<void> => {
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
    const rt = classifyActionRuntime((parseYaml(yml, a.uses) as Obj | undefined)?.runs, a.uses);
    if (rt.kind === "composite") await walkSteps(a.uses, rt.steps, depth);
  };

  for (const a of plan.actions) await walkRemote(a, 1);
  return rebuildArgv({ ...plan, actions, files, checkoutRefs, stubDirs });
}
