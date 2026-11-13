import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AuditService } from "../src/service.js";
import { groupAlive, receipt } from "../src/safety.js";
import { fixture, submit, waitFor } from "./helpers.js";
test("hard crash releases owner lock; restart reconciles or conservatively retains orphan without replay", async () => {
  const f = await fixture();
  await f.service.invoke("setup_project", f.registration());
  await f.service.close();
  const worker = join(f.dir, "crash-worker.mts");
  const src = resolve("src");
  writeFileSync(
    worker,
    `
    import {AuditService} from ${JSON.stringify(join(src, "service.ts"))};
    import {FakeExecutor} from ${JSON.stringify(resolve("test/fake-executor.ts"))};
    import {OwnedProcess} from ${JSON.stringify(join(src, "process.ts"))};
    const options=${JSON.stringify({ ...f.options, executor: undefined, timeoutMs: 60000 })};
    const service=await AuditService.open({...options,executor:new FakeExecutor(async c=>{
      const p=new OwnedProcess(process.execPath,['-e',"const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\\\n');setInterval(()=>{},1000);"],c.worktree,{PATH:'/usr/bin:/bin'},c.observe);
      p.child.stdout.once('data',()=>process.send({ jobId:c.packet.jobId,pid:p.group.pid}));p.child.stderr.resume();
      await new Promise(()=>{});
    })});
    await service.invoke('submit_job',${JSON.stringify(f.submission())});
  `,
  );
  const child = spawn(process.execPath, ["--import", "tsx", worker], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { PATH: "/usr/bin:/bin" },
  });
  child.stderr!.resume();
  const message = await new Promise<{ jobId: string; pid: number }>(
    (yes, no) => {
      const timer = setTimeout(
        () => no(new Error("crash worker startup timeout")),
        10000,
      );
      child.once("message", (m) => {
        clearTimeout(timer);
        yes(m as { jobId: string; pid: number });
      });
      child.once("exit", () => {
        clearTimeout(timer);
        no(new Error("crash worker exited"));
      });
    },
  );
  assert(groupAlive(message.pid));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGKILL");
  await exited;
  const restarted = await AuditService.open(f.options);
  try {
    const job = restarted.store.job(message.jobId);
    assert.equal(
      job.execution,
      process.platform === "darwin" ? "stop_unconfirmed" : "crashed",
    );
    assert.equal(job.failurePhase, "restart");
    assert.equal(groupAlive(message.pid), process.platform === "darwin");
    assert.equal(job.result, undefined);
    if (process.platform === "darwin") assert.equal(restarted.isIdle(), false);
  } finally {
    await restarted.close();
    // Test-owned orphan only; production must not signal a stale macOS PID.
    if (groupAlive(message.pid)) process.kill(-message.pid, "SIGKILL");
    await waitFor(() => !groupAlive(message.pid));
  }
  const recovered = await AuditService.open(f.options);
  try {
    assert.equal(recovered.store.job(message.jobId).execution, "crashed");
    assert.equal(recovered.store.job(message.jobId).result, undefined);
  } finally {
    await recovered.close();
  }
});

test("ambiguous source receipt preserves startup, durable diagnostics and ownership while blocking work", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
    cwd: f.dir,
  });
  await new Promise<void>((yes, no) => {
    child.once("spawn", yes);
    child.once("error", no);
  });
  const group = { ...receipt(child.pid!), start: "mismatched-start" };
  let restarted: AuditService | undefined;
  try {
    await f.service.invoke("setup_project", f.registration());
    f.service.store.db
      .prepare("INSERT INTO source_reads VALUES(?,?)")
      .run("ambiguous", JSON.stringify([group]));
    await f.service.close();
    restarted = await AuditService.open(f.options);
    assert(groupAlive(group.pid), "must not kill an identity-mismatched group");
    assert(
      restarted.store.db
        .prepare("SELECT 1 FROM source_reads WHERE id=?")
        .get("ambiguous"),
    );
    assert.equal(
      restarted.store.events("source:ambiguous")[0].kind,
      "source_reconciliation_required",
    );
    assert.equal(restarted.isIdle(), false);
    const id = await submit(restarted, f.submission());
    await waitFor(
      () =>
        restarted!.store.job(id).diagnostic ===
        "source_reconciliation_required",
    );
    assert.equal(restarted.store.job(id).execution, "queued");
    await assert.rejects(
      restarted.invoke("read_design_context", {
        projectId: "fixture",
        commit: f.commit,
        path: "README.md",
      }),
      /source_reconciliation_required/,
    );
    await restarted.invoke("cancel_job", { projectId: "fixture", jobId: id });
    assert.equal(
      restarted.isIdle(),
      false,
      "source receipt alone retains ownership",
    );
  } finally {
    if (restarted) await restarted.close();
    else await f.service.close();
    const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
    child.kill("SIGKILL");
    await exited;
  }
  const recovered = await AuditService.open(f.options);
  try {
    assert.equal(
      recovered.store.db
        .prepare("SELECT count(*) AS n FROM source_reads")
        .get()!.n,
      0,
    );
    assert.equal(recovered.isIdle(), true);
  } finally {
    await recovered.close();
  }
});

test("matching orphaned source group is stopped and its receipt removed at restart", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
    cwd: f.dir,
  });
  await new Promise<void>((yes, no) => {
    child.once("spawn", yes);
    child.once("error", no);
  });
  const group = receipt(child.pid!);
  const exited = new Promise<void>((yes) => child.once("exit", () => yes()));
  f.service.store.db
    .prepare("INSERT INTO source_reads VALUES(?,?)")
    .run("matching", JSON.stringify([group]));
  await f.service.close();
  let restarted: AuditService | undefined;
  try {
    restarted = await AuditService.open(f.options);
    assert(!groupAlive(group.pid));
    assert.equal(
      restarted.store.db
        .prepare("SELECT count(*) AS n FROM source_reads")
        .get()!.n,
      0,
    );
    assert.equal(restarted.isIdle(), true);
  } finally {
    await restarted?.close();
    if (groupAlive(group.pid)) child.kill("SIGKILL");
    await exited;
  }
});

test("stop_unconfirmed job retains owner even with no queued or active work", async () => {
  const f = await fixture();
  try {
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, f.submission());
    const job = f.service.store.job(id);
    job.execution = "stop_unconfirmed";
    f.service.store.save(job, "test_stop_unconfirmed");
    assert.equal(f.service.isIdle(), false);
    job.execution = "crashed";
    f.service.store.save(job, "test_stop_confirmed");
    assert.equal(f.service.isIdle(), true);
  } finally {
    await f.service.close();
  }
});
