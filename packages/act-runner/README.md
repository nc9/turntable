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
- act runs under the step environment in `src/step-env.ts` (constants set inside the sandbox, no
  controller env): `GIT_PAGER=cat`, `PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `LANG=C.UTF-8`, `TERM`
  unset, and the step shims first on `PATH`. See "Parity assumptions" for why.
- Sandbox image needs `bash`, `git`, `tar`, `sha256sum` (or `shasum`) and, for JavaScript actions,
  `node`.

## Parity assumptions

Each is a claim about GitHub's hosted runner that Turntable makes true for steps. A workflow that
passes on GitHub must not fail here because of the environment. Numbers are stable: tests and
issues cite them.

1. **P1: no terminal on a step's stdin, stdout or stderr.** act v0.2.97 allocates a pty for every
   host-mode command, unconditionally (`if true /* allocate Terminal */` in
   `pkg/container/host_environment.go`; no flag or env disables it), so `[ -t 1 ]` and
   `process.stdout.isTTY` are true. GitHub's runner captures steps through pipes. Turntable puts
   shims for `bash`, `sh`, `python`, `python3`, `node` and `pwsh` first on `PATH` (act resolves a
   step's interpreter through the PATH it inherits). A shim runs the real interpreter with stdin
   from `/dev/null` and stdout and stderr (merged, as the runner captures them) on a pipe, and
   forwards the pipe to act's pty; everything the step starts inherits it. Found by a parity
   run of a real project's CLI tests: its `fmt` colours when `process.stdout.isTTY &&
   TERM !== "dumb"`, and two tests that assert the output has no escape sequence failed.
   The shim stays as the step's parent so output is fully flushed before act moves on, which
   would make act's step-timeout SIGKILL (sent to the direct child only) hit the shim and leave
   the interpreter running. So the shim guards it: the interpreter runs in its own process group
   (perl `setpgrp` then `exec`; perl is in Debian's base set), a TERM, INT or HUP sent to the shim
   goes to that group with KILL after a grace period (`TURNTABLE_STEP_GRACE`, default 5 s), and
   a small watcher takes the group down (TERM, then KILL) if the shim disappears while the
   interpreter still runs. When the interpreter ended normally, a daemon it left behind on
   purpose is left alone, as on GitHub. Without perl the interpreter runs in the shim's own
   group with no watchdog. Known limits: the interpreter still has a controlling terminal
   (`/dev/tty` opens), since dropping it would need a new session; git prompts are off
   (`GIT_TERMINAL_PROMPT=0`). An interpreter that a step puts ahead of the shims (a `node` from
   `setup-node`) is not wrapped; it still inherits the wrapped step's pipes when started from a
   shimmed shell.
2. **P2: `CI=true` and `GITHUB_ACTIONS=true`.** act sets both for every step (`env["CI"] = "true"`
   and `env["GITHUB_ACTIONS"] = "true"` in `pkg/runner/run_context.go`, v0.2.97). Pinned by the
   end-to-end parity job.
3. **P3: `TERM` is unset.** The runner process has no terminal, so none. `env -u TERM` keeps the
   controller's own TERM out of the sandbox. bash itself reports `dumb` for an unset `TERM`, which
   is what a bash step sees on GitHub. GitHub does not document this; it is read from the widely
   reported `tput`/`clear` "TERM environment variable not set" errors on hosted runners.
   Verify with a probe workflow on GitHub if it ever matters; the tests accept unset or `dumb`
   and refuse anything else.
4. **P4: `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`.** (The customer's own controller runs each part as
   `part.sh > file 2>&1` with the same locale, TERM unset or dumb, and stdin not a terminal.) act's own container mode sets it with the comment "Use same locale as
   GitHub Actions" (`run_context.go`), and actions/runner-images sets no `LANG` or `LC_ALL` in
   `/etc/environment`, so the Ubuntu image default applies. The sandbox image may have no locale
   (POSIX), which changes sorting, case folding and character handling.
5. **P5: no pager, no prompt.** `GIT_PAGER=cat`, `PAGER=cat`, `GIT_TERMINAL_PROMPT=0`. Not a
   GitHub variable: with no terminal GitHub has no pager to block on, and git never prompts.

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

## Whole workflows

`planWorkflow(yaml, event, { readFile })` plans every job: the trigger match (`matchTrigger`:
branches, tags, paths, activity types), the graph with matrices expanded (include, exclude,
fail-fast, max-parallel), static `if:` results, and jobs that cannot run here marked
`unsupported` with the reason. `if:` that reads `needs` is evaluated at schedule time with
`evaluateCondition` (the expression subset: contexts, operators, success/failure/always/cancelled,
contains, startsWith, endsWith, fromJSON, toJSON, join, format; anything else throws `ExprError`
naming the feature). A matrix built from an expression (`fromJSON(needs...)`) is marked unsupported.

`splitJob` generates a single-job workflow for one job (one matrix leg) whose needed jobs are
stubs carrying the real result and outputs as literals, so `needs.x.outputs.y` and
`needs.x.result` resolve in act. A final `if: always()` step writes the job's declared outputs to
files that `runJob` reads back, because act's JSON stream has none. A job with
`continue-on-error` that fails counts as `success` for its dependents.

## Parity assumptions

Places where the engine had to pick a behaviour that GitHub documents loosely or not at all.
Each one is checked against the GitHub checks API on the same sha; tick them off here.

1. **continue-on-error.** A job that fails with `continue-on-error: true` reports
   `needs.<job>.result == 'success'` to its dependents, and the run does not fail. The job
   itself is stored as `failure`.
2. **Implicit success().** A job with no `if:` (or `success()`) runs only when every need
   succeeded. A skipped need skips the dependent, as does a failed or cancelled one. Only
   `always()`, `!cancelled()` or an explicit `needs.x.result` test lets it run.
3. **Unsupported jobs are skipped.** A job that needs docker, runs on a non-Linux runner or calls
   a reusable workflow is recorded as `skipped` with the reason, and dependents see `skipped`.
   GitHub would run it; this is an engine limit, not parity.
4. **infra_error needs.** A needed job that ended in `infra_error` counts as `failure` for its
   dependents.
5. **Matrix needs.** `needs.<id>.result` for a matrix job is `failure` if any leg failed, else
   `cancelled` if any was cancelled, else `skipped` if all were skipped, else `success`.
6. **Matrix outputs.** Outputs of the legs merge in leg order; a later non-empty value wins.
7. **Fail-fast.** On a failed leg (without continue-on-error) queued sibling legs are cancelled.
   Legs already running finish.
8. **Plan-time `if:`.** An `if:` that reads only github, vars, inputs, env or matrix is decided
   at plan time and the job is skipped with no sandbox. The `github.event` payload holds only
   `action` and, for pull requests, `pull_request.base.ref`, `head.ref`, `head.sha` and `draft`;
   any other field is null.
9. **Path filters without a change list.** When changed files are not supplied the filter is not
   applied and the run proceeds, with a note.
10. **Filter globs.** `?` and `+` apply to the preceding character, `**/` matches zero or more
    directories, and the last matching pattern wins with `!` negation.
11. **Workflow concurrency** is evaluated and recorded but not enforced: a local run never
    cancels another.
12. **Stub need results.** A needed job's result reaches act as a stub: success runs `true`, skipped
    is `if: false`, failure and cancelled run `exit 1` (so `needs.x.result` reads `failure` for
    cancelled).
13. **Job outputs.** Read from files written by a generated final step, as UTF-8 text. An output
    over 1 MiB, or one whose step never ran, is unset. Output names must be identifiers.
14. **Expression semantics.** String comparison is case-insensitive, mixed types compare as
    numbers, `&&` and `||` return operands, and property names are case-insensitive, as GitHub
    documents. `hashFiles` and `.*` filters are not evaluated by the planner (act evaluates
    step-level `hashFiles` itself).

## Tests

- `tests/plan.test.ts`, `tests/events.test.ts` (recorded-style fixtures in `tests/fixtures`) and
  `tests/run-job.test.ts` (against the fake provider with a stand-in `act`) run locally.
- `tests/e2e.test.ts` runs `examples/hello` end to end with the Docker provider. CI only
  (`bun run test:act-e2e`, job `act-runner-e2e`). The image is `node:22-bookworm`, pinned by
  digest, because host mode needs bash, git and node; `ubuntu:24.04` has none of them.
