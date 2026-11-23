import { z } from "zod";
import { acceptActionMove, listActionPins } from "../../db/repos";
import { defineOp } from "../define";
import { OpError } from "../errors";

const repoField = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
  .max(200)
  .describe("Action repository as owner/name.");
const shaField = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .describe("A full 40-character commit sha.");

export const listActionPinsOp = defineOp({
  name: "get_action_pins",
  summary: "The remembered tag-to-sha pins of a project, with any unaccepted tag moves.",
  description:
    "Every action reference (repo and tag or branch) a project has resolved, with the commit it " +
    "was pinned to, when it was first and last seen, and `pending_sha` when the tag now points " +
    "somewhere else (a moved tag). A protected or release run fails on a moved tag until an " +
    "operator accepts it with accept_action_move. Needs one project. Read-only.",
  input: z.object({}),
  output: z.object({
    pins: z.array(
      z.object({
        repo: z.string(),
        ref: z.string(),
        sha: z.string(),
        pending_sha: z.string().nullable().describe("Set while a moved tag awaits acceptance."),
        first_seen: z.int(),
        last_seen: z.int(),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "project",
  http: { method: "GET", path: "/action-pins" },
  async handler(ctx) {
    const rows = await listActionPins(ctx.db, ctx.scope);
    return {
      pins: rows.map((r) => ({
        repo: r.repo,
        ref: r.ref,
        sha: r.sha,
        pending_sha: r.pendingSha,
        first_seen: r.firstSeen,
        last_seen: r.lastSeen,
      })),
    };
  },
});

export const acceptActionMoveOp = defineOp({
  name: "accept_action_move",
  // A trust decision (it blesses a moved action tag for protected and release runs).
  mcp: false,
  summary: "Accept a moved action tag: re-pin it to the commit it now points at.",
  description:
    "A tag that used to resolve to one commit and now resolves to another is a moved tag. " +
    "Protected and release runs refuse it; PR runs keep using the old pinned commit. Look at " +
    "the new commit first (get_action_pins shows it as pending_sha), then pass that exact sha " +
    "here to accept the move: the pin changes to it. The sha must equal the pending one, so an " +
    "accept never blesses a commit nobody looked at. Needs one project. Writes and is audited; " +
    "operator role. Not available over MCP: accepting a moved tag is a trust decision a person makes.",
  input: z.object({ repo: repoField, ref: z.string().min(1).max(200), sha: shaField }),
  output: z.object({
    repo: z.string(),
    ref: z.string(),
    previous_sha: z.string(),
    sha: z.string(),
  }),
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/action-pins/accept-move" },
  async handler(ctx, input) {
    const r = await acceptActionMove(ctx.db, ctx.scope, input);
    if (!r.ok) {
      const why = {
        no_pin: "no pin for that repo and ref",
        no_pending_move: "that pin has no moved tag to accept",
        sha_mismatch: "sha is not the commit the tag now points at (see get_action_pins)",
      }[r.reason];
      throw new OpError(r.reason === "no_pin" ? "not_found" : "conflict", why);
    }
    return {
      repo: input.repo.toLowerCase(),
      ref: input.ref,
      previous_sha: r.previousSha,
      sha: input.sha,
    };
  },
});
