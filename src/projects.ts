import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { git } from "./git.js";
import { noSymlinks, pathExists, owned } from "./safety.js";
import { requireThat, type Project } from "./contracts.js";

export async function validateProjectRoot(path: string) {
  requireThat(
    isAbsolute(path) && path === resolve(path),
    "canonical_project_path_required",
  );
  noSymlinks(path);
  const st = statSync(path);
  requireThat(
    st.isDirectory() && st.uid === process.getuid?.(),
    "same_user_project_required",
  );
  noSymlinks(join(path, ".git"));
  requireThat(
    statSync(join(path, ".git")).isDirectory(),
    "regular_git_root_required",
  );
  requireThat(
    (await git(path, ["rev-parse", "--show-toplevel"])) === path,
    "git_root_required",
  );
  requireThat(
    (await git(path, ["rev-parse", "--show-object-format"])) === "sha1",
    "sha1_repository_required",
  );
}
const marker = (p: Project) =>
  JSON.stringify(
    {
      schemaVersion: 1,
      projectId: p.projectId,
      projectPath: p.projectPath,
      mode: "source-only-v1",
    },
    null,
    2,
  ) + "\n";
const ignore = "runs/\n";
function checkFile(path: string, expected: string) {
  noSymlinks(path);
  const st = statSync(path);
  requireThat(
    st.isFile() &&
      st.nlink === 1 &&
      st.uid === process.getuid?.() &&
      (st.mode & 0o022) === 0 &&
      readFileSync(path, "utf8") === expected,
    "conflicting_project_config",
  );
}
export function validateProjectState(p: Project) {
  noSymlinks(p.projectPath);
  noSymlinks(join(p.projectPath, ".git"));
  requireThat(
    statSync(join(p.projectPath, ".git")).isDirectory(),
    "regular_git_root_required",
  );
  for (const path of [
    join(p.projectPath, ".jared"),
    join(p.projectPath, ".jared/runs"),
  ]) {
    requireThat(pathExists(path), "project_state_missing_run_setup_project");
    noSymlinks(path);
    const st = statSync(path);
    requireThat(
      st.isDirectory() &&
        st.uid === process.getuid?.() &&
        (st.mode & 0o022) === 0,
      "unsafe_project_state_directory",
    );
  }
  for (const name of ["config.json", ".gitignore"])
    requireThat(
      pathExists(join(p.projectPath, ".jared", name)),
      "project_state_missing_run_setup_project",
    );
  checkFile(join(p.projectPath, ".jared/config.json"), marker(p));
  checkFile(join(p.projectPath, ".jared/.gitignore"), ignore);
  noSymlinks(join(p.projectPath, ".jared/runs"));
  requireThat(
    statSync(join(p.projectPath, ".jared/runs")).isDirectory(),
    "project_runs_directory_required",
  );
}
/** Explicit operator-authorized writes only, never overwrites existing content. */
export async function setupProjectFiles(p: Project) {
  await validateProjectRoot(p.projectPath);
  const dir = join(p.projectPath, ".jared");
  if (pathExists(dir)) {
    noSymlinks(dir);
    requireThat(
      statSync(dir).isDirectory() &&
        statSync(dir).uid === process.getuid?.() &&
        (statSync(dir).mode & 0o022) === 0,
      "conflicting_project_config",
    );
    requireThat(
      readdirSync(dir).every((n) =>
        ["config.json", ".gitignore", "runs"].includes(n),
      ),
      "conflicting_project_config",
    );
  }
  for (const [name, expected] of [
    ["config.json", marker(p)],
    [".gitignore", ignore],
  ])
    if (pathExists(join(dir, name))) checkFile(join(dir, name), expected);
  if (pathExists(join(dir, "runs"))) {
    noSymlinks(join(dir, "runs"));
    const st = statSync(join(dir, "runs"));
    requireThat(
      st.isDirectory() &&
        st.uid === process.getuid?.() &&
        (st.mode & 0o022) === 0,
      "conflicting_project_config",
    );
    requireThat(
      existsSync(join(dir, "config.json")),
      "conflicting_project_config",
    );
  }
  requireThat(
    !(await git(p.projectPath, ["ls-files", "--", ".jared/runs"])),
    "tracked_runs_forbidden",
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, expected] of [
    ["config.json", marker(p)],
    [".gitignore", ignore],
  ])
    if (!pathExists(join(dir, name)))
      writeFileSync(join(dir, name), expected, { flag: "wx", mode: 0o600 });
  mkdirSync(join(dir, "runs"), { recursive: true, mode: 0o700 });
  validateProjectState(p);
  requireThat(
    (await git(p.projectPath, [
      "check-ignore",
      "--no-index",
      ".jared/runs/probe",
    ])) === ".jared/runs/probe",
    "runs_not_ignored",
  );
}
export function createReportDirectory(p: Project, jobId: string) {
  validateProjectState(p);
  const dir = join(p.projectPath, ".jared/runs", jobId);
  mkdirSync(dir, { mode: 0o700 }); // Exclusive: never adopt another run's directory.
  return owned(join(p.projectPath, ".jared/runs"), dir);
}
export function writeReport(
  p: Project,
  dir: string,
  name: string,
  content: string,
) {
  validateProjectState(p);
  owned(join(p.projectPath, ".jared/runs"), dir);
  writeFileSync(join(dir, name), content, { flag: "wx", mode: 0o600 });
}
