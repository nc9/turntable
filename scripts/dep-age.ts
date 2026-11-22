// Dependency minimum-age rule: a registry package version that is new in bun.lock (compared with
// the base branch's lockfile) must have been published at least MIN_AGE_DAYS ago. Young versions
// are the window in which a hijacked release is most likely to be live and least likely to have
// been caught. Exceptions go in .github/dep-age-allowlist.json with a reason.
//
//   bun run scripts/dep-age.ts --base <path to the base bun.lock, or "none"> [--lock bun.lock]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseLock, registryPackages } from "./lockfile";

export const MIN_AGE_DAYS = 14;
const DAY_MS = 86_400_000;

export type AllowEntry = { name: string; version: string; reason: string; expires?: string };
export type Finding = { id: string; reason: string };

/** `name@version` strings present in `head` and absent from `base`. */
export function addedPackages(baseText: string | null, headText: string): string[] {
  const head = registryPackages(parseLock(headText));
  const base = baseText === null ? new Set<string>() : registryPackages(parseLock(baseText));
  return [...head].filter((id) => !base.has(id)).toSorted();
}

export function parseAllowlist(text: string): AllowEntry[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("allowlist must be a JSON array");
  return raw.map((e, i) => {
    const x = e as Partial<AllowEntry>;
    if (!x.name || !x.version || !x.reason?.trim())
      throw new Error(`allowlist entry ${i} needs name, version and a reason`);
    return x as AllowEntry;
  });
}

export type PublishedAt = (name: string, version: string) => Promise<Date | null>;

/** Publish time from the npm registry's packument `time` map. */
export function registryPublishedAt(fetchFn: typeof fetch = fetch): PublishedAt {
  const cache = new Map<string, Promise<Record<string, string>>>();
  return async (name, version) => {
    let p = cache.get(name);
    if (!p) {
      p = (async () => {
        const res = await fetchFn(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`registry returned ${res.status} for ${name}`);
        return ((await res.json()) as { time?: Record<string, string> }).time ?? {};
      })();
      cache.set(name, p);
    }
    const t = (await p)[version];
    return t ? new Date(t) : null;
  };
}

export async function checkAges(o: {
  added: string[];
  allowlist: AllowEntry[];
  publishedAt: PublishedAt;
  now?: Date;
  minDays?: number;
}): Promise<{ failures: Finding[]; allowed: Finding[]; checked: number }> {
  const now = (o.now ?? new Date()).getTime();
  const min = (o.minDays ?? MIN_AGE_DAYS) * DAY_MS;
  const failures: Finding[] = [];
  const allowed: Finding[] = [];
  for (const id of o.added) {
    const at = id.lastIndexOf("@");
    const name = id.slice(0, at);
    const version = id.slice(at + 1);
    const entry = o.allowlist.find((a) => a.name === name && a.version === version);
    const expired = entry?.expires !== undefined && Date.parse(entry.expires) < now;
    const published = await o.publishedAt(name, version);
    if (published === null) {
      // Not on the registry (a git or tarball dependency): no age to check, so a human decides.
      if (entry && !expired) allowed.push({ id, reason: entry.reason });
      else failures.push({ id, reason: "no publish time on the npm registry" });
      continue;
    }
    const age = now - published.getTime();
    if (age >= min) continue;
    const days = Math.floor(age / DAY_MS);
    if (entry && !expired) allowed.push({ id, reason: `${entry.reason} (published ${days}d ago)` });
    else
      failures.push({
        id,
        reason: expired
          ? `allowlist entry expired ${entry!.expires}; published ${days}d ago`
          : `published ${days}d ago, minimum is ${o.minDays ?? MIN_AGE_DAYS}d`,
      });
  }
  return { failures, allowed, checked: o.added.length };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      lock: { type: "string", default: join(root, "bun.lock") },
      allowlist: { type: "string", default: join(root, ".github", "dep-age-allowlist.json") },
    },
  });
  if (!values.base) throw new Error('usage: dep-age.ts --base <base bun.lock path | "none">');
  const baseText =
    values.base === "none" || !existsSync(values.base) ? null : readFileSync(values.base, "utf8");
  const added = addedPackages(baseText, readFileSync(values.lock!, "utf8"));
  const allowlist = existsSync(values.allowlist!)
    ? parseAllowlist(readFileSync(values.allowlist!, "utf8"))
    : [];
  const r = await checkAges({ added, allowlist, publishedAt: registryPublishedAt() });
  console.log(`checked ${r.checked} new package version(s)`);
  for (const a of r.allowed) console.log(`allowed   ${a.id}: ${a.reason}`);
  for (const f of r.failures) console.error(`too new   ${f.id}: ${f.reason}`);
  if (r.failures.length > 0) {
    console.error(
      `\nA new dependency version must be at least ${MIN_AGE_DAYS} days old. Wait, pin an older version, or add an entry with a reason to .github/dep-age-allowlist.json.`,
    );
    process.exit(1);
  }
}
