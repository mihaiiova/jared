import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { OwnedProcess, type ProcessObserver } from "./process.js";
import { noSymlinks } from "./safety.js";
import { requireThat, sha, sourcePath } from "./contracts.js";
export type LocalRepository = { path: string };
export const gitEnv = {
  PATH: "/usr/bin:/bin",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_ATTR_NOSYSTEM: "1",
  HOME: "/nonexistent",
};
export function validateLocalRepository(
  repository: LocalRepository,
): LocalRepository {
  requireThat(
    isAbsolute(repository.path) && resolve(repository.path) === repository.path,
    "canonical_project_path_required",
  );
  noSymlinks(repository.path);
  requireThat(
    statSync(repository.path).isDirectory(),
    "project_directory_required",
  );
  return repository;
}
export async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  observe: ProcessObserver = () => {},
  local = false,
  trimOutput = true,
): Promise<string> {
  signal?.throwIfAborted();
  const p = new OwnedProcess(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "http.followRedirects=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=never",
      "-c",
      `protocol.file.allow=${local ? "always" : "never"}`,
      "-c",
      "fetch.recurseSubmodules=false",
      "-c",
      "protocol.ssh.allow=never",
      "-c",
      "core.attributesFile=/dev/null",
      ...args,
    ],
    cwd,
    gitEnv,
    observe,
  );
  let output = Buffer.alloc(0),
    overflow = false;
  p.child.stdout.on("data", (b: Buffer) => {
    if (output.length + b.length <= 1024 * 1024)
      output = Buffer.concat([output, b]);
    else {
      overflow = true;
      void p.stop();
    }
  });
  p.child.stderr.resume();
  const abort = () => {
    void p.stop().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15000);
  try {
    const exit = await p.exited;
    signal?.throwIfAborted();
    requireThat(exit.code === 0 && !overflow, "git_operation_failed");
    return trimOutput
      ? output.toString("utf8").trimEnd()
      : output.toString("utf8");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await p.stop();
  }
}
export async function fetchExact(
  dir: string,
  repository: LocalRepository,
  commit: string,
  signal?: AbortSignal,
  observe?: ProcessObserver,
) {
  sha.parse(commit);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  noSymlinks(dir);
  validateLocalRepository(repository);
  const run = (args: string[]) => git(dir, args, signal, observe, true);
  if (!existsSync(join(dir, "HEAD"))) await run(["init", "--bare", "."]);
  // Verify the full commit exists locally first; no network or remote configuration is used.
  requireThat(
    (await git(
      repository.path,
      ["cat-file", "-t", commit],
      signal,
      observe,
    )) === "commit",
    "local_commit_required",
  );
  await run([
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    repository.path,
    commit,
  ]);
  requireThat(
    (await run(["cat-file", "-t", commit])) === "commit",
    "not_a_commit",
  );
  requireThat(
    (await run(["rev-parse", "--verify", `${commit}^{commit}`])) === commit,
    "commit_mismatch",
  );
  await run(["update-ref", `refs/jared/${commit}`, commit]);
}
export async function prepareWorkspace(
  root: string,
  repository: LocalRepository,
  commit: string,
  signal: AbortSignal,
  observe: ProcessObserver,
) {
  const repo = join(root, "repo.git"),
    worktree = join(root, "worktree");
  await fetchExact(repo, repository, commit, signal, observe);
  await git(
    repo,
    ["worktree", "add", "--detach", worktree, commit],
    signal,
    observe,
    true,
  );
  noSymlinks(worktree);
  return { repo, worktree };
}
export async function snapshot(
  worktree: string,
  signal?: AbortSignal,
  observe?: ProcessObserver,
) {
  noSymlinks(worktree);
  noSymlinks(join(worktree, ".git"));
  const expected = join(dirname(worktree), "repo.git", "worktrees", "worktree");
  noSymlinks(expected);
  requireThat(
    readFileSync(join(worktree, ".git"), "utf8").trim() ===
      `gitdir: ${expected}`,
    "worktree_gitdir_changed",
  );
  const actualCommit = await git(
    worktree,
    ["rev-parse", "HEAD"],
    signal,
    observe,
  );
  const status = await git(
    worktree,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    signal,
    observe,
  );
  return { actualCommit, clean: status === "" };
}
export async function sourceAt(
  repo: string,
  commit: string,
  path: string,
  signal?: AbortSignal,
  observe?: ProcessObserver,
): Promise<string> {
  sha.parse(commit);
  sourcePath.parse(path);
  const listing = await git(
    repo,
    ["ls-tree", commit, "--", path],
    signal,
    observe,
  );
  requireThat(
    /^100(644|755) blob [0-9a-f]{40}\t/.test(listing) &&
      listing.split("\n").length === 1,
    "not_regular_source",
  );
  const object = listing.split(" ")[2].split("\t")[0];
  const size = Number(
    await git(repo, ["cat-file", "-s", object], signal, observe),
  );
  requireThat(size <= 256 * 1024, "source_too_large");
  return git(repo, ["cat-file", "blob", object], signal, observe, false, false);
}
