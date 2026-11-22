// Ad-hoc re-signing of the darwin binary, on any host (CI signs on the Linux runner).
//
// `bun build --compile` leaves a linker-style ad-hoc signature (flags ADHOC|LINKER_SIGNED) whose
// page hashes cover the binary before the app payload was attached. Re-signing recomputes them.
// rcodesign is Apple-codesign by Gregory Szorc (MPL-2.0), downloaded by pinned sha256 like act.
//
//   bun run scripts/rcodesign.ts sign   <binary> [identifier]
//   bun run scripts/rcodesign.ts verify <binary> [identifier]
import { createHash } from "node:crypto";
import { safeFetch } from "../packages/net/src/index";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RCODESIGN_VERSION = "0.29.0";

/** Bump the version and every hash together, from the release's SHA256SUMS. */
export const RCODESIGN_ASSETS: Record<string, { asset: string; sha256: string }> = {
  "linux-x64": {
    asset: `apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002",
  },
  "darwin-arm64": {
    asset: `apple-codesign-${RCODESIGN_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "d1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a",
  },
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Path to rcodesign: $RCODESIGN, or the pinned release downloaded and verified into a cache. */
export async function ensureRcodesign(): Promise<string> {
  if (process.env.RCODESIGN) return process.env.RCODESIGN;
  const key = `${process.platform}-${process.arch}`;
  const rel = RCODESIGN_ASSETS[key];
  if (!rel) throw new Error(`no pinned rcodesign for ${key}; set RCODESIGN to a binary`);
  const dir = join(tmpdir(), `longshore-rcodesign-${RCODESIGN_VERSION}-${key}`);
  const bin = join(dir, "rcodesign");
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/${rel.asset}`;
  const res = await safeFetch(url, { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 });
  if (!res.ok) throw new Error(`download ${url} failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== rel.sha256)
    throw new Error(`rcodesign checksum mismatch: got ${got}, want ${rel.sha256}`);
  const tgz = join(dir, rel.asset);
  writeFileSync(tgz, bytes);
  const stem = rel.asset.replace(/\.tar\.gz$/, "");
  const p = Bun.spawn(["tar", "xzf", tgz, "-C", dir, "--strip-components=1", `${stem}/rcodesign`], {
    stderr: "pipe",
  });
  if ((await p.exited) !== 0) throw new Error(`tar failed: ${await new Response(p.stderr).text()}`);
  chmodSync(bin, 0o755);
  return bin;
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

/** Replaces the signature with a fresh ad-hoc one that covers the whole file. */
export async function signAdhoc(file: string, identifier: string): Promise<void> {
  const rc = await ensureRcodesign();
  const r = await run([rc, "sign", "--binary-identifier", identifier, file]);
  if (r.code !== 0) throw new Error(`rcodesign sign failed:\n${r.err}`);
}

export interface SignatureFacts {
  flags: string;
  identifier: string;
  digestType: string;
  fileSha256: string;
}

/** Parses `rcodesign print-signature-info` (YAML) for the facts we assert. */
export function parseSignatureInfo(text: string): SignatureFacts {
  const pick = (re: RegExp, what: string): string => {
    const m = re.exec(text);
    if (!m) throw new Error(`signature info has no ${what}`);
    return (m[1] ?? "").trim();
  };
  return {
    flags: pick(/^\s*flags:\s*(.+)$/m, "code directory flags"),
    identifier: pick(/^\s*identifier:\s*(.+)$/m, "identifier"),
    digestType: pick(/^\s*digest_type:\s*(.+)$/m, "digest type"),
    fileSha256: pick(/^\s*file_sha256:\s*(.+)$/m, "file hash"),
  };
}

/** Asserts the binary carries a fresh ad-hoc signature (not Bun's stale linker signature). */
export async function verifySignature(file: string, identifier: string): Promise<SignatureFacts> {
  const rc = await ensureRcodesign();
  const r = await run([rc, "print-signature-info", file]);
  if (r.code !== 0) throw new Error(`rcodesign print-signature-info failed:\n${r.err}`);
  const facts = parseSignatureInfo(r.out);
  if (!facts.flags.includes("ADHOC")) throw new Error(`not ad-hoc signed: ${facts.flags}`);
  if (facts.flags.includes("LINKER_SIGNED")) {
    throw new Error(`still has the linker signature from bun build: ${facts.flags}`);
  }
  if (facts.digestType !== "sha256")
    throw new Error(`digest type ${facts.digestType}, want sha256`);
  if (facts.identifier !== identifier) {
    throw new Error(`identifier ${facts.identifier}, want ${identifier}`);
  }
  if (facts.fileSha256 !== sha256(readFileSync(file))) throw new Error("file hash mismatch");
  return facts;
}

if (import.meta.main) {
  const [cmd, file, id] = process.argv.slice(2);
  if (!file || (cmd !== "sign" && cmd !== "verify")) {
    console.error("usage: rcodesign.ts <sign|verify> <binary> [identifier]");
    process.exit(2);
  }
  const identifier = id ?? file.split("/").pop() ?? "longshore";
  if (cmd === "sign") await signAdhoc(file, identifier);
  const facts = await verifySignature(file, identifier);
  console.log(
    `${cmd === "sign" ? "signed and verified" : "verified"} ${file}: ${facts.flags}, ${facts.identifier}`,
  );
}
