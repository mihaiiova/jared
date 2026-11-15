import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync, statSync } from "node:fs";
import { noSymlinks, pathExists } from "./safety.js";
import { requireThat, jobLogsSchema, } from "./contracts.js";
import { progressView, publicLogEvent, diagnosticView } from "./progress.js";
export class Store {
    db;
    constructor(root, readOnly = false) {
        const path = join(root, "service.sqlite");
        for (const candidate of [path, path + "-wal", path + "-shm"])
            if (pathExists(candidate)) {
                noSymlinks(candidate);
                const st = statSync(candidate);
                requireThat(st.isFile() && st.nlink === 1 && st.uid === process.getuid?.(), "unsafe_database_file");
            }
        this.db = new DatabaseSync(path, { readOnly });
        if (readOnly)
            return;
        chmodSync(path, 0o600);
        this.db
            .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project TEXT NOT NULL, caller TEXT NOT NULL, idem TEXT NOT NULL, body TEXT NOT NULL, execution TEXT NOT NULL, UNIQUE(project,caller,idem));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, job TEXT NOT NULL, time TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_reads(id TEXT PRIMARY KEY, groups_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event_retention(job TEXT PRIMARY KEY, through INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job_seq ON events(job,seq);
      CREATE INDEX IF NOT EXISTS events_job_kind_seq ON events(job,kind,seq);`);
        // Migrate retained databases once; hot scheduling queries must not parse results.
        this.transaction(() => {
            if (!this.db
                .prepare("PRAGMA table_info(jobs)")
                .all()
                .some((c) => c.name === "execution")) {
                this.db.exec("ALTER TABLE jobs ADD COLUMN execution TEXT NOT NULL DEFAULT 'queued'");
                this.db.exec("UPDATE jobs SET execution=json_extract(body, '$.execution')");
            }
            this.db
                .exec(`CREATE INDEX IF NOT EXISTS jobs_execution ON jobs(execution);
        CREATE INDEX IF NOT EXISTS jobs_caller_execution ON jobs(caller,execution);`);
        });
    }
    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const r = fn();
            this.db.exec("COMMIT");
            return r;
        }
        catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }
    project(id) {
        const r = this.db.prepare("SELECT body FROM projects WHERE id=?").get(id);
        requireThat(r, "not_found_or_denied");
        return JSON.parse(r.body);
    }
    register(p) {
        this.db
            .prepare("INSERT INTO projects VALUES(?,?)")
            .run(p.projectId, JSON.stringify(p));
    }
    job(id) {
        const r = this.db.prepare("SELECT body FROM jobs WHERE id=?").get(id);
        requireThat(r, "not_found_or_denied");
        return JSON.parse(r.body);
    }
    authorizedJob(projectId, id) {
        const j = this.job(id);
        requireThat(j.projectId === projectId, "not_found_or_denied");
        return j;
    }
    jobsIn(executions) {
        return this.db
            .prepare(`SELECT body FROM jobs WHERE execution IN (${executions.map(() => "?").join(",")}) ORDER BY rowid`)
            .all(...executions)
            .map((r) => JSON.parse(r.body));
    }
    outstanding(caller) {
        return Number(this.db
            .prepare("SELECT count(*) AS n FROM jobs WHERE caller=? AND execution IN ('queued','running')")
            .get(caller).n);
    }
    hasExecution(execution) {
        return !!this.db
            .prepare("SELECT 1 FROM jobs WHERE execution=? LIMIT 1")
            .get(execution);
    }
    idempotent(project, caller, key) {
        const r = this.db
            .prepare("SELECT body FROM jobs WHERE project=? AND caller=? AND idem=?")
            .get(project, caller, key);
        return r ? JSON.parse(r.body) : undefined;
    }
    insert(j) {
        this.db
            .prepare("INSERT INTO jobs(id,project,caller,idem,body,execution) VALUES(?,?,?,?,?,?)")
            .run(j.jobId, j.projectId, j.callerId, j.submission.idempotencyKey, JSON.stringify(j), j.execution);
        this.event(j.jobId, "queued", {});
    }
    save(j, kind, detail = {}) {
        this.transaction(() => {
            this.db
                .prepare("UPDATE jobs SET body=?, execution=? WHERE id=?")
                .run(JSON.stringify(j), j.execution, j.jobId);
            this.event(j.jobId, kind, {
                execution: j.execution,
                agentOutcome: j.agentOutcome,
                taskOutcome: j.taskOutcome,
                verification: j.verification,
                ...detail,
            });
        });
    }
    event(job, kind, body) {
        this.db
            .prepare("INSERT INTO events(job,time,kind,body) VALUES(?,?,?,?)")
            .run(job, new Date().toISOString(), kind, JSON.stringify(body));
        // Bound new progress telemetry only; never prune preexisting lifecycle or
        // ownership evidence. Global sequence gaps alone do not imply truncation.
        const cutoff = this.db
            .prepare("SELECT seq FROM events WHERE job=? AND kind='progress' ORDER BY seq DESC LIMIT 1 OFFSET 999")
            .get(job);
        if (cutoff) {
            const removed = this.db
                .prepare("SELECT max(seq) AS seq FROM events WHERE job=? AND kind='progress' AND seq<?")
                .get(job, cutoff.seq);
            if (removed?.seq != null) {
                this.db
                    .prepare("INSERT INTO event_retention(job,through) VALUES(?,?) ON CONFLICT(job) DO UPDATE SET through=max(through,excluded.through)")
                    .run(job, removed.seq);
                this.db
                    .prepare("DELETE FROM events WHERE job=? AND kind='progress' AND seq<?")
                    .run(job, cutoff.seq);
            }
        }
    }
    jobLogs(input) {
        const { projectId, jobId, after, limit } = jobLogsSchema.parse(input);
        const job = this.authorizedJob(projectId, jobId);
        const rows = this.db
            .prepare("SELECT seq,time,kind,body FROM events WHERE job=? AND seq>? ORDER BY seq LIMIT ?")
            .all(jobId, after, limit + 1);
        const events = rows.slice(0, limit).map(publicLogEvent);
        // Read-only CLI can also inspect databases created before this migration.
        const migrated = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_retention'")
            .get();
        const prunedThrough = migrated
            ? Number(this.db
                .prepare("SELECT through FROM event_retention WHERE job=?")
                .get(jobId)?.through ?? 0)
            : 0;
        return {
            projectId,
            jobId,
            execution: job.execution,
            taskOutcome: job.taskOutcome,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            failurePhase: job.failurePhase,
            diagnostic: diagnosticView(job.diagnostic),
            progress: progressView(job.progress),
            events,
            nextCursor: events.at(-1)?.seq ?? after,
            hasMore: rows.length > limit,
            truncated: after < prunedThrough,
            prunedThrough,
        };
    }
    recentEvents(job) {
        return this.db
            .prepare("SELECT seq,time,kind,body FROM events WHERE job=? ORDER BY seq DESC LIMIT 20")
            .all(job)
            .reverse();
    }
    events(job) {
        return this.db
            .prepare("SELECT seq,time,kind,body FROM events WHERE job=? ORDER BY seq")
            .all(job);
    }
    close() {
        this.db.close();
    }
}
