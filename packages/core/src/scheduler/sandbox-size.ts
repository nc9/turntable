// Sandbox size per job. The operator maps `runs-on` labels to a size class (cpus, memory, disk, or
// a provider snapshot), and the scheduler asks the provider for that size. Nothing here is stored
// in the database: it is serve configuration, like the provider's own.
//
//   { "classes": { "large": { "cpus": 4, "memoryMb": 8192,
//                              "providers": { "daytona": { "snapshot": "daytona-large" },
//                                             "docker": { "image": "registry.example/runner:large" } } } },
//     "labels":  { "ubuntu-latest-4-cores": "large" },
//     "default": "small",           // a class name; unset: the provider's own default size
//     "untrustedClass": "small",    // optional: untrusted PR runs always get this class
//     "maxCpus": 8, "maxMemoryMb": 16384, "maxDiskGb": 100 }   // global ceilings, optional
//
// A class is realised per provider: `providers.<name>` holds what only that provider understands
// (Daytona: `snapshot`; Docker: `image`), and the provider's `realiseClass` maps the class to a
// sandbox spec or refuses it. The top-level `snapshot` is a deprecated alias for
// `providers.daytona.snapshot`. An org or project may map labels to class NAMES the operator
// defined (the `runner_labels` settings); the ceilings still clamp, and project beats org beats
// the instance map.
//
// A workflow file chooses its labels, so a stranger's pull request could ask for the biggest
// class. `untrustedClass` fixes what such a run gets whatever it asks for, and the ceilings clamp
// every class (so a typo in a class cannot exceed them). An unknown label gets the default.
//
// GitHub-hosted labels: `ubuntu-latest`, `ubuntu-24.04` and `ubuntu-22.04` mean the default class
// (unless the operator maps them). `ubuntu-latest-{N}-cores` means a class with N cpus when the
// operator lists in `coresClasses` has, else the default. A workflow can name any label, so a class
// the operator did not list is never reachable by an `-N-cores` label. A job that names another OS (macOS, Windows) or arm
// is refused before any sandbox exists (`refusalFor`), never run on a Linux amd64 sandbox.
import { z } from "zod";
import type { SandboxResources } from "@turntable/provider-sdk";

const pos = (max: number) => z.number().int().positive().max(max);
const ORG_SLUG = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/);
const NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;
const PROVIDER_VALUE = z.union([z.string().max(512), z.number(), z.boolean()]);

/** What one provider needs to realise a class. Known providers are checked tightly. */
const providerSpecific = z
  .record(NAME, z.record(z.string().min(1).max(64), PROVIDER_VALUE))
  .superRefine((m, ctx) => {
    const check = (prov: string, key: string, re: RegExp): void => {
      const v = m[prov]?.[key];
      if (v !== undefined && !(typeof v === "string" && re.test(v)))
        ctx.addIssue({ code: "custom", path: [prov, key], message: `${prov}.${key} is not valid` });
    };
    check("daytona", "snapshot", SNAPSHOT);
    check("docker", "image", IMAGE);
  });

const classSchema = z
  .object({
    cpus: pos(256).optional(),
    memoryMb: pos(2_097_152).optional(),
    diskGb: pos(16_384).optional(),
    /** Deprecated alias for `providers.daytona.snapshot`; folded in when the config is parsed. */
    snapshot: z.string().regex(SNAPSHOT).optional(),
    /** Per provider settings: `{ daytona: { snapshot }, docker: { image } }`. */
    providers: providerSpecific.optional(),
    /**
     * Whether an org or project label map may name this class. Default true. Set false for a class
     * with cost or privilege (a macOS reservation, a Docker-capable sandbox).
     */
    tenantSelectable: z.boolean().default(true),
    /** Org slugs that may name the class even when it is not `tenantSelectable`. */
    orgs: z.array(ORG_SLUG).max(64).optional(),
  })
  .strict();

export const sandboxSizesSchema = z
  .object({
    classes: z.record(NAME, classSchema),
    labels: z.record(z.string().min(1).max(100), NAME).default({}),
    default: NAME.optional(),
    untrustedClass: NAME.optional(),
    /** Classes an `ubuntu-latest-N-cores` label may resolve to, by cpu count. Empty: none. */
    coresClasses: z.array(NAME).default([]),
    maxCpus: pos(256).optional(),
    maxMemoryMb: pos(2_097_152).optional(),
    maxDiskGb: pos(16_384).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [n, k] of Object.entries(c.classes)) {
      const p = k.providers?.daytona?.snapshot;
      if (k.snapshot !== undefined && p !== undefined && p !== k.snapshot)
        ctx.addIssue({
          code: "custom",
          path: ["classes", n, "snapshot"],
          message: "snapshot and providers.daytona.snapshot disagree",
        });
    }
    const known = (n: string | undefined, path: (string | number)[]): void => {
      if (n !== undefined && !Object.hasOwn(c.classes, n))
        ctx.addIssue({ code: "custom", path, message: `unknown size class ${n}` });
    };
    known(c.default, ["default"]);
    known(c.untrustedClass, ["untrustedClass"]);
    c.coresClasses.forEach((n, i) => known(n, ["coresClasses", i]));
    for (const [label, cls] of Object.entries(c.labels)) known(cls, ["labels", label]);
  });

export type SandboxSizes = z.infer<typeof sandboxSizesSchema>;
export type SizeClassDef = SandboxSizes["classes"][string];

const warned = new Set<string>();
/** A config warning, once per process per message (boot reads the config more than once). */
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`turntable: ${msg}`);
}

/** Folds the deprecated top-level `snapshot` into `providers.daytona.snapshot`, with a warning. */
function normalise(c: SandboxSizes): SandboxSizes {
  const classes: SandboxSizes["classes"] = {};
  for (const [n, k] of Object.entries(c.classes)) {
    const { snapshot, ...rest } = k;
    if (snapshot === undefined) {
      classes[n] = k;
      continue;
    }
    warnOnce(`sandbox size class ${n}: \`snapshot\` is deprecated, use providers.daytona.snapshot`);
    classes[n] = {
      ...rest,
      providers: { ...rest.providers, daytona: { ...rest.providers?.daytona, snapshot } },
    };
  }
  return { ...c, classes };
}

let operator: SandboxSizes | undefined;
/** The operator's size config, held for the label-map settings' set-time check. Set at boot. */
export function setOperatorSizes(s: SandboxSizes | undefined): void {
  operator = s;
}
export function operatorSizes(): SandboxSizes | undefined {
  return operator;
}

/** A tenant's label map: label to the NAME of a class. */
export type LabelMap = Readonly<Record<string, string>>;

/** Whether an org's label map may name this class: selectable, or the org is on its allowlist. */
export function tenantMayName(c: SizeClassDef, orgSlug: string | undefined): boolean {
  return c.tenantSelectable !== false || (orgSlug !== undefined && !!c.orgs?.includes(orgSlug));
}

/**
 * Why a tenant label map cannot be set: it may name only classes the operator defined. Undefined
 * when fine. Fixed words plus the label and class name (both are the caller's own input); it never
 * names another org. A class that is not `tenantSelectable` is refused unless `ctx.orgSlug` is in
 * the class's `orgs`.
 */
export function refuseLabelMap(
  m: LabelMap,
  ctx: { orgSlug?: string } = {},
  sizes: SandboxSizes | undefined = operator,
): string | undefined {
  for (const [label, cls] of Object.entries(m)) {
    const def = sizes && Object.hasOwn(sizes.classes, cls) ? sizes.classes[cls] : undefined;
    if (!def) {
      return `runner label ${labelText(label)} names size class ${labelText(cls)}, which the instance operator has not defined`;
    }
    if (!tenantMayName(def, ctx.orgSlug)) {
      return `runner label ${labelText(label)} names size class ${labelText(cls)}, which is not available to this org`;
    }
  }
  return undefined;
}

export function parseSandboxSizes(text: string, source: string): SandboxSizes {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const r = sandboxSizesSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(
      `${source}: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return normalise(r.data);
}

export type SandboxSize = {
  resources?: SandboxResources;
  class?: string;
  /** The class's per provider settings, for the provider's `realiseClass`. */
  providers?: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>>;
};

const own = <T>(m: Readonly<Record<string, T>>, k: string | undefined): T | undefined =>
  k !== undefined && Object.hasOwn(m, k) ? m[k] : undefined;

/** GitHub-hosted labels that mean "an ordinary Linux sandbox": the default class. */
export const GITHUB_DEFAULT_LABELS: readonly string[] = [
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-22.04",
];

const ARM_LABEL = /(^|-)arm(64)?$/i;
const CORES_LABEL = /^ubuntu-(?:latest|\d\d\.04)-(\d+)-cores$/i;

const labelText = (v: string): string => v.replaceAll(/[`\r\n]+/g, " ").slice(0, 60);

/**
 * Why a planned job cannot run here, or undefined. The planner already marks other-OS and docker
 * jobs `unsupported`; an arm label is checked here, against what the provider advertises (amd64
 * only unless it says `arm64`). The text is public (a check summary): fixed words and the label.
 */
export function refusalFor(
  planned: { unsupported?: string; runsOn?: readonly string[] } | undefined,
  providerArch: readonly string[],
): string | undefined {
  if (!planned) return undefined;
  if (planned.unsupported) return `unsupported: ${planned.unsupported}`;
  const arm = (planned.runsOn ?? []).find((l) => ARM_LABEL.test(l));
  if (arm !== undefined && !providerArch.includes("arm64")) {
    return `unsupported: This job asks for an arm64 runner (\`${labelText(arm)}\`). The sandbox provider offers amd64 only; arm runners are not supported by it.`;
  }
  return undefined;
}

const CLASSES = new Set(["protected", "release", "trusted_pr", "untrusted_pr"]);

/**
 * Whether a job counts as untrusted for sizing: its OWN effective class (after the demotion
 * rule), not its run's. An unknown, missing or unrecognised class is untrusted (fail closed); only
 * a local run (the operator's own checkout) is exempt.
 */
export function untrustedForSize(klass: string | null | undefined, local = false): boolean {
  if (local) return false;
  return klass === undefined || klass === null || !CLASSES.has(klass) || klass === "untrusted_pr";
}

/**
 * The size a job's sandbox gets. Labels are checked in order and the first mapped one wins (GitHub
 * lists a runner's labels as a set; an operator maps the ones they mean). An untrusted job ignores
 * its labels. Lookups are own-key only (a label of `constructor` or `__proto__` is not a mapping),
 * and a lookup that fails falls back to `default`, never to "no opinion" when a map exists.
 * `{}` means the provider's own default size: no map, or no default and no match.
 */
export function sizeFor(
  cfg: SandboxSizes | undefined,
  labels: readonly string[],
  o: {
    untrusted?: boolean;
    /** Tenant label maps, most specific first (project, then org). */
    overrides?: readonly LabelMap[];
  } = {},
): SandboxSize {
  if (!cfg) return {};
  const pick = (
    name: string | undefined,
  ): [string, SandboxSizes["classes"][string]] | undefined => {
    const c = own(cfg.classes, name);
    return name !== undefined && c ? [name, c] : undefined;
  };
  const defaultPick = pick(cfg.default);
  // `ubuntu-latest-4-cores`: a class with exactly 4 cpus among the operator's `coresClasses`.
  const coresPick = (label: string): ReturnType<typeof pick> => {
    const n = Number(CORES_LABEL.exec(label)?.[1]);
    if (!Number.isInteger(n)) return undefined;
    const name = [...cfg.coresClasses].toSorted().find((k) => own(cfg.classes, k)?.cpus === n);
    return pick(name);
  };
  const chosen =
    o.untrusted === true
      ? (pick(cfg.untrustedClass) ?? defaultPick)
      : (fromLayers(o.overrides ?? [], labels, pick) ??
        labels.map((l) => pick(own(cfg.labels, l)) ?? coresPick(l)).find((x) => x !== undefined) ??
        defaultPick);
  if (!chosen) return {};
  const [name, c] = chosen;
  const clamp = (v: number | undefined, max: number | undefined): number | undefined =>
    v === undefined ? undefined : max === undefined ? v : Math.min(v, max);
  const cpus = clamp(c.cpus, cfg.maxCpus);
  const memoryMb = clamp(c.memoryMb, cfg.maxMemoryMb);
  const diskGb = clamp(c.diskGb, cfg.maxDiskGb);
  const resources: SandboxResources = {
    ...(cpus !== undefined ? { cpus } : {}),
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(diskGb !== undefined ? { diskGb } : {}),
  };
  return {
    class: name,
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    ...(c.providers && Object.keys(c.providers).length > 0 ? { providers: c.providers } : {}),
  };
}

/** The first layer (most specific first) that maps any of the labels, and that class if defined. */
function firstLayerHit<C>(
  layers: readonly LabelMap[],
  labels: readonly string[],
  pick: (name: string | undefined) => [string, C] | undefined,
): { label: string; hit: [string, C] } | undefined {
  for (const layer of layers) {
    for (const label of labels) {
      const hit = pick(own(layer, label));
      if (hit) return { label, hit };
    }
  }
  return undefined;
}

function fromLayers<C>(
  layers: readonly LabelMap[],
  labels: readonly string[],
  pick: (name: string | undefined) => [string, C] | undefined,
): [string, C] | undefined {
  return firstLayerHit(layers, labels, pick)?.hit;
}

/**
 * Run-time check of a stored tenant label map: the entry that would pick the class names one this
 * org may no longer select (the operator changed `tenantSelectable` or `orgs` after the map was
 * set). The job must FAIL with this reason, never fall back to the instance map or the default,
 * which would hide size-dependent bugs. Undefined when fine. Untrusted runs never read tenant
 * maps. Fixed words plus the label and class name; never another org.
 */
export function tenantMapRefusal(
  cfg: SandboxSizes | undefined,
  labels: readonly string[],
  o: { untrusted?: boolean; overrides?: readonly LabelMap[]; orgSlug?: string | undefined },
): string | undefined {
  if (!cfg || o.untrusted === true) return undefined;
  const found = firstLayerHit(o.overrides ?? [], labels, (name) => {
    const c = own(cfg.classes, name);
    return name !== undefined && c ? [name, c] : undefined;
  });
  if (!found || tenantMayName(found.hit[1], o.orgSlug)) return undefined;
  return `unsupported: runner label \`${labelText(found.label)}\` maps to class \`${labelText(found.hit[0])}\`, which this org may not select; ask the operator or change the map`;
}
