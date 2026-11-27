// Which log store the process uses. Boot sets an external one (ClickHouse); without it every
// call uses the main database, on the handle it is given (so it joins that handle's transaction).
import type { Db } from "../db";
import { DbLogStore } from "./db-store";
import type { LogStore } from "./types";

let external: LogStore | undefined;

export function setLogStore(store: LogStore | undefined): void {
  external = store;
}

/** The external store when one is configured, else the database store on `db`. */
export function logStoreFor(db: Db): LogStore {
  return external ?? new DbLogStore(db);
}

/** The configured external store, or undefined when logs live in the database. */
export function externalLogStore(): LogStore | undefined {
  return external;
}
