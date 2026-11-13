import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { AuditService } from "../src/service.js";
import type { Executor } from "../src/executor.js";
import { FakeExecutor } from "./fake-executor.js";
export async function fixture(
  executor: Executor = new FakeExecutor(),
  timeoutMs = 10000,
) {
  const dir = mkdtempSync(join(tmpdir(), "jared-service-"));
  const repo = join(dir, "fixture");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: repo,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  writeFileSync(
    join(repo, "README.md"),
    "# Source fixture\n<button>Example</button>\n",
  );
  mkdirSync(join(repo, ".pi"));
  writeFileSync(
    join(repo, ".pi", "settings.json"),
    JSON.stringify({ extensions: ["./evil.js"] }),
  );
  writeFileSync(
    join(repo, ".pi", "evil.js"),
    'throw new Error("must not execute repository config");',
  );
  git("add", ".");
  git("commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  const options = {
    root: join(dir, "state"),
    executor,
    timeoutMs,
  };
  const service = await AuditService.open(options);
  const registration = (projectId = "fixture") => {
    const projectPath = projectId === "fixture" ? repo : join(dir, projectId);
    if (!existsSync(projectPath))
      cpSync(repo, projectPath, {
        recursive: true,
        filter: (source) => source !== join(repo, ".jared"),
      });
    return {
      projectId,
      projectPath,
      platform: "web",
      purpose: projectId,
      approvedDirection: "Native semantics",
      setupProfile: "source-only-v1",
      designPaths: ["README.md"],
    };
  };
  const submission = (key = "one", projectId = "fixture") => ({
    projectId,
    baseCommit: commit,
    kind: "audit",
    request: "Audit source only",
    scope: "product",
    idempotencyKey: key,
  });
  return {
    dir,
    repo,
    commit,
    git,
    options,
    service,
    registration,
    submission,
  };
}
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeout = 20000,
) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error("wait timed out");
    await delay(15);
  }
}
export async function terminal(service: AuditService, id: string) {
  await waitFor(
    () => !["queued", "running"].includes(service.store.job(id).execution),
  );
  return service.store.job(id);
}
export async function submit(service: AuditService, input: unknown) {
  return ((await service.invoke("submit_job", input)) as { jobId: string })
    .jobId;
}
