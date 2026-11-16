import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sourcePath } from "../src/contracts.js";
import { FakeExecutor } from "./fake-executor.js";
import { fixture, submit, terminal } from "./helpers.js";

const route = "client/src/routes/items.$id.tsx";

test("literal dollar route paths are valid while traversal, options and Git syntax remain refused", () => {
  assert.equal(sourcePath.parse(route), route);
  for (const path of [
    "../items.$id.tsx",
    "/tmp/items.$id.tsx",
    "client/../items.$id.tsx",
    "client/.git/config",
    "client//items.$id.tsx",
    "--output=file",
    "client/x:README.md",
    "client/x;touch-file",
    "client/x\nfile",
    "client/x\\file",
  ])
    assert.equal(sourcePath.safeParse(path).success, false, path);
});

test("both audit reports can validate and corroborate a committed dollar route filename", async () => {
  const roles: string[] = [];
  const f = await fixture(
    new FakeExecutor(async (c) => {
      roles.push(c.role);
      const reportPath = join(c.outputDir, "report.json");
      writeFileSync(
        reportPath,
        JSON.stringify({
          schemaVersion: 1,
          jobId: c.packet.jobId,
          reviewedCommit: c.packet.reviewedCommit,
          summary:
            "Synthetic source audit of a dynamic route; no provider ran.",
          findings: [
            {
              severity: "low",
              path: route,
              line: 1,
              observation: "Synthetic finding.",
              recommendation: "Verify the route semantics.",
            },
          ],
          inspectedPaths: [route],
          limitations: ["Synthetic test; no rendering."],
          visualVerification: "not_run",
        }),
      );
      return { agentOutcome: "completed", reportPath };
    }),
  );
  try {
    mkdirSync(join(f.repo, "client/src/routes"), { recursive: true });
    writeFileSync(join(f.repo, route), "export const route = 'item';\n");
    f.git("add", ".");
    f.git("commit", "-qm", "dynamic route fixture");
    await f.service.invoke("setup_project", f.registration());
    const id = await submit(f.service, {
      ...f.submission(),
      baseCommit: f.git("rev-parse", "HEAD"),
    });
    const job = await terminal(f.service, id);
    assert.equal(
      job.taskOutcome,
      "delivered",
      `${job.failurePhase}:${job.diagnostic}`,
    );
    assert.deepEqual(roles, ["lead", "ui-reviewer"]);
    assert.equal(job.result!.lead.findings[0].path, route);
    assert.equal(job.result!.reviewer.findings[0].path, route);
  } finally {
    await f.service.close();
  }
});
