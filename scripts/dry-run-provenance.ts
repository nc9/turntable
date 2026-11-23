// Release dry run: exercises Turntable's own provenance path on the built binaries, without
// publishing anything and without GitHub's attestation (which writes to a public log).
//
//   bun run scripts/dry-run-provenance.ts --dist dist --version v0.1.0-alpha.1 \
//     --repo nc9/turntable --sha <commit> --ref refs/tags/v0.1.0-alpha.1 --out dist-dry
//
// It builds an SLSA v1 statement for every binary in SHA256SUMS, signs it with a key made for this
// run and thrown away, then verifies every binary against it with the same code `turntable verify`
// uses. A negative control (a changed copy of a binary must NOT verify) proves the check can fail.
// The signature proves the format and the digests, not an identity: it is a dry-run check, and the
// published release carries GitHub's attestation instead.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type Artifact,
  buildStatement,
  LocalSigner,
  PAYLOAD_TYPE,
  sha256Hex,
  signEnvelope,
  statementBytes,
  verifyArtifact,
} from "../packages/signer/src/index";

/** The binaries listed in a SHA256SUMS file (`<hex>  <name>` lines), SBOMs and the like left out. */
export function binariesIn(sums: string): Artifact[] {
  return sums
    .split("\n")
    .map((l) => /^([0-9a-f]{64})\s+\*?(turntable-(?:linux|darwin)-[A-Za-z0-9_]+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ sha256: m[1]!, name: m[2]! }));
}

export interface DryRunResult {
  subjects: Artifact[];
  verified: string[];
  tamperRefused: boolean;
}

export async function dryRunProvenance(o: {
  dist: string;
  out: string;
  version: string;
  repo: string;
  sha: string;
  ref: string;
}): Promise<DryRunResult> {
  const subjects = binariesIn(readFileSync(join(o.dist, "SHA256SUMS"), "utf8"));
  if (subjects.length === 0) throw new Error("no binaries in SHA256SUMS");
  // What is listed must be what is on disk: the digests are taken from the files, not trusted.
  for (const s of subjects) {
    const actual = sha256Hex(readFileSync(join(o.dist, s.name)));
    if (actual !== s.sha256) throw new Error(`${s.name} does not match SHA256SUMS`);
  }
  const keys = new Map<string, string>();
  const signer = new LocalSigner({
    get: async (n) => keys.get(n),
    set: async (n, v) => void keys.set(n, v),
  });
  const pub = await signer.ensureKey("dry-run");
  const statement = buildStatement({
    builderId: `https://github.com/${o.repo}/.github/workflows/release.yml`,
    invocationId: `dry-run-${o.version}`,
    repo: o.repo,
    workflowPath: ".github/workflows/release.yml",
    ref: o.ref,
    sha: o.sha,
    event: "workflow_dispatch",
    inputs: { version: o.version },
    actions: [],
    subjects,
    byproducts: [],
  });
  const envelope = await signEnvelope(PAYLOAD_TYPE, statementBytes(statement), signer, "dry-run");
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "provenance.dry-run.intoto.json"), JSON.stringify(envelope, null, 2));
  writeFileSync(join(o.out, "dry-run-public-key.pem"), pub.publicKeyPem);

  const verified: string[] = [];
  for (const s of subjects) {
    const bytes = readFileSync(join(o.dist, s.name));
    const v = verifyArtifact({
      artifact: bytes,
      envelope,
      publicKeyPem: pub.publicKeyPem,
      name: s.name,
    });
    if (!v.ok) throw new Error(`${s.name} did not verify against its own provenance: ${v.reason}`);
    verified.push(s.name);
  }
  // Negative control: one changed byte must not verify.
  const first = subjects[0]!;
  const changed = Buffer.from(readFileSync(join(o.dist, first.name)));
  changed[0] = changed[0]! ^ 0xff;
  const tamper = verifyArtifact({
    artifact: changed,
    envelope,
    publicKeyPem: pub.publicKeyPem,
    name: first.name,
  });
  if (tamper.ok) throw new Error("a changed binary verified: the check cannot fail");
  return { subjects, verified, tamperRefused: true };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dist: { type: "string" },
      out: { type: "string" },
      version: { type: "string" },
      repo: { type: "string" },
      sha: { type: "string" },
      ref: { type: "string" },
    },
  });
  for (const k of ["dist", "out", "version", "repo", "sha", "ref"] as const) {
    if (!values[k]) {
      console.error(`missing --${k}`);
      process.exit(2);
    }
  }
  const r = await dryRunProvenance({
    dist: values.dist!,
    out: values.out!,
    version: values.version!,
    repo: values.repo!,
    sha: values.sha!,
    ref: values.ref!,
  });
  console.log(`provenance verified for ${r.verified.length} binaries: ${r.verified.join(", ")}`);
  console.log("a changed binary was refused (negative control)");
}
