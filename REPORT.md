# PR #667 red tests: decisions

## 1. checks.test.ts "only the CLI sets it, per project, audited; off by default; bad values refused" (test:ops2)

Decision: (b), a filter that was too broad, not a broken rule. The setting under test is `checks_mode`, and the PR does not touch it (`git diff origin/main...HEAD` has no checks_mode change; the CLI audit, per-project and bad-value assertions still pass untouched). The failing assertion listed every op matching `/policy/`, which now catches the four new `approval_policy` ops (`get_`, `set_`, `approval_policy_challenge`, `approve_`). Fix: exclude `approval_policy` ops from that filter (the no-op-can-change-checks_mode assertion still holds for everything else) and add an assertion pinning the exact approval_policy op set.

## 2. ops-dispatch.test.ts "signature ops are refused for every principal and token, and absent from the token adapters" (test:ops)

Decision: (b) for the list only. `approve_approval_policy` is a normal signature op (`auth: { type: "signature" }`), like `approve_key_policy`: only a signed approver statement reaches it. There is NO session exception; the web path uses `set_approval_policy` (owner session + step-up, a token-type op), which is not a signature op. So the pinned list of shipped signature ops gains `approve_approval_policy`. Every existing assertion is kept. Added: the shipped `approve_approval_policy` is refused with `signature_required` for a bearer token and for an owner principal, and is absent from `tokenOps()` and the MCP tools.

## Gates (run, all passed)

fmt --check, typecheck, mcp-tools/openapi/page-css/ops-table/config-reference --check, test-wiring; checks, ops-dispatch, settings, session-step-up, approvals (145 pass) and approval-policy-web, settings-approval-policy, settings-writes (38 pass), each on SQLite and pglite.
NOT RUN: a test file named "setting-guard" (none exists; settings-writes is the nearest). Agent principals are not separately dispatched in the test; the dispatcher refuses every non-signed credential for signature ops.
