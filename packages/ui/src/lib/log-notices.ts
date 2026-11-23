// Notices Turntable writes at the top of a job log. Parsed from the first lines only, as text.

export type LogNotice = { kind: "isolation_override" | "egress_unverified"; text: string };

const ISOLATION = "isolation override:";
const EGRESS = "egress canary could not run";
/** The tag a notice starts with. Logs written before the rename (formerly Longshore) carry the old one. */
const TAGS = ["[turntable] ", "[longshore] "]; // rename-keep

/** Notices Turntable writes at the top of a job log, read from its first lines only. */
export function parseLogNotices(head: string): LogNotice[] {
  const out: LogNotice[] = [];
  for (const line of head.split("\n").slice(0, 8)) {
    const tag = TAGS.find((t) => line.startsWith(t));
    if (tag === undefined) break;
    const rest = line.slice(tag.length);
    if (rest.startsWith(ISOLATION)) out.push({ kind: "isolation_override", text: line.slice(12) });
    else if (rest.startsWith(EGRESS)) out.push({ kind: "egress_unverified", text: line.slice(12) });
  }
  return out;
}
