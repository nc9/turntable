import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "@/api";
import { LogParser } from "@/log/parser";

/** Bytes of log held in the view. "Load more" raises it by this much. */
export const VIEW_CAP = 2 * 1024 * 1024;

export type LogStatus = "loading" | "ready" | "error";

export type LogModel = {
  parser: LogParser;
  /** Bumps whenever the parser changed; use it as a dependency. */
  version: number;
  status: LogStatus;
  error: string | null;
  /** Bytes known to exist in the attempt's log right now. */
  knownSize: number;
  /** True when more bytes exist beyond what is in the view. */
  truncated: boolean;
  /** True when the attempt is finished and the whole log is in the view. */
  complete: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
};

/**
 * Loads one attempt's log: first window by offset, then the live stream from the next byte
 * offset. Reconnects resume from `parser.nextOffset`, so nothing is lost or duplicated.
 */
export function useAttemptLog(attemptId: string | null, active: boolean): LogModel {
  const [parser, setParser] = useState(() => new LogParser(0));
  const parserRef = useRef(parser);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<LogStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [knownSize, setKnownSize] = useState(0);
  const [eof, setEof] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cap, setCap] = useState(VIEW_CAP);
  const [resub, setResub] = useState(0);
  const [retryN, setRetryN] = useState(0);
  const raf = useRef<number | null>(null);
  const capRef = useRef(cap);
  capRef.current = cap;
  const knownRef = useRef(0);

  const bump = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      setVersion(parserRef.current.version);
      setKnownSize(knownRef.current);
    });
  }, []);

  // New attempt (or retry): fresh parser and first window.
  useEffect(() => {
    const fresh = new LogParser(0);
    parserRef.current = fresh;
    knownRef.current = 0;
    setParser(fresh);
    setVersion(0);
    setKnownSize(0);
    setEof(false);
    setCap(VIEW_CAP);
    setError(null);
    if (!attemptId) {
      setStatus("ready");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    getBackend()
      .api.jobLog({ attemptId, offset: 0, limit: VIEW_CAP })
      .then(
        (slice) => {
          if (cancelled) return;
          fresh.push(slice.bytes, slice.offset);
          knownRef.current = slice.size;
          if (slice.done) setEof(true);
          setVersion(fresh.version);
          setKnownSize(slice.size);
          setStatus("ready");
          setResub((n) => n + 1);
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : "Could not load the log");
          setStatus("error");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [attemptId, retryN]);

  // Live stream, resumed from the next byte offset. Stops at the view cap and at end of log.
  useEffect(() => {
    if (!attemptId || status !== "ready" || eof) return;
    const p = parserRef.current;
    if (p.nextOffset >= capRef.current) return;
    const off = getBackend().realtime.subscribe(
      { kind: "attempt-log", attemptId },
      { offset: p.nextOffset },
      (msg) => {
        if (msg.type === "reset") {
          setResub((n) => n + 1);
          return;
        }
        if (msg.type !== "log" || msg.attemptId !== attemptId) return;
        knownRef.current = Math.max(knownRef.current, msg.offset + msg.data.length);
        if (p.nextOffset < capRef.current) p.push(msg.data, msg.offset);
        if (msg.eof) setEof(true);
        bump();
      },
    );
    return off;
    // `resub` restarts the subscription from the parser's current offset
  }, [attemptId, status, eof, resub, cap, bump]);

  // The attempt finished while we were following: pick up anything the stream missed.
  useEffect(() => {
    if (active || !attemptId || status !== "ready" || eof) return;
    let cancelled = false;
    const p = parserRef.current;
    getBackend()
      .api.jobLog({
        attemptId,
        offset: p.nextOffset,
        limit: Math.max(0, capRef.current - p.nextOffset),
      })
      .then(
        (slice) => {
          if (cancelled) return;
          if (slice.bytes.length > 0) p.push(slice.bytes, slice.offset);
          knownRef.current = slice.size;
          if (slice.done) setEof(true);
          bump();
        },
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [active, attemptId, status, eof, bump]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const loadMore = useCallback(() => {
    if (!attemptId || loadingMore) return;
    const p = parserRef.current;
    const nextCap = capRef.current + VIEW_CAP;
    setLoadingMore(true);
    getBackend()
      .api.jobLog({ attemptId, offset: p.nextOffset, limit: nextCap - p.nextOffset })
      .then(
        (slice) => {
          if (slice.bytes.length > 0) p.push(slice.bytes, slice.offset);
          knownRef.current = slice.size;
          setCap(nextCap);
          if (slice.done) setEof(true);
          setVersion(p.version);
          setKnownSize(slice.size);
          setResub((n) => n + 1);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : "Could not load more"),
      )
      .finally(() => setLoadingMore(false));
  }, [attemptId, loadingMore]);

  const truncated = knownSize > parser.nextOffset;
  return {
    parser,
    version,
    status,
    error,
    knownSize,
    truncated,
    complete: eof && !truncated,
    loadingMore,
    loadMore,
    retry: () => setRetryN((n) => n + 1),
  };
}

/** Download the whole raw log by paging through offsets, independent of the view cap. */
export async function downloadRawLog(attemptId: string, filename: string): Promise<void> {
  const { api } = getBackend();
  const parts: BlobPart[] = [];
  let offset = 0;
  for (;;) {
    const slice = await api.jobLog({ attemptId, offset, limit: 1024 * 1024 });
    if (slice.bytes.length === 0) break;
    parts.push(slice.bytes as Uint8Array<ArrayBuffer>);
    offset += slice.bytes.length;
    if (offset >= slice.size) break;
  }
  const url = URL.createObjectURL(new Blob(parts, { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
