import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyDigest } from "@longshore/signer";

export const VERIFY_USAGE = `Usage: longshore verify <artifact> --provenance <file> --pubkey <file> [--name <subject>]

Checks that <artifact> is a subject of the DSSE-signed SLSA provenance in --provenance, and that the
signature verifies under the Ed25519 public key (SPKI PEM) in --pubkey. It trusts only that key.
Exit code: 0 verified, 1 not verified, 2 usage or unreadable file.`;

const REASONS: Record<string, string> = {
  malformed: "the provenance or the public key is not well formed",
  no_signature_for_key: "the provenance carries no signature made by this key",
  bad_signature:
    "the signature does not verify (the provenance was changed, or it is not this key's)",
  wrong_payload_type: "the envelope does not carry an in-toto statement",
  not_a_statement: "the envelope's payload is not an in-toto statement",
  wrong_predicate_type: "the statement is not SLSA provenance v1",
  artifact_not_a_subject:
    "the artifact's digest is not a subject of this provenance (it was changed, or it is another file)",
};

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** Returns the process exit code. */
export async function verifyCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        provenance: { type: "string" },
        pubkey: { type: "string" },
        name: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    console.error(VERIFY_USAGE);
    return 2;
  }
  const [artifact] = parsed.positionals;
  if (
    !artifact ||
    parsed.positionals.length !== 1 ||
    !parsed.values.provenance ||
    !parsed.values.pubkey
  ) {
    console.error(VERIFY_USAGE);
    return 2;
  }
  let sha256: string;
  let envelope: unknown;
  let publicKeyPem: string;
  try {
    sha256 = await sha256File(artifact);
    envelope = JSON.parse(readFileSync(parsed.values.provenance, "utf8"));
    publicKeyPem = readFileSync(parsed.values.pubkey, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    console.error(
      e instanceof SyntaxError
        ? "the provenance file is not JSON"
        : `cannot read a file${code ? ` (${code})` : ""}`,
    );
    return 2;
  }
  const v = verifyDigest({ sha256, envelope, publicKeyPem, name: parsed.values.name });
  if (!v.ok) {
    console.error(`NOT VERIFIED: ${REASONS[v.reason] ?? v.reason}`);
    return 1;
  }
  const params = v.statement.predicate.buildDefinition.externalParameters as {
    ref?: string;
    sha?: string;
    workflow?: string;
  };
  console.log(`verified ${v.subject} sha256:${v.sha256}`);
  console.log(`  signed by key ${v.keyid}`);
  console.log(`  builder ${v.statement.predicate.runDetails.builder.id}`);
  console.log(`  source ${params.ref ?? "?"} @ ${params.sha ?? "?"} (${params.workflow ?? "?"})`);
  return 0;
}
