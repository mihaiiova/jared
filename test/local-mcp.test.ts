import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  symlinkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { isolated, project, client, call } from "./local-fixtures.js";
import { loadLocalConfig } from "../src/local-config.js";
import { startWorker } from "../src/worker.js";
import { FakeExecutor } from "./fake-executor.js";
import { waitFor } from "./helpers.js";
const main = resolve("dist/src/main.js");
const setupArgs = (id: string, path: string) => ({
  projectId: id,
  projectPath: path,
  platform: "web",
  purpose: id,
  approvedDirection: "Preserve native semantics",
  setupProfile: "source-only-v1",
  designPaths: ["README.md"],
});
const submitArgs = (id: string, commit: string, key = "one") => ({
  projectId: id,
  baseCommit: commit,
  kind: "audit",
  request: "Audit source only",
  scope: "product",
  idempotencyKey: key,
});

test("actual stdio clients share local worker, explicit multi-project routing, unpushed clean snapshots, disconnect/restart and retained reports", async () => {
  const f = isolated();
  const previous = { ...process.env };
  Object.assign(process.env, f.env);
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const clients: Client[] = [];
  try {
    const boot = spawnSync(
      process.execPath,
      [main, "setup", "--no-login", "--no-register"],
      { env: f.env, encoding: "utf8", cwd: f.root },
    );
    assert.equal(boot.status, 0, boot.stderr);
    let waiting = false;
    worker = await startWorker(
      loadLocalConfig(),
      new FakeExecutor(async (c) => {
        assert(
          !readFileSync(join(c.worktree, "README.md"), "utf8").includes(
            "DIRTY",
          ),
        );
        if (waiting) await delay(10000, undefined, { signal: c.signal });
        else await delay(300, undefined, { signal: c.signal });
        return undefined;
      }),
    );
    const [a, b] = await Promise.all([
      client(main, f.env, "/"),
      client(main, f.env, f.root),
    ]);
    clients.push(a, b);
    const tools = await a.listTools();
    assert.equal(tools.tools.length, 10);
    assert.equal(
      tools.tools.find((t) => t.name === "setup_project")!.annotations
        ?.readOnlyHint,
      false,
    );
    const guide = (await call(a, "get_jared_guide", {})).data.guide;
    assert.match(guide, /Never infer/);
    assert.match(
      guide,
      /Audits require operator-selected auth \(jared setup\); no auth is needed for discovery\/setup_project/,
    );
    assert(!guide.includes("require dedicated auth"));
    assert.match(
      (await call(b, "get_jared_guide", {})).data.guide,
      /not code implementation/,
    );
    const one = project(f.root, "one"),
      two = project(f.root, "two");
    writeFileSync(join(one.path, "README.md"), "DIRTY original one\n");
    writeFileSync(join(two.path, "untracked.txt"), "DIRTY untracked two\n");
    const branch = one.git("symbolic-ref", "HEAD");
    const s1 = setupArgs("one", one.path),
      s2 = setupArgs("two", two.path);
    const both = await Promise.all([
      call(a, "setup_project", s1),
      call(b, "setup_project", s1),
    ]);
    assert(both.every((r) => !r.error));
    assert.equal((await call(b, "setup_project", s2)).error, false);
    const config = join(one.path, ".jared/config.json"),
      mtime = statSync(config).mtimeMs;
    assert.equal((await call(a, "setup_project", s1)).error, false);
    assert.equal(statSync(config).mtimeMs, mtime);
    assert.equal(
      (await call(a, "setup_project", { ...s1, projectId: "alias" })).error,
      true,
    );
    assert.equal(
      (
        await call(a, "submit_job", {
          ...submitArgs("one", one.commit),
          projectId: undefined,
        })
      ).error,
      true,
    );
    const source = await call(a, "read_design_context", {
      projectId: "one",
      commit: one.commit,
      path: "README.md",
    });
    assert.equal(source.data.text, "# one committed only\n");
    const r1 = await call(a, "submit_job", submitArgs("one", one.commit));
    const r2 = await call(b, "submit_job", submitArgs("two", two.commit));
    assert(!r1.error && !r2.error);
    const id1 = r1.data.jobId,
      id2 = r2.data.jobId;
    for (const name of [
      "get_job",
      "get_result",
      "get_report",
      "cancel_job",
      "acknowledge_handoff",
    ]) {
      const args = {
        projectId: "two",
        jobId: id1,
        ...(name === "acknowledge_handoff" ? { disposition: "abandoned" } : {}),
      };
      assert.deepEqual((await call(b, name, args)).data, {
        error: "not_found_or_denied",
      });
    }
    // Closing both stdio frontends must not cancel accepted jobs or own the worker lock.
    await Promise.all([a.close(), b.close()]);
    clients.length = 0;
    const c = await client(main, f.env, "/");
    clients.push(c);
    await waitFor(
      async () =>
        (await call(c, "get_job", { projectId: "one", jobId: id1 })).data
          .taskOutcome === "delivered",
    );
    await waitFor(
      async () =>
        (await call(c, "get_job", { projectId: "two", jobId: id2 })).data
          .taskOutcome === "delivered",
    );
    for (const [p, id, commit] of [
      [one, id1, one.commit],
      [two, id2, two.commit],
    ] as const) {
      const path = join(p.path, ".jared/runs", id, "result.json");
      assert.equal(JSON.parse(readFileSync(path, "utf8")).actualCommit, commit);
      assert(existsSync(join(p.path, ".jared/runs", id, "audit.md")));
      assert(existsSync(join(p.path, ".jared/runs", id, "reviewer-report.md")));
    }
    assert(!existsSync(join(one.path, ".jared/runs", id2)));
    assert(!existsSync(join(two.path, ".jared/runs", id1)));
    assert.equal(one.git("symbolic-ref", "HEAD"), branch);
    assert.equal(
      readFileSync(join(one.path, "README.md"), "utf8"),
      "DIRTY original one\n",
    );
    assert.equal(
      readFileSync(join(two.path, "untracked.txt"), "utf8"),
      "DIRTY untracked two\n",
    );
    assert.equal(
      (await call(c, "submit_job", submitArgs("one", one.commit))).data.jobId,
      id1,
    );
    waiting = true;
    const cancel = await call(
      c,
      "submit_job",
      submitArgs("one", one.commit, "cancel"),
    );
    await waitFor(() =>
      existsSync(
        join(
          loadLocalConfig().stateDir,
          "jobs",
          cancel.data.jobId,
          "evidence/lead/packet.json",
        ),
      ),
    );
    assert.equal(
      (
        await call(c, "cancel_job", {
          projectId: "one",
          jobId: cancel.data.jobId,
        })
      ).data.execution,
      "cancelled",
    );
    assert(
      existsSync(
        join(loadLocalConfig().stateDir, "jobs", cancel.data.jobId, "worktree"),
      ),
    );
    await c.close();
    clients.length = 0;
    await worker.close();
    worker = await startWorker(loadLocalConfig(), new FakeExecutor());
    const d = await client(main, f.env, "/");
    clients.push(d);
    assert.equal(
      (await call(d, "get_result", { projectId: "one", jobId: id1 })).data
        .visualVerification,
      "not_run",
    );
    assert.equal(
      (
        await call(d, "acknowledge_handoff", {
          projectId: "one",
          jobId: id1,
          disposition: "acknowledged",
        })
      ).error,
      false,
    );
    assert(
      !existsSync(join(loadLocalConfig().stateDir, "jobs", id1, "worktree")),
    );
    assert(existsSync(join(one.path, ".jared/runs", id1, "result.json")));
    const runs = join(one.path, ".jared/runs");
    renameSync(runs, runs + "-preserved");
    symlinkSync(two.path, runs);
    assert.equal(
      (await call(d, "submit_job", submitArgs("one", one.commit, "symlink")))
        .error,
      true,
    );
    unlinkSync(runs);
    renameSync(runs + "-preserved", runs);
    assert.equal(
      readFileSync(join(f.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8"),
      '{"sentinel":"GLOBAL-SECRET-DO-NOT-IMPORT"}\n',
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await worker?.close();
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
