import type { ReleaseArtifact } from "@/api/types";
import { manifestRows } from "@/lib/release-approval";
import { sanitize } from "@/log/parser";

/** The artifacts a release approval covers, and the digest that binds them into the signature. */
export function ManifestSection({
  artifacts,
  digest,
}: {
  artifacts: ReleaseArtifact[];
  digest: string;
}) {
  return (
    <section aria-labelledby="manifest-h" className="mt-5">
      <h2 id="manifest-h" className="text-sm font-semibold">
        Release manifest
      </h2>
      <p className="mt-1 text-xs text-dim">
        Your signature covers exactly these files. The release lane signs only this set, once.
      </p>
      <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
        {manifestRows(artifacts).map((a) => (
          <li key={a.name} className="px-4 py-3 text-[13px]">
            <span className="block break-all font-mono font-medium">{sanitize(a.name)}</span>
            <span className="block text-dim">{a.size}</span>
            <span className="block break-all font-mono text-xs">sha256 {a.sha256}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 overflow-hidden rounded-xl border border-line px-4 py-3">
        <div className="text-[13px] text-dim">Manifest digest (sha256)</div>
        <div className="mt-1 break-all font-mono text-[13px]">{digest}</div>
      </div>
    </section>
  );
}
