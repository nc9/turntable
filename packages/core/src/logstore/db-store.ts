// The `db` log store: chunks in `log_chunks` of the main database (today's behaviour).
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db";
import * as s from "../db/schema";
import { compileSafeRegex } from "../ops/safe-regex";
import {
  assembleRange,
  type LogChunk,
  type LogGrepQuery,
  type LogGrepResult,
  type LogKey,
  type LogStore,
} from "./types";

const GREP_PAGE = 200;

const scopeOf = (k: LogKey) =>
  and(
    eq(s.logChunks.orgId, k.orgId),
    eq(s.logChunks.projectId, k.projectId),
    eq(s.logChunks.attemptId, k.attemptId),
  );

export class DbLogStore implements LogStore {
  readonly kind = "db";
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async append(key: LogKey, offset: number, bytes: Uint8Array): Promise<void> {
    await this.#db.orm
      .insert(s.logChunks)
      .values({ ...key, offset, bytes: Buffer.from(bytes) })
      .onConflictDoNothing();
  }

  read(key: LogKey, fromOffset = 0): Promise<LogChunk[]> {
    return this.#db.run((h) =>
      h.orm
        .select({ offset: s.logChunks.offset, bytes: s.logChunks.bytes })
        .from(s.logChunks)
        .where(and(scopeOf(key), gte(s.logChunks.offset, fromOffset)))
        .orderBy(asc(s.logChunks.offset)),
    );
  }

  async range(key: LogKey, from: number, to: number): Promise<Buffer> {
    if (to <= from) return Buffer.alloc(0);
    const chunks = await this.#db.run((h) =>
      h.orm
        .select({ offset: s.logChunks.offset, bytes: s.logChunks.bytes })
        .from(s.logChunks)
        .where(
          and(
            scopeOf(key),
            lt(s.logChunks.offset, to),
            sql`${s.logChunks.offset} + length(${s.logChunks.bytes}) > ${from}`,
          ),
        )
        .orderBy(asc(s.logChunks.offset)),
    );
    return assembleRange(chunks, from, to);
  }

  async tail(key: LogKey, maxBytes: number): Promise<{ start: number; bytes: Buffer }> {
    const { size } = await this.stat(key);
    const start = Math.max(0, size - maxBytes);
    return { start, bytes: await this.range(key, start, size) };
  }

  async stat(key: LogKey): Promise<{ chunks: number; size: number }> {
    const [row] = await this.#db.run((h) =>
      h.orm
        .select({
          chunks: sql<number>`count(*)`,
          size: sql<number | null>`max(${s.logChunks.offset} + length(${s.logChunks.bytes}))`,
        })
        .from(s.logChunks)
        .where(scopeOf(key)),
    );
    return { chunks: Number(row?.chunks ?? 0), size: Number(row?.size ?? 0) };
  }

  async grep(key: LogKey, q: LogGrepQuery): Promise<LogGrepResult> {
    const match = q.regex
      ? compileSafeRegex(q.pattern, { ignoreCase: q.ignoreCase })
      : q.ignoreCase
        ? (
            (n) => (t: string) =>
              t.toLowerCase().includes(n)
          )(q.pattern.toLowerCase())
        : (t: string) => t.includes(q.pattern);
    const hits: number[] = [];
    let from = q.from;
    for (;;) {
      const page = await this.#db.run((h) =>
        h.orm
          .select({ offset: s.logChunks.offset, bytes: s.logChunks.bytes })
          .from(s.logChunks)
          .where(and(scopeOf(key), gte(s.logChunks.offset, from)))
          .orderBy(asc(s.logChunks.offset))
          .limit(GREP_PAGE),
      );
      for (const c of page) {
        if (match(c.bytes.toString("utf8"))) {
          hits.push(c.offset);
          if (hits.length >= q.limit) return { hits, next: c.offset + 1 };
        }
      }
      if (page.length < GREP_PAGE) return { hits, next: null };
      from = (page.at(-1)?.offset ?? from) + 1;
    }
  }

  async deleteAttempt(key: LogKey): Promise<void> {
    await this.#db.orm.delete(s.logChunks).where(scopeOf(key));
  }

  async deleteProject(orgId: string, projectId: string): Promise<void> {
    await this.#db.orm
      .delete(s.logChunks)
      .where(and(eq(s.logChunks.orgId, orgId), eq(s.logChunks.projectId, projectId)));
  }

  async orgBytes(orgId: string): Promise<number> {
    const [row] = await this.#db.run((h) =>
      h.orm
        .select({ n: sql<number>`coalesce(sum(length(${s.logChunks.bytes})), 0)`.mapWith(Number) })
        .from(s.logChunks)
        .where(eq(s.logChunks.orgId, orgId)),
    );
    return Number(row?.n ?? 0);
  }

  async flush(): Promise<void> {}
}
