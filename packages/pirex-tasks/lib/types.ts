export type TaskKind = "shell" | "agent" | "code";
export type TaskState =
  | "queued"
  | "starting"
  | "running"
  | "stop_requested"
  | "unknown"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timed_out";
export interface AgentSettings {
  description?: string;
  system_prompt_file?: string;
  tools?: string[];
  inherit_context?: boolean;
  provider?: string;
  model?: string;
  thinking?: string;
}
export interface Config {
  version: number;
  execution: { shell: string; shell_args: string[]; max_concurrent: number; node: string };
  agent_runtime: { executable: string; bootstrap_shell: string; bootstrap_args: string[] };
  notifications: { enabled: boolean; wake_parent: boolean };
  popup: { bounds: [number, number, number, number] };
  agents: {
    require_explicit_request: true;
    allow_nested: boolean;
    profiles?: Record<string, AgentSettings>;
  };
}
export interface LaunchContext {
  session?: string;
  anchor?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  snapshot?: string;
  child?: boolean;
}
export interface TaskInput {
  name: string;
  command?: string;
  code?: string;
  prompt?: string;
  cwd?: string;
  timeoutSeconds?: number;
  profile?: string;
  explicitRequest?: boolean;
  resume?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  inheritContext?: boolean;
}
export interface TaskSpec {
  executionMode?: "detached" | "rex-native";
  persistentShell?: boolean;
  resumeRunId?: string;
  cwd: string;
  command?: string;
  code?: string;
  prompt?: string;
  timeoutSeconds?: number;
  parentRun?: string;
  anchor?: string;
  config: Config;
  agent?: AgentSettings;
  systemPrompt?: string;
  context: string;
  launchContext: LaunchContext;
}
export interface RunRecord {
  id: string;
  task_id: string;
  parent_run: string | null;
  state: TaskState;
  spec: string;
  rex_session: string;
  rex_block: string | null;
  rex_source: string | null;
  created: number;
  started: number | null;
  ended: number | null;
  heartbeat: number | null;
  exit_code: number | null;
  error: string | null;
  result_path: string | null;
  log_path: string;
}
export interface TaskRecord extends Omit<RunRecord, "id" | "task_id"> {
  id: string;
  owner: string;
  name: string;
  kind: TaskKind;
  current_run: string;
  run_id: string;
}
export interface TaskReceipt {
  taskId: string;
  runId: string;
  kind: TaskKind;
  name: string;
  state: TaskState;
  rexBlockId: string | null;
  outputPath: string;
}
export interface TaskResult extends TaskReceipt {
  ready: boolean;
  exitCode?: number | null;
  error?: string | null;
  output?: BoundedOutput;
  agentSession?: string;
  [key: string]: unknown;
}
export interface ControlRecord {
  id: string;
  run_id: string;
  type: "stop" | "steer";
  message: string | null;
  state: string;
}
export interface OutboxRecord {
  id: string;
  run_id: string;
  owner: string;
  delivered: number | null;
  lease_until: number | null;
  lease_token: string | null;
}
export interface BoundedOutput {
  text: string;
  bytes: number;
  truncated: boolean;
  path: string;
}
export type SqlValue = string | number | bigint | null | Uint8Array;
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
