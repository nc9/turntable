import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReleaseArtifact, ReleaseStatement } from "../src/api/types";
import { ManifestSection } from "../src/features/runs/release-manifest";
import {
  approvalErrorMessage,
  challengeRequest,
  manifestDigest,
  manifestRows,
  manifestText,
  RELEASE_REQUIRES_V2_MESSAGE,
  releaseEnvironment,
  releaseMismatch,
  submitPath,
} from "../src/lib/release-approval";

const A = "a".repeat(64);
const B = "b".repeat(64);
const artifacts: ReleaseArtifact[] = [
  { name: "turntable-linux-x64", sha256: B, size: 85_000_000 },
  { name: "SHA256SUMS", sha256: A, size: 412 },
];

const shown = {
  runId: "run1",
  headSha: "c".repeat(40),
  workflowHash: "ab".repeat(32),
  environment: "release",
  approver: "ap1",
};
const statementFor = async (over: Partial<ReleaseStatement> = {}): Promise<ReleaseStatement> => ({
  type: "turntable.approve_release.v2",
  org: "acme",
  project: "app",
  run_id: "run1",
  head_sha: "c".repeat(40),
  workflow_hash: "ab".repeat(32),
  environment: "release",
  manifest_sha256: await manifestDigest(artifacts),
  lane_config_version: 2,
  approver: "ap1",
  expires_at: 1,
  nonce: "n".repeat(20),
  ...over,
});

describe("which challenge the page asks for", () => {
  const args = {
    runId: "run1",
    environment: "release",
    approver: "ap1",
    org: "acme",
    project: "app",
  };
  test("a release environment gets the v2 release challenge, others the v1 challenge", () => {
    const rel = challengeRequest({ ...args, release: true });
    expect(rel.op).toBe("release_approval_challenge");
    expect(rel.path).toBe("/approvals/release-challenge");
    expect(rel.body).toEqual({ run_id: "run1", approver: "ap1", org: "acme", project: "app" });
    const v1 = challengeRequest({ ...args, environment: "production", release: false });
    expect(v1.op).toBe("approval_challenge");
    expect(v1.path).toBe("/approvals/challenge");
    expect(v1.body).toMatchObject({ environment: "production" });
    expect(submitPath(true)).toBe("/approvals/release");
    expect(submitPath(false)).toBe("/approvals");
  });

  test("the release environment is the waiting one the server marks", () => {
    const envs = [
      { environment: "production", waiting: true, release: false },
      { environment: "release", waiting: true, release: true },
      { environment: "release-old", waiting: false, release: true },
    ];
    expect(releaseEnvironment(envs)).toBe("release");
    expect(releaseEnvironment(envs, "production")).toBe("release");
    expect(releaseEnvironment(envs.slice(0, 1))).toBeNull();
    expect(releaseEnvironment(envs.slice(2))).toBeNull();
  });
});

describe("the manifest on screen is the manifest signed", () => {
  test("the digest matches the server's encoding (sorted by name, domain line first)", async () => {
    const text = `turntable.release_manifest.v1\n${A} 412 SHA256SUMS\n${B} 85000000 turntable-linux-x64\n`;
    expect(manifestText(artifacts)).toBe(text);
    expect(await manifestDigest(artifacts)).toBe(createHash("sha256").update(text).digest("hex"));
    expect(await manifestDigest([...artifacts].reverse())).toBe(await manifestDigest(artifacts));
  });

  test("a statement whose digest and artifacts agree passes", async () => {
    expect(await releaseMismatch(await statementFor(), artifacts, shown)).toBeNull();
  });

  test("a changed artifact, a wrong digest, a wrong type or another run is refused", async () => {
    const st = await statementFor();
    const tampered = artifacts.map((a, i) => (i === 0 ? { ...a, size: a.size + 1 } : a));
    expect(await releaseMismatch(st, tampered, shown)).toContain(
      "do not match the manifest digest",
    );
    expect(
      await releaseMismatch(
        await statementFor({ manifest_sha256: "0".repeat(64) }),
        artifacts,
        shown,
      ),
    ).toContain("do not match");
    expect(await releaseMismatch(st, [], shown)).toContain("no artifact");
    expect(
      await releaseMismatch(
        { ...st, type: "longshore.approve_environment.v1" } as never,
        artifacts,
        shown,
      ),
    ).toContain("not a release approval");
    expect(await releaseMismatch(st, artifacts, { ...shown, runId: "run2" })).toContain("run");
    expect(await releaseMismatch(st, [{ name: "x", sha256: "zz", size: 1 }], shown)).toContain(
      "malformed",
    );
  });
});

describe("the manifest summary", () => {
  test("renders every artifact with its size and sha256, and the manifest digest", async () => {
    const digest = await manifestDigest(artifacts);
    const html = renderToStaticMarkup(<ManifestSection artifacts={artifacts} digest={digest} />);
    for (const a of manifestRows(artifacts)) {
      expect(html).toContain(a.name);
      expect(html).toContain(a.size);
      expect(html).toContain(a.sha256);
    }
    expect(html).toContain(digest);
    expect(html).toContain("Manifest digest");
    expect(html.indexOf("SHA256SUMS")).toBeLessThan(html.indexOf("turntable-linux-x64"));
  });

  test("an artifact name is rendered as text, never as markup", () => {
    const html = renderToStaticMarkup(
      <ManifestSection artifacts={[{ name: "<img src=x>", sha256: A, size: 1 }]} digest={B} />,
    );
    expect(html).not.toContain("<img");
  });
});

describe("a v1 attempt for a release", () => {
  test("the server's release_requires_v2 refusal shows the clear message", () => {
    const server =
      "release_requires_v2: release is this project's release environment: use release_approval_challenge";
    expect(approvalErrorMessage(server)).toBe(RELEASE_REQUIRES_V2_MESSAGE);
    expect(RELEASE_REQUIRES_V2_MESSAGE).toContain("update the client");
    expect(RELEASE_REQUIRES_V2_MESSAGE).toContain("release manifest");
    expect(approvalErrorMessage("the challenge is unknown, already used or expired")).toBe(
      "the challenge is unknown, already used or expired",
    );
  });
});
