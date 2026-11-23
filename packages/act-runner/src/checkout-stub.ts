/**
 * Tokenless checkout. act's default checkout copy has no .git, so the controller delivers the
 * repo (with .git) to the sandbox and act is told, per pinned `actions/checkout@<ref>`, to use
 * this composite action instead (`--no-skip-checkout --local-repository <ref>=<dir>`).
 *
 * It works from the delivered repository only and never touches the network. Inputs:
 *  - `path`: where under the workspace to check out (it may not leave it);
 *  - `ref`: a commit sha, branch or tag that exists in the delivered repository, else an error;
 *  - `fetch-depth`: GitHub's default is 1 (a shallow clone); 0 is the full history;
 *  - `submodules`: `true` or `recursive`, from the modules the controller delivered under
 *    `.git/modules`; a module that was not delivered is an error, not a fetch.
 * Inputs it cannot honour offline (`lfs`, `sparse-checkout`, `fetch-tags`) are accepted and ignored.
 */
export function checkoutScript(repoDir: string): string {
  const repo = repoDir.replaceAll("'", "'\\''");
  return `set -eu
src='${repo}'
case "$TT_CHECKOUT_PATH" in
  /*|..|../*|*/..|*/../*) echo "checkout: path ($TT_CHECKOUT_PATH) must stay inside the workspace" >&2; exit 1 ;;
esac
dest="$GITHUB_WORKSPACE"
if [ -n "$TT_CHECKOUT_PATH" ]; then dest="$GITHUB_WORKSPACE/$TT_CHECKOUT_PATH"; fi
mkdir -p "$dest"
depth="\${TT_FETCH_DEPTH:-1}"
case "$depth" in ''|*[!0-9]*) echo "checkout: fetch-depth must be a number, got $depth" >&2; exit 1 ;; esac
sub="\${TT_SUBMODULES:-false}"
case "$sub" in true|recursive|false|'') ;; *) echo "checkout: submodules must be true, recursive or false, got $sub" >&2; exit 1 ;; esac

# The commit to check out, found only in what was delivered.
want=$(git -C "$src" rev-parse --verify --quiet 'HEAD^{commit}')
branch=
if [ -n "$TT_REF" ]; then
  ref=\${TT_REF#refs/heads/}; ref=\${ref#refs/tags/}
  want=
  for cand in "$TT_REF" "refs/heads/$ref" "refs/remotes/origin/$ref" "refs/tags/$ref"; do
    if c=$(git -C "$src" rev-parse --verify --quiet "$cand^{commit}" 2>/dev/null); then want=$c; break; fi
  done
  if [ -z "$want" ]; then
    echo "checkout: ref $TT_REF is not in the delivered repository (checkout never fetches)" >&2
    exit 1
  fi
  if git -C "$src" rev-parse --verify --quiet "refs/heads/$ref" >/dev/null 2>&1 ||
     git -C "$src" rev-parse --verify --quiet "refs/remotes/origin/$ref" >/dev/null 2>&1; then branch=$ref; fi
fi

# The delivered history, copied; a depth above 0 then cuts it the way a shallow clone is cut, by
# marking the commits that sit \`depth\` generations from the tip as shallow roots.
if [ -e "$dest/.git" ]; then rm -rf "$dest/.git"; fi
cp -a "$src/.git" "$dest/.git"
rm -f "$dest/.git/shallow"
if [ "$depth" != 0 ]; then
  frontier=$want
  i=1
  while [ "$i" -lt "$depth" ]; do
    next=$(for c in $frontier; do git -C "$dest" rev-parse --quiet --verify "$c^@" 2>/dev/null || true; done | sort -u)
    [ -n "$next" ] || break
    frontier=$next
    i=$((i + 1))
  done
  printf '%s\n' $frontier > "$dest/.git/shallow"
fi
# The remote is the repository's own address, as after a real checkout, not whatever the
# controller delivered from; nothing is ever retrieved from it here.
git -C "$dest" remote set-url origin "\${GITHUB_SERVER_URL:-}/\${GITHUB_REPOSITORY:-owner/repo}" 2>/dev/null || true
if [ -n "$branch" ]; then
  git -C "$dest" checkout -q --force -B "$branch" "$want"
else
  git -C "$dest" checkout -q --force --detach "$want"
fi

if [ "$sub" = true ] || [ "$sub" = recursive ]; then
  if [ -d "$src/.git/modules" ] && [ ! -d "$dest/.git/modules" ]; then cp -a "$src/.git/modules" "$dest/.git/modules"; fi
  rec=
  if [ "$sub" = recursive ]; then rec=--recursive; fi
  # --no-fetch, and no transport allowed at all: a module that was not delivered fails here, it is
  # never downloaded or cloned from the address in .gitmodules.
  if ! GIT_ALLOW_PROTOCOL=none git -C "$dest" submodule update --init --no-fetch $rec; then
    echo "checkout: submodules were requested but were not delivered with the repository" >&2
    exit 1
  fi
fi
`;
}

export function checkoutStubAction(repoDir: string): string {
  const body = checkoutScript(repoDir)
    .split("\n")
    .map((l) => (l === "" ? "" : `        ${l}`))
    .join("\n");
  return `name: turntable checkout stub
description: Checks out from the repository the controller delivered; never uses the network.
inputs:
  repository: { required: false }
  ref: { required: false, default: "" }
  token: { required: false }
  path: { required: false, default: "" }
  fetch-depth: { required: false, default: "1" }
  submodules: { required: false, default: "false" }
  persist-credentials: { required: false }
  clean: { required: false }
  lfs: { required: false }
  fetch-tags: { required: false }
  sparse-checkout: { required: false }
runs:
  using: composite
  steps:
    - shell: bash
      env:
        TT_CHECKOUT_PATH: \${{ inputs.path }}
        TT_REF: \${{ inputs.ref }}
        TT_FETCH_DEPTH: \${{ inputs.fetch-depth }}
        TT_SUBMODULES: \${{ inputs.submodules }}
      run: |
${body}
`;
}
