// Sandbox size per job. The operator maps `runs-on` labels to a size class (cpus, memory, disk, or
// a provider snapshot), and the scheduler asks the provider for that size. Nothing here is stored
// in the database: it is serve configuration, like the provider's own.
//
//   { "classes": { "large": { "cpus": 4, "memoryMb": 8192, "snapshot": "daytona-large" } },
//     "labels":  { "ubuntu-latest-4-cores": "large" },
//     "default": "small",           // a class name; unset: the provider's own default size
//     "untrustedClass": "small",    // optional: untrusted PR runs always get this class
//     "maxCpus": 8, "maxMemoryMb": 16384, "maxDiskGb": 100 }   // global ceilings, optional
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
const NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const classSchema = z
  .object({
    cpus: pos(256).optional(),
    memoryMb: pos(2_097_152).optional(),
    diskGb: pos(16_384).optional(),
    /** A provider snapshot of this size (Daytona: a snapshot per class). */
    snapshot: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/)
      .optional(),
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
  return r.data;
}

export type SandboxSize = { resources?: SandboxResources; snapshot?: string; class?: string };

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
  o: { untrusted?: boolean } = {},
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
      : (labels.map((l) => pick(own(cfg.labels, l)) ?? coresPick(l)).find((x) => x !== undefined) ??
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
    ...(c.snapshot ? { snapshot: c.snapshot } : {}),
  };
}
