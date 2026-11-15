import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { repositoryRoot } from "./config.js";
import { requireThat } from "./contracts.js";
import { noSymlinks } from "./safety.js";
export const systemPath = "/usr/bin:/bin";
export const runtimeTargets = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
];
const entrySchema = z.strictObject({
    version: z.string(),
    file: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    archiveUrl: z.string().url(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.strictObject({
    schemaVersion: z.literal(1),
    targets: z.record(z.string(), z.strictObject({ fd: entrySchema, rg: entrySchema })),
    licenses: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
export function runtimeTarget(platform = process.platform, arch = process.arch) {
    const target = `${platform}-${arch}`;
    requireThat(runtimeTargets.includes(target), "unsupported_runtime_target");
    return target;
}
// Explicit root/target parameters are developer test/build seams, never CLI,
// environment or project configuration. Production always uses its own package.
export function packagedSearchTools(root = repositoryRoot(), target = runtimeTarget()) {
    requireThat(runtimeTargets.includes(target), "unsupported_runtime_target");
    const base = noSymlinks(join(root, "vendor/tools"));
    const manifestPath = noSymlinks(join(base, "manifest.json"));
    const manifestFile = lstatSync(manifestPath);
    requireThat(manifestFile.isFile() &&
        manifestFile.nlink === 1 &&
        (manifestFile.uid === 0 || manifestFile.uid === process.getuid?.()) &&
        (manifestFile.mode & 0o022) === 0 &&
        manifestFile.size > 0 &&
        manifestFile.size <= 64 * 1024, "unsafe_runtime_tool_manifest");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const selected = manifest.targets[target];
    requireThat(selected, "packaged_search_tools_missing_reinstall_jared");
    const bin = join(base, target);
    const result = { bin, fd: join(bin, "fd"), rg: join(bin, "rg") };
    for (const tool of ["fd", "rg"]) {
        requireThat(selected[tool].file === `${target}/${tool}`, "invalid_packaged_tool_path");
        const path = noSymlinks(result[tool]);
        const st = lstatSync(path);
        requireThat(st.isFile() &&
            st.nlink === 1 &&
            (st.uid === 0 || st.uid === process.getuid?.()) &&
            (st.mode & 0o022) === 0 &&
            (st.mode & 0o111) !== 0 &&
            st.size > 0 &&
            st.size <= 32 * 1024 * 1024, "unsafe_packaged_search_tool");
        requireThat(createHash("sha256").update(readFileSync(path)).digest("hex") ===
            selected[tool].sha256, "packaged_search_tool_checksum_mismatch");
    }
    return result;
}
export function searchToolPath() {
    return `${packagedSearchTools().bin}:${systemPath}`;
}
/** Setup/doctor only: run pinned binaries with no auth or global Pi resources. */
export function verifySearchTools() {
    const tools = packagedSearchTools();
    for (const tool of ["fd", "rg"]) {
        const result = spawnSync(tools[tool], ["--version"], {
            env: { PATH: systemPath, LANG: "C" },
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 4096,
        });
        requireThat(result.status === 0 &&
            !result.error &&
            result.stdout.startsWith(tool === "rg" ? "ripgrep " : "fd "), "packaged_search_tool_execution_failed");
    }
    return tools;
}
