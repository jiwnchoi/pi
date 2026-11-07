import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { configSchema, profileSchema } from "./config.ts";
import type { TaskSpec } from "./types.ts";

const jsonSchema = Type.Cyclic(
  {
    Json: Type.Union([
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String(), Type.Ref("Json")),
    ]),
  },
  "Json",
);

/** Native JSON text conversion is confined to this storage/RPC boundary. */
export function stringifyJson(value: unknown, space?: number): string {
  const text = JSON.stringify(value, null, space);
  if (text === undefined) throw new TypeError("Value has no JSON representation");
  return text;
}
export function decodeJson<S extends TSchema>(text: string, schema: S): Static<S>;
export function decodeJson(text: string): unknown;
export function decodeJson(text: string, schema: TSchema = Type.Unknown()): unknown {
  const value: unknown = JSON.parse(text);
  Value.Assert(schema, value);
  return value;
}
export function jsonOutput(value: unknown): Static<typeof jsonSchema> {
  return decodeJson(stringifyJson(value), jsonSchema);
}
const launchContextSchema = Type.Object({
  session: Type.Optional(Type.String()),
  anchor: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  snapshot: Type.Optional(Type.String()),
  child: Type.Optional(Type.Boolean()),
});
const taskSpecSchema = Type.Object({
  executionMode: Type.Optional(Type.Union([Type.Literal("detached"), Type.Literal("rex-native")])),
  persistentShell: Type.Optional(Type.Boolean()),
  resumeRunId: Type.Optional(Type.String()),
  cwd: Type.String(),
  command: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  parentRun: Type.Optional(Type.String()),
  anchor: Type.Optional(Type.String()),
  config: configSchema,
  agent: Type.Optional(profileSchema),
  systemPrompt: Type.Optional(Type.String()),
  context: Type.String(),
  launchContext: launchContextSchema,
});
export function parseSpec(record: { spec: string }): TaskSpec {
  return decodeJson(record.spec, taskSpecSchema);
}
