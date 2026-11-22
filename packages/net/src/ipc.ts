// Calls between two Longshore processes that the operator wired together: the worker asking the
// release lane for a job's proxy credential. The target is configured by the operator (a unix
// socket path, or an https address with mutual TLS), never taken from a job or a request, so it
// does not go through the address validation that outbound requests to the internet do. It lives
// here so that no other module reaches for fetch.

export type ControlTarget =
  /** A unix socket on this machine. */
  | { unix: string }
  /** An https address, with this process's client certificate and the CA of the server. */
  | { url: string; tls: { cert: string; key: string; ca: string } };

export interface ControlReply {
  status: number;
  json: unknown;
}

const MAX_REPLY = 64 * 1024;

/** One JSON POST to a control endpoint, with a timeout and a small reply cap. */
export async function controlPost(
  target: ControlTarget,
  path: string,
  body: unknown,
  o: { timeoutMs?: number } = {},
): Promise<ControlReply> {
  const base = "unix" in target ? "http://control.local" : target.url.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    ...("unix" in target
      ? { unix: target.unix }
      : { tls: { cert: target.tls.cert, key: target.tls.key, ca: target.tls.ca } }),
  });
  const text = await res.text();
  if (text.length > MAX_REPLY) throw new Error("control reply too large");
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}
