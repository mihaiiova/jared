import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../vendor/tools/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
if (
  manifest.schemaVersion !== 1 ||
  JSON.stringify(Object.keys(manifest.targets).sort()) !==
    JSON.stringify([...targets].sort())
)
  throw new Error("Invalid runtime tool target matrix");
function verify(file, expected, executable = false) {
  const path = join(root, file);
  const st = lstatSync(path);
  if (!st.isFile() || st.nlink !== 1 || (executable && (st.mode & 0o111) === 0))
    throw new Error(`Invalid packaged runtime file: ${file}`);
  if (
    createHash("sha256").update(readFileSync(path)).digest("hex") !== expected
  )
    throw new Error(`Packaged runtime checksum mismatch: ${file}`);
}
for (const target of targets) {
  for (const tool of ["fd", "rg"]) {
    const entry = manifest.targets[target][tool];
    if (
      entry.file !== `${target}/${tool}` ||
      !/^https:\/\/github\.com\/(sharkdp\/fd|BurntSushi\/ripgrep)\/releases\/download\//.test(
        entry.archiveUrl,
      ) ||
      !/^[a-f0-9]{64}$/.test(entry.archiveSha256)
    )
      throw new Error(`Invalid upstream provenance: ${target}/${tool}`);
    verify(entry.file, entry.sha256, true);
  }
}
for (const [file, hash] of Object.entries(manifest.licenses)) {
  if (
    !/^licenses\/(fd|rg)\/(LICENSE-MIT|LICENSE-APACHE|COPYING|UNLICENSE)$/.test(
      file,
    )
  )
    throw new Error("Invalid license path");
  verify(file, hash);
}
if (
  !Object.keys(manifest.licenses).some((f) => f.startsWith("licenses/fd/")) ||
  !Object.keys(manifest.licenses).some((f) => f.startsWith("licenses/rg/"))
)
  throw new Error("Missing upstream licenses");
console.log(
  "Verified 8 packaged runtime binaries, 4 OS/CPU targets and upstream licenses",
);
