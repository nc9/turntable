#!/usr/bin/env bash
# Renames Longshore back to Turntable across the tracked text files of the current checkout.
# Idempotent. Other branches can run it before rebasing onto the rename:
#   scripts/rename-turntable.sh && bun fmt && git commit -am "chore(repo): apply the Turntable rename"
#
# Mapping (case-preserving): Longshore -> Turntable, LONGSHORE -> TURNTABLE, longshore ->
# turntable. That covers @longshore/* packages, the binary and dist names, LONGSHORE_* env vars,
# Longshore-Untrusted-Content style names, the longshore.v1 subprotocol, docker labels, and
# ghcr.io/nc9/longshore. The word "longshore" in a new file of a branch is renamed too.
#
# Kept on purpose (the compat layer and the frozen strings):
# - the repo (github.com/nc9/turntable, issue links);
# - SQL migrations (packages/core/drizzle*/), this script, the old script;
# - every legacy-*.ts file and legacy-*.test.ts file: they name the old strings on purpose;
# - any line containing `rename-keep`, and every line between `rename-keep-begin` and
#   `rename-keep-end`: hand-written compat text next to renamed text;
# - the phrase "formerly Longshore", and docs lines that end with the MDX comment {/* rename-keep */};
# - FROZEN strings: brand text inside key derivation, MAC and AAD contexts, signed statement and
#   provenance types, wire headers that receivers match, and fleet names (configuration). Changing
#   one breaks data or peers that already exist. The list is the `frozen` rules below; the PR that
#   introduced this script has the table (string, file, why).
# Tokens: new ones are tt_ and tti_; ls_ and lsi_ are still accepted (packages/core/src/ops/tokens.ts).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

skip='^(packages/core/drizzle/|packages/core/drizzle-pg/|scripts/rename-turntable\.sh$|scripts/rename-longshore\.sh$)|(^|/)legacy-[a-z0-9-]+(\.test)?\.ts$'

git ls-files -z | while IFS= read -r -d '' f; do
  [[ "$f" =~ $skip ]] && continue
  [ -f "$f" ] || continue
  grep -Iq . "$f" 2>/dev/null || continue # binary or empty
  grep -qi longshore "$f" || continue
  perl -pi -e '
    BEGIN { $k = 0 }
    if (/rename-keep-begin/) { $k = 1 }
    if ($k || /rename-keep/) { $k = 0 if /rename-keep-end/; next }
    # Frozen: a \x01 inside the word stops every rule below from matching it. Removed at the end.
    s{(l)(ongshore)(?=:(?:vault|release-key|domain|cache-blob|audit-anchor|webhook-secret)\b)}{$1\x01$2}gi;
    s{(l)(ongshore)(?=:\$\{VERSION\})}{$1\x01$2}g; # case-sensitive: ghcr.io/nc9/longshore:${version} is an image tag
    s{(l)(ongshore)(?=\.approve_)}{$1\x01$2}gi;
    s{(l)(ongshore)(?=-release-channel/)}{$1\x01$2}gi;
    s{(l)(ongshore)(?=\.dev/buildtype)}{$1\x01$2}gi;
    s{(l)(ongshore)(?=-(?:signature|event|delivery|cursor|webhook/))}{$1\x01$2}gi;
    s{(?<=x-)(l)(ongshore)}{$1\x01$2}gi;
    s{(l)(ongshore)(?=-(?:dev|shadow)\b)}{$1\x01$2}gi;
    s{(?<=ormerly[ -])(L)(ongshore)}{$1\x01$2}gi;
    s{ghcr\.io/nc9/longshore}{ghcr.io/nc9/turntable}g;
    s{nc9/turntable}{nc9/\x00KEEP\x00}g;
    s/Longshore/Turntable/g;
    s/LONGSHORE/TURNTABLE/g;
    s/longshore/turntable/g;
    s{nc9/\x00KEEP\x00}{nc9/turntable}g;
    s/Bearer ls_\.\.\./Bearer tt_.../g;
    s/`ls_\.\.\.`/`tt_...`/g;
    s/"ls_\.\.\."/"tt_..."/g;
    s/`ls_` plus/`tt_` plus/g;
    s/`lsi_` plus/`tti_` plus/g;
    s/\x01//g;
  ' "$f"
done
