// Parity comparison: our run's jobs against the check runs another CI posted for the same commit.
// Pure: it takes both sides as data and says, job by job, whether they agree. Nothing here knows
// who the other CI is. Rules:
//  - jobs are paired by name (exact, then case-insensitive);
//  - conclusions are normalised to success, failure, cancelled, skipped, error or pending;
//  - our `skipped` equals their `success` when our job was gated off by its `if:` (a CI that
//    reports a skipped required job as success, which is what a required check needs). The reason
//    is kept in the output. A skip for any other reason (unsupported, cannot evaluate) is a
//    divergence;
//  - their contexts we do not run are "not ours"; our jobs they do not post are "not reported".

export type OurJob = {
  name: string;
  /** Our job state: success, failure, skipped, cancelled, infra_error, queued, running ... */
  state: string;
  durationMs: number | null;
  /** For a skipped job: the stored reason (`if: <expr> is false`, `unsupported: ...`). */
  skipReason?: string | null | undefined;
};

export type TheirCheck = {
  name: string;
  /** GitHub's `status`: queued, in_progress or completed. */
  status: string;
  /** GitHub's `conclusion`; null until completed. */
  conclusion: string | null;
  durationMs: number | null;
};

export type Norm = "success" | "failure" | "cancelled" | "skipped" | "error" | "pending";

export function normOurs(state: string): Norm {
  switch (state) {
    case "success":
    case "failure":
    case "cancelled":
    case "skipped":
      return state;
    case "infra_error":
      return "error";
    default:
      return "pending";
  }
}

export function normTheirs(status: string, conclusion: string | null): Norm {
  if (status !== "completed" || conclusion === null) return "pending";
  switch (conclusion) {
    case "success":
    case "failure":
    case "cancelled":
      return conclusion;
    case "skipped":
    case "neutral":
      return "skipped";
    case "timed_out":
      return "failure";
    case "stale":
      return "cancelled";
    default:
      // action_required, startup_failure and anything new: not comparable as a result
      return "error";
  }
}

export type Verdict = "MATCH" | "DIVERGE" | "PENDING";

export type Row = {
  job: string;
  ours: Norm;
  theirs: Norm;
  oursState: string;
  theirsConclusion: string | null;
  oursDurationMs: number | null;
  theirsDurationMs: number | null;
  verdict: Verdict;
  note: string;
};

export type ParityReport = {
  /** Divergences first, then pending, then matches; stable within each. */
  rows: Row[];
  notOurs: { name: string; conclusion: string | null; durationMs: number | null }[];
  notReported: { name: string; state: string; durationMs: number | null }[];
  totals: {
    match: number;
    diverge: number;
    pending: number;
    /** Matches that rest on the gated-skip rule (a subset of `match`). */
    gatedSkips: number;
    notOurs: number;
    notReported: number;
  };
};

const GATED = /^if: (.*) is false$/s;

/** `if: <expr> is false`: the gate is the job's own condition, so a CI that reports it as success agrees. */
export function gatedBy(reason: string | null | undefined): string | undefined {
  const m = reason ? GATED.exec(reason.trim()) : null;
  return m ? (m[1] as string).trim() : undefined;
}

const key = (s: string): string => s.trim().toLowerCase();

export function compareParity(
  ours: readonly OurJob[],
  theirs: readonly TheirCheck[],
): ParityReport {
  // Their checks by exact name, then by lowercase name; each is paired at most once, in order.
  const unmatched = [...theirs];
  const take = (name: string): TheirCheck | undefined => {
    let i = unmatched.findIndex((t) => t.name === name);
    if (i < 0) i = unmatched.findIndex((t) => key(t.name) === key(name));
    return i < 0 ? undefined : unmatched.splice(i, 1)[0];
  };
  const rows: Row[] = [];
  const notReported: ParityReport["notReported"] = [];
  for (const job of ours) {
    const t = take(job.name);
    if (!t) {
      notReported.push({ name: job.name, state: job.state, durationMs: job.durationMs });
      continue;
    }
    const o = normOurs(job.state);
    const th = normTheirs(t.status, t.conclusion);
    let verdict: Verdict;
    let note = "";
    if (o === "pending" || th === "pending") {
      verdict = "PENDING";
      note = o === "pending" ? `ours is ${job.state}` : "theirs has not completed";
    } else if (o === th && o !== "error") {
      verdict = "MATCH";
    } else if (o === "skipped" && th === "success") {
      const gate = gatedBy(job.skipReason);
      if (gate !== undefined) {
        verdict = "MATCH";
        note = `ours skipped by if: ${gate}; their success stands for a skipped required job`;
      } else {
        verdict = "DIVERGE";
        note = `ours skipped (${job.skipReason?.trim() || "no reason recorded"}), not by an if:`;
      }
    } else {
      verdict = "DIVERGE";
      note = `ours ${job.state}, theirs ${t.conclusion ?? t.status}`;
    }
    rows.push({
      job: job.name,
      ours: o,
      theirs: th,
      oursState: job.state,
      theirsConclusion: t.conclusion,
      oursDurationMs: job.durationMs,
      theirsDurationMs: t.durationMs,
      verdict,
      note,
    });
  }
  const order: Record<Verdict, number> = { DIVERGE: 0, PENDING: 1, MATCH: 2 };
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .toSorted((a, b) => order[a.r.verdict] - order[b.r.verdict] || a.i - b.i)
    .map((x) => x.r);
  return {
    rows: sorted,
    notOurs: unmatched.map((t) => ({
      name: t.name,
      conclusion: t.conclusion,
      durationMs: t.durationMs,
    })),
    notReported,
    totals: {
      match: rows.filter((r) => r.verdict === "MATCH").length,
      diverge: rows.filter((r) => r.verdict === "DIVERGE").length,
      pending: rows.filter((r) => r.verdict === "PENDING").length,
      gatedSkips: rows.filter(
        (r) => r.verdict === "MATCH" && r.ours === "skipped" && r.theirs === "success",
      ).length,
      notOurs: unmatched.length,
      notReported: notReported.length,
    },
  };
}

const fmtMs = (ms: number | null): string => {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** The report as a plain table: divergences first, then the lists that did not pair, then totals. */
export function renderParity(r: ParityReport, head: { run: string; sha: string | null }): string {
  const out: string[] = [
    `parity for run ${head.run}${head.sha ? ` at ${head.sha.slice(0, 12)}` : ""}`,
    "",
  ];
  const cell = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length));
  if (r.rows.length > 0) {
    const w = Math.max(3, ...r.rows.map((x) => x.job.length));
    out.push(`${cell("JOB", w)}  ${cell("OURS", 18)}  ${cell("THEIRS", 18)}  VERDICT`);
    for (const x of r.rows) {
      const ours = `${x.oursState} ${fmtMs(x.oursDurationMs)}`;
      const theirs = `${x.theirsConclusion ?? "pending"} ${fmtMs(x.theirsDurationMs)}`;
      out.push(`${cell(x.job, w)}  ${cell(ours, 18)}  ${cell(theirs, 18)}  ${x.verdict}`);
      if (x.note) out.push(`${cell("", w)}  ${x.note}`);
    }
    out.push("");
  }
  if (r.notOurs.length > 0) {
    out.push("not ours (they report a context we do not run):");
    for (const x of r.notOurs)
      out.push(`  ${x.name}  ${x.conclusion ?? "pending"} ${fmtMs(x.durationMs)}`);
    out.push("");
  }
  if (r.notReported.length > 0) {
    out.push("not reported (our job, no matching check from them):");
    for (const x of r.notReported) out.push(`  ${x.name}  ${x.state} ${fmtMs(x.durationMs)}`);
    out.push("");
  }
  const t = r.totals;
  out.push(
    `${t.match} match (${t.gatedSkips} by the gated-skip rule), ${t.diverge} diverge, ${t.pending} pending, ${t.notOurs} not ours, ${t.notReported} not reported`,
  );
  return out.join("\n");
}

export type ParityVerdictWord = "match" | "diverge" | "pending";

/** One word for a whole comparison: any divergence, else anything unfinished (or nothing paired), else match. */
export function verdictOf(r: ParityReport): { word: ParityVerdictWord; text: string } {
  if (r.totals.diverge > 0) return { word: "diverge", text: `${r.totals.diverge} diverge` };
  if (r.totals.pending > 0 || r.rows.length === 0) return { word: "pending", text: "pending" };
  return { word: "match", text: "match" };
}
