// Notices Longshore writes at the top of a job log. Parsed from the first lines only, as text.

export type LogNotice = { kind: "isolation_override" | "egress_unverified"; text: string };

const ISOLATION = "[longshore] isolation override:";
const EGRESS = "[longshore] egress canary could not run";

/** Notices Longshore writes at the top of a job log, read from its first lines only. */
export function parseLogNotices(head: string): LogNotice[] {
  const out: LogNotice[] = [];
  for (const line of head.split("\n").slice(0, 8)) {
    if (!line.startsWith("[longshore] ")) break;
    if (line.startsWith(ISOLATION)) out.push({ kind: "isolation_override", text: line.slice(12) });
    else if (line.startsWith(EGRESS)) out.push({ kind: "egress_unverified", text: line.slice(12) });
  }
  return out;
}
