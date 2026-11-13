import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../agent/v1/", import.meta.url));
const provenance = JSON.parse(
  readFileSync(join(root, "provenance.json"), "utf8"),
);
// Export is explicit developer-only; normal builds verify self-contained checked-in assets.
const source = process.argv[2];
for (const [file, expected] of Object.entries(provenance.files)) {
  const bytes = readFileSync(join(source || root, file));
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`Approved asset hash mismatch: ${file}`);
  if (source) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(source, file), join(root, file));
  }
}
console.log(
  `Verified ${Object.keys(provenance.files).length} unchanged native assets`,
);
