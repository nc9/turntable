// One helper that removes a checkout token from any text before it reaches an error message, a log
// line or an event. It also removes the forms the token takes on the wire: the Basic credential
// and its base64.
const basic = (token: string): string => Buffer.from(`x-access-token:${token}`).toString("base64");

/** `text` with the token (and its Basic header forms) replaced by `[token]`. No token: unchanged. */
export function scrubToken(text: string, token: string | undefined): string {
  if (!token) return text;
  let out = text;
  for (const secret of [basic(token), token]) out = out.split(secret).join("[token]");
  return out;
}

/** The token as a single stdin line for the child: a small JSON message. */
export function tokenMessage(token: string): string {
  return `${JSON.stringify({ token })}\n`;
}

const TOKEN_SHAPE = /^[\x21-\x7e]{1,1024}$/;

/** Parses the parent's stdin message. An empty message or `{"anonymous":true}` is no token. */
export function parseTokenMessage(raw: string): string | undefined {
  const line = raw.split("\n")[0]?.trim() ?? "";
  if (line === "") return undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    throw new Error("the checkout's credential message is not JSON");
  }
  if (typeof msg !== "object" || msg === null)
    throw new Error("the checkout's credential message is not an object");
  const { token, anonymous } = msg as { token?: unknown; anonymous?: unknown };
  if (anonymous === true && token === undefined) return undefined;
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token))
    throw new Error("the checkout's credential message has no usable token");
  return token;
}
