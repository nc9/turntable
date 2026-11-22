import { afterAll, describe, expect, test } from "bun:test";
import {
  RequestTimeoutError,
  ResponseTooLargeError,
  SsrfError,
  TooManyRedirectsError,
  allowHostsFromEnv,
  blockedReason,
  createHttpClient,
  readCapped,
} from "../src/index";

describe("address classification", () => {
  test.each([
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.0.9",
    "169.254.169.254",
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.0.2.5",
    "198.18.0.1",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "::127.0.0.1",
  ])("%s is refused", (ip) => {
    expect(blockedReason(ip)).toBeString();
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.255.255",
    "169.255.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])("%s is public", (ip) => {
    expect(blockedReason(ip)).toBeUndefined();
  });

  test("garbage is refused, not treated as public", () => {
    for (const s of [
      "",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "fe80::1%eth0",
      "::g",
      "1::2::3",
      "example.com",
    ]) {
      expect(blockedReason(s)).toBeString();
    }
  });
});

// A local server that does what hostile servers do.
const server: Bun.Server<undefined> = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const port = server.port;
    switch (u.pathname) {
      case "/ok":
        return new Response("hello");
      case "/echo":
        return Response.json({
          method: req.method,
          host: req.headers.get("host"),
          ua: req.headers.get("user-agent"),
          auth: req.headers.get("authorization"),
          enc: req.headers.get("accept-encoding"),
          body: await req.text(),
        });
      case "/redir":
        return new Response(null, { status: 302, headers: { location: "/ok" } });
      case "/loop":
        return new Response(null, { status: 302, headers: { location: "/loop" } });
      case "/to-metadata":
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      case "/to-loopback":
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${port}/ok` },
        });
      case "/to-https-metadata":
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/" },
        });
      case "/to-b":
        return new Response(null, {
          status: 302,
          headers: { location: `http://b.test:${port}/echo` },
        });
      case "/to-same":
        return new Response(null, { status: 302, headers: { location: `/echo` } });
      case "/see-other":
        return new Response(null, { status: 303, headers: { location: "/echo" } });
      case "/temporary":
        return new Response(null, { status: 307, headers: { location: "/echo" } });
      case "/big": {
        return new Response("x".repeat(2000));
      }
      case "/stream-big": {
        const enc = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 30; i += 1) c.enqueue(enc.encode("y".repeat(100)));
              c.close();
            },
          }),
        );
      }
      case "/slow":
        await Bun.sleep(600);
        return new Response("late");
      case "/nobody":
        return new Response(null, { status: 204 });
      case "/missing":
        return new Response("nope", { status: 404 });
    }
    return new Response("?", { status: 400 });
  },
});
afterAll(() => void server.stop(true));
const origin = `http://a.test:${server.port}`;

/** Names map to the loopback test server; both are allowlisted, so http is allowed. */
function client(
  extra: { allow?: string[]; resolve?: (h: string) => string[]; maxRedirects?: number } = {},
) {
  const calls: string[] = [];
  const c = createHttpClient({
    allowHosts: extra.allow ?? ["a.test", "b.test"],
    resolve: async (h) => {
      calls.push(h);
      return extra.resolve ? extra.resolve(h) : ["127.0.0.1"];
    },
    ...(extra.maxRedirects !== undefined ? { maxRedirects: extra.maxRedirects } : {}),
  });
  return { ...c, calls };
}

describe("refusing what the control plane must never contact", () => {
  const c = createHttpClient({ resolve: async () => ["10.0.0.5"] });
  test.each([
    ["http://127.0.0.1:1/", "https only"],
    ["https://127.0.0.1/", "loopback"],
    ["https://[::1]/", "loopback"],
    ["https://169.254.169.254/latest/meta-data/", "link-local"],
    ["https://[::ffff:169.254.169.254]/", "ipv4-mapped"],
    ["https://100.64.0.1/", "carrier-grade"],
    ["https://192.168.1.1/", "private"],
    ["https://localhost/", "localhost"],
    ["https://anything.localhost/", "localhost"],
    ["https://2130706433/", "loopback"], // decimal 127.0.0.1, normalised by the URL parser
    ["https://0x7f.1/", "loopback"],
    ["https://user:pw@example.com/", "credentials"],
    ["http://example.com/", "https only"],
    ["ftp://example.com/", "https only"],
    ["https://internal.example.com/", "private"], // resolves to 10.0.0.5
  ])("%s", async (url, why) => {
    const err = await c.fetch(url).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfError);
    expect(err.reason.toLowerCase()).toContain(why.split(" ")[0] as string);
  });

  test("one private record among public ones is still refused (mixed answers)", async () => {
    const mixed = createHttpClient({ resolve: async () => ["8.8.8.8", "169.254.169.254"] });
    expect(await mixed.fetch("https://rebinder.example/").catch((e) => e)).toBeInstanceOf(
      SsrfError,
    );
  });

  test("a name that does not resolve is refused", async () => {
    const none = createHttpClient({ resolve: async () => [] });
    expect(await none.fetch("https://nothing.example/").catch((e) => e)).toBeInstanceOf(SsrfError);
  });

  test("an allowlist entry opens exactly that host", async () => {
    const only = createHttpClient({ allowHosts: ["a.test"], resolve: async () => ["127.0.0.1"] });
    expect((await only.fetch(`${origin}/ok`)).status).toBe(200);
    const err = await only.fetch(`http://c.test:${server.port}/ok`).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfError);
  });

  test("LONGSHORE_NET_ALLOW_HOSTS is parsed", () => {
    expect(
      allowHostsFromEnv({ LONGSHORE_NET_ALLOW_HOSTS: " daytona.internal, 10.1.2.3 ,," }),
    ).toEqual(["daytona.internal", "10.1.2.3"]);
    expect(allowHostsFromEnv({})).toEqual([]);
  });
});

describe("pinning", () => {
  test("DNS is asked once per hop and the connection goes to the validated address", async () => {
    const c = client();
    const res = await c.fetch(`${origin}/echo`);
    expect(((await res.json()) as { host: string }).host).toBe(`a.test:${server.port}`);
    expect(c.calls).toEqual(["a.test"]);
    // a redirect resolves the new hop once more
    await c.fetch(`${origin}/redir`);
    expect(c.calls).toEqual(["a.test", "a.test", "a.test"]);
  });

  test("a name that would resolve elsewhere on a second lookup cannot redirect the connection", async () => {
    let n = 0;
    // First answer: the test server. Any later answer would be the metadata address.
    const c = client({ resolve: () => (n++ === 0 ? ["127.0.0.1"] : ["169.254.169.254"]) });
    const res = await c.fetch(`${origin}/ok`);
    expect(await res.text()).toBe("hello");
    expect(c.calls).toEqual(["a.test"]); // one lookup, so there is no second answer to race
  });
});

describe("redirects", () => {
  test("same-host redirects are followed, hop by hop", async () => {
    expect(await (await client().fetch(`${origin}/redir`)).text()).toBe("hello");
  });

  test("more than 5 redirects fail", async () => {
    const err = await client()
      .fetch(`${origin}/loop`)
      .catch((e) => e);
    expect(err).toBeInstanceOf(TooManyRedirectsError);
    const tight = client({ maxRedirects: 1 });
    expect(await tight.fetch(`${origin}/redir`)).toBeInstanceOf(Response); // one hop is within the limit
  });

  test("a redirect to a refused address is never followed", async () => {
    const c = client({ allow: ["a.test"] });
    for (const path of ["/to-metadata", "/to-https-metadata", "/to-loopback"]) {
      const err = await c.fetch(`${origin}${path}`).catch((e) => e);
      expect(err).toBeInstanceOf(SsrfError);
    }
  });

  test("credentials are dropped when the origin changes, kept when it does not", async () => {
    const c = client();
    const cross = await c.fetch(`${origin}/to-b`, { headers: { authorization: "Bearer secret" } });
    expect(((await cross.json()) as { auth: string | null }).auth).toBeNull();
    const same = await c.fetch(`${origin}/to-same`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(((await same.json()) as { auth: string }).auth).toBe("Bearer secret");
  });

  test("303 turns a POST into a GET, 307 keeps the method and the body", async () => {
    const c = client();
    const see = (await (
      await c.fetch(`${origin}/see-other`, { method: "POST", body: "payload" })
    ).json()) as {
      method: string;
      body: string;
    };
    expect(see).toMatchObject({ method: "GET", body: "" });
    const keep = (await (
      await c.fetch(`${origin}/temporary`, { method: "POST", body: "payload" })
    ).json()) as {
      method: string;
      body: string;
    };
    expect(keep).toMatchObject({ method: "POST", body: "payload" });
  });

  test("redirect: manual and error are honoured", async () => {
    const c = client();
    const manual = await c.fetch(`${origin}/redir`, { redirect: "manual" });
    expect(manual.status).toBe(302);
    expect(manual.headers.get("location")).toBe("/ok");
    expect(await c.fetch(`${origin}/redir`, { redirect: "error" }).catch((e) => e)).toBeInstanceOf(
      TypeError,
    );
  });
});

describe("caps and timeouts", () => {
  test("a response over the cap is refused, declared or streamed", async () => {
    const c = client();
    expect(await c.fetch(`${origin}/big`, { maxBytes: 1000 }).catch((e) => e)).toBeInstanceOf(
      ResponseTooLargeError,
    );
    expect(
      await c.fetch(`${origin}/stream-big`, { maxBytes: 1000 }).catch((e) => e),
    ).toBeInstanceOf(ResponseTooLargeError);
    expect((await (await c.fetch(`${origin}/big`, { maxBytes: 5000 })).text()).length).toBe(2000);
    const small = createHttpClient({
      allowHosts: ["a.test"],
      resolve: async () => ["127.0.0.1"],
      maxBytes: 100,
    });
    expect(await small.fetch(`${origin}/big`).catch((e) => e)).toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  test("the whole exchange has a deadline, and a caller's signal aborts it", async () => {
    const c = client();
    expect(await c.fetch(`${origin}/slow`, { timeoutMs: 100 }).catch((e) => e)).toBeInstanceOf(
      RequestTimeoutError,
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("stop")), 50);
    const err = await c.fetch(`${origin}/slow`, { signal: ac.signal }).catch((e) => e);
    expect((err as Error).message).toBe("stop");
  });
});

describe("it behaves like fetch for ordinary requests", () => {
  test("headers, bodies, statuses and empty responses", async () => {
    const c = client();
    const echo = (await (
      await c.fetch(`${origin}/echo`, {
        method: "POST",
        body: JSON.stringify({ a: 1 }),
        headers: { authorization: "x" },
      })
    ).json()) as Record<string, string>;
    expect(echo).toMatchObject({
      method: "POST",
      ua: "longshore",
      auth: "x",
      enc: "identity",
      body: '{"a":1}',
    });
    const missing = await c.fetch(`${origin}/missing`);
    expect(missing.ok).toBe(false);
    expect(await missing.text()).toBe("nope");
    const none = await c.fetch(`${origin}/nobody`);
    expect(none.status).toBe(204);
    expect((await c.fetch(`${origin}/ok`, { method: "HEAD" })).status).toBe(200);
    const viaRequest = await c.fetch(new Request(`${origin}/ok`));
    expect(await viaRequest.text()).toBe("hello");
  });
});

describe("readCapped", () => {
  const stream = (n: number, chunk = 10): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        for (let i = 0; i < n; i += 1) c.enqueue(new Uint8Array(chunk));
        c.close();
      },
    });
  test("within the cap, over it, declared length, and no body", async () => {
    expect((await readCapped(stream(3), 100)) as Uint8Array).toHaveLength(30);
    expect(await readCapped(stream(20), 100)).toBe("too-large");
    expect(await readCapped(stream(1), 100, 1000)).toBe("too-large");
    expect(await readCapped(null, 100)).toHaveLength(0);
  });
});

describe("request bodies", () => {
  test("FormData keeps its multipart boundary and length; the server can decode it", async () => {
    const srv: Bun.Server<undefined> = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const form = await req.formData();
        const file = form.get("file") as File;
        return Response.json({
          name: file.name,
          text: await file.text(),
          len: req.headers.get("content-length"),
        });
      },
    });
    try {
      const c = createHttpClient({ allowHosts: ["127.0.0.1"] });
      const fd = new FormData();
      fd.set("file", new File(["payload"], "a.txt"));
      const res = await c.fetch(`http://127.0.0.1:${srv.port}/`, { method: "POST", body: fd });
      const j = (await res.json()) as { name: string; text: string; len: string };
      expect(j).toMatchObject({ name: "a.txt", text: "payload" });
      expect(Number(j.len)).toBeGreaterThan(7);
    } finally {
      await srv.stop(true);
    }
  });

  test("URLSearchParams gets its content type", async () => {
    const c = client();
    const echo = await c.fetch(`${origin}/echo`, {
      method: "POST",
      body: new URLSearchParams({ a: "1" }),
    });
    expect(((await echo.json()) as { body: string }).body).toBe("a=1");
  });
});
