// A git smart-HTTP v2 server for tests: `git upload-pack --stateless-rpc` behind Bun.serve, over a
// real repository on disk. This is only for tests (they have git); the code under test needs none.
import { createHttpClient, type SafeFetch } from "@turntable/net";

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>/<name>.git`, for any `name`: every path serves the repository. */
  url: string;
  /** A client that may reach the loopback test server (the guard refuses it otherwise). */
  fetch: SafeFetch;
  requests: { method: string; path: string; body: Uint8Array }[];
  stop(): void;
}

const run = async (
  repo: string,
  extra: string[],
  input?: Uint8Array,
): Promise<{ out: Uint8Array; code: number }> => {
  const p = Bun.spawn(
    [
      "git",
      "-c",
      "uploadpack.allowAnySHA1InWant=true",
      "upload-pack",
      "--stateless-rpc",
      ...extra,
      repo,
    ],
    {
      stdin: input ? new Blob([input]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", GIT_PROTOCOL: "version=2" },
    },
  );
  const [out, code] = await Promise.all([new Response(p.stdout).bytes(), p.exited]);
  return { out, code };
};

export interface GitHttpOptions {
  /** `GET <prefix>/info/refs` answers 301 to the repository's real path (a repository that moved). */
  movedFrom?: string;
  /** `POST .../git-upload-pack` answers 307 to the same path. */
  postRedirect?: boolean;
  /** A location `GET .../info/refs` redirects to instead (another origin, say). */
  redirectTo?: string;
}

export function serveGitRepo(repo: string, opts: GitHttpOptions = {}): GitHttpServer {
  const requests: GitHttpServer["requests"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      requests.push({ method: req.method, path: u.pathname, body });
      if (opts.redirectTo && req.method === "GET" && u.pathname.endsWith("/info/refs"))
        return new Response(null, { status: 302, headers: { location: opts.redirectTo } });
      if (opts.movedFrom && req.method === "GET" && u.pathname === `${opts.movedFrom}/info/refs`)
        return new Response(null, {
          status: 301,
          headers: { location: `/acme/web.git/info/refs?service=git-upload-pack` },
        });
      if (opts.postRedirect && req.method === "POST")
        return new Response(null, { status: 307, headers: { location: u.pathname } });
      if (req.method === "GET" && u.pathname.endsWith("/info/refs")) {
        const { out } = await run(repo, ["--advertise-refs"]);
        return new Response(out, {
          headers: { "content-type": "application/x-git-upload-pack-advertisement" },
        });
      }
      if (req.method === "POST" && u.pathname.endsWith("/git-upload-pack")) {
        const { out } = await run(repo, [], body);
        return new Response(out, {
          headers: { "content-type": "application/x-git-upload-pack-result" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/acme/web.git`,
    fetch: createHttpClient({ allowHosts: ["127.0.0.1"] }).fetch,
    requests,
    stop: () => void server.stop(true),
  };
}

/** The program that runs a checkout in a test: bun running this repository's entry file. */
export const CHECKOUT_COMMAND = [
  process.execPath,
  new URL("../src/main.ts", import.meta.url).pathname,
];
