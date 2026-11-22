/**
 * Tokenless checkout. act's default checkout copy has no .git, so the controller delivers the
 * repo (with .git) to the sandbox and act is told, per pinned `actions/checkout@<ref>`, to use
 * this composite action instead (`--no-skip-checkout --local-repository <ref>=<dir>`).
 */
export function checkoutStubAction(repoDir: string): string {
  return `name: turntable checkout stub
description: Copies the repository the controller delivered into the workspace.
inputs:
  repository: { required: false }
  ref: { required: false }
  token: { required: false }
  path: { required: false, default: "" }
  fetch-depth: { required: false }
  submodules: { required: false }
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
      run: |
        set -eu
        dest="$GITHUB_WORKSPACE"
        if [ -n "$TT_CHECKOUT_PATH" ]; then dest="$GITHUB_WORKSPACE/$TT_CHECKOUT_PATH"; fi
        mkdir -p "$dest"
        cp -a '${repoDir.replaceAll("'", "'\\''")}'/. "$dest"/
`;
}
