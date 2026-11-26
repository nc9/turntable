// The underlying error's name and code, kept next to an attempt's `error_class` (#670) so the
// instance administrator can tell a TypeError from an ECONNRESET without reading raw text. Both
// are short identifiers, never messages: anything outside a plain identifier charset is dropped,
// and the length is capped.

export type ErrorDetail = { name?: string; code?: string };

const IDENT = /^[A-Za-z0-9_.:-]{1,60}$/;

const ident = (v: unknown): string | undefined => {
  const s = typeof v === "number" ? String(v) : v;
  return typeof s === "string" && IDENT.test(s) ? s : undefined;
};

/** Name and code of a thrown value, as safe identifiers. Empty when it has neither. */
export function errorDetailOf(err: unknown): ErrorDetail {
  if (typeof err !== "object" || err === null) return {};
  const o = err as { name?: unknown; code?: unknown };
  const name = ident(o.name);
  const code = ident(o.code);
  return { ...(name ? { name } : {}), ...(code ? { code } : {}) };
}
