import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  describeSqlite,
  instrumentSlowSql,
  slowSqlLine,
  slowSqlMsFromEnv,
} from "../src/db/slow-sql";

test("off unless set; refuses a bad threshold", () => {
  expect(slowSqlMsFromEnv({})).toBeUndefined();
  expect(slowSqlMsFromEnv({ TURNTABLE_SLOW_SQL_MS: "500" })).toBe(500);
  expect(() => slowSqlMsFromEnv({ TURNTABLE_SLOW_SQL_MS: "5" })).toThrow();
});

test("logs the parameterized SQL, never the bound values", () => {
  const lines: string[] = [];
  const db = instrumentSlowSql(new Database(":memory:"), 0, (m) => lines.push(m));
  db.run("CREATE TABLE t (secret TEXT)");
  db.prepare("INSERT INTO t (secret) VALUES (?)").run("hunter2-token");
  expect(db.query("SELECT secret FROM t WHERE secret = ?").get("hunter2-token")).toEqual({
    secret: "hunter2-token",
  });
  expect(lines.some((l) => l.includes("INSERT INTO t (secret) VALUES (?)"))).toBe(true);
  expect(lines.some((l) => l.includes("SELECT secret FROM t WHERE secret = ?"))).toBe(true);
  expect(lines.join("\n")).not.toContain("hunter2-token");
});

test("a line is one line and capped", () => {
  expect(slowSqlLine(1234.6, "SELECT\n  a\nFROM   b")).toBe(
    "[turntable] slow sql 1235 ms: SELECT a FROM b",
  );
  expect(slowSqlLine(1, "x".repeat(500)).length).toBeLessThan(260);
});

test("the boot line names the journal mode and the file sizes", () => {
  const line = describeSqlite(new Database(":memory:"), "/nonexistent/turntable.db");
  expect(line).toContain("journal_mode memory");
  expect(line).toContain("db none, wal none");
});
