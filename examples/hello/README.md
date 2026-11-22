# hello

A self-contained workflow for trying Longshore: run steps, `$GITHUB_OUTPUT`, `$GITHUB_ENV`,
`$GITHUB_STEP_SUMMARY`, a local composite action and `actions/checkout`.

- `.github/workflows/ci.yml`, job `hello`, succeeds.
- `.github/workflows/fail.yml`, job `fail`, fails on purpose (to check that a failing job is
  reported as a failure, not as an infrastructure error).
