// What a release actually signs: files. An artifact the build uploaded is either a zip (the
// default of upload-artifact, which only carries files) or one raw file (`archive: false`). A zip
// is unpacked here, safely (unpack.ts), into a fresh directory under the lane's own root, and each
// file inside becomes a subject by its path and the sha256 of its bytes. A raw artifact is its own
// subject. The zip's own digest is checked against what the build recorded, so the bytes unpacked
// are the bytes that were uploaded, but the zip is never what gets signed or published.
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dirArtifacts, type ArtifactBytes } from "./artifacts";
import { freshUnpackDir, looksLikeZip, unpackZip, UnpackError, type UnpackLimits } from "./unpack";

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export type FileOpenFailure =
  | { ok: false; reason: "artifact_bytes_missing"; detail: string }
  | { ok: false; reason: "unpack_failed"; detail: string }
  | { ok: false; reason: "duplicate_subject"; detail: string }
  /** The caller's own check of an artifact's bytes (against what the build recorded) failed. */
  | { ok: false; reason: "rejected"; detail: string; cause: string };

export class ReleaseFiles {
  /** Every file or raw artifact to sign: name to sha256. */
  readonly digests: Record<string, string> = {};
  /** The zips that were unpacked, by artifact name and the digest of the zip itself. */
  readonly archives: { name: string; sha256: string }[] = [];
  readonly #o: { bytes: ArtifactBytes; runId: string };
  readonly #owner = new Map<string, { kind: "raw"; artifact: string } | { kind: "file" }>();
  /** Which unpacked archive (by index) holds each file. */
  readonly #where = new Map<string, number>();
  /** The artifact each file came from. */
  readonly #artifact = new Map<string, string>();
  #dir: string | undefined;
  #reader: ArtifactBytes | undefined;

  private constructor(o: { bytes: ArtifactBytes; runId: string }) {
    this.#o = o;
  }

  /**
   * Reads each named artifact. `check` sees the artifact's bytes first, before any unpacking, so
   * only bytes the build recorded are ever unpacked; it returns a reason to refuse them.
   */
  static async open(o: {
    bytes: ArtifactBytes;
    runId: string;
    names: readonly string[];
    unpackRoot: string;
    limits?: UnpackLimits;
    check?: (name: string, bytes: Uint8Array) => string | undefined;
  }): Promise<{ ok: true; files: ReleaseFiles } | FileOpenFailure> {
    const files = new ReleaseFiles(o);
    const fail = async (f: FileOpenFailure): Promise<FileOpenFailure> => {
      await files.dispose();
      return f;
    };
    for (const name of o.names) {
      const bytes = await o.bytes.read(o.runId, name);
      if (!bytes) return fail({ ok: false, reason: "artifact_bytes_missing", detail: name });
      const why = o.check?.(name, bytes);
      if (why !== undefined)
        return fail({ ok: false, reason: "rejected", detail: name, cause: why });
      if (!looksLikeZip(bytes)) {
        if (name in files.digests)
          return fail({ ok: false, reason: "duplicate_subject", detail: name });
        files.digests[name] = sha256(bytes);
        files.#owner.set(name, { kind: "raw", artifact: name });
        files.#artifact.set(name, name);
        continue;
      }
      if (files.#dir === undefined) {
        files.#dir = await freshUnpackDir(o.unpackRoot, o.runId);
        await mkdir(join(files.#dir, "f"), { mode: 0o700 });
        files.#reader = dirArtifacts(files.#dir);
      }
      // Each zip into its own directory, so one artifact can never overwrite another's files.
      const sub = join(files.#dir, "f", `a${files.archives.length}`);
      await mkdir(sub, { mode: 0o700 });
      let unpacked;
      try {
        unpacked = await unpackZip(bytes, sub, o.limits);
      } catch (err) {
        if (err instanceof UnpackError)
          return fail({ ok: false, reason: "unpack_failed", detail: `${name}: ${err.message}` });
        throw err;
      }
      files.archives.push({ name, sha256: sha256(bytes) });
      const index = files.archives.length - 1;
      for (const f of unpacked) {
        if (f.name in files.digests)
          return fail({ ok: false, reason: "duplicate_subject", detail: f.name });
        files.digests[f.name] = f.sha256;
        files.#owner.set(f.name, { kind: "file" });
        files.#where.set(f.name, index);
        files.#artifact.set(f.name, name);
      }
    }
    return { ok: true, files };
  }

  /** The artifact (upload-artifact name) a file came from. */
  artifactOf(file: string): string | undefined {
    return this.#artifact.get(file);
  }

  /** Every file of one artifact, by path, sorted. */
  filesOf(artifact: string): string[] {
    return [...this.#artifact]
      .filter(([, a]) => a === artifact)
      .map(([f]) => f)
      .toSorted();
  }

  /** The bytes of a signed file, read back from where it was unpacked (or the raw artifact). */
  async readBytes(name: string): Promise<Uint8Array | undefined> {
    const o = this.#owner.get(name);
    if (!o) return undefined;
    if (o.kind === "raw") return this.#o.bytes.read(this.#o.runId, name);
    const i = this.#where.get(name);
    if (i === undefined || !this.#reader) return undefined;
    return this.#reader.read("f", `a${i}/${name}`);
  }

  /** Removes the unpacked files. Idempotent. */
  async dispose(): Promise<void> {
    const d = this.#dir;
    this.#dir = undefined;
    this.#reader = undefined;
    if (d) await rm(d, { recursive: true, force: true });
  }
}
