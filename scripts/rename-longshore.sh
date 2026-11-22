#!/usr/bin/env bash
# Renames Turntable to Longshore across the tracked text files of the current checkout.
# Idempotent. Other branches can run it before rebasing onto the rename:
#   scripts/rename-longshore.sh && git commit -am "chore(repo): apply the Longshore rename"
#
# Mapping (case-preserving): Turntable -> Longshore, TURNTABLE -> LONGSHORE, turntable ->
# longshore. That covers @turntable/* packages, the binary and dist names, TURNTABLE_* env vars,
# Turntable-Untrusted-Content and turntable-* meta keys, the turntable.v1 subprotocol, docker
# labels, /tmp/.turntable, and ghcr.io/nc9/turntable.
#
# Kept on purpose: the repo (github.com/nc9/turntable, issue links; the repo rename is separate),
# the SQL migration files, the compat module (db/legacy-names.ts) that reads old data, and this
# script. The execId prefix `tt1-` is not touched. Tokens: new ones are ls_, tt_ is still accepted.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

skip='^(packages/core/drizzle/|scripts/rename-longshore\.sh$|packages/core/src/db/legacy-names\.ts$|packages/core/tests/legacy-names\.test\.ts$)'

git ls-files -z | while IFS= read -r -d '' f; do
  [[ "$f" =~ $skip ]] && continue
  [ -f "$f" ] || continue
  grep -Iq . "$f" 2>/dev/null || continue # binary or empty
  grep -qi turntable "$f" || continue
  perl -0pi -e '
    s{ghcr\.io/nc9/turntable}{ghcr.io/nc9/longshore}g;
    s{nc9/turntable}{nc9/\x00KEEP\x00}g;
    s/Turntable/Longshore/g;
    s/TURNTABLE/LONGSHORE/g;
    s/turntable/longshore/g;
    s{nc9/\x00KEEP\x00}{nc9/turntable}g;
    s/Bearer tt_\.\.\./Bearer ls_.../g;
    s/`tt_\.\.\.`/`ls_...`/g;
    s/"tt_\.\.\."/"ls_..."/g;
    s/`tt_` plus/`ls_` plus/g;
  ' "$f"
done
