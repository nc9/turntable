import { z } from "zod";
import type { Op } from "./define";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  [key: string]: unknown;
};

function toSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  // draft 2020-12 is what OpenAPI 3.1 and MCP tool schemas speak. `unrepresentable: "throw"`
  // (the default) makes an op that cannot be described fail loudly at startup, not silently.
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
  }) as JsonSchema;
  return rest;
}

export const inputJsonSchema = (op: Op): JsonSchema => toSchema(op.input, "input");
export const outputJsonSchema = (op: Op): JsonSchema =>
  op.download
    ? { type: "string", format: "binary", description: "The bytes, not JSON." }
    : toSchema(op.output, "output");
