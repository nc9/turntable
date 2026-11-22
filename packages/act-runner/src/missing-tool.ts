// A step that runs a tool the image does not have exits 127 with a one-line shell message, which
// in a long log reads as a bare failure. This finds the tool name in that message so the log can
// say so plainly. It only annotates; the step's result is whatever act reported.

/** The shells' wording: bash `foo: command not found`, dash `foo: not found`. */
const NOT_FOUND = /(?:^|[\s:])([A-Za-z0-9][A-Za-z0-9._+-]{0,63}): (?:command )?not found\s*$/m;
/** `env: 'foo': No such file or directory`, from a launcher that execs the tool directly. */
const ENV_MISSING = /^env: '([A-Za-z0-9][A-Za-z0-9._+-]{0,63})': No such file or directory\s*$/m;

/** The name of the missing tool in a step's output, or undefined. */
export function missingTool(output: string): string | undefined {
  const m = NOT_FOUND.exec(output) ?? ENV_MISSING.exec(output);
  return m?.[1];
}

/** The line the log shows. */
export function missingToolNotice(tool: string): string {
  return `${tool} is not available on this image (see the compatibility list: /compatibility)\n`;
}
