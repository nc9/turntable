// The login lookup asks GitHub's public user endpoint with no credentials: an App JWT is accepted
// only on /app endpoints, so sending one made every invite and enrolment fail on a live instance.
import { expect, test } from "bun:test";
import { GithubLookupError, githubUserLookup } from "../src/github/api";

type Seen = { url: string; headers: Record<string, string> };

function fakeFetch(respond: (url: string) => Response, seen: Seen[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({ url, headers });
    return respond(url);
  };
}

const auth = { apiBase: "https://api.github.test" };

test("asks the public user endpoint with no authorization header", async () => {
  const seen: Seen[] = [];
  const lookup = githubUserLookup(
    auth,
    fakeFetch(() => Response.json({ id: 4242, login: "Octo-Cat" }), seen),
  );
  expect(await lookup.idOfLogin("octo-cat")).toBe("4242");
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://api.github.test/users/octo-cat");
  expect(seen[0]?.headers.authorization).toBeUndefined();
});

test("a 404 is no such user; an answer for another login is refused", async () => {
  const seen: Seen[] = [];
  const missing = githubUserLookup(
    auth,
    fakeFetch(() => new Response("", { status: 404 }), seen),
  );
  expect(await missing.idOfLogin("nobody")).toBeUndefined();
  const other = githubUserLookup(
    auth,
    fakeFetch(() => Response.json({ id: 7, login: "someone-else" }), seen),
  );
  expect(await other.idOfLogin("octo-cat")).toBeUndefined();
});

test("a malformed login is never sent", async () => {
  const seen: Seen[] = [];
  const lookup = githubUserLookup(
    auth,
    fakeFetch(() => Response.json({}), seen),
  );
  expect(await lookup.idOfLogin("../app")).toBeUndefined();
  expect(seen).toHaveLength(0);
});

test("a spent rate limit says when to retry", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const lookup = githubUserLookup(
    auth,
    fakeFetch(
      () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        }),
      [],
    ),
  );
  const err = await lookup.idOfLogin("octo-cat").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GithubLookupError);
  expect((err as Error).message).toContain(new Date(reset * 1000).toISOString());
});

test("another failure names only the status; a network failure is classified", async () => {
  const failing = githubUserLookup(
    auth,
    fakeFetch(() => new Response("x", { status: 502 }), []),
  );
  const e1 = await failing.idOfLogin("octo-cat").catch((e: unknown) => e);
  expect(e1).toBeInstanceOf(GithubLookupError);
  expect((e1 as Error).message).toBe("GitHub answered HTTP 502");
  const down = githubUserLookup(auth, async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.1:443");
  });
  const e2 = await down.idOfLogin("octo-cat").catch((e: unknown) => e);
  expect(e2).toBeInstanceOf(GithubLookupError);
  expect((e2 as Error).message).toBe("GitHub could not be reached");
});
