import type { ForwardedSnapshot } from "./types";

/** Counts the forwarded headers the server sees, so doctor can compare them with its settings. */
export class ForwardedObserver {
  #requests = 0;
  #proto = 0;
  #for = 0;

  record(req: Request): void {
    this.#requests += 1;
    if (req.headers.has("x-forwarded-proto")) this.#proto += 1;
    if (req.headers.has("x-forwarded-for")) this.#for += 1;
  }

  snapshot(): ForwardedSnapshot {
    return {
      requests: this.#requests,
      withForwardedProto: this.#proto,
      withForwardedFor: this.#for,
    };
  }
}
