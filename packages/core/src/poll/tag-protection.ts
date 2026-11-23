// Is the creation of a tag restricted to administrators? A release run must not depend only on who
// can push a tag: anyone with write access can push one at any merged commit. A tag run is a
// release run straight away only when GitHub reports an active ruleset that fully locks the tags a
// pattern covers (creation, update and deletion, and no force-moves), with nobody able to bypass it
// but organization and repository admins. Anything else, including not being able to read a
// ruleset's bypass list or the rulesets at all, is "not protected".
//
// Reading `bypass_actors` needs the token to have administration read access (the API leaves the
// list out otherwise). Without it every ruleset is unverifiable and every tag run is held.
import type { TagRuleset } from "./github";

/** The built-in repository role id of an admin, in a ruleset's bypass list. */
export const ADMIN_ROLE_ID = 5;

/** The rules a protecting ruleset must have for tags. */
export const REQUIRED_RULES: readonly string[] = [
  "creation",
  "update",
  "deletion",
  "non_fast_forward",
];

/** The literal start of a pattern after `refs/tags/`: all of an exact ref, or what precedes the star. */
export function literalPrefix(pattern: string): string {
  const rest = pattern.slice("refs/tags/".length);
  const star = rest.indexOf("*");
  return star < 0 ? rest : rest.slice(0, star);
}

const SAFE_PREFIX_INCLUDE = /^refs\/tags\/([A-Za-z0-9._\-/]*)\*$/;

/**
 * Whether a ruleset's include entry certainly covers every tag the pattern can match. Deliberately
 * narrow: `~ALL`; the very same string; or `refs/tags/<literal>*` where `<literal>` is a prefix of
 * the pattern's own literal prefix. An include with any other glob feature (`?`, `[`, `{`, `+`,
 * `**`, a star anywhere but the end) is not understood well enough to rely on, so it covers nothing.
 */
export function includeCovers(include: string, pattern: string): boolean {
  if (include === "~ALL") return true;
  if (include === pattern) return true;
  const m = SAFE_PREFIX_INCLUDE.exec(include);
  if (m === null) return false;
  const have = m[1] as string;
  const lit = literalPrefix(pattern);
  // GitHub's `*` does not match `/` (fnmatch with a path separator), so an include `refs/tags/v*`
  // covers `v1` but not `v1/evil`. Our own `*` is the same (see matchesPatterns), so the pattern's
  // literal part may extend the include's only by characters that are not `/`.
  return lit.startsWith(have) && !lit.slice(have.length).includes("/");
}

/**
 * True when some active tag ruleset (a) has all of `REQUIRED_RULES`, (b) covers every tag the
 * pattern can match, (c) excludes nothing, and (d) has a bypass list that was READ and lets only
 * admins bypass it. A ruleset whose bypass list is missing is unverifiable, never protective.
 */
export function patternProtected(
  rulesets: readonly TagRuleset[] | "unknown",
  pattern: string,
): boolean {
  return protectingRulesets(rulesets, pattern).length > 0;
}

/** The rulesets that, each on its own, protect every tag the pattern can match (see `patternProtected`). */
export function protectingRulesets(
  rulesets: readonly TagRuleset[] | "unknown",
  pattern: string,
): TagRuleset[] {
  if (rulesets === "unknown") return [];
  return rulesets.filter(
    (r) =>
      Array.isArray(r.bypass) &&
      REQUIRED_RULES.every((x) => r.rules.includes(x)) &&
      r.exclude.length === 0 &&
      r.include.some((inc) => includeCovers(inc, pattern)) &&
      r.bypass.every(
        (b) =>
          b.type === "OrganizationAdmin" || (b.type === "RepositoryRole" && b.id === ADMIN_ROLE_ID),
      ),
  );
}

/**
 * "ruleset": protected, and the tag was created after protection began. "predates": a ruleset
 * protects the pattern now but the tag may have been created before it did. "none" and "unknown":
 * no protecting ruleset, or the rulesets could not be read.
 */
export type TagProtection = "ruleset" | "predates" | "none" | "unknown";
