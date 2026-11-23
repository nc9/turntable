import { SpecError } from "@turntable/provider-sdk";

/**
 * Where the API key comes from. It is read when needed, never stored in config, and never logged.
 * `file` is a path to a file holding only the key; `env` names an environment variable.
 */
export type ApiKeySource = { file: string } | { env: string } | (() => string | Promise<string>);

export async function readApiKey(src: ApiKeySource): Promise<string> {
  let key: string | undefined;
  let where: string;
  if (typeof src === "function") {
    where = "the key provider function";
    key = await src();
  } else if ("file" in src) {
    where = `file ${src.file}`;
    try {
      key = await Bun.file(src.file).text();
    } catch {
      throw new SpecError(`Daytona API key file is not readable: ${src.file}`);
    }
  } else {
    where = `environment variable ${src.env}`;
    key = process.env[src.env];
  }
  key = key?.trim();
  if (!key) throw new SpecError(`Daytona API key is empty or missing in ${where}`);
  if (/\s/.test(key)) throw new SpecError(`Daytona API key in ${where} contains whitespace`);
  return key;
}
