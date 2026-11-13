import { createHash } from "node:crypto";
import { bootIdentity, processInfo, processGroupAlive } from "./platform.js";
import {
  constants,
  lstatSync,
  realpathSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { requireThat, type GroupReceipt } from "./contracts.js";
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function pathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export function noSymlinks(path: string): string {
  const p = resolve(path);
  let current = "/";
  for (const part of p.split(sep).filter(Boolean)) {
    current = join(current, part);
    requireThat(!lstatSync(current).isSymbolicLink(), "symlink_forbidden");
  }
  requireThat(realpathSync(p) === p, "noncanonical_path");
  return p;
}
export function owned(root: string, path: string): string {
  requireThat(
    isAbsolute(path) &&
      path === resolve(path) &&
      root === resolve(root) &&
      path.startsWith(root + sep),
    "outside_owned_root",
  );
  noSymlinks(path);
  return path;
}
export function readBounded(
  root: string,
  path: string,
  max = 256 * 1024,
): string {
  owned(root, path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    requireThat(
      st.isFile() && st.nlink === 1 && st.size > 0 && st.size <= max,
      "invalid_artifact_size_or_type",
    );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export const boot = bootIdentity;
export const procInfo = processInfo;
export const groupAlive = processGroupAlive;
export function receipt(pid: number): GroupReceipt {
  const i = procInfo(pid);
  requireThat(i, "missing_process_receipt");
  return { pid, start: i.start, boot: boot() };
}
export function sameProcess(g: GroupReceipt): boolean {
  return g.boot === boot() && procInfo(g.pid)?.start === g.start;
}
// A separate SQLite connection holds an EXCLUSIVE transaction for the owner's
// lifetime. SQLite's OS locks work on Linux/macOS and release on process death.
// Never unlink this database: replacing its inode would split ownership.
export async function ownerLock(root: string): Promise<() => Promise<void>> {
  // Keep audit-role bootstrap imports free of SQLite's experimental warning.
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  noSymlinks(root);
  const st = statSync(root);
  requireThat(
    (st.mode & 0o077) === 0 && st.uid === process.getuid?.(),
    "private_owned_state_required",
  );
  const path = join(root, "owner.sqlite");
  for (const candidate of [
    path,
    path + "-journal",
    path + "-wal",
    path + "-shm",
  ]) {
    if (!pathExists(candidate)) continue;
    noSymlinks(candidate);
    const file = statSync(candidate);
    requireThat(
      file.isFile() &&
        file.nlink === 1 &&
        file.uid === process.getuid?.() &&
        (file.mode & 0o077) === 0,
      "unsafe_owner_lock_file",
    );
  }
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(fd);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5)
      throw new Error("service_already_owned");
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    db.close();
    released = true;
  };
}
