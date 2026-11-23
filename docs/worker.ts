/**
 * Serves the Turntable docs at https://turntableci.com/docs.
 *
 * WHY A SCRIPT AT ALL (an assets-only Worker cannot strip the prefix):
 * `tangly build --base /docs` prefixes every *link* with /docs but does NOT
 * nest the output: pages still land at `dist/quickstart/index.html`, not
 * `dist/docs/quickstart/index.html` (verified against tangly 0.6.0, which does prefix the .md twins and llms-full.txt itself). The
 * assets binding keys on the request path, so an incoming /docs/quickstart
 * would miss. This worker strips the prefix before handing over, and puts it
 * back on anything the assets binding redirects to: that binding knows
 * nothing about the base, so its own Location headers escape the subpath.
 *
 * `run_worker_first = true` in wrangler.toml means every request lands here
 * first; `not_found_handling` then only governs `env.ASSETS.fetch()`, which
 * is what serves dist/404.html.
 */

const BASE = "/docs";

/** Old URLs mapped to their home in the docs site (post-prefix-strip, no trailing slash). None yet. */
const PRESERVED: Record<string, string> = {};

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

/**
 * Put BASE back on a same-origin Location. Returns null for anything that would leave this origin
 * (absolute, protocol-relative `//host`, or unparsable): the docs never redirect off-site, so such
 * a Location is refused rather than passed through (an open redirect otherwise).
 */
const rebaseLocation = (location: string, origin: string): string | null => {
  if (location.startsWith("//") || location.startsWith("\\")) return null;
  let target: URL;
  try {
    target = new URL(location, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin) return null;
  if (target.pathname === BASE || target.pathname.startsWith(`${BASE}/`)) {
    return location;
  }
  return `${BASE}${target.pathname}${target.search}${target.hash}`;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The route patterns only send us /docs and /docs/*, but a worker that
    // assumes its own route is a worker that breaks when the route moves.
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) {
      return env.ASSETS.fetch(request);
    }

    // Collapse leading slashes: `/docs//evil.example` must not become a protocol-relative path that
    // the assets binding could echo back in a Location header.
    const inner = `/${url.pathname.slice(BASE.length).replace(/^[/\\]+/, "")}`;
    // Tangly canonicals carry no trailing slash. Normalise here rather than
    // letting `html_handling` do it, so the redirect keeps the prefix.
    const canonical = inner.length > 1 ? inner.replace(/\/+$/, "") || "/" : inner;

    const preserved = PRESERVED[canonical];
    if (preserved) {
      return Response.redirect(`${url.origin}${BASE}${preserved}${url.search}`, 301);
    }

    if (canonical !== inner) {
      return Response.redirect(`${url.origin}${BASE}${canonical}${url.search}`, 308);
    }

    const target = new URL(url);
    target.pathname = canonical;
    const response = await env.ASSETS.fetch(new Request(target, request));

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const rebased = rebaseLocation(location, url.origin);
        if (rebased === null) return new Response("Not Found", { status: 404 });
        if (rebased !== location) {
          const headers = new Headers(response.headers);
          headers.set("location", rebased);
          return new Response(response.body, {
            headers,
            status: response.status,
            statusText: response.statusText,
          });
        }
      }
    }

    return response;
  },
};
