import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { startWorker } from "../src/worker.js";
import { bootstrap, loadLocalConfig, localPaths } from "../src/local-config.js";
import { isolated } from "./local-fixtures.js";
import { fixture, submit, terminal, waitFor } from "./helpers.js";
import { FakeExecutor } from "./fake-executor.js";

test("operator configuration accepts a larger finite whole-job budget and preserves old defaults", () => {
  const f = isolated();
  const previous = { ...process.env };
  Object.assign(process.env, f.env);
  try {
    bootstrap();
    const file = localPaths().configFile;
    const original = JSON.parse(readFileSync(file, "utf8"));
    delete original.jobTimeoutMs; // A v0.3.0 config must load without rewriting it.
    writeFileSync(file, JSON.stringify(original));
    assert.equal(loadLocalConfig().jobTimeoutMs, 120000);
    writeFileSync(file, JSON.stringify({ ...original, jobTimeoutMs: 600000 }));
    assert.equal(loadLocalConfig().jobTimeoutMs, 600000);
    for (const value of [0, -1, 1.5, 3600001, "600000", null]) {
      writeFileSync(file, JSON.stringify({ ...original, jobTimeoutMs: value }));
      assert.throws(() => loadLocalConfig());
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("live progress and retained paged logs are project-scoped and omit request content", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const f = await fixture(
    new FakeExecutor(async (c) => {
      c.progress?.({ kind: "prompt_accepted" });
      started = true;
      await gate;
      return undefined;
    }),
  );
  try {
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, {
      ...f.submission(),
      request: "PRIVATE_REQUEST_NOT_A_LOG",
    });
    await waitFor(() => started);
    const running = (await f.service.invoke("get_job", {
      projectId: "fixture",
      jobId: id,
    })) as any;
    assert.equal(running.progress.phase, "lead");
    assert.equal(running.progress.lastActivity, "prompt_accepted");
    assert.equal(running.progress.timeoutMs, 120000);
    assert(running.progress.deadlineAt);
    const page = (await f.service.invoke("get_job_logs", {
      projectId: "fixture",
      jobId: id,
      limit: 2,
    })) as any;
    assert.equal(page.events.length, 2);
    assert.equal(page.hasMore, true);
    assert(!JSON.stringify(page).includes("PRIVATE_REQUEST_NOT_A_LOG"));
    // The operator CLI reads the live database without starting another worker.
    const operator = isolated();
    const previous = { ...process.env };
    Object.assign(process.env, operator.env);
    try {
      const c = bootstrap();
      writeFileSync(
        localPaths().configFile,
        JSON.stringify({ ...c, stateDir: f.options.root }),
      );
      const before = f.service.store.events(id).length;
      const cli = spawnSync(
        process.execPath,
        [
          resolve("dist/src/main.js"),
          "logs",
          "--project",
          "fixture",
          "--job",
          id,
        ],
        { env: operator.env, cwd: "/", encoding: "utf8", timeout: 20000 },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const lines = cli.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(lines[0].type, "status");
      assert.equal(lines[0].progress.phase, "lead");
      assert(!cli.stdout.includes("PRIVATE_REQUEST_NOT_A_LOG"));
      assert.equal(f.service.store.events(id).length, before);
      const follow = spawn(
        process.execPath,
        [
          resolve("dist/src/main.js"),
          "logs",
          "--project",
          "fixture",
          "--job",
          id,
          "--follow",
          "--limit",
          "2",
        ],
        { env: operator.env, cwd: "/", signal: AbortSignal.timeout(60000) },
      );
      let output = "";
      follow.stderr.resume();
      follow.stdout.on("data", (bytes) => {
        output += bytes.toString();
        if (output.includes('"type":"status"')) release();
      });
      const [code] = await once(follow, "close");
      assert.equal(code, 0, output);
      assert(output.includes('"phase":"terminal"'));
      assert(!output.includes("PRIVATE_REQUEST_NOT_A_LOG"));
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
    await assert.rejects(
      f.service.invoke("get_job_logs", { projectId: "wrong", jobId: id }),
      /not_found_or_denied/,
    );
    await assert.rejects(
      f.service.invoke("get_job_logs", {
        projectId: "fixture",
        jobId: id,
        limit: 101,
      }),
    );
    release();
    const done = await terminal(f.service, id);
    assert.equal(done.taskOutcome, "delivered");
    const end = (await f.service.invoke("get_job_logs", {
      projectId: "fixture",
      jobId: id,
      after: page.nextCursor,
    })) as any;
    assert(end.events.every((event: any) => event.seq > page.nextCursor));
    assert.equal(end.progress.phase, "terminal");
  } finally {
    release();
    await f.service.close();
  }
});

test("log retention is bounded, reports lost cursors and filters unknown payloads", async () => {
  const f = await fixture();
  try {
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, f.submission());
    await terminal(f.service, id);
    const other = await submit(f.service, f.submission("second"));
    await terminal(f.service, other);
    assert.equal(
      f.service.store.jobLogs({ projectId: "fixture", jobId: other }).truncated,
      false,
    );
    const lifecycleCount = f.service.store
      .events(id)
      .filter((event) => event.kind !== "progress").length;
    for (let i = 0; i < 1010; i++)
      f.service.store.event(id, "progress", {
        phase: "lead",
        activity: "model_activity",
        privatePayload: "NEVER_EXPOSE_LOG_PAYLOAD",
      });
    assert.equal(
      f.service.store.events(id).filter((event) => event.kind === "progress")
        .length,
      1000,
    );
    assert.equal(
      f.service.store.events(id).filter((event) => event.kind !== "progress")
        .length,
      lifecycleCount,
    );
    const page = f.service.store.jobLogs({ projectId: "fixture", jobId: id });
    assert.equal(page.events.length, 100);
    assert.equal(page.truncated, true);
    assert(page.prunedThrough > 0);
    assert(!JSON.stringify(page).includes("NEVER_EXPOSE_LOG_PAYLOAD"));
    const resumed = f.service.store.jobLogs({
      projectId: "fixture",
      jobId: id,
      after: page.prunedThrough,
    });
    assert.equal(resumed.truncated, false);
    const retained = f.service.store.job(id);
    retained.diagnostic = "PRIVATE_UNKNOWN_DIAGNOSTIC";
    f.service.store.save(retained, "terminal");
    const safe = f.service.store.jobLogs({ projectId: "fixture", jobId: id });
    assert.equal(safe.diagnostic, "unclassified_execution_failure");
    assert(!JSON.stringify(safe).includes("PRIVATE_UNKNOWN_DIAGNOSTIC"));
  } finally {
    await f.service.close();
  }
});

test("setup persists an explicit budget, worker uses it, and active-worker changes are refused", async () => {
  const f = isolated();
  const previous = { ...process.env };
  Object.assign(process.env, f.env);
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const command = [
      resolve("dist/src/main.js"),
      "setup",
      "--no-login",
      "--no-register",
      "--job-timeout-seconds",
    ];
    const configured = spawnSync(process.execPath, [...command, "600"], {
      env: f.env,
      encoding: "utf8",
    });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(loadLocalConfig().jobTimeoutMs, 600000);
    const original = readFileSync(localPaths().configFile, "utf8");
    worker = await startWorker(loadLocalConfig(), new FakeExecutor());
    assert.equal(worker.service.options.timeoutMs, 600000);
    const blocked = spawnSync(process.execPath, [...command, "900"], {
      env: f.env,
      encoding: "utf8",
    });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /Timeout change blocked/);
    assert.equal(readFileSync(localPaths().configFile, "utf8"), original);
    for (const invalid of ["0", "3601", "1.5", "Infinity"]) {
      const result = spawnSync(process.execPath, [...command, invalid], {
        env: f.env,
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.equal(readFileSync(localPaths().configFile, "utf8"), original);
    }
  } finally {
    await worker?.close();
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
