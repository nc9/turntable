// `turntable approvals approve-release` (#483): the offline-key flow for a release approval,
// against a fake server that issues a real v2 statement and verifies the signature it gets back.
import { describe, expect, test } from "bun:test";
import { generateEd25519, verifyEd25519 } from "../src/approvals/keys";
import {
  approveReleaseRemote,
  challengeProblem,
  manifestSummary,
  RELEASE_REQUIRES_V2_MESSAGE,
  refusalText,
  releaseSignPreview,
  type ReleaseChallengeWire,
} from "../src/approvals/release-cli";
import { canonicalStatement, RELEASE_STATEMENT_TYPE } from "../src/approvals/statement";
import { manifestSha256, type ManifestArtifact } from "../src/release/manifest";

const artifacts: ManifestArtifact[] = [
  { name: "turntable-linux-x64", sha256: "b".repeat(64), size: 85_000_000 },
  { name: "SHA256SUMS", sha256: "a".repeat(64), size: 412 },
];

function issue(over: { manifest?: string; arts?: ManifestArtifact[] } = {}): ReleaseChallengeWire {
  const statement = {
    type: RELEASE_STATEMENT_TYPE,
    org: "acme",
    project: "web",
    run_id: "run1",
    head_sha: "c".repeat(40),
    workflow_hash: "ab".repeat(32),
    environment: "release",
    manifest_sha256: over.manifest ?? manifestSha256(artifacts),
    approver: "ap1",
    expires_at: Date.now() + 600_000,
    nonce: "n".repeat(24),
  };
  return {
    statement,
    canonical: canonicalStatement(statement as never),
    manifest_sha256: statement.manifest_sha256,
    artifacts: over.arts ?? artifacts,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Seen = { path: string; auth: string | null; body: any };

function fakeServer(challenge: ReleaseChallengeWire, publicSpki: string) {
  const seen: Seen[] = [];
  const fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init.body));
    const auth = new Headers(init.headers).get("authorization");
    seen.push({ path: url.pathname, auth, body });
    if (url.pathname === "/api/v1/approvals/release-challenge") return json(challenge);
    if (url.pathname === "/api/v1/approvals/release") {
      const ok = verifyEd25519(publicSpki, challenge.canonical, body.signature.signature);
      if (!ok)
        return json({ error: { code: "unauthenticated", message: "signature not accepted" } }, 401);
      return json({
        run_id: "run1",
        environment: "release",
        approvals: 1,
        required: 2,
        released_jobs: 0,
        state: "queued",
        manifest_sha256: body.statement.manifest_sha256,
      });
    }
    return json({ error: { code: "not_found", message: "no" } }, 404);
  }) as never;
  return { seen, fetch };
}

const base = (k: ReturnType<typeof generateEd25519>) => ({
  baseUrl: new URL("https://ci.example.com"),
  org: "acme",
  project: "web",
  runId: "run1",
  approver: "ap1",
  privatePem: k.privatePem,
  token: "tt_operator",
});

describe("approve-release round trip", () => {
  test("fetches the v2 challenge, prints the manifest, signs the statement, submits without a token", async () => {
    const k = generateEd25519();
    const c = issue();
    const srv = fakeServer(c, k.publicSpki);
    const printed: string[] = [];
    const out = await approveReleaseRemote({
      ...base(k),
      print: (t) => printed.push(t),
      confirm: async () => true,
      fetch: srv.fetch,
    });
    expect(out).toMatchObject({ approvals: 1, required: 2, manifest_sha256: c.manifest_sha256 });
    // the challenge call carries the token; the approval carries only the signature
    expect(srv.seen.map((s) => [s.path, s.auth])).toEqual([
      ["/api/v1/approvals/release-challenge", "Bearer tt_operator"],
      ["/api/v1/approvals/release", null],
    ]);
    expect(srv.seen[0]!.body).toEqual({
      run_id: "run1",
      approver: "ap1",
      org: "acme",
      project: "web",
    });
    // the signature verifies against the canonical v2 statement that was submitted
    const sent = srv.seen[1]!.body;
    expect(sent.statement.type).toBe(RELEASE_STATEMENT_TYPE);
    expect(
      verifyEd25519(k.publicSpki, canonicalStatement(sent.statement), sent.signature.signature),
    ).toBe(true);
    // the manifest was printed first: each artifact, its sha256 and the digest
    const text = printed.join("\n");
    for (const a of artifacts) {
      expect(text).toContain(a.name);
      expect(text).toContain(a.sha256);
      expect(text).toContain(`${a.size} bytes`);
    }
    expect(text).toContain(c.manifest_sha256);
    expect(text.indexOf("SHA256SUMS")).toBeLessThan(text.indexOf("turntable-linux-x64"));
  });

  test("a declined confirmation signs and submits nothing", async () => {
    const k = generateEd25519();
    const srv = fakeServer(issue(), k.publicSpki);
    await expect(
      approveReleaseRemote({
        ...base(k),
        print: () => {},
        confirm: async () => false,
        fetch: srv.fetch,
      }),
    ).rejects.toThrow("nothing was signed");
    expect(srv.seen.map((s) => s.path)).toEqual(["/api/v1/approvals/release-challenge"]);
  });

  test("artifacts that do not hash to the statement's digest are never signed", async () => {
    const k = generateEd25519();
    const lying = issue({ arts: [{ ...artifacts[0]!, size: 1 }, artifacts[1]!] });
    const srv = fakeServer(lying, k.publicSpki);
    await expect(
      approveReleaseRemote({
        ...base(k),
        print: () => {},
        confirm: async () => true,
        fetch: srv.fetch,
      }),
    ).rejects.toThrow("do not hash to the manifest digest");
    expect(srv.seen).toHaveLength(1);
  });

  test("a v1 refusal for a release shows the clear message", async () => {
    const k = generateEd25519();
    const fetch = (async () =>
      json(
        {
          error: {
            code: "conflict",
            message: "release_requires_v2: release is this project's release environment",
          },
        },
        409,
      )) as never;
    await expect(
      approveReleaseRemote({ ...base(k), print: () => {}, confirm: async () => true, fetch }),
    ).rejects.toThrow(RELEASE_REQUIRES_V2_MESSAGE);
    expect(RELEASE_REQUIRES_V2_MESSAGE).toContain("update the client");
    expect(refusalText("another refusal")).toBe("another refusal");
  });
});

describe("checks before signing", () => {
  test("challengeProblem accepts a consistent challenge and names each inconsistency", () => {
    const want = { runId: "run1", approver: "ap1" };
    expect(challengeProblem(issue(), want)).toBeNull();
    expect(challengeProblem(issue(), { ...want, runId: "run2" })).toContain("another run");
    expect(challengeProblem(issue(), { ...want, approver: "ap2" })).toContain("another approver");
    expect(challengeProblem({ ...issue(), canonical: "{}" }, want)).toContain("canonical");
    expect(challengeProblem({ ...issue(), statement: { type: "x" } }, want)).toContain("not a");
    expect(challengeProblem(issue({ arts: [] }), want)).toContain("not valid");
  });

  test("approvals sign previews and checks a release challenge's manifest", () => {
    const c = issue();
    const preview = releaseSignPreview(c)!;
    expect(preview).toContain(c.manifest_sha256);
    expect(preview).toContain("SHA256SUMS");
    expect(releaseSignPreview({ canonical: '{"x":1}' })).toBeNull();
    expect(() => releaseSignPreview(issue({ arts: [{ ...artifacts[1]!, size: 5 }] }))).toThrow(
      "nothing was signed",
    );
  });

  test("manifestSummary lists artifacts in manifest order with the digest last", () => {
    const s = manifestSummary(artifacts, "d".repeat(64));
    expect(s.indexOf("SHA256SUMS")).toBeLessThan(s.indexOf("turntable-linux-x64"));
    expect(s.trimEnd().endsWith("d".repeat(64))).toBe(true);
  });
});
