import test from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fixture, submit, terminal } from "./helpers.js";
test("failed source initialization releases its slot and durable receipt", async () => {
  const f = await fixture();
  try {
    await f.service.invoke("setup_project", f.registration());
    const parent = join(f.options.root, "sources", "fixture");
    mkdirSync(parent, { recursive: true });
    const cache = join(parent, f.commit);
    symlinkSync(f.repo, cache, "dir");
    const input = {
      projectId: "fixture",
      commit: f.commit,
      path: "README.md",
    };
    await assert.rejects(f.service.invoke("read_design_context", input));
    assert.equal(
      Number(
        f.service.store.db
          .prepare("SELECT count(*) AS n FROM source_reads")
          .get()!.n,
      ),
      0,
    );
    // fetchExact is async: even an early throw rejects at await, after the
    // context-read entry has been registered. No stale slot survives cleanup.
    unlinkSync(cache);
    const result = (await f.service.invoke("read_design_context", input)) as {
      text: string;
    };
    assert.match(result.text, /Source fixture/);
  } finally {
    await f.service.close();
  }
});

test("source context and audit use exact fetched commit, never current HEAD or uncommitted content", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.repo, "README.md"), "# New committed baseline\n");
    f.git("add", "README.md");
    f.git("commit", "-qm", "new baseline");
    const newer = f.git("rev-parse", "HEAD");
    writeFileSync(join(f.repo, "README.md"), "# Uncommitted local data\n");
    await f.service.invoke("setup_project", f.registration());
    const original = (await f.service.invoke("read_design_context", {
      projectId: "fixture",
      commit: f.commit,
      path: "README.md",
    })) as { text: string; commit: string };
    assert.match(original.text, /Source fixture/);
    assert(original.text.endsWith("\n"));
    assert.equal(original.commit, f.commit);
    const current = (await f.service.invoke("read_design_context", {
      projectId: "fixture",
      commit: newer,
      path: "README.md",
    })) as { text: string };
    assert.equal(current.text, "# New committed baseline\n");
    await assert.rejects(
      f.service.invoke("read_design_context", {
        projectId: "fixture",
        commit: "2".repeat(40),
        path: "README.md",
      }),
    );
    const job = await terminal(
      f.service,
      await submit(f.service, f.submission()),
    );
    assert.equal(job.result!.actualCommit, f.commit);
    assert.equal(
      readFileSync(join(f.repo, "README.md"), "utf8"),
      "# Uncommitted local data\n",
    );
  } finally {
    await f.service.close();
  }
});
