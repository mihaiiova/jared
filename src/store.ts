import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync, statSync } from "node:fs";
import { noSymlinks, pathExists } from "./safety.js";
import {
  type Execution,
  type Job,
  type Project,
  requireThat,
} from "./contracts.js";
export class Store {
  readonly db: DatabaseSync;
  constructor(root: string) {
    const path = join(root, "service.sqlite");
    for (const candidate of [path, path + "-wal", path + "-shm"])
      if (pathExists(candidate)) {
        noSymlinks(candidate);
        const st = statSync(candidate);
        requireThat(
          st.isFile() && st.nlink === 1 && st.uid === process.getuid?.(),
          "unsafe_database_file",
        );
      }
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT NOT NULL, caller TEXT NOT NULL, idem TEXT NOT NULL, body TEXT NOT NULL, execution TEXT NOT NULL, UNIQUE(project,caller,idem));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, job TEXT NOT NULL, time TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_reads(id TEXT PRIMARY KEY, groups_json TEXT NOT NULL);`);
    // Migrate retained databases once; hot scheduling queries must not parse results.
    this.transaction(() => {
      if (
        !this.db
          .prepare("PRAGMA table_info(jobs)")
          .all()
          .some((c) => c.name === "execution")
      ) {
        this.db.exec(
          "ALTER TABLE jobs ADD COLUMN execution TEXT NOT NULL DEFAULT 'queued'",
        );
        this.db.exec(
          "UPDATE jobs SET execution=json_extract(body, '$.execution')",
        );
      }
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS jobs_execution ON jobs(execution);
        CREATE INDEX IF NOT EXISTS jobs_caller_execution ON jobs(caller,execution);`);
    });
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  project(id: string): Project {
    const r = this.db.prepare("SELECT body FROM projects WHERE id=?").get(id);
    requireThat(r, "not_found_or_denied");
    return JSON.parse(r.body as string);
  }
  register(p: Project) {
    this.db
      .prepare("INSERT INTO projects VALUES(?,?)")
      .run(p.projectId, JSON.stringify(p));
  }
  job(id: string): Job {
    const r = this.db.prepare("SELECT body FROM jobs WHERE id=?").get(id);
    requireThat(r, "not_found_or_denied");
    return JSON.parse(r.body as string);
  }
  authorizedJob(projectId: string, id: string): Job {
    const j = this.job(id);
    requireThat(j.projectId === projectId, "not_found_or_denied");
    return j;
  }
  jobsIn(executions: Execution[]): Job[] {
    return this.db
      .prepare(
        `SELECT body FROM jobs WHERE execution IN (${executions.map(() => "?").join(",")}) ORDER BY rowid`,
      )
      .all(...executions)
      .map((r) => JSON.parse(r.body as string));
  }
  outstanding(caller: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM jobs WHERE caller=? AND execution IN ('queued','running')",
        )
        .get(caller)!.n,
    );
  }
  hasExecution(execution: Execution): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM jobs WHERE execution=? LIMIT 1")
      .get(execution);
  }
  idempotent(project: string, caller: string, key: string): Job | undefined {
    const r = this.db
      .prepare("SELECT body FROM jobs WHERE project=? AND caller=? AND idem=?")
      .get(project, caller, key);
    return r ? JSON.parse(r.body as string) : undefined;
  }
  insert(j: Job) {
    this.db
      .prepare(
        "INSERT INTO jobs(id,project,caller,idem,body,execution) VALUES(?,?,?,?,?,?)",
      )
      .run(
        j.jobId,
        j.projectId,
        j.callerId,
        j.submission.idempotencyKey,
        JSON.stringify(j),
        j.execution,
      );
    this.event(j.jobId, "queued", {});
  }
  save(j: Job, kind: string) {
    this.transaction(() => {
      this.db
        .prepare("UPDATE jobs SET body=?, execution=? WHERE id=?")
        .run(JSON.stringify(j), j.execution, j.jobId);
      this.event(j.jobId, kind, {
        execution: j.execution,
        agentOutcome: j.agentOutcome,
        taskOutcome: j.taskOutcome,
        verification: j.verification,
      });
    });
  }
  event(job: string, kind: string, body: unknown) {
    this.db
      .prepare("INSERT INTO events(job,time,kind,body) VALUES(?,?,?,?)")
      .run(job, new Date().toISOString(), kind, JSON.stringify(body));
  }
  events(job: string) {
    return this.db
      .prepare("SELECT seq,time,kind,body FROM events WHERE job=? ORDER BY seq")
      .all(job);
  }
  close() {
    this.db.close();
  }
}
