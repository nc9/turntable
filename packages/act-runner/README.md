# @turntable/act-runner

Runs one GitHub Actions job inside a sandbox using [nektos/act](https://github.com/nektos/act)
(MIT) in host mode. It talks to the sandbox only through the provider SDK: detached exec, status
polling and offset-based log reads. No stream is needed for correctness.

```ts
const planned = planJob(workflowYaml, "hello", { workflowPath: ".github/workflows/ci.yml" });
const plan = await resolveActions(planned); // tag -> commit sha for every `uses:`
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

## Security rules

- No container socket reaches a job: host mode mounts nothing, and act is started with
  `--container-daemon-socket -`. `assertNoDockerAccess` runs on every act command (in `planJob`
  and again in `runJob`) and rejects `docker.sock`, `--privileged`, a container-daemon socket
  other than `-`, and bind mounts. Tests pin this, and the Docker provider's run args are
  checked for volumes, mounts and privileged mode.
- `resolveActions(plan, resolver)` takes an `ActionRefResolver` `(owner, repo, ref) => sha`
  (default: the GitHub API; `staticResolver` is the test stub; core will plug in the forge API).
  Pass `readFile` to `planJob` and local composite actions are scanned too, so remote actions
  nested inside them are pinned and delivered the same way. Without it, nested remote actions
  are invisible to the plan and act would fetch them by ref.
- Every `uses:` is resolved to a commit sha before the run, and the files act reads are
  rewritten (`uses: owner/repo@v4` becomes `@<sha> # v4`) in the delivered repo. `plan.actions` carries the
  tag-to-sha mapping (`repo`, `ref`, `sha`). `runJob` refuses a plan with an unresolved remote
  action. Remote actions are fetched by sha (`codeload.github.com/<repo>/tar.gz/<sha>`),
  uploaded, and served to act with `--local-repository`, so a moved tag cannot change what runs.
  Detecting tag moves over time is a later issue.
- `plan.warnings` (with the `file` and step) flags untrusted context interpolated straight into `run:` or
  `with.script` (`github.event.pull_request.title`, `head_ref`, issue and comment bodies, commit
  messages and so on). Pass such values through `env:` instead. A failing lint comes later.
- The checkout stub only copies the repository the controller delivered. It never fetches, and a
  test checks the stub text for network commands.

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

## Limits

- The repo tarball goes through `files.put`, so it is bounded by the provider's file cap (the
  Docker provider allows 64 MiB). That is fine for M0. A git-bundle path for large repos is a
  follow-up.
- The checkout stub copies the delivered repo. `ref`, `path` (beyond a subdirectory) and
  `fetch-depth` inputs are accepted and ignored.

## Tests

- `tests/plan.test.ts`, `tests/events.test.ts` (recorded-style fixtures in `tests/fixtures`) and
  `tests/run-job.test.ts` (against the fake provider with a stand-in `act`) run locally.
- `tests/e2e.test.ts` runs `examples/hello` end to end with the Docker provider. CI only
  (`bun run test:act-e2e`, job `act-runner-e2e`). The image is `node:22-bookworm`, pinned by
  digest, because host mode needs bash, git and node; `ubuntu:24.04` has none of them.
