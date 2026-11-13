import { rmSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
// tsc does not remove deleted source outputs: never ship obsolete remote entrypoints.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc"], {
  stdio: "inherit",
});
chmodSync(new URL("../dist/src/main.js", import.meta.url), 0o755);
