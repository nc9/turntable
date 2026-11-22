import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalSigner,
  PAYLOAD_TYPE,
  buildStatement,
  sha256Hex,
  signEnvelope,
  statementBytes,
} from "@longshore/signer";
import { verifyCommand } from "../src/verify/cli";
import { setSigningPolicy } from "../src/ops/policy-cli";
import { createOrg, createProject, openDatabase, getProjectSigning, listAudit } from "../src/db";

const dir = mkdtempSync(join(tmpdir(), "ls-verify-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BINARY = Buffer.from("release bytes");

async function fixture(name: string) {
  const vault = new Map<string, string>();
  const signer = new LocalSigner({
    get: async (n) => vault.get(n),
    set: async (n, v) => void vault.set(n, v),
  });
  const key = await signer.ensureKey("release");
  const envelope = await signEnvelope(
    PAYLOAD_TYPE,
    statementBytes(
      buildStatement({
        builderId: "https://ci.example.test/longshore",
        invocationId: "run1",
        repo: "acme/web",
        workflowPath: ".github/workflows/release.yml",
        ref: "refs/tags/v1.0.0",
        sha: "a".repeat(40),
        event: "push",
        inputs: {},
        actions: [],
        subjects: [{ name: "app.bin", sha256: sha256Hex(BINARY) }],
        byproducts: [],
      }),
    ),
    signer,
    "release",
  );
  const paths = {
    artifact: join(dir, `${name}.bin`),
    provenance: join(dir, `${name}.intoto.json`),
    pubkey: join(dir, `${name}.pub`),
  };
  writeFileSync(paths.artifact, BINARY);
  writeFileSync(paths.provenance, JSON.stringify(envelope));
  writeFileSync(paths.pubkey, key.publicKeyPem);
  return { paths, envelope, key };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    return { code: await verifyCommand(args), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}
const cli = (p: { artifact: string; provenance: string; pubkey: string }, extra: string[] = []) => [
  p.artifact,
  "--provenance",
  p.provenance,
  "--pubkey",
  p.pubkey,
  ...extra,
];

describe("longshore verify", () => {
  test("an artifact, its provenance and the right key verify, and the result says where it came from", async () => {
    const { paths, key } = await fixture("good");
    const r = await run(cli(paths));
    expect(r.code).toBe(0);
    expect(r.out).toContain("verified app.bin");
    expect(r.out).toContain(`sha256:${sha256Hex(BINARY)}`);
    expect(r.out).toContain(key.keyid);
    expect(r.out).toContain("refs/tags/v1.0.0");
    expect(r.out).toContain("https://ci.example.test/longshore");
    expect((await run(cli(paths, ["--name", "app.bin"]))).code).toBe(0);
  });

  test("a tampered artifact is not verified", async () => {
    const { paths } = await fixture("tamper-artifact");
    writeFileSync(paths.artifact, Buffer.concat([BINARY, Buffer.from("!")]));
    const r = await run(cli(paths));
    expect(r.code).toBe(1);
    expect(r.err).toContain("NOT VERIFIED");
    expect(r.err).toContain("not a subject");
  });

  test("tampered provenance is not verified", async () => {
    const { paths, envelope } = await fixture("tamper-provenance");
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
    statement.predicate.buildDefinition.externalParameters.sha = "b".repeat(40);
    writeFileSync(
      paths.provenance,
      JSON.stringify({
        ...envelope,
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      }),
    );
    const r = await run(cli(paths));
    expect(r.code).toBe(1);
    expect(r.err).toContain("does not verify");
  });

  test("another key is not accepted", async () => {
    const { paths } = await fixture("wrong-key");
    const other = await fixture("other-key");
    writeFileSync(paths.pubkey, await Bun.file(other.paths.pubkey).text());
    const r = await run(cli(paths));
    expect(r.code).toBe(1);
    expect(r.err).toContain("no signature made by this key");
  });

  test("a different subject name is not accepted", async () => {
    const { paths } = await fixture("name");
    expect((await run(cli(paths, ["--name", "other.bin"]))).code).toBe(1);
  });

  test("usage mistakes and unreadable files are exit code 2", async () => {
    const { paths } = await fixture("usage");
    expect((await run([])).code).toBe(2);
    expect((await run([paths.artifact])).code).toBe(2);
    expect((await run(cli({ ...paths, artifact: join(dir, "missing") }))).code).toBe(2);
    writeFileSync(paths.provenance, "not json");
    const bad = await run(cli(paths));
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("not JSON");
  });
});

describe("longshore policy: signing", () => {
  test("release refs and the key are set per project, validated and audited", async () => {
    const db = openDatabase(":memory:");
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
    const scope = { orgId: org.id, projectId: project.id };
    await expect(setSigningPolicy(db, "acme", "app", { signingKey: "vault:x" })).rejects.toThrow(
      "--signing-key",
    );
    await expect(setSigningPolicy(db, "acme", "app", { releaseRefs: ["main"] })).rejects.toThrow(
      "--release-refs",
    );
    await expect(
      setSigningPolicy(db, "acme", "nope", { signingKey: "builtin:r" }),
    ).rejects.toThrow();
    const out = await setSigningPolicy(db, "acme", "app", {
      releaseRefs: ["refs/tags/v*", "refs/heads/release/*"],
      signingKey: "builtin:release",
    });
    expect(out).toEqual([
      {
        project: "app",
        releaseRefs: ["refs/tags/v*", "refs/heads/release/*"],
        signingKey: "builtin:release",
      },
    ]);
    expect(await getProjectSigning(db, scope)).toEqual({
      releaseRefs: ["refs/tags/v*", "refs/heads/release/*"],
      signingKey: "builtin:release",
    });
    // An empty key unsets it.
    await setSigningPolicy(db, "acme", "app", { signingKey: "" });
    expect((await getProjectSigning(db, scope)).signingKey).toBeNull();
    expect((await listAudit(db, scope)).filter((a) => a.op === "policy_set")).toHaveLength(2);
  });
});
