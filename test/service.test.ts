import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FakeExecutor } from "./fake-executor.js";
import { AuditService } from "../src/service.js";
import { validateLocalRepository } from "../src/git.js";
import { OwnedProcess } from "../src/process.js";
import { groupAlive } from "../src/safety.js";
import { fixture, submit, terminal, waitFor } from "./helpers.js";

test("fetch exact full SHA, reject missing SHA/ref injection and implementation fails closed", async () => {
  const f = await fixture();
  try {
    await f.service.invoke("setup_project", f.registration());
    for (const baseCommit of [
      "HEAD",
      "--upload-pack=evil",
      "a".repeat(39),
      "../evil",
    ])
      await assert.rejects(
        f.service.invoke("submit_job", {
          ...f.submission(),
          baseCommit,
        }),
      );
    await assert.rejects(
      f.service.invoke("submit_job", {
        ...f.submission(),
        kind: "implement",
      }),
      /implementation_and_push_unsupported/,
    );
    await assert.rejects(
      f.service.invoke("submit_job", {
        ...f.submission(),
        remote: "file:///etc",
      }),
    );
    const missing = await submit(f.service, {
      ...f.submission(),
      baseCommit: "1".repeat(40),
    });
    const job = await terminal(f.service, missing);
    assert.equal(job.taskOutcome, "failed");
    assert.equal(job.failurePhase, "fetch");
    assert.equal(job.verification, "not_run");
    f.git("tag", "-a", "annotated", "-m", "not commit");
    const tag = f.git("rev-parse", "annotated");
    const notCommit = await submit(f.service, {
      ...f.submission("tag"),
      baseCommit: tag,
    });
    assert.equal((await terminal(f.service, notCommit)).taskOutcome, "failed");
  } finally {
    await f.service.close();
  }
});

test("bounded concurrency 2 and conservative per-project serialization", async () => {
  let count = 0,
    max = 0;
  const executor = new FakeExecutor(async () => {
    count++;
    max = Math.max(max, count);
    await delay(160);
    count--;
    return undefined;
  });
  const f = await fixture(executor);
  try {
    for (const project of ["one", "two", "three"])
      await f.service.invoke("setup_project", f.registration(project));
    const ids = [];
    for (const [key, project] of [
      ["a", "one"],
      ["b", "one"],
      ["c", "two"],
      ["d", "three"],
    ])
      ids.push(await submit(f.service, f.submission(key, project)));
    const jobs = await Promise.all(ids.map((id) => terminal(f.service, id)));
    assert(jobs.every((j) => j.taskOutcome === "delivered"));
    assert.equal(max, 2);
    assert(jobs[1].startedAt! >= jobs[0].endedAt!);
  } finally {
    await f.service.close();
  }
});

test("fresh neutral reviewer packet excludes lead output; findings do not mean audit failure", async () => {
  let leadPacket = "";
  let reviewerPacket = "";
  const executor = new FakeExecutor(async (c) => {
    if (c.role === "ui-reviewer") {
      reviewerPacket = JSON.stringify(c.packet);
      assert(!reviewerPacket.includes("LEAD_NARRATIVE"));
      return undefined;
    }
    leadPacket = JSON.stringify(c.packet);
    const base = await new FakeExecutor().run(c);
    const report = JSON.parse(readFileSync(base.reportPath, "utf8"));
    report.summary = "LEAD_NARRATIVE";
    report.findings = [
      {
        severity: "blocker",
        path: "README.md",
        line: 2,
        observation: "Synthetic defect",
        recommendation: "Inspect",
      },
    ];
    writeFileSync(base.reportPath, JSON.stringify(report));
    return base;
  });
  const f = await fixture(executor);
  try {
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, f.submission());
    const job = await terminal(f.service, id);
    assert.equal(job.taskOutcome, "delivered");
    assert.equal(job.verification, "partial");
    assert.equal(leadPacket, reviewerPacket);
    assert.notEqual(
      job.result!.provenance.leadRun,
      job.result!.provenance.reviewerRun,
    );
    assert.equal(job.result!.lead.findings[0].severity, "blocker");
  } finally {
    await f.service.close();
  }
});

test("missing, malformed, wrong linkage, symlink, oversized, escaped reports never become success", async (t) => {
  for (const variant of [
    "missing",
    "malformed",
    "wrong-sha",
    "symlink",
    "oversized",
    "escape",
    "errored",
    "dirty",
    "self-verified",
    "unknown-source",
  ])
    await t.test(variant, async () => {
      const executor = new FakeExecutor(async (c) => {
        const path = join(c.outputDir, "report.json");
        if (variant === "malformed") writeFileSync(path, '{"oops":');
        if (variant === "oversized")
          writeFileSync(path, "x".repeat(256 * 1024 + 1));
        if (variant === "symlink") symlinkSync("/etc/passwd", path);
        if (
          ["wrong-sha", "dirty", "self-verified", "unknown-source"].includes(
            variant,
          )
        ) {
          const result = await new FakeExecutor().run(c);
          const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
          if (variant === "wrong-sha") report.reviewedCommit = "0".repeat(40);
          if (variant === "dirty")
            writeFileSync(
              join(c.worktree, "undelivered.txt"),
              "retain dirty evidence",
            );
          if (variant === "self-verified") report.verification = "passed";
          if (variant === "unknown-source")
            report.inspectedPaths = ["not-in-this-commit.md"];
          writeFileSync(path, JSON.stringify(report));
        }
        return {
          agentOutcome: variant === "errored" ? "errored" : "completed",
          reportPath: variant === "escape" ? "/etc/passwd" : path,
        };
      });
      const f = await fixture(executor);
      try {
        await f.service.invoke("setup_project", f.registration());
        const id = await submit(f.service, f.submission());
        const job = await terminal(f.service, id);
        assert.equal(job.taskOutcome, "failed");
        assert.equal(job.verification, "not_run");
        assert.equal(job.result, undefined);
        assert(existsSync(join(f.options.root, "jobs", id, "worktree")));
        if (variant === "dirty") {
          assert(
            existsSync(
              join(f.options.root, "jobs", id, "worktree", "undelivered.txt"),
            ),
          );
          await assert.rejects(
            f.service.invoke("acknowledge_handoff", {
              projectId: "fixture",
              jobId: id,
              disposition: "abandoned",
            }),
            /dirty_or_changed_workspace_retained/,
          );
        }
      } finally {
        await f.service.close();
      }
    });
});

test("cancel and deadline wait for executor stop; preserve workspaces; queued cancel does not run", async () => {
  let started = 0,
    stopped = 0;
  const groups: number[] = [];
  const executor = new FakeExecutor(async (c) => {
    const p = new OwnedProcess(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write('ready');setInterval(()=>{},1000);",
      ],
      c.worktree,
      { PATH: "/usr/bin:/bin" },
      c.observe,
    );
    groups.push(p.group.pid);
    p.child.stdout.resume();
    p.child.stderr.resume();
    started++;
    await new Promise<void>((resolve) => {
      if (c.signal.aborted) resolve();
      else c.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await p.stop(() => p.child.stdin.write('{\"type\":\"abort\"}\\n'));
    stopped++;
    c.signal.throwIfAborted();
    return undefined;
  });
  const f = await fixture(executor, 2000);
  try {
    await f.service.invoke("setup_project", f.registration());
    const a = await submit(f.service, f.submission("a"));
    const b = await submit(f.service, f.submission("b"));
    await waitFor(() => started === 1);
    await f.service.invoke("cancel_job", { projectId: "fixture", jobId: b });
    assert.equal(f.service.store.job(b).execution, "cancelled");
    const cancellation = (await f.service.invoke("cancel_job", {
      projectId: "fixture",
      jobId: a,
    })) as { execution: string };
    assert.equal(cancellation.execution, "cancelled");
    assert.equal(stopped, 1);
    assert(!groupAlive(groups[0]));
    assert(existsSync(join(f.options.root, "jobs", a, "worktree")));
    const c = await submit(f.service, f.submission("c"));
    assert.equal((await terminal(f.service, c)).execution, "timed_out");
    assert.equal(stopped, 2);
    assert(groups.every((g) => !groupAlive(g)));
  } finally {
    await f.service.close();
  }
});

test("restart preserves evidence, interrupted jobs are crashed without replay; single owner", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    await service.invoke("setup_project", f.registration());
    const id = await submit(service, f.submission());
    await terminal(service, id);
    await assert.rejects(AuditService.open(f.options), /service_already_owned/);
    const job = service.store.job(id);
    job.execution = "running";
    job.result = undefined;
    job.taskOutcome = "pending";
    job.groups = [];
    service.store.save(job, "simulate_interruption");
    await service.close();
    service = await AuditService.open(f.options);
    assert.equal(service.store.job(id).execution, "crashed");
    assert.equal(service.store.job(id).failurePhase, "restart");
    await delay(50);
    assert.equal(service.store.job(id).execution, "crashed");
    await assert.rejects(
      service.invoke("get_job", { projectId: "other", jobId: id }),
      /not_found_or_denied/,
    );
    assert(
      existsSync(
        join(f.options.root, "jobs", id, "evidence", "lead", "report.json"),
      ),
    );
  } finally {
    await service.close();
  }
});

test("retention: explicit ack only, dirty and symlink workspaces retained; refs and evidence survive clean ack", async () => {
  const f = await fixture();
  try {
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, f.submission());
    await terminal(f.service, id);
    const worktree = join(f.options.root, "jobs", id, "worktree");
    assert(existsSync(worktree));
    writeFileSync(join(worktree, "undelivered.txt"), "keep");
    await assert.rejects(
      f.service.invoke("acknowledge_handoff", {
        projectId: "fixture",
        jobId: id,
        disposition: "abandoned",
      }),
      /dirty_or_changed_workspace_retained/,
    );
    assert(existsSync(join(worktree, "undelivered.txt")));
    const clean = await submit(f.service, f.submission("clean"));
    await terminal(f.service, clean);
    const cleanRoot = join(f.options.root, "jobs", clean);
    writeFileSync(
      join(cleanRoot, "repo.git", "info", "exclude"),
      "ignored.data\n",
    );
    writeFileSync(
      join(cleanRoot, "worktree", "ignored.data"),
      "undelivered ignored data",
    );
    await assert.rejects(
      f.service.invoke("acknowledge_handoff", {
        projectId: "fixture",
        jobId: clean,
        disposition: "acknowledged",
      }),
      /dirty_or_changed_workspace_retained/,
    );
    assert(existsSync(join(cleanRoot, "worktree", "ignored.data")));
    unlinkSync(join(cleanRoot, "worktree", "ignored.data")); // explicit test-fixture disposal, never service cleanup
    await f.service.invoke("acknowledge_handoff", {
      projectId: "fixture",
      jobId: clean,
      disposition: "acknowledged",
    });
    assert(!existsSync(join(f.options.root, "jobs", clean, "worktree")));
    assert(
      existsSync(
        join(
          f.options.root,
          "jobs",
          clean,
          "repo.git",
          "refs",
          "jared",
          f.commit,
        ),
      ),
    );
    assert(f.service.store.job(clean).result);
    const alias = await submit(f.service, f.submission("alias"));
    await terminal(f.service, alias);
    const aliasPath = join(f.options.root, "jobs", alias, "worktree");
    renameSync(aliasPath, aliasPath + "-preserved");
    symlinkSync(f.repo, aliasPath);
    await assert.rejects(
      f.service.invoke("acknowledge_handoff", {
        projectId: "fixture",
        jobId: alias,
        disposition: "acknowledged",
      }),
      /symlink_forbidden/,
    );
    assert(existsSync(f.repo));
  } finally {
    await f.service.close();
  }
});

test("local registration and design source paths prevent traversal, symlinks and URL/ref injection", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "../README.md",
      "/etc/passwd",
      "a/../../b",
      "a//b",
      "-evil",
      "a/.git/config",
    ])
      await assert.rejects(
        f.service.invoke("setup_project", {
          ...f.registration(),
          designPaths: [path],
        }),
      );
    for (const path of [
      "file:///etc",
      "ext::evil",
      "ssh://evil/x",
      "https://example.com/a",
    ])
      assert.throws(() => validateLocalRepository({ path }));
    symlinkSync(f.repo, join(f.dir, "alias"));
    assert.throws(() =>
      validateLocalRepository({ path: join(f.dir, "alias") }),
    );
    symlinkSync("/etc/passwd", join(f.repo, "link"));
    f.git("add", "link");
    f.git("commit", "-qm", "symlink source");
    const commit = f.git("rev-parse", "HEAD");
    await f.service.invoke("setup_project", {
      ...f.registration(),
      designPaths: ["link"],
    });
    await assert.rejects(
      f.service.invoke("read_design_context", {
        projectId: "fixture",
        commit,
        path: "link",
      }),
      /not_regular_source/,
    );
    await assert.rejects(
      f.service.invoke("read_design_context", {
        projectId: "fixture",
        commit,
        path: "README.md",
      }),
      /design_path_not_registered/,
    );
  } finally {
    await f.service.close();
  }
});

test("orphan source reads fail closed with visible queued-job diagnostic, then reconcile on restart", async () => {
  const f = await fixture();
  let reopened: AuditService | undefined;
  let closed = false;
  try {
    await f.service.invoke("setup_project", f.registration());
    f.service.store.db
      .prepare("INSERT INTO source_reads VALUES(?,?)")
      .run("orphan", "[]");
    await assert.rejects(
      f.service.invoke("read_design_context", {
        projectId: "fixture",
        commit: f.commit,
        path: "README.md",
      }),
      /source_reconciliation_required/,
    );
    const id = await submit(f.service, f.submission());
    await waitFor(
      () =>
        f.service.store.job(id).diagnostic === "source_reconciliation_required",
    );
    assert.equal(f.service.store.job(id).execution, "queued");
    assert.equal(f.service.store.job(id).failurePhase, "source_reconciliation");
    assert(
      f.service.store
        .events(id)
        .some((e) => e.kind === "source_reconciliation_required"),
    );
    const cancelledId = await submit(
      f.service,
      f.submission("cancel-orphaned"),
    );
    await waitFor(
      () =>
        f.service.store.job(cancelledId).diagnostic ===
        "source_reconciliation_required",
    );
    await f.service.invoke("cancel_job", {
      projectId: "fixture",
      jobId: cancelledId,
    });
    const cancelled = f.service.store.job(cancelledId);
    assert.equal(cancelled.execution, "cancelled");
    assert.equal(cancelled.failurePhase, undefined);
    assert.equal(cancelled.diagnostic, undefined);
    await f.service.close();
    closed = true;
    reopened = await AuditService.open(f.options);
    const job = await terminal(reopened, id);
    assert.equal(job.taskOutcome, "delivered");
    assert.equal(job.diagnostic, undefined);
    assert.equal(job.failurePhase, undefined);
  } finally {
    if (!closed) await f.service.close();
    await reopened?.close();
  }
});

test("graceful shutdown records service interruption, not caller cancellation; no replay", async () => {
  let started = false;
  const executor = new FakeExecutor(async (c) => {
    started = true;
    await new Promise<void>((resolve) =>
      c.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    c.signal.throwIfAborted();
    return undefined;
  });
  const f = await fixture(executor);
  let closed = false;
  let reopened: AuditService | undefined;
  try {
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, f.submission());
    await waitFor(() => started);
    await f.service.close();
    closed = true;
    reopened = await AuditService.open({
      ...f.options,
      executor: new FakeExecutor(),
    });
    const job = reopened.store.job(id);
    assert.equal(job.execution, "crashed");
    assert.equal(job.agentOutcome, "aborted");
    assert.equal(job.failurePhase, "shutdown");
    assert.equal(job.diagnostic, "service_shutdown");
    assert.equal(job.result, undefined);
    assert(existsSync(join(f.options.root, "jobs", id, "worktree")));
    await delay(50);
    assert.equal(reopened.store.job(id).execution, "crashed");
  } finally {
    if (!closed) await f.service.close();
    await reopened?.close();
  }
});
