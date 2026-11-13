import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { noSymlinks } from "./safety.js";
import { requireThat } from "./contracts.js";

/** Credentials must never be source in any Git checkout (including this service). */
export function outsideCheckouts(path: string) {
  requireThat(
    isAbsolute(path) && resolve(path) === path,
    "canonical_external_path_required",
  );
  for (let dir = path; ; dir = dirname(dir)) {
    requireThat(!existsSync(join(dir, ".git")), "credential_inside_checkout");
    if (dirname(dir) === dir) break;
  }
  return path;
}
export function privateDirectory(path: string) {
  outsideCheckouts(path);
  noSymlinks(path);
  const st = statSync(path);
  requireThat(
    st.isDirectory() &&
      (st.mode & 0o777) === 0o700 &&
      st.uid === process.getuid?.(),
    "private_operator_directory_required",
  );
  return path;
}
export function credentialFile(path: string) {
  outsideCheckouts(path);
  noSymlinks(path);
  privateDirectory(dirname(path));
  const st = statSync(path);
  requireThat(
    st.isFile() &&
      st.nlink === 1 &&
      st.uid === process.getuid?.() &&
      (st.mode & 0o777) === 0o600 &&
      st.size > 0 &&
      st.size <= 256 * 1024,
    "private_credential_file_required",
  );
  return path;
}
export function outsideRoots(path: string, roots: string[]) {
  requireThat(
    roots.every(
      (root) => path !== resolve(root) && !path.startsWith(resolve(root) + "/"),
    ),
    "credential_inside_source_or_state",
  );
}
