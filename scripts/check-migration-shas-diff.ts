// A shipped migration is immutable: its recorded hash in migration-shas.json must never change, or
// every database that applied it refuses to boot. This compares the file between a pull request's
// base and HEAD and fails when an EXISTING entry changes or is removed, unless the same tag is
// also newly named in EDITED_IN_PLACE (migration-sha.ts) in the same diff, with its reason.
// Appending entries (a new migration) is always fine.
//
//   bun run scripts/check-migration-shas-diff.ts --base origin/main
//   bun run scripts/check-migration-shas-diff.ts --base origin/main --base-repo owner/name --base-sha <sha>
//
// The base content comes from git (`git show <base>:<path>`); when that ref is not in this checkout
// (a runner that fetched only the one commit), `--base-repo` and `--base-sha` fetch it from
// raw.githubusercontent.com instead. A base that does not have the file yet has nothing to protect.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type SafeFetch, safeFetch } from "../packages/net/src/index";

export const SHAS_PATH = "packages/core/src/db/migration-shas.json";
export const EDITED_PATH = "packages/core/src/db/migration-sha.ts";

type Shas = Record<string, Record<string, string>>;

/** The per-dialect `tag -> sha` maps of a golden file (the `//` note and any non-map key ignored). */
export function parseShas(text: string): Shas {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const out: Shas = {};
  for (const [dialect, v] of Object.entries(raw)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    out[dialect] = Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  }
  return out;
}

/** The tags named as keys of the EDITED_IN_PLACE object in migration-sha.ts. */
export function editedTags(source: string): Set<string> {
  const start = source.search(/EDITED_IN_PLACE[^=]*=\s*\{/);
  if (start < 0) return new Set();
  // The object ends at the first line that is just `};`.
  const body = source.slice(start).split(/\n\};?\s*\n/, 1)[0] ?? "";
  return new Set(
    [...body.matchAll(/^\s{2}"(\d{4}_[A-Za-z0-9_]+)":\s*\{/gm)].map((m) => m[1] as string),
  );
}

/**
 * What is wrong between a base and a head: an existing entry changed or removed without its tag
 * being newly named in EDITED_IN_PLACE. `baseEdited` and `headEdited` are the tags named there.
 */
export function diffProblems(
  base: Shas,
  head: Shas,
  baseEdited: ReadonlySet<string>,
  headEdited: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const excused = (tag: string): boolean => headEdited.has(tag) && !baseEdited.has(tag);
  for (const [dialect, entries] of Object.entries(base)) {
    for (const [tag, sha] of Object.entries(entries)) {
      const now = head[dialect]?.[tag];
      if (now === sha || excused(tag)) continue;
      problems.push(
        now === undefined
          ? `${dialect} ${tag}: the entry was removed`
          : `${dialect} ${tag}: the hash changed (${sha.slice(0, 12)} -> ${now.slice(0, 12)})`,
      );
    }
  }
  return problems;
}

async function baseText(
  repo: string,
  base: string,
  path: string,
  fetchFn: SafeFetch,
  remote?: { repo: string; sha: string },
): Promise<string | null> {
  const git = Bun.spawnSync(["git", "show", `${base}:${path}`], { cwd: repo });
  if (git.exitCode === 0) return git.stdout.toString();
  if (remote) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote.repo) || remote.repo.includes(".."))
      throw new Error("--base-repo must be owner/name");
    if (!/^[0-9a-f]{40}$/.test(remote.sha))
      throw new Error("--base-sha must be a 40-character sha");
    const res = await fetchFn(
      `https://raw.githubusercontent.com/${remote.repo}/${remote.sha}/${path}`,
    );
    if (res.status === 404) return null; // the base does not have the file
    if (!res.ok) throw new Error(`base ${path}: HTTP ${res.status}`);
    return await res.text();
  }
  // `git show` failed: the path is not in that ref (fine) or the ref is not here (an error).
  const known = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
    cwd: repo,
  });
  if (known.exitCode !== 0) throw new Error(`the base ${base} is not in this checkout`);
  return null;
}

/** Checks the working tree of `repo` against `base`; returns the problems. */
export async function checkRepo(o: {
  repo: string;
  base: string;
  remote?: { repo: string; sha: string };
  fetchFn?: SafeFetch;
}): Promise<{ problems: string[]; skipped: boolean }> {
  const f = o.fetchFn ?? safeFetch;
  const baseShas = await baseText(o.repo, o.base, SHAS_PATH, f, o.remote);
  if (baseShas === null) return { problems: [], skipped: true };
  const baseSrc = (await baseText(o.repo, o.base, EDITED_PATH, f, o.remote)) ?? "";
  const headShas = parseShas(readFileSync(join(o.repo, SHAS_PATH), "utf8"));
  let headSrc = "";
  try {
    headSrc = readFileSync(join(o.repo, EDITED_PATH), "utf8");
  } catch {
    // no list yet: nothing is excused
  }
  return {
    problems: diffProblems(parseShas(baseShas), headShas, editedTags(baseSrc), editedTags(headSrc)),
    skipped: false,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      repo: { type: "string", default: process.cwd() },
      "base-repo": { type: "string" },
      "base-sha": { type: "string" },
    },
  });
  if (!values.base)
    throw new Error(
      "usage: check-migration-shas-diff.ts --base <ref> [--base-repo owner/name --base-sha <sha>]",
    );
  const remote =
    values["base-repo"] && values["base-sha"]
      ? { repo: values["base-repo"], sha: values["base-sha"] }
      : undefined;
  const r = await checkRepo({
    repo: values.repo!,
    base: values.base,
    ...(remote ? { remote } : {}),
  });
  if (r.skipped) {
    console.log(`${SHAS_PATH} is not in the base: nothing to compare`);
  } else if (r.problems.length === 0) {
    console.log("migration hashes: only appends, or edits named in EDITED_IN_PLACE");
  } else {
    for (const p of r.problems) console.error(`error: ${p}`);
    console.error(
      `\nA shipped migration is immutable: a changed hash refuses boot on every database that applied it. ` +
        `Restore the SQL and put the change in a new migration. If a migration really must be edited in place, ` +
        `name its tag, the earlier hashes and a reason in EDITED_IN_PLACE (${EDITED_PATH}) in the same PR.`,
    );
    process.exit(1);
  }
}
