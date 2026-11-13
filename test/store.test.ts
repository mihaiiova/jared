import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import type { Job } from "../src/contracts.js";

test("store migrates existing job states and indexed queries skip retained result bodies", () => {
  const root = mkdtempSync(join(tmpdir(), "jared-store-"));
  const db = new DatabaseSync(join(root, "service.sqlite"));
  db.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY, project TEXT NOT NULL, caller TEXT NOT NULL, idem TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(project,caller,idem))",
  );
  const job: Job = {
    jobId: "queued",
    projectId: "fixture",
    callerId: "alice",
    fingerprint: "test",
    submission: {
      projectId: "fixture",
      baseCommit: "a".repeat(40),
      kind: "audit",
      request: "test",
      scope: "product",
      idempotencyKey: "one",
    },
    execution: "queued",
    agentOutcome: "not_run",
    taskOutcome: "pending",
    verification: "not_run",
    createdAt: "test",
    groups: [],
  };
  db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?)").run(
    job.jobId,
    job.projectId,
    job.callerId,
    "one",
    JSON.stringify(job),
  );
  db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?)").run(
    "retained",
    "fixture",
    "alice",
    "retained",
    JSON.stringify({ ...job, jobId: "retained", execution: "stopped" }),
  );
  db.close();
  const store = new Store(root);
  try {
    assert.equal(
      store.db.prepare("SELECT execution FROM jobs WHERE id='retained'").get()!
        .execution,
      "stopped",
    );
    // A deliberately unreadable terminal body proves hot queries do not parse it.
    store.db.exec("UPDATE jobs SET body='not JSON' WHERE id='retained'");
    assert.equal(store.outstanding("alice"), 1);
    assert.equal(store.outstanding("eve"), 0);
    assert.deepEqual(
      store.jobsIn(["queued", "running"]).map((j) => j.jobId),
      ["queued"],
    );
    assert(!store.hasExecution("stop_unconfirmed"));
    job.execution = "stop_unconfirmed";
    store.save(job, "test");
    assert(store.hasExecution("stop_unconfirmed"));
    assert.equal(store.outstanding("alice"), 0);
    store.insert({
      ...job,
      jobId: "new",
      execution: "running",
      submission: { ...job.submission, idempotencyKey: "new" },
    });
    assert.equal(store.outstanding("alice"), 1);
    assert.match(
      JSON.stringify(
        store.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT count(*) FROM jobs WHERE caller=? AND execution IN ('queued','running')",
          )
          .all("alice"),
      ),
      /jobs_caller_execution/,
    );
    assert.match(
      JSON.stringify(
        store.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT body FROM jobs WHERE execution IN ('queued','running')",
          )
          .all(),
      ),
      /jobs_execution/,
    );
  } finally {
    store.close();
  }
  const reopened = new Store(root);
  try {
    assert(reopened.hasExecution("running"));
  } finally {
    reopened.close();
  }
});
