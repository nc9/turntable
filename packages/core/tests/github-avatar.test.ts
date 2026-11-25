// Avatar URLs (#559): only GitHub's avatar origin is ever stored, so what the UI renders as an
// image source is held to the one origin its CSP allows.
import { expect, test } from "bun:test";
import { completeSignIn, createOrg, openDatabase, schema, upsertInstallation } from "../src/db";
import { githubFacts } from "../src/github/api";
import { AVATAR_ORIGIN, sanitizeAvatarUrl } from "../src/github/avatar";
import { eq } from "drizzle-orm";

test("sanitizeAvatarUrl keeps GitHub avatar URLs and drops everything else", () => {
  expect(sanitizeAvatarUrl(`${AVATAR_ORIGIN}/u/583231?v=4`)).toBe(`${AVATAR_ORIGIN}/u/583231?v=4`);
  for (const bad of [
    "http://avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com.evil.example/u/1",
    "https://evil.example/avatars.githubusercontent.com/u/1",
    "https://user:pw@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com/u/1#frag",
    "https://avatars.githubusercontent.com/<script>",
    "https://github.com/octocat.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "",
    null,
    undefined,
    42,
  ]) {
    expect(sanitizeAvatarUrl(bad)).toBeNull();
  }
  expect(sanitizeAvatarUrl(`${AVATAR_ORIGIN}/u/${"1".repeat(400)}`)).toBeNull();
});

test("sign-in stores and refreshes the avatar; a later sign-in without one keeps it", async () => {
  const db = openDatabase(":memory:");
  try {
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    const base = {
      githubUserId: "77",
      login: "pat",
      now: 1000,
      sessionHash: "h1",
      absoluteMs: 10_000,
      allowNoMembership: true,
    };
    void org;
    await completeSignIn(db, { ...base, avatarUrl: `${AVATAR_ORIGIN}/u/77?v=1` });
    const read = async () =>
      (
        await db.run((h) =>
          h.orm
            .select()
            .from(schema.githubIdentities)
            .where(eq(schema.githubIdentities.githubUserId, "77")),
        )
      )[0]!;
    expect(await read()).toMatchObject({
      avatarUrl: `${AVATAR_ORIGIN}/u/77?v=1`,
      avatarSyncedAt: 1000,
    });
    await completeSignIn(db, {
      ...base,
      now: 2000,
      sessionHash: "h2",
      avatarUrl: `${AVATAR_ORIGIN}/u/77?v=2`,
    });
    expect(await read()).toMatchObject({
      avatarUrl: `${AVATAR_ORIGIN}/u/77?v=2`,
      avatarSyncedAt: 2000,
    });
    await completeSignIn(db, { ...base, now: 3000, sessionHash: "h3" });
    expect(await read()).toMatchObject({
      avatarUrl: `${AVATAR_ORIGIN}/u/77?v=2`,
      avatarSyncedAt: 2000,
    });
  } finally {
    db.close();
  }
});

test("installation sync stores the account avatar and a refresh replaces it", async () => {
  const db = openDatabase(":memory:");
  try {
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    const input = {
      installationId: "5",
      appId: "1",
      accountLogin: "acme",
      accountId: "9",
      accountType: "Organization",
      repositorySelection: "all",
      status: "active" as const,
    };
    const a = await upsertInstallation(
      db,
      { orgId: org.id },
      { ...input, avatarUrl: `${AVATAR_ORIGIN}/u/9?v=1` },
    );
    expect(a.avatarUrl).toBe(`${AVATAR_ORIGIN}/u/9?v=1`);
    expect(a.avatarSyncedAt).not.toBeNull();
    const b = await upsertInstallation(
      db,
      { orgId: org.id },
      { ...input, avatarUrl: `${AVATAR_ORIGIN}/u/9?v=2` },
    );
    expect(b.avatarUrl).toBe(`${AVATAR_ORIGIN}/u/9?v=2`);
    const c = await upsertInstallation(db, { orgId: org.id }, input);
    expect(c.avatarUrl).toBe(`${AVATAR_ORIGIN}/u/9?v=2`);
  } finally {
    db.close();
  }
});

test("the GitHub facts reader drops an avatar URL from any other origin", async () => {
  const reply = (avatar: unknown) =>
    githubFacts(
      {
        apiBase: "https://api.example.test",
        appJwt: async () => "jwt",
        mint: async () => ({ token: "t" }),
      } as never,
      (async () =>
        new Response(
          JSON.stringify({
            id: 1,
            app_id: 2,
            account: { login: "acme", id: 3, type: "Organization", avatar_url: avatar },
            repository_selection: "all",
            suspended_at: null,
          }),
        )) as never,
    ).getInstallation("1");
  expect((await reply(`${AVATAR_ORIGIN}/u/3?v=4`))?.account.avatarUrl).toBe(
    `${AVATAR_ORIGIN}/u/3?v=4`,
  );
  expect((await reply("https://evil.example/x.png"))?.account.avatarUrl).toBeUndefined();
});
