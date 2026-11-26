// Pure helpers for the org and project switchers. The selection itself lives in the URL
// (`/`, `/<org>`, `/<org>/<project>`); these only order the lists and build the targets.

export type Item = { slug: string; name: string };

/** The remembered item first (when it still exists), the rest in their given order. */
export function withLastFirst<T extends Item>(items: readonly T[], last: string | null): T[] {
  const hit = last === null ? undefined : items.find((i) => i.slug === last);
  return hit ? [hit, ...items.filter((i) => i !== hit)] : [...items];
}

/** The text cmdk filters on: the name and the slug, so either finds the item. */
export const filterValue = (i: Item): string => `${i.name} ${i.slug}`;

/** Where choosing an org (or "All orgs", null) goes. */
export const orgTarget = (org: string | null): string =>
  org === null ? "/" : `/${encodeURIComponent(org)}`;

/** Where choosing a project (or "All projects", null) in an org goes. */
export const projectTarget = (org: string, project: string | null): string =>
  project === null
    ? `/${encodeURIComponent(org)}`
    : `/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;

/**
 * The name to show for a project. Projects added before the short-name change are stored as
 * `owner/name`; a name with exactly one `/` shows without its leading `<segment>/`. Anything else
 * is unchanged. Keep the full stored name in `title` attributes.
 */
export function projectDisplayName(name: string): string {
  const parts = name.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] !== "" ? parts[1]! : name;
}
