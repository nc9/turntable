// The cache service: the actions/cache v1 REST protocol (the `_apis/artifactcache` API that act's
// own cache server and actions/cache speak), served from the control plane with the namespace
// rules of #38. act v0.2.97 implements only this protocol, not the newer twirp service.
//
// The job reaches it at `<base>/_cache/<token>/` (that is what ACTIONS_CACHE_URL is set to). The
// token names a grant minted for one attempt: it fixes the job's namespace, which the client can
// neither see nor change, and it stops working when the attempt ends.
import type { Db } from "../db";
import {
  completeCacheEntry,
  deleteCacheEntry,
  evictCacheClass,
  existingCacheIds,
  expirePendingCache,
  PENDING_TTL_MS,
  findCacheEntry,
  getCacheEntryIn,
  reserveCacheEntry,
  touchCacheEntry,
} from "../db/repos";
import type { TrustClass } from "../trust";
import { type CacheGrant, CacheGrants } from "./grants";
import { CLASS_SHARE, readableNamespaces } from "./namespace";
import type { CacheBlobStore } from "./store";
import { canonicalizeArchive } from "./canon";
import { ArchiveError, ArchiveTooLargeError, DEFAULT_RULES, type ArchiveRules } from "./tar";

export const CACHE_PREFIX = "/_cache/";
const API = "/_apis/artifactcache";
const MAX_KEY = 512;

export type CacheOptions = {
  db: Db;
  store: CacheBlobStore;
  grants: CacheGrants;
  /** Bytes an org may hold in total. Each class gets a share (see CLASS_SHARE). */
  orgQuotaBytes: number;
  /** Largest single entry. */
  maxEntryBytes: number;
  /** Public base URL the sandbox reaches the service at, no trailing slash. */
  baseUrl: string;
  rules?: ArchiveRules;
  /**
   * Most the unpacked contents of one archive may be, as a multiple of the size reserved for it
   * (default 8). Stops a compression bomb early, before it is written out.
   */
  maxExpansion?: number;
  now?: () => number;
  /** Whether the grant's attempt is still running (a revoked-by-state check). Default: yes. */
  isActive?: (g: CacheGrant) => Promise<boolean>;
};

const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });

function parseContentRange(h: string | null): { start: number } | undefined {
  const m = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(h ?? "");
  return m ? { start: Number(m[1]) } : undefined;
}

export type CacheService = {
  /** Handles `/_cache/...`; undefined for any other path. */
  handle(req: Request): Promise<Response | undefined>;
  /** The URL a job's ACTIONS_CACHE_URL is set to for a grant token. */
  urlFor(token: string): string;
  grants: CacheGrants;
  /** Drops uploads that never committed. */
  sweep(): Promise<void>;
};

export function createCacheService(o: CacheOptions): CacheService {
  const now = o.now ?? Date.now;
  const rules = o.rules ?? DEFAULT_RULES;
  const base = o.baseUrl.replace(/\/+$/, "");
  const classLimit = (klass: string) =>
    Math.floor(o.orgQuotaBytes * (CLASS_SHARE[klass as TrustClass] ?? 0));

  // A generation per entry id. Dropping an entry (expiry, eviction, refusal) bumps it, which
  // aborts any upload still writing to it: an expired reservation can never recreate a file.
  const gens = new Map<number, number>();
  const genOf = (id: number) => gens.get(id) ?? 0;
  const bump = (id: number) => gens.set(id, genOf(id) + 1);
  const dropBlobs = async (ids: number[]) => {
    for (const id of ids) {
      bump(id);
      await o.store.delete(id).catch(() => {});
      states.delete(id);
      for (const set of pendingByAttempt.values()) set.delete(id);
    }
  };

  // Per entry: how many uploads are writing, and whether a commit has the staging file. A commit
  // waits for no one: it is refused while an upload is in flight, and uploads are refused once it
  // starts, so the bytes that were validated are the bytes that get served. Both checks and their
  // updates happen in one synchronous step after the awaits, so they cannot interleave.
  const states = new Map<number, { inflight: number; committing: boolean }>();
  const stateOf = (id: number) => {
    let st = states.get(id);
    if (!st) states.set(id, (st = { inflight: 0, committing: false }));
    return st;
  };
  // Uncommitted reservations per attempt, so one job cannot reserve without bound.
  const pendingByAttempt = new Map<string, Set<number>>();
  const MAX_PENDING_PER_GRANT = 16;
  const MAX_PENDING_PER_PROJECT_CLASS = 64;
  const finishPending = (attemptId: string, id: number) => {
    const set = pendingByAttempt.get(attemptId);
    set?.delete(id);
    if (set && set.size === 0) pendingByAttempt.delete(attemptId);
  };

  async function grantOf(token: string): Promise<CacheGrant | undefined> {
    const g = o.grants.verify(token);
    if (!g) return undefined;
    if (o.isActive && !(await o.isActive(g))) {
      o.grants.revoke(g.attemptId);
      return undefined;
    }
    return g;
  }

  async function find(g: CacheGrant, url: URL, token: string): Promise<Response> {
    const keys = (url.searchParams.get("keys") ?? "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k !== "" && k.length <= MAX_KEY);
    const version = url.searchParams.get("version") ?? "";
    if (keys.length === 0 || keys.length > 10 || version === "" || version.length > 128)
      return json(400, { error: "keys and version are required" });
    // The namespaces searched are the grant's, in order; the client cannot add one.
    for (const ns of readableNamespaces(g.own, { releaseRestore: g.releaseRestore })) {
      const hit = await findCacheEntry(o.db, ns, keys, version);
      if (hit) {
        return json(200, {
          result: "hit",
          archiveLocation: `${base}${CACHE_PREFIX}${token}${API}/artifacts/${hit.id}`,
          cacheKey: hit.key,
        });
      }
    }
    return json(204);
  }

  async function reserve(g: CacheGrant, req: Request): Promise<Response> {
    let body: { key?: unknown; version?: unknown; cacheSize?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { error: "bad request body" });
    }
    const key = typeof body.key === "string" ? body.key.toLowerCase() : "";
    const version = typeof body.version === "string" ? body.version : "";
    const size = body.cacheSize;
    if (
      key === "" ||
      key.length > MAX_KEY ||
      key.includes(",") ||
      version === "" ||
      version.length > 128
    )
      return json(400, { error: "invalid key or version" });
    // The size is what is charged to the class and the most an upload may write: it must be a
    // real, positive number, so a reservation cannot be free and then grow.
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0)
      return json(400, { error: "cacheSize must be a positive integer" });
    if (size > o.maxEntryBytes) return json(413, { error: "cache entry is too large" });
    if ((pendingByAttempt.get(g.attemptId)?.size ?? 0) >= MAX_PENDING_PER_GRANT)
      return json(429, { error: "too many uncommitted cache reservations for this job" });
    // Reclaim reservations that outlived the upload window, then make room inside this class's
    // share, never in another's.
    await dropBlobs(await expirePendingCache(o.db, now()));
    const room = await evictCacheClass(o.db, {
      orgId: g.own.orgId,
      klass: g.own.klass,
      limit: classLimit(g.own.klass),
      needed: size,
      staleBefore: now() - PENDING_TTL_MS,
    });
    await dropBlobs(room.removed);
    if (!room.fits) return json(413, { error: "cache quota for this trust class is full" });
    const r = await reserveCacheEntry(o.db, g.own, {
      key,
      version,
      size,
      now: now(),
      maxPendingBytes: Math.max(
        Math.floor(classLimit(g.own.klass) / 2),
        Math.min(classLimit(g.own.klass), o.maxEntryBytes),
      ),
      maxPendingCount: MAX_PENDING_PER_PROJECT_CLASS,
    });
    if ("pendingFull" in r)
      return json(429, { error: "too many uncommitted cache reservations for this project" });
    if ("conflict" in r) return json(409, { error: "a cache with this key and version exists" });
    let set = pendingByAttempt.get(g.attemptId);
    if (!set) pendingByAttempt.set(g.attemptId, (set = new Set()));
    set.add(r.id);
    return json(200, { cacheId: r.id });
  }

  async function upload(g: CacheGrant, req: Request, id: number): Promise<Response> {
    // Writes go only to an entry of the grant's own namespace.
    const e = await getCacheEntryIn(o.db, g.own, id);
    if (!e) return json(400, { error: `cache ${id}: not reserved` });
    if (e.complete === 1) return json(400, { error: `cache ${id}: already complete` });
    const range = parseContentRange(req.headers.get("content-range"));
    if (!range) return json(400, { error: "Content-Range is required" });
    if (!req.body) return json(400, { error: "empty body" });
    // A commit that has started owns the staging file: no more writes.
    const st = stateOf(id);
    if (st.committing) return json(409, { error: `cache ${id}: commit in progress` });
    if (now() - e.createdAt >= PENDING_TTL_MS)
      return json(409, { error: `cache ${id}: the reservation expired` });
    st.inflight++;
    const gen = genOf(id);
    try {
      let offset = range.start;
      for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
        // Never past the reserved size, which is what the class was charged for.
        if (offset + chunk.length > e.size)
          return json(413, { error: "upload is larger than the reserved size" });
        // Every chunk needs a live pending row of the same generation: a reservation that was
        // reclaimed meanwhile ends the upload and leaves no file behind.
        const live = await getCacheEntryIn(o.db, g.own, id);
        if (
          genOf(id) !== gen ||
          !live ||
          live.complete === 1 ||
          now() - live.createdAt >= PENDING_TTL_MS
        ) {
          if (!live) await o.store.delete(id).catch(() => {});
          return json(409, { error: `cache ${id}: the reservation is gone` });
        }
        await o.store.write(id, offset, chunk);
        if (genOf(id) !== gen) {
          await o.store.delete(id).catch(() => {});
          return json(409, { error: `cache ${id}: the reservation is gone` });
        }
        offset += chunk.length;
      }
      return json(200);
    } finally {
      st.inflight--;
    }
  }

  async function commit(g: CacheGrant, req: Request, id: number): Promise<Response> {
    const e = await getCacheEntryIn(o.db, g.own, id);
    if (!e) return json(400, { error: `cache ${id}: not reserved` });
    if (e.complete === 1) return json(400, { error: `cache ${id}: already complete` });
    let declared = 0;
    try {
      declared = Number(((await req.json()) as { size?: unknown }).size ?? 0);
    } catch {
      // the size is optional
    }
    // Take the staging file: refused while an upload is writing, and uploads are refused from now.
    const st = stateOf(id);
    if (st.committing) return json(409, { error: `cache ${id}: commit in progress` });
    if (st.inflight > 0) return json(409, { error: `cache ${id}: an upload is still in progress` });
    st.committing = true;
    const bad = async (status: number, msg: string) => {
      await deleteCacheEntry(o.db, g.own, id);
      await o.store.delete(id);
      bump(id);
      states.delete(id);
      finishPending(g.attemptId, id);
      return json(status, { error: msg });
    };
    try {
      const size = await o.store.stagedSize(id);
      if (size === null) return await bad(400, "nothing was uploaded");
      if (size !== e.size) return await bad(400, "uploaded size does not match the reservation");
      if (declared > 0 && declared !== size) return await bad(400, "uploaded size does not match");
      // The client's bytes are never served back. Parse the staging file under every rule and
      // write a fresh archive of the entries that pass; that is what gets stored and served.
      const staged = await o.store.stagedPath(id);
      const scratch = await o.store.scratchPath(id);
      try {
        if (staged === null) throw new ArchiveError("blob is missing");
        await canonicalizeArchive(
          staged,
          scratch,
          {
            ...rules,
            maxUncompressed: Math.min(rules.maxUncompressed, e.size * (o.maxExpansion ?? 8)),
          },
          { maxOutputBytes: o.maxEntryBytes },
        );
      } catch (err) {
        if (err instanceof ArchiveTooLargeError) return await bad(413, err.message);
        if (err instanceof ArchiveError) return await bad(400, `archive refused: ${err.message}`);
        throw err;
      }
      const canonSize = (await o.store.scratchSize(id)) ?? 0;
      if (canonSize > o.maxEntryBytes) return await bad(413, "cache entry is too large");
      // The re-emitted archive can differ in size from what was reserved: account for the real one.
      if (canonSize > e.size) {
        const room = await evictCacheClass(o.db, {
          orgId: g.own.orgId,
          klass: g.own.klass,
          limit: classLimit(g.own.klass),
          needed: canonSize - e.size,
          keep: id,
          staleBefore: now() - PENDING_TTL_MS,
        });
        await dropBlobs(room.removed);
        if (!room.fits) return await bad(413, "cache quota for this trust class is full");
      }
      // Served only once renamed from the staging name; the row flips after the bytes are in place.
      await o.store.promote(id);
      await completeCacheEntry(o.db, g.own, id, canonSize, now());
      states.delete(id);
      finishPending(g.attemptId, id);
      return json(200);
    } catch (err) {
      st.committing = false;
      throw err;
    }
  }

  async function artifact(g: CacheGrant, req: Request, id: number): Promise<Response> {
    // Served only from a namespace the grant may read, and only complete, validated entries.
    for (const ns of readableNamespaces(g.own, { releaseRestore: g.releaseRestore })) {
      const e = await getCacheEntryIn(o.db, ns, id);
      if (!e || e.complete !== 1) continue;
      await touchCacheEntry(o.db, ns, id, now());
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
      const res = await o.store.read(
        id,
        m ? { start: Number(m[1]), end: m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER } : undefined,
      );
      return res ?? json(404, { error: "not found" });
    }
    return json(404, { error: "not found" });
  }

  return {
    grants: o.grants,
    urlFor: (token) => `${base}${CACHE_PREFIX}${token}/`,
    async sweep() {
      await dropBlobs(await expirePendingCache(o.db, now()));
      // Files with no row at all (a write that raced a reclaim) are removed.
      const onDisk = await o.store.listIds();
      const live = await existingCacheIds(o.db, onDisk);
      await dropBlobs(onDisk.filter((id) => !live.has(id)));
    },
    async handle(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(CACHE_PREFIX)) return undefined;
      const rest = url.pathname.slice(CACHE_PREFIX.length);
      const slash = rest.indexOf("/");
      const token = slash < 0 ? rest : rest.slice(0, slash);
      const path = slash < 0 ? "" : rest.slice(slash);
      // The same answer for a bad token and an ended job: nothing says which.
      const g = await grantOf(token);
      if (!g) return json(401, { error: "unauthorized" });
      if (!path.startsWith(API)) return json(404, { error: "not found" });
      const route = path.slice(API.length);
      try {
        if (req.method === "GET" && route === "/cache") return await find(g, url, token);
        if (req.method === "POST" && route === "/caches") return await reserve(g, req);
        const m = /^\/(caches|artifacts)\/(\d{1,15})$/.exec(route);
        if (m) {
          const id = Number(m[2]);
          if (m[1] === "caches" && req.method === "PATCH") return await upload(g, req, id);
          if (m[1] === "caches" && req.method === "POST") return await commit(g, req, id);
          if (m[1] === "artifacts" && req.method === "GET") return await artifact(g, req, id);
        }
        if (req.method === "POST" && route === "/clean") return json(200);
        return json(404, { error: "not found" });
      } catch (err) {
        console.error("longshore: cache service error", err);
        return json(500, { error: "internal error" });
      }
    },
  };
}
