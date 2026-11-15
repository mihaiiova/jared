import { setupProjectFiles, validateProjectState, createReportDirectory, writeReport, } from "./projects.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./store.js";
import { supportedPlatform } from "./platform.js";
import { neutralPacket } from "./executor.js";
import { fetchExact, git, prepareWorkspace, snapshot, sourceAt, } from "./git.js";
import { digest, groupAlive, noSymlinks, owned, ownerLock, readBounded, sameProcess, pathExists, } from "./safety.js";
import { agentReportSchema, resultSchema, setupProjectSchema, submitSchema, integrationSchema, contextSchema, ackSchema, jobSchema, requireThat, ServiceError, } from "./contracts.js";
import { activitySchema, progressView, } from "./progress.js";
export class AuditService {
    options;
    release;
    store;
    root;
    active = new Map();
    stopped = false;
    scheduled = false;
    constructor(options, release) {
        this.options = options;
        this.release = release;
        this.root = noSymlinks(resolve(options.root));
        this.store = new Store(this.root);
    }
    static async open(options) {
        supportedPlatform();
        requireThat(options.timeoutMs === undefined ||
            (Number.isSafeInteger(options.timeoutMs) &&
                options.timeoutMs > 0 &&
                options.timeoutMs <= 3600000), "invalid_job_timeout");
        const release = await ownerLock(resolve(options.root));
        let service;
        try {
            service = new AuditService(options, release);
            await service.reconcile();
            service.schedule();
            return service;
        }
        catch (e) {
            service?.store.close();
            await release();
            throw e;
        }
    }
    async reconcile() {
        for (const row of this.store.db
            .prepare("SELECT * FROM source_reads")
            .all()) {
            const groups = JSON.parse(row.groups_json);
            let confirmed = true;
            for (const group of groups) {
                if (!groupAlive(group.pid))
                    continue;
                if (!sameProcess(group)) {
                    confirmed = false;
                    continue;
                }
                try {
                    process.kill(-group.pid, "SIGKILL");
                }
                catch {
                    confirmed = false;
                }
                for (let i = 0; i < 50 && groupAlive(group.pid); i++)
                    await delay(20);
                if (groupAlive(group.pid))
                    confirmed = false;
            }
            if (confirmed)
                this.store.db
                    .prepare("DELETE FROM source_reads WHERE id=?")
                    .run(row.id);
            else
                this.store.event(`source:${row.id}`, "source_reconciliation_required", {
                    sourceReadId: row.id,
                    diagnostic: "operator_process_reconciliation_required",
                });
        }
        for (const job of this.store.jobsIn(["running", "stop_unconfirmed"])) {
            let confirmed = true;
            for (const group of job.groups) {
                if (!groupAlive(group.pid))
                    continue;
                if (!sameProcess(group)) {
                    confirmed = false;
                    continue;
                }
                try {
                    process.kill(-group.pid, "SIGKILL");
                }
                catch {
                    confirmed = false;
                }
                for (let i = 0; i < 50 && groupAlive(group.pid); i++)
                    await delay(20);
                if (groupAlive(group.pid))
                    confirmed = false;
            }
            job.execution = confirmed ? "crashed" : "stop_unconfirmed";
            job.agentOutcome = "errored";
            job.taskOutcome = "failed";
            job.verification = "not_run";
            job.failurePhase = "restart";
            job.diagnostic = confirmed
                ? "interrupted_no_replay"
                : "operator_process_reconciliation_required";
            job.endedAt = new Date().toISOString();
            if (job.progress) {
                job.progress.phase = "terminal";
                job.progress.phaseStartedAt = job.progress.updatedAt = job.endedAt;
            }
            this.store.save(job, "restart_reconciliation");
        }
    }
    async invoke(name, input) {
        if (name === "setup_project") {
            requireThat(!this.stopped, "service_stopping");
            this.registrationsPending++;
            const run = this.registration
                .then(() => this.setupProject(input))
                .finally(() => {
                this.registrationsPending--;
            });
            this.registration = run.then(() => { }, () => { });
            return run;
        }
        if (name === "submit_job") {
            const s = submitSchema.parse(input);
            this.store.project(s.projectId);
            requireThat(s.kind === "audit", "implementation_and_push_unsupported");
            return this.submit(s);
        }
        if (name === "review_integration") {
            const s = integrationSchema.parse(input);
            this.store.project(s.projectId);
            const original = this.store.authorizedJob(s.projectId, s.originalJobId);
            requireThat(original.projectId === s.projectId && original.result, "invalid_original_job");
            return this.submit({
                projectId: s.projectId,
                baseCommit: s.integratedCommit,
                kind: "audit",
                request: s.request,
                scope: original.submission.scope,
                idempotencyKey: s.idempotencyKey,
                originalJobId: s.originalJobId,
            });
        }
        if (name === "read_design_context") {
            const s = contextSchema.parse(input);
            const project = this.store.project(s.projectId);
            requireThat(project.designPaths.includes(s.path), "design_path_not_registered");
            const dir = join(this.root, "sources", s.projectId, s.commit);
            validateProjectState(project);
            const repository = { path: project.projectPath };
            requireThat(!this.sourceReconciliationRequired(), "source_reconciliation_required");
            // A commit-addressed cache is immutable after initialization. Concurrent initialization is denied, not silently raced.
            requireThat(!this.stopped &&
                !this.contextReads.has(dir) &&
                this.contextReads.size + this.active.size <
                    (this.options.concurrency ?? 2) &&
                Number(this.store.db
                    .prepare("SELECT count(*) AS n FROM source_reads")
                    .get().n) === this.contextReads.size, "source_context_busy");
            const controller = new AbortController(), readId = randomUUID(), groups = [];
            this.store.db
                .prepare("INSERT INTO source_reads VALUES(?,?)")
                .run(readId, "[]");
            const observe = (group) => {
                groups.push(group);
                this.store.db
                    .prepare("UPDATE source_reads SET groups_json=? WHERE id=?")
                    .run(JSON.stringify(groups), readId);
            };
            // Source reads have no model phases; retain their independent native-I/O bound.
            const timer = setTimeout(() => controller.abort(), 120000);
            const done = (async () => {
                try {
                    await fetchExact(dir, repository, s.commit, controller.signal, observe);
                    return {
                        commit: s.commit,
                        path: s.path,
                        text: await sourceAt(dir, s.commit, s.path, controller.signal, observe),
                    };
                }
                finally {
                    clearTimeout(timer);
                    if (!groups.some((g) => groupAlive(g.pid)))
                        this.store.db
                            .prepare("DELETE FROM source_reads WHERE id=?")
                            .run(readId);
                    this.contextReads.delete(dir);
                    this.schedule();
                }
            })();
            this.contextReads.set(dir, { controller, done });
            return done;
        }
        if (name === "acknowledge_handoff") {
            const s = ackSchema.parse(input);
            const job = this.store.authorizedJob(s.projectId, s.jobId);
            requireThat(!["queued", "running", "stop_unconfirmed"].includes(job.execution), "job_not_stopped");
            requireThat(s.disposition === "abandoned" || job.taskOutcome === "delivered", "delivery_not_available");
            const dir = this.jobDir(job), worktree = join(dir, "worktree");
            if (pathExists(worktree)) {
                owned(this.root, worktree);
                const state = await snapshot(worktree);
                requireThat(state.clean && state.actualCommit === job.submission.baseCommit, "dirty_or_changed_workspace_retained");
                const repo = owned(this.root, join(dir, "repo.git"));
                await git(repo, ["worktree", "remove", worktree]);
            }
            job.acknowledgement = s.disposition;
            this.store.save(job, "explicit_cleanup");
            return {
                jobId: job.jobId,
                acknowledgement: job.acknowledgement,
                evidenceRetained: true,
            };
        }
        if (name === "get_job_logs")
            return this.store.jobLogs(input);
        const { projectId, jobId } = jobSchema.parse(input);
        const job = this.store.authorizedJob(projectId, jobId);
        if (name === "get_job")
            return {
                ...job,
                result: undefined,
                groups: undefined,
                progress: progressView(job.progress),
                events: this.store.recentEvents(jobId),
            };
        if (name === "get_result") {
            requireThat(job.result, "result_not_available");
            return job.result;
        }
        if (name === "get_report") {
            requireThat(job.result, "result_not_available");
            return {
                audit: job.result.lead,
                independentReview: job.result.reviewer,
                provenance: job.result.provenance,
            };
        }
        if (name === "cancel_job") {
            if (job.execution === "queued") {
                job.execution = "cancelled";
                job.agentOutcome = "not_run";
                job.taskOutcome = "blocked";
                job.endedAt = new Date().toISOString();
                if (job.progress) {
                    job.progress.phase = "terminal";
                    job.progress.phaseStartedAt = job.progress.updatedAt = job.endedAt;
                }
                delete job.failurePhase;
                delete job.diagnostic;
                this.store.save(job, "cancelled");
            }
            const active = this.active.get(jobId);
            if (active) {
                active.reason = "cancelled";
                active.controller.abort();
                await active.done;
            }
            return { jobId, execution: this.store.job(jobId).execution };
        }
        throw new ServiceError("unknown_tool");
    }
    registrationsPending = 0;
    registration = Promise.resolve();
    async setupProject(input) {
        const p = setupProjectSchema.parse(input);
        const existing = this.store.db
            .prepare("SELECT body FROM projects WHERE id=?")
            .get(p.projectId);
        requireThat(!existing ||
            JSON.parse(existing.body).projectPath === p.projectPath, "project_already_registered");
        for (const row of this.store.db
            .prepare("SELECT body FROM projects")
            .all()) {
            const other = JSON.parse(row.body);
            requireThat(other.projectPath !== p.projectPath || other.projectId === p.projectId, "project_path_already_registered");
        }
        await setupProjectFiles(p);
        if (!existing)
            this.store.register(p);
        else if (existing.body !== JSON.stringify(p))
            this.store.transaction(() => {
                this.store.db
                    .prepare("UPDATE projects SET body=? WHERE id=?")
                    .run(JSON.stringify(p), p.projectId);
                this.store.event(`project:${p.projectId}`, "project_metadata_updated", {});
            });
        return {
            projectId: p.projectId,
            projectPath: p.projectPath,
            mode: p.setupProfile,
            writes: [
                ".jared/config.json",
                ".jared/.gitignore (ignores runs/)",
                ".jared/runs/",
            ],
            authority: "Local MCP clients have same-user operator authority; not multi-tenant isolation.",
        };
    }
    contextReads = new Map();
    submit(s) {
        requireThat(!this.stopped, "service_stopping");
        validateProjectState(this.store.project(s.projectId));
        this.options.checkReady?.();
        const fingerprint = digest(JSON.stringify(s));
        const result = this.store.transaction(() => {
            const existing = this.store.idempotent(s.projectId, "local", s.idempotencyKey);
            if (existing) {
                requireThat(existing.fingerprint === fingerprint, "idempotency_conflict");
                return {
                    jobId: existing.jobId,
                    idempotent: true,
                    timeoutMs: existing.progress?.timeoutMs,
                };
            }
            requireThat(this.store.outstanding("local") < 100, "queue_limit");
            const job = {
                jobId: randomUUID(),
                projectId: s.projectId,
                callerId: "local",
                submission: s,
                fingerprint,
                execution: "queued",
                agentOutcome: "not_run",
                taskOutcome: "pending",
                verification: "not_run",
                createdAt: new Date().toISOString(),
                groups: [],
                progress: {
                    phase: "queued",
                    phaseStartedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    timeoutMs: this.options.timeoutMs ?? 120000,
                    activityCount: 0,
                },
            };
            this.store.insert(job);
            return {
                jobId: job.jobId,
                idempotent: false,
                timeoutMs: job.progress.timeoutMs,
            };
        });
        this.schedule();
        return result;
    }
    schedule() {
        if (this.scheduled || this.stopped)
            return;
        this.scheduled = true;
        setImmediate(() => {
            this.scheduled = false;
            this.pump();
        });
    }
    sourceReconciliationRequired() {
        return (Number(this.store.db.prepare("SELECT count(*) AS n FROM source_reads").get()
            .n) > this.contextReads.size);
    }
    pump() {
        if (this.stopped)
            return;
        if (this.sourceReconciliationRequired()) {
            // Keep the queue fail-closed, but make the operator action visible to pollers.
            for (const job of this.store.jobsIn(["queued"])) {
                if (job.diagnostic === "source_reconciliation_required")
                    continue;
                job.failurePhase = "source_reconciliation";
                job.diagnostic = "source_reconciliation_required";
                this.store.save(job, "source_reconciliation_required");
            }
            return;
        }
        if (this.store.hasExecution("stop_unconfirmed"))
            return;
        const busy = new Set(this.store.jobsIn(["running"]).map((j) => j.projectId));
        for (const job of this.store.jobsIn(["queued"])) {
            if (this.active.size + this.contextReads.size >=
                (this.options.concurrency ?? 2))
                break;
            if (busy.has(job.projectId))
                continue;
            busy.add(job.projectId);
            job.execution = "running";
            delete job.failurePhase;
            delete job.diagnostic;
            job.startedAt = new Date().toISOString();
            this.store.save(job, "started");
            const entry = { controller: new AbortController(), done: Promise.resolve() };
            this.active.set(job.jobId, entry);
            entry.done = this.run(job, entry).finally(() => {
                this.active.delete(job.jobId);
                this.schedule();
            });
        }
    }
    jobDir(job) {
        return join(this.root, "jobs", job.jobId);
    }
    async run(job, active) {
        const signal = active.controller.signal;
        const timeoutMs = job.progress?.timeoutMs ?? this.options.timeoutMs ?? 120000;
        job.progress ??= {
            phase: "queued",
            phaseStartedAt: job.createdAt,
            updatedAt: job.createdAt,
            timeoutMs,
            activityCount: 0,
        };
        job.progress.deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
        let lastActivityWrite = 0, persistedActivityCount = 0, progressFailed = false;
        const flushActivity = () => {
            const p = job.progress;
            this.store.save(job, "progress", {
                phase: p.phase,
                role: p.role,
                runId: p.runId,
                activity: p.lastActivity,
                tool: p.tool,
                activityCount: p.activityCount,
            });
            lastActivityWrite = Date.now();
            persistedActivityCount = p.activityCount;
        };
        const activity = (input) => {
            if (job.execution !== "running")
                return;
            const parsed = activitySchema.safeParse(input);
            if (!parsed.success)
                return;
            const now = Date.now(), p = job.progress;
            p.lastActivityAt = p.updatedAt = new Date(now).toISOString();
            p.lastActivity = parsed.data.kind;
            p.tool = parsed.data.tool;
            p.activityCount++;
            // Token/tool activity can be very noisy. Aggregate counts and retain at
            // most one activity sample/second, but always persist protocol milestones.
            const sampled = [
                "workspace_activity",
                "model_activity",
                "tool_started",
                "tool_finished",
            ].includes(parsed.data.kind);
            if (!sampled || now - lastActivityWrite >= 1000) {
                try {
                    flushActivity();
                }
                catch (error) {
                    progressFailed = true;
                    throw error;
                }
            }
        };
        const timer = setTimeout(() => {
            active.reason ??= "timed_out";
            active.controller.abort();
            try {
                activity({ kind: "deadline_expired" });
            }
            catch {
                /* Still abort if storage fails. */
            }
        }, timeoutMs);
        const activityFlush = setInterval(() => {
            if (job.progress.activityCount === persistedActivityCount)
                return;
            try {
                flushActivity();
            }
            catch {
                progressFailed = true;
                active.controller.abort();
            }
        }, 1000);
        let phase = "fetch";
        const setPhase = (next, role, runId) => {
            phase = next;
            const p = job.progress;
            p.phase = next;
            p.phaseStartedAt = p.updatedAt = new Date().toISOString();
            p.role = role;
            p.runId = runId;
            p.tool = undefined;
            this.store.save(job, "progress", {
                phase: next,
                role,
                runId,
                activityCount: p.activityCount,
            });
        };
        let reportDir;
        const project = this.store.project(job.projectId);
        const observe = (g) => {
            job.groups.push(g);
            if (phase !== "lead" && phase !== "ui-reviewer")
                activity({ kind: "workspace_activity" });
            this.store.save(job, "owned_process");
        };
        try {
            setPhase("fetch");
            const dir = this.jobDir(job);
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            owned(this.root, dir);
            validateProjectState(project);
            reportDir = createReportDirectory(project, job.jobId);
            const repository = { path: project.projectPath };
            const { repo, worktree } = await prepareWorkspace(dir, repository, job.submission.baseCommit, signal, observe);
            const before = await snapshot(worktree, signal, observe);
            requireThat(before.actualCommit === job.submission.baseCommit && before.clean, "checkout_receipt_failed");
            const packet = neutralPacket(job.jobId, job.submission.baseCommit, project.purpose, job.submission.request, project.platform, project.approvedDirection, job.submission.scope, project.designPaths);
            const packetHash = digest(JSON.stringify(packet));
            const runs = [];
            for (const role of ["lead", "ui-reviewer"]) {
                signal.throwIfAborted();
                const runId = randomUUID(), outputDir = join(dir, "evidence", role);
                setPhase(role, role, runId);
                mkdirSync(outputDir, { recursive: true, mode: 0o700 });
                writeFileSync(join(outputDir, "packet.json"), JSON.stringify({ runId, role, packet }), { mode: 0o600 });
                const output = await this.options.executor.run({
                    role,
                    runId,
                    worktree,
                    outputDir,
                    packet: structuredClone(packet),
                    signal,
                    observe,
                    progress: activity,
                });
                requireThat(output.agentOutcome === "completed", "agent_not_completed");
                setPhase((role + "_report_validation"), role, runId);
                const report = agentReportSchema.parse(JSON.parse(readBounded(outputDir, output.reportPath)));
                requireThat(report.jobId === job.jobId &&
                    report.reviewedCommit === before.actualCommit, "report_linkage_failed");
                // Host corroborates paths exist as regular blobs at the exact commit, not claimed coverage.
                for (const path of new Set([
                    ...report.inspectedPaths,
                    ...report.findings.map((f) => f.path),
                ]))
                    await sourceAt(repo, before.actualCommit, path, signal, observe);
                runs.push({ runId, report });
                this.store.event(job.jobId, "validated_report", {
                    role,
                    runId,
                    packetHash,
                });
            }
            setPhase("host_validation");
            signal.throwIfAborted();
            const after = await snapshot(worktree, signal, observe);
            requireThat(after.actualCommit === before.actualCommit && after.clean, "audit_mutated_workspace");
            requireThat(!job.groups.some((g) => groupAlive(g.pid)), "owned_process_still_running");
            const result = {
                schemaVersion: 1,
                jobId: job.jobId,
                reviewedCommit: job.submission.baseCommit,
                actualCommit: after.actualCommit,
                clean: true,
                taskOutcome: "delivered",
                verification: "partial",
                sourceValidation: "passed",
                visualVerification: "not_run",
                coverage: "agent-reported paths, not exhaustive coverage",
                lead: runs[0].report,
                reviewer: runs[1].report,
                provenance: {
                    leadRun: runs[0].runId,
                    reviewerRun: runs[1].runId,
                    reviewerName: "ui-reviewer",
                    packetHash,
                    reviewerDefinitionHash: this.options.executor.reviewerDefinitionHash,
                    evaluateSkillHash: this.options.executor.evaluateSkillHash,
                    executor: this.options.executor.kind,
                },
                limitations: [
                    "Source-only audit: no setup, tests, browser or native runtime executed.",
                    "Worktrees and tool allowlists are not an OS sandbox.",
                    "Independent reviewer has fresh context; source coverage remains agent-reported.",
                ],
            };
            resultSchema.parse(result);
            writeFileSync(join(dir, "evidence", "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
            for (const [name, report] of [
                ["audit.md", result.lead],
                ["reviewer-report.md", result.reviewer],
            ]) {
                writeFileSync(join(dir, "evidence", name), `# ${name}\n\nCommit: ${report.reviewedCommit}\n\n${report.summary}\n\n## Findings\n${report.findings.map((f) => `- ${f.severity}: ${f.path}:${f.line} — ${f.observation}; recommendation: ${f.recommendation}`).join("\n")}\n\n## Inspected (agent-reported)\n${report.inspectedPaths.join("\n")}\n\n## Limitations\n${report.limitations.join("\n")}\nVisual verification: not_run\n`, { mode: 0o600 });
            }
            for (const name of ["result.json", "audit.md", "reviewer-report.md"])
                writeReport(project, reportDir, name, readBounded(join(dir, "evidence"), join(dir, "evidence", name), 4 * 1024 * 1024));
            job.result = result;
            job.execution = "stopped";
            job.agentOutcome = "completed";
            job.taskOutcome = "delivered";
            job.verification = "partial";
        }
        catch (error) {
            const alive = job.groups.some((g) => groupAlive(g.pid));
            job.execution = alive
                ? "stop_unconfirmed"
                : active.reason === "shutdown"
                    ? "crashed"
                    : (active.reason ?? "stopped");
            job.agentOutcome = active.reason ? "aborted" : "errored";
            job.taskOutcome = active.reason ? "blocked" : "failed";
            job.verification = "not_run";
            job.failurePhase = active.reason === "shutdown" ? "shutdown" : phase;
            job.diagnostic = progressFailed
                ? "progress_storage_failed"
                : active.reason === "shutdown"
                    ? "service_shutdown"
                    : error instanceof ServiceError
                        ? error.code
                        : active.reason
                            ? "execution_aborted"
                            : "execution_or_report_validation_failed";
        }
        finally {
            clearTimeout(timer);
            clearInterval(activityFlush);
            job.endedAt = new Date().toISOString();
            setPhase("terminal");
            this.store.save(job, "terminal");
            if (reportDir) {
                try {
                    writeReport(project, reportDir, "status.json", JSON.stringify({
                        jobId: job.jobId,
                        projectId: job.projectId,
                        execution: job.execution,
                        taskOutcome: job.taskOutcome,
                        diagnostic: job.diagnostic,
                        progress: progressView(job.progress),
                    }, null, 2));
                }
                catch {
                    this.store.event(job.jobId, "project_status_publication_failed", {});
                }
            }
        }
    }
    isIdle() {
        return (this.registrationsPending === 0 &&
            this.active.size === 0 &&
            this.contextReads.size === 0 &&
            !this.sourceReconciliationRequired() &&
            !this.store.hasExecution("queued") &&
            !this.store.hasExecution("stop_unconfirmed"));
    }
    async close() {
        this.stopped = true;
        for (const entry of this.active.values()) {
            entry.reason ??= "shutdown";
            entry.controller.abort();
        }
        for (const entry of this.contextReads.values())
            entry.controller.abort();
        await Promise.allSettled([...this.active.values(), ...this.contextReads.values()].map((e) => e.done));
        await this.registration;
        this.store.close();
        await this.release();
    }
}
