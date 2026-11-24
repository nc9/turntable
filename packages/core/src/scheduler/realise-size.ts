// A size class on a provider (#492): the provider's own `realiseClass` maps the class to what its
// sandbox starts from, or refuses. A provider without the capability gets the resources alone, and
// a class that carries settings for that provider (an image, a snapshot) is refused rather than
// run at the wrong size or from the wrong image. The caller fails the job closed on a refusal.
import type { Provider, SandboxResources } from "@turntable/provider-sdk";
import type { SandboxSize } from "./sandbox-size";

export type Realised =
  | { ok: true; sandbox?: { resources?: SandboxResources; snapshot?: string; image?: string } }
  | { ok: false; reason: string };

export function realiseSize(provider: Provider, size: SandboxSize): Realised {
  if (size.class === undefined) return { ok: true };
  const resources: SandboxResources = size.resources ?? {};
  const specific = size.providers?.[provider.info.name];
  let r;
  if (provider.realiseClass) {
    r = provider.realiseClass(resources, specific);
  } else if (specific && Object.keys(specific).length > 0) {
    return { ok: false, reason: "this provider cannot realise per provider class settings" };
  } else {
    r = { ok: true as const, resources };
  }
  if (!r.ok) return { ok: false, reason: r.reason.replaceAll(/[`\r\n]+/g, " ").slice(0, 200) };
  const sandbox = {
    ...(r.resources && Object.keys(r.resources).length > 0 ? { resources: r.resources } : {}),
    ...(r.snapshot ? { snapshot: r.snapshot } : {}),
    ...(r.image ? { image: r.image } : {}),
  };
  return Object.keys(sandbox).length > 0 ? { ok: true, sandbox } : { ok: true };
}
