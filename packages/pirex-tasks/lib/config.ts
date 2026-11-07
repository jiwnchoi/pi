import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Config } from "./types.ts";
import { errorMessage } from "./types.ts";
export const defaultRoot = () =>
  process.env.PIREX_TASKS_HOME ||
  join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pirex-tasks");
export const defaultConfig = `version = 1

[execution]
shell = "/bin/zsh"
shell_args = ["-c"]
max_concurrent = 4
node = "node"

[agent_runtime]
executable = "pi"
# Shell aliases are not executables. Source the user's zsh config before invoking pi.
bootstrap_shell = "/bin/zsh"
bootstrap_args = ["-ic"]

[notifications]
enabled = true
# Wake the parent with task ID and status only, never result content.
wake_parent = true

[popup]
bounds = [0.08, 0.08, 0.84, 0.84]

[agents]
require_explicit_request = true
# Compatibility setting retained for existing configuration.
allow_nested = true

# No agent profiles are pre-registered. Add your own, for example:
# [agents.profiles.reviewer]
# description = "Read-only code review"
# system_prompt_file = "./prompts/reviewer.md"
# tools = ["read", "grep", "find", "ls"]
# inherit_context = false
`;
type Table = Record<string, unknown>;
const defaults = (): Table => parse(defaultConfig) as Table;
function object(x: unknown): x is Table {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
function merge(a: Table, b: Table): Table {
  const result = { ...a };
  for (const [k, v] of Object.entries(b))
    result[k] = object(v) && object(a[k]) ? merge(a[k], v) : v;
  return result;
}
const nonEmpty = Type.String({ minLength: 1 });
export const profileSchema = Type.Object(
  {
    description: Type.Optional(Type.String()),
    system_prompt_file: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    inherit_context: Type.Optional(Type.Boolean()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const configSchema = Type.Object(
  {
    version: Type.Literal(1),
    execution: Type.Object(
      {
        shell: nonEmpty,
        shell_args: Type.Array(Type.String()),
        max_concurrent: Type.Integer({ minimum: 1, maximum: 64 }),
        node: nonEmpty,
      },
      { additionalProperties: false },
    ),
    agent_runtime: Type.Object(
      {
        executable: Type.String({ minLength: 1, pattern: "^[a-zA-Z0-9_./-]+$" }),
        bootstrap_shell: nonEmpty,
        bootstrap_args: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    notifications: Type.Object(
      { enabled: Type.Boolean(), wake_parent: Type.Boolean() },
      { additionalProperties: false },
    ),
    popup: Type.Object(
      { bounds: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]) },
      { additionalProperties: false },
    ),
    agents: Type.Object(
      {
        require_explicit_request: Type.Literal(true),
        allow_nested: Type.Boolean(),
        profiles: Type.Optional(Type.Record(Type.String(), profileSchema)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
function check(raw: Table): Config {
  if (!Value.Check(configSchema, raw))
    throw new Error(
      Value.Errors(configSchema, raw)
        .map((issue) => `${issue.instancePath}: ${issue.message}`)
        .join("; "),
    );
  const b = raw.popup.bounds;
  if (
    !b.every(Number.isFinite) ||
    b[0] < 0 ||
    b[1] < 0 ||
    b[2] <= 0 ||
    b[3] <= 0 ||
    b[0] + b[2] > 1 ||
    b[1] + b[3] > 1
  )
    throw new Error("Invalid popup.bounds");
  return raw;
}
export function validateConfigText(value: string): Config {
  return check(merge(defaults(), parse(value) as Table));
}
export function loadConfig(cwd: string, trusted = false, root = defaultRoot()): Config {
  let config = defaults();
  const files = [
    join(root, "config.toml"),
    ...(trusted ? [join(cwd, ".pi", "pirex-tasks.toml")] : []),
  ];
  for (const path of files)
    if (existsSync(path)) {
      try {
        const data = parse(readFileSync(path, "utf8"));
        const agents = object(data.agents) ? data.agents : {};
        const profiles = object(agents.profiles) ? agents.profiles : {};
        for (const profile of Object.values(profiles)) {
          if (object(profile) && typeof profile.system_prompt_file === "string")
            profile.system_prompt_file = resolve(dirname(path), profile.system_prompt_file);
        }
        config = merge(config, data as Table);
      } catch (e) {
        throw new Error(`${path}: ${errorMessage(e)}`);
      }
    }
  try {
    return check(config);
  } catch (e) {
    throw new Error(`${files.join(", ")}: ${errorMessage(e)}`);
  }
}
export function validateCwd(cwd: string | undefined, base: string): string {
  const path = cwd && isAbsolute(cwd) ? cwd : resolve(base, cwd || ".");
  return path;
}
