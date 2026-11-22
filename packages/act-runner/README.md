# @turntable/act-runner

Runs one GitHub Actions job inside a sandbox using [nektos/act](https://github.com/nektos/act)
(MIT) in host mode. It talks to the sandbox only through the provider SDK: detached exec, status
polling and offset-based log reads. No stream is needed for correctness.

```ts
const plan = planJob(workflowYaml, "hello", { workflowPath: ".github/workflows/ci.yml" });
const run = runJob(provider, sandboxId, plan, { repoTarball });
for (;;) {
  const r = await run.next();
  if (r.done) {
    console.log(r.value);
    break;
  } // { state, exitCode, reason }
  // r.value is a phase, a log chunk with its offset, or a parsed act event
}
```

`drain(run, onEvent)` does the loop for you. Cancelling is destroying the sandbox; the job then
ends as `infra_error`.

## How it runs act

- Host mode: `-P <label>=-self-hosted`. One job per sandbox, so shared HOME and caches are fine.
- Always `-W <workflow file>` and `--concurrent-jobs 1`. Never `-n`: in host mode a dry run still
  executes `run` steps.
- act is downloaded by the controller (pinned release, sha256 committed in `src/act-install.ts`),
  uploaded as a tarball, and verified again inside the sandbox before unpacking. Pinned:
  act v0.2.97.
- Tokenless checkout: the controller delivers the repo (with `.git`) as a tarball. Each pinned
  `actions/checkout@<ref>` is replaced by a composite stub that copies it into the workspace
  (`--no-skip-checkout --local-repository <ref>=<stub dir>`).
- act runs under `env GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0` (constants, set inside the
  sandbox; no controller env). act gives run steps a pty, so without these `git log` blocks in a
  pager until the timeout.
- Sandbox image needs `bash`, `git`, `tar`, `sha256sum` (or `shasum`) and, for JavaScript actions,
  `node`.

## Results

| State         | Meaning                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`     | act exited 0 and reported the job as successful                                                                                                                              |
| `failure`     | the job ran and failed (or hit the timeout or output ceiling)                                                                                                                |
| `skipped`     | act exited 0 and emitted nothing (a job skipped by `if:`)                                                                                                                    |
| `infra_error` | no trustworthy result: act crashed before running the job, the exec was lost, the sandbox disappeared, the provider stayed unreachable, or exit code and job result disagree |

## Event stream

`createActParser()` turns `act --json` lines into typed events. act has no job-start event, so
`job-start` and missing `step-start` events are inferred. Step outputs are not in the stream.

## M0 support matrix

| Feature                                                                                     | M0                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `run` steps, `env`, `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_STEP_SUMMARY`, `::set-output` | yes                                            |
| JavaScript and composite actions, local composite actions                                   | yes                                            |
| `actions/checkout` (tokenless, via stub)                                                    | yes                                            |
| Linux runners (`ubuntu-*`, `self-hosted`, `linux`)                                          | yes                                            |
| `needs`                                                                                     | rejected (M1: needs stub jobs)                 |
| `strategy.matrix`                                                                           | rejected (M1)                                  |
| `services`                                                                                  | rejected (act host mode ignores them silently) |
| `container`                                                                                 | rejected                                       |
| `docker://` actions                                                                         | rejected                                       |
| Windows and macOS runners                                                                   | rejected                                       |
| `runs-on` expressions, reusable workflows (`jobs.<id>.uses`)                                | rejected                                       |

Rejections throw `PlanError` with a `feature` field naming what was refused, at plan time, before
any sandbox exists. Docker actions inside local composite actions cannot be seen from the
workflow file alone and fail when act runs them.

## Tests

- `tests/plan.test.ts`, `tests/events.test.ts` (recorded-style fixtures in `tests/fixtures`) and
  `tests/run-job.test.ts` (against the fake provider with a stand-in `act`) run locally.
- `tests/e2e.test.ts` runs `examples/hello` end to end with the Docker provider. CI only
  (`bun run test:act-e2e`, job `act-runner-e2e`). The image is `node:22-bookworm`, pinned by
  digest, because host mode needs bash, git and node; `ubuntu:24.04` has none of them.
