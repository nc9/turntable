// Where a web sign-in may send the person back to. The sign-in flow takes a `next` path (the
// onboarding wizard uses it to come back to the same step after a GitHub reconnect). It is
// accepted only as a same-origin path on a short allowlist of app routes with a strict query:
// never a full URL, never a protocol-relative or backslash form, never anything else.

const STEPS = new Set(["org", "repos", "preview", "run"]);
const ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INSTALLATION = /^\d{1,20}$/;

/** The path to redirect to, or undefined when `next` is not an allowed return target. */
export function sanitizeReturnTarget(next: unknown): string | undefined {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return undefined;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return undefined;
  let u: URL;
  try {
    u = new URL(next, "http://turntable.invalid");
  } catch {
    return undefined;
  }
  if (u.origin !== "http://turntable.invalid" || u.hash !== "") return undefined;
  if (u.pathname !== "/onboarding") return undefined;
  const out = new URLSearchParams();
  const seen = new Set<string>();
  for (const [k, v] of u.searchParams) {
    if (seen.has(k)) return undefined;
    seen.add(k);
    const ok =
      (k === "step" && STEPS.has(v)) ||
      (k === "org" && ORG.test(v)) ||
      (k === "installation" && INSTALLATION.test(v));
    if (!ok) return undefined;
    out.set(k, v);
  }
  const qs = out.toString();
  return qs ? `/onboarding?${qs}` : "/onboarding";
}
