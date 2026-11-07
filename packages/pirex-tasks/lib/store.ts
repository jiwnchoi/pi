import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringifyJson } from "./validation.ts";

import type { RunRecord, TaskRecord, TaskKind, TaskState, TaskSpec, SqlValue } from "./types.ts";
interface Statement {
  get(...args: SqlValue[]): unknown;
  all(...args: SqlValue[]): unknown[];
  run(...args: SqlValue[]): unknown;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
const bunModule = "bun:sqlite";
const SQLite: new (path: string) => Database = process.versions.bun
  ? ((await import(bunModule)) as { Database: new (path: string) => Database }).Database
  : (await import("node:sqlite")).DatabaseSync;
export const terminal = new Set<TaskState>(["succeeded", "failed", "stopped", "timed_out"]);
export class Store {
  root: string;
  db: Database;
  private inTransaction = false;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = root;
    this.db = new SQLite(join(root, "tasks.sqlite"));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        current_run TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), parent_run TEXT,
        state TEXT NOT NULL, spec TEXT NOT NULL, rex_session TEXT NOT NULL,
        rex_block TEXT, created INTEGER NOT NULL, started INTEGER, ended INTEGER,
        heartbeat INTEGER, exit_code INTEGER, error TEXT, result_path TEXT, log_path TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner);
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL,
        data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_outbox(
        id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES runs(id), owner TEXT NOT NULL,
        delivered INTEGER, lease_until INTEGER, lease_token TEXT);
      CREATE TABLE IF NOT EXISTS controls(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), type TEXT NOT NULL,
        message TEXT, state TEXT NOT NULL DEFAULT 'pending', error TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_sessions(
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), path TEXT NOT NULL, settings TEXT NOT NULL);
    `);
    const columns = this.all<{ name: string }>("PRAGMA table_info(tasks)");
    if (!columns.some((column) => column.name === "hidden")) {
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
      } catch (error) {
        if (
          !this.all<{ name: string }>("PRAGMA table_info(tasks)").some(
            (column) => column.name === "hidden",
          )
        )
          throw error;
      }
    }
    if (
      !this.all<{ name: string }>("PRAGMA table_info(runs)").some(
        (column) => column.name === "rex_source",
      )
    ) {
      try {
        this.db.exec("ALTER TABLE runs ADD COLUMN rex_source TEXT");
      } catch (error) {
        if (
          !this.all<{ name: string }>("PRAGMA table_info(runs)").some(
            (column) => column.name === "rex_source",
          )
        )
          throw error;
      }
    }
    chmodSync(join(root, "tasks.sqlite"), 0o600);
  }
  stmt(sql: string): Statement {
    return this.db.prepare(sql);
  }
  get<T = RunRecord>(sql: string, ...args: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...args) as T | undefined;
  }
  required<T = RunRecord>(sql: string, ...args: SqlValue[]): T {
    const row = this.get<T>(sql, ...args);
    if (!row) throw new Error("Database record missing");
    return row;
  }
  all<T = RunRecord>(sql: string, ...args: SqlValue[]): T[] {
    return this.stmt(sql).all(...args) as T[];
  }
  exec(sql: string, ...args: SqlValue[]): unknown {
    return this.stmt(sql).run(...args);
  }
  tx<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  event(run: string, type: string, data: unknown = {}): void {
    this.exec(
      "INSERT INTO events(run_id,type,data,created) VALUES(?,?,?,?)",
      run,
      type,
      stringifyJson(data),
      Date.now(),
    );
  }
  submit(
    owner: string,
    kind: TaskKind,
    name: string,
    spec: TaskSpec,
    session: string,
    resume?: string,
  ): TaskRecord {
    if (!name?.trim() || name.length > 120) throw new Error("name must be 1–120 characters");
    return this.tx(() => {
      const id = resume || `task_${randomUUID()}`;
      const run = `run_${randomUUID()}`;
      if (resume) {
        const old = this.task(owner, resume);
        if (old.kind !== "agent" || !terminal.has(old.state))
          throw new Error("Only a terminal agent task can be resumed");
      }
      const dir = join(this.root, "runs", run);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!resume)
        this.exec(
          "INSERT INTO tasks(id,owner,name,kind,current_run,created) VALUES(?,?,?,?,?,?)",
          id,
          owner,
          name.trim(),
          kind,
          run,
          Date.now(),
        );
      else this.exec("UPDATE tasks SET current_run=?,hidden=0 WHERE id=?", run, id);
      this.exec(
        `INSERT INTO runs(id,task_id,parent_run,state,spec,rex_session,created,log_path)
        VALUES(?,?,?,'queued',?,?,?,?)`,
        run,
        id,
        spec.parentRun || null,
        stringifyJson(spec),
        session,
        Date.now(),
        join(dir, "output.log"),
      );
      if (kind === "agent" && !resume)
        this.exec(
          "INSERT INTO agent_sessions VALUES(?,?,?)",
          id,
          join(dir, "agent.jsonl"),
          stringifyJson(spec.agent || {}),
        );
      this.event(run, "queued");
      return this.task(owner, id);
    });
  }
  task(owner: string, id: string): TaskRecord {
    const row = this.get<TaskRecord>(
      `SELECT t.*,r.id run_id,r.state,r.spec,r.rex_session,r.rex_block,r.started,r.ended,
      r.heartbeat,r.exit_code,r.error,r.result_path,r.log_path,r.parent_run,r.rex_source
      FROM tasks t JOIN runs r ON r.id=t.current_run WHERE t.owner=? AND t.id=?`,
      owner,
      id,
    );
    if (!row) throw new Error(`Unknown task in this session: ${id}`);
    return row;
  }
  list(owner: string): TaskRecord[] {
    return this.all<TaskRecord>(
      `SELECT t.*,r.id run_id,r.state,r.spec,r.rex_block,r.rex_session,r.started,r.ended,r.exit_code,r.error,r.log_path,r.result_path,r.heartbeat,r.parent_run,r.rex_source
      FROM tasks t JOIN runs r ON r.id=t.current_run WHERE t.owner=? AND t.hidden=0 ORDER BY t.created DESC LIMIT 100`,
      owner,
    );
  }
  claim(run: string, limit: number): boolean {
    return this.tx(() => {
      const row = this.get("SELECT * FROM runs WHERE id=?", run);
      if (row?.state !== "queued") return false;
      const kind = this.required<{ kind: TaskKind }>(
        "SELECT kind FROM tasks WHERE id=?",
        row.task_id,
      ).kind;
      const count = this.required<{
        n: number;
      }>(`SELECT count(*) n FROM runs r JOIN tasks t ON t.id=r.task_id
        WHERE r.state IN ('starting','running','stop_requested') AND t.kind!='code'`).n;
      if (kind !== "code" && count >= limit) return false;
      this.exec("UPDATE runs SET state='starting',heartbeat=? WHERE id=?", Date.now(), run);
      this.event(run, "starting");
      return true;
    });
  }
  finish(
    run: string,
    state: TaskState,
    code?: number | null,
    error?: string,
    resultPath?: string,
  ): boolean {
    if (!terminal.has(state)) throw new Error("Invalid terminal state");
    return this.tx(() => {
      const row = this.get("SELECT * FROM runs WHERE id=?", run);
      if (!row || terminal.has(row.state)) return false;
      this.exec(
        "UPDATE runs SET state=?,exit_code=?,error=?,result_path=?,ended=? WHERE id=?",
        state,
        code ?? null,
        error || null,
        resultPath || null,
        Date.now(),
        run,
      );
      this.exec(
        "UPDATE controls SET state='failed',error='Task finished before acknowledgement' WHERE run_id=? AND state IN ('pending','sending')",
        run,
      );
      this.event(run, state, { code, error });
      // Workflow children report to their workflow, not independently to the parent Pi.
      if (!row.parent_run) {
        const owner = this.required<{ owner: string }>(
          "SELECT owner FROM tasks WHERE id=?",
          row.task_id,
        ).owner;
        this.exec(
          "INSERT OR IGNORE INTO notification_outbox(id,run_id,owner) VALUES(?,?,?)",
          `done_${run}`,
          run,
          owner,
        );
      }
      return true;
    });
  }
  clear(owner: string, id?: string): number {
    return this.tx(() => {
      const rows = this.all<{ id: string }>(
        `SELECT t.id FROM tasks t JOIN runs r ON r.id=t.current_run WHERE t.owner=? AND t.hidden=0 AND r.state IN ('succeeded','failed','stopped','timed_out')`,
        owner,
      );
      const selected = id ? rows.filter((row) => row.id === id) : rows;
      if (id && !selected.length) throw new Error("Only completed tasks can be cleared");
      for (const row of selected)
        this.exec("UPDATE tasks SET hidden=1 WHERE owner=? AND id=?", owner, row.id);
      return selected.length;
    });
  }
  control(
    owner: string,
    id: string,
    type: "stop" | "steer",
    message?: string,
  ): { taskId: string; requestId: string; state: string } {
    return this.tx(() => {
      const row = this.task(owner, id);
      if (terminal.has(row.state)) throw new Error("Task already finished");
      if (type === "steer" && (row.kind !== "agent" || row.state !== "running"))
        throw new Error("Steer requires a running agent");
      const requestId = randomUUID();
      this.exec(
        "INSERT INTO controls(id,run_id,type,message,created) VALUES(?,?,?,?,?)",
        requestId,
        row.run_id,
        type,
        message || null,
        Date.now(),
      );
      if (type === "stop") {
        if (row.state === "queued") {
          this.finish(row.run_id, "stopped", null, "Stopped before launch");
          this.exec("UPDATE controls SET state='delivered',error=NULL WHERE id=?", requestId);
        } else {
          this.exec("UPDATE runs SET state='stop_requested' WHERE id=?", row.run_id);
        }
      }
      this.event(row.run_id, `${type}_requested`, { requestId });
      return { taskId: id, requestId, state: type === "stop" ? "stop_requested" : "accepted" };
    });
  }
  close() {
    this.db.close();
  }
}
