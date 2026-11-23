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
import { z } from "zod";
import type { SandboxResources } from "@longshore/provider-sdk";

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
    maxCpus: pos(256).optional(),
    maxMemoryMb: pos(2_097_152).optional(),
    maxDiskGb: pos(16_384).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const known = (n: string | undefined, path: (string | number)[]): void => {
      if (n !== undefined && !(n in c.classes))
        ctx.addIssue({ code: "custom", path, message: `unknown size class ${n}` });
    };
    known(c.default, ["default"]);
    known(c.untrustedClass, ["untrustedClass"]);
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

/**
 * The size a job's sandbox gets. Labels are checked in order and the first mapped one wins (GitHub
 * lists a runner's labels as a set; an operator maps the ones they mean). An untrusted run ignores
 * its labels. `{}` means "no opinion": the provider's own default size.
 */
export function sizeFor(
  cfg: SandboxSizes | undefined,
  labels: readonly string[],
  o: { untrusted?: boolean } = {},
): SandboxSize {
  if (!cfg) return {};
  const name =
    o.untrusted === true
      ? (cfg.untrustedClass ?? cfg.default)
      : (labels.map((l) => cfg.labels[l]).find((n) => n !== undefined) ?? cfg.default);
  if (name === undefined) return {};
  const c = cfg.classes[name];
  if (!c) return {};
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
