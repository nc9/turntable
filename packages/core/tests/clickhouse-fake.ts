// A test double of the ClickHouse HTTP interface for the statements the log store sends. It holds
// rows in memory and answers by recognising the statement shape, with `param_*` bound as
// ClickHouse does. It is not a SQL engine: a statement it does not know fails the test.
import type { SafeFetch } from "@turntable/net";

type Row = {
  org: string;
  project: string;
  attempt: string;
  offset: number;
  bytes: Buffer;
  ms: number;
  seq: number;
};

export type FakeClickHouse = {
  fetch: SafeFetch;
  rows: Row[];
  statements: string[];
  /** Every request's URL, headers and body, for assertions about what goes on the wire. */
  requests: { url: URL; headers: Record<string, string>; body: string }[];
  /** While set, requests fail with this error. */
  down: Error | undefined;
  /** While true, requests never answer (until the caller's deadline). */
  hang: boolean;
  inserts: number;
  /** The TTL the table was last given, in days. */
  ttlDays: number | undefined;
};

export function fakeClickHouse(): FakeClickHouse {
  let seq = 0;
  const f: FakeClickHouse = {
    rows: [],
    statements: [],
    requests: [],
    down: undefined,
    hang: false,
    inserts: 0,
    ttlDays: undefined,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = String(init?.body ?? "");
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      f.requests.push({ url, headers, body });
      if (f.hang) {
        await new Promise((_, rej) =>
          setTimeout(() => rej(new Error("request timed out")), init?.timeoutMs ?? 10_000),
        );
      }
      if (f.down) throw f.down;
      const p = (n: string): string => url.searchParams.get(`param_${n}`) ?? "";
      const ok = (text = "") => new Response(text, { status: 200 });
      const rowsOf = (): Row[] =>
        f.rows.filter((r) => r.org === p("o") && r.project === p("p") && r.attempt === p("a"));
      const dedupe = (rs: Row[]): Row[] => {
        const by = new Map<number, Row>();
        for (const r of rs.sort((a, b) => a.ms - b.ms || a.seq - b.seq))
          if (!by.has(r.offset)) by.set(r.offset, r);
        return [...by.values()].sort((a, b) => a.offset - b.offset);
      };
      const lines = (xs: object[]) =>
        ok(xs.map((x) => JSON.stringify(x)).join("\n") + (xs.length ? "\n" : ""));

      const insertQuery = url.searchParams.get("query");
      if (insertQuery?.startsWith("INSERT INTO")) {
        f.statements.push(insertQuery);
        f.inserts += 1;
        for (const l of body.split("\n").filter(Boolean)) {
          const j = JSON.parse(l) as {
            org_id: string;
            project_id: string;
            attempt_id: string;
            offset: number;
            b64: string;
            ms: number;
          };
          f.rows.push({
            org: j.org_id,
            project: j.project_id,
            attempt: j.attempt_id,
            offset: j.offset,
            bytes: Buffer.from(j.b64, "base64"),
            ms: j.ms,
            seq: seq++,
          });
        }
        return ok();
      }
      const sql = body.replace(/ FORMAT JSONEachRow$/, "");
      f.statements.push(sql);
      if (sql.startsWith("CREATE TABLE") || sql.includes("MODIFY TTL")) {
        const m = /INTERVAL (\d+) DAY/.exec(sql);
        if (m && (f.ttlDays === undefined || sql.includes("MODIFY TTL"))) f.ttlDays = Number(m[1]);
        return ok();
      }
      if (sql.includes("FROM system.tables")) {
        return lines(f.ttlDays === undefined ? [] : [{ q: `TTL x + INTERVAL ${f.ttlDays} DAY` }]);
      }
      if (
        sql.startsWith("ALTER TABLE") &&
        sql.includes(" DELETE WHERE org_id = {o:String} AND project_id")
      ) {
        f.rows = f.rows.filter((r) => !(r.org === p("o") && r.project === p("p")));
        return ok();
      }
      if (sql.startsWith("ALTER TABLE") && sql.includes(" DELETE WHERE")) {
        const k = rowsOf();
        f.rows = f.rows.filter((r) => !k.includes(r));
        return ok();
      }
      if (sql.includes("any(length(bytes))")) {
        const first = new Map<string, Row>();
        for (const r of f.rows.filter((r) => r.org === p("o")))
          if (!first.has(`${r.project}/${r.attempt}/${r.offset}`))
            first.set(`${r.project}/${r.attempt}/${r.offset}`, r);
        const n = [...first.values()].reduce((a, r) => a + r.bytes.length, 0);
        return lines([{ n: String(n) }]);
      }
      if (sql.includes("uniqExact(offset)")) {
        const d = dedupe(rowsOf());
        return lines([
          {
            c: String(d.length),
            s: String(d.reduce((m, r) => Math.max(m, r.offset + r.bytes.length), 0)),
          },
        ]);
      }
      if (sql.startsWith("SELECT DISTINCT offset")) {
        const list = /offset IN \(([\d,]*)\)/.exec(sql)?.[1]?.split(",").map(Number) ?? [];
        return lines(
          [
            ...new Set(
              rowsOf()
                .filter((r) => list.includes(r.offset))
                .map((r) => r.offset),
            ),
          ].map((o) => ({ offset: String(o) })),
        );
      }
      if (sql.includes("base64Encode(bytes) AS b")) {
        let rs = dedupe(rowsOf());
        if (sql.includes("{from:UInt64}") && !sql.includes("{to:UInt64}"))
          rs = rs.filter((r) => r.offset >= Number(p("from")));
        if (sql.includes("{to:UInt64}"))
          rs = rs.filter(
            (r) => r.offset < Number(p("to")) && r.offset + r.bytes.length > Number(p("from")),
          );
        return lines(rs.map((r) => ({ offset: String(r.offset), b: r.bytes.toString("base64") })));
      }
      if (sql.startsWith("SELECT offset FROM") && sql.includes("{pat:String}")) {
        const pat = p("pat");
        const test = sql.includes("match(bytes")
          ? (
              (re) => (t: string) =>
                re.test(t)
            )(new RegExp(pat.replace(/^\(\?i\)/, ""), pat.startsWith("(?i)") ? "i" : ""))
          : sql.includes("positionCaseInsensitiveUTF8")
            ? (t: string) => t.toLowerCase().includes(pat.toLowerCase())
            : (t: string) => t.includes(pat);
        const hit = [
          ...new Set(
            rowsOf()
              .filter((r) => r.offset >= Number(p("from")) && test(r.bytes.toString("utf8")))
              .map((r) => r.offset),
          ),
        ].sort((a, b) => a - b);
        return lines(hit.slice(0, Number(p("lim"))).map((o) => ({ offset: String(o) })));
      }
      return new Response(`unknown statement: ${sql.slice(0, 100)}`, { status: 400 });
    },
  };
  return f;
}
