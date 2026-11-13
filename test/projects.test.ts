import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fixture, submit, terminal } from "./helpers.js";

test("setup_project rejects symlink/conflicting roots/config/ignore without overwriting user data", async (t) => {
  for (const mode of ["root", "state", "config", "ignore", "foreign"])
    await t.test(mode, async () => {
      const f = await fixture();
      try {
        const input = f.registration();
        const dir = join(f.repo, ".jared");
        if (mode === "root") {
          const alias = join(f.dir, "alias");
          symlinkSync(f.repo, alias);
          input.projectPath = alias;
        } else if (mode === "state") symlinkSync(f.dir, dir);
        else {
          mkdirSync(dir);
          writeFileSync(
            join(
              dir,
              mode === "config"
                ? "config.json"
                : mode === "ignore"
                  ? ".gitignore"
                  : "foreign.txt",
            ),
            "user-content-do-not-overwrite\n",
          );
        }
        await assert.rejects(f.service.invoke("setup_project", input));
        if (["config", "ignore", "foreign"].includes(mode)) {
          const file =
            mode === "config"
              ? "config.json"
              : mode === "ignore"
                ? ".gitignore"
                : "foreign.txt";
          assert.equal(
            readFileSync(join(dir, file), "utf8"),
            "user-content-do-not-overwrite\n",
          );
          assert(!existsSync(join(dir, "runs")));
        }
        assert.equal(
          f.service.store.db
            .prepare("SELECT count(*) AS n FROM projects")
            .get()!.n,
          0,
        );
      } finally {
        await f.service.close();
      }
    });
});

test("job report directory collision fails closed, retains prior files and never reports delivery", async () => {
  const f = await fixture();
  try {
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, f.submission());
    const dir = join(f.repo, ".jared/runs", id);
    mkdirSync(dir);
    writeFileSync(join(dir, "sentinel"), "keep");
    const job = await terminal(f.service, id);
    assert.equal(job.taskOutcome, "failed");
    assert.equal(job.result, undefined);
    assert.equal(readFileSync(join(dir, "sentinel"), "utf8"), "keep");
    assert(!existsSync(join(dir, "result.json")));
  } finally {
    await f.service.close();
  }
});

test("read-only integration review uses exact local commit and rejects cross-project linkage", async () => {
  const f = await fixture();
  try {
    await f.service.invoke("setup_project", f.registration());
    await f.service.invoke("setup_project", f.registration("other"));
    const original = await submit(f.service, f.submission());
    await terminal(f.service, original);
    const input = {
      projectId: "fixture",
      originalJobId: original,
      integratedCommit: f.commit,
      request: "Inspect integrated source only",
      idempotencyKey: "integration",
    };
    await assert.rejects(
      f.service.invoke("review_integration", { ...input, projectId: "other" }),
      /not_found_or_denied/,
    );
    const response = (await f.service.invoke("review_integration", input)) as {
      jobId: string;
    };
    const job = await terminal(f.service, response.jobId);
    assert.equal(job.taskOutcome, "delivered");
    assert.equal(job.submission.originalJobId, original);
    assert.equal(job.result!.visualVerification, "not_run");
    assert(
      existsSync(join(f.repo, ".jared/runs", response.jobId, "result.json")),
    );
  } finally {
    await f.service.close();
  }
});

test("same-root setup repairs missing state and updates metadata, but never changes roots or overwrites conflicts", async () => {
  const f = await fixture();
  try {
    const original = f.registration();
    await f.service.invoke("setup_project", original);
    rmSync(join(f.repo, ".jared"), { recursive: true });
    await assert.rejects(
      f.service.invoke("submit_job", f.submission()),
      /project_state_missing_run_setup_project/,
    );
    const updated = {
      ...original,
      purpose: "Updated purpose",
      approvedDirection: "Updated direction",
      designPaths: [],
    };
    await f.service.invoke("setup_project", updated);
    assert(existsSync(join(f.repo, ".jared/config.json")));
    assert.deepEqual(f.service.store.project("fixture"), updated);
    assert.equal(
      f.service.store.events("project:fixture")[0].kind,
      "project_metadata_updated",
    );
    await f.service.invoke("setup_project", updated);
    assert.equal(f.service.store.events("project:fixture").length, 1);
    await assert.rejects(
      f.service.invoke("setup_project", { ...updated, projectPath: f.dir }),
      /project_already_registered/,
    );
    writeFileSync(join(f.repo, ".jared/config.json"), "user-content\n");
    await assert.rejects(
      f.service.invoke("setup_project", {
        ...updated,
        purpose: "Must not persist",
      }),
      /conflicting_project_config/,
    );
    assert.deepEqual(f.service.store.project("fixture"), updated);
    assert.equal(
      readFileSync(join(f.repo, ".jared/config.json"), "utf8"),
      "user-content\n",
    );
  } finally {
    await f.service.close();
  }
});
