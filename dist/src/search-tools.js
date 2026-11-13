import { constants, copyFileSync, linkSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory } from "./local-config.js";
import { outsideCheckouts, privateDirectory } from "./operator-paths.js";
import { noSymlinks, pathExists } from "./safety.js";
import { requireThat } from "./contracts.js";
const tools = ["fd", "rg"];
export const systemPath = "/usr/bin:/bin";
export function searchBin(stateDir) {
    privateDirectory(stateDir);
    const root = join(stateDir, "search-tools");
    privateDirectory(root);
    return privateDirectory(join(root, "bin"));
}
/** Read-only, identical resolution for doctor and worker; no PATH discovery here. */
export function searchToolPath(stateDir) {
    const bin = searchBin(stateDir);
    for (const tool of tools)
        validateManagedBinary(join(bin, tool));
    return `${bin}:${systemPath}`;
}
function validateManagedBinary(path) {
    noSymlinks(path);
    const st = lstatSync(path);
    requireThat(st.isFile() &&
        st.nlink === 1 &&
        st.uid === process.getuid?.() &&
        (st.mode & 0o022) === 0 &&
        (st.mode & 0o111) !== 0, "unsafe_managed_search_tool");
}
/** Binary-only import: never read any Pi auth/settings/resources. */
function safeBinary(path) {
    requireThat(isAbsolute(path) && resolve(path) === path, "absolute_tool_required");
    outsideCheckouts(path);
    const canonical = realpathSync(path);
    outsideCheckouts(canonical);
    noSymlinks(canonical);
    const parents = [];
    for (let p = dirname(canonical);; p = dirname(p)) {
        parents.unshift(p);
        if (dirname(p) === p)
            break;
    }
    let privateBoundary = false;
    for (const p of parents) {
        const st = statSync(p);
        // Once an owned private directory excludes other users, group permissions
        // below it cannot expose the binary. This accepts normal Pi caches inside
        // a private HOME without weakening checks on public/shared ancestors.
        requireThat((st.uid === 0 || st.uid === process.getuid?.()) &&
            (privateBoundary ||
                (st.mode & 0o022) === 0 ||
                (st.uid === 0 && (st.mode & 0o1000) !== 0)), "unsafe_tool_parent");
        if (st.uid === process.getuid?.() && (st.mode & 0o077) === 0)
            privateBoundary = true;
    }
    const st = statSync(canonical);
    requireThat(st.isFile() &&
        (st.uid === 0 || st.uid === process.getuid?.()) &&
        (st.mode & 0o022) === 0 &&
        (st.mode & 0o111) !== 0 &&
        st.size > 0, "unsafe_search_tool");
    return canonical;
}
function existingBinary(tool) {
    const names = tool === "fd" ? ["fd", "fdfind"] : ["rg"];
    const pi = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
    const dirs = [...(process.env.PATH || "").split(delimiter), join(pi, "bin")];
    for (const dir of dirs)
        for (const name of names) {
            try {
                return safeBinary(join(dir, name));
            }
            catch {
                /* Skip unsafe/missing candidates. */
            }
        }
    return undefined;
}
function cacheBinary(source, bin, tool) {
    const target = join(bin, tool);
    if (pathExists(target))
        return; // Never replace a prior cache entry, including unsafe ones.
    const temp = mkdtempSync(join(dirname(bin), "copy-"));
    try {
        const staged = join(temp, tool);
        copyFileSync(safeBinary(source), staged, constants.COPYFILE_EXCL);
        const identity = lstatSync(staged);
        let published = false;
        // Publish a complete file exclusively; concurrent setup cannot overwrite it.
        try {
            linkSync(staged, target);
            published = true;
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
        }
        unlinkSync(staged);
        return published
            ? { path: target, dev: identity.dev, ino: identity.ino }
            : undefined;
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
export function searchHelperArgs() {
    const js = fileURLToPath(new URL("./search-tools-helper.js", import.meta.url));
    return pathExists(js)
        ? [js]
        : [
            "--import",
            import.meta.resolve("tsx"),
            fileURLToPath(new URL("./search-tools-helper.ts", import.meta.url)),
        ];
}
export function searchHelperEnv(home, agent, bin, download) {
    return {
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        PATH: `${bin}:${systemPath}`,
        LANG: "C.UTF-8",
        ...(download ? {} : { PI_OFFLINE: "1" }),
    };
}
/** Public native tool execution in a disposable private fixture; never a session/model. */
export function runSearchPreparation(fixture, bin, download) {
    const result = spawnSync(process.execPath, searchHelperArgs(), {
        cwd: fixture,
        env: searchHelperEnv(join(fixture, "home"), join(fixture, "pi"), bin, download),
        timeout: 180_000,
        maxBuffer: 8192,
        stdio: ["ignore", "pipe", "pipe"],
    });
    requireThat(result.status === 0, "native_search_preparation_failed_rerun_setup");
}
export async function prepareSearchTools(stateDir, ask, hooks = {}) {
    privateDirectory(stateDir);
    const root = ensurePrivateDirectory(join(stateDir, "search-tools"));
    const bin = ensurePrivateDirectory(join(root, "bin"));
    const created = [];
    const cache = (source, tool) => {
        const entry = cacheBinary(source, bin, tool);
        if (entry)
            created.push(entry);
    };
    let fixture;
    try {
        for (const tool of tools) {
            if (pathExists(join(bin, tool))) {
                validateManagedBinary(join(bin, tool));
                continue;
            }
            const source = (hooks.discover ?? existingBinary)(tool);
            if (source)
                cache(source, tool);
        }
        const missing = tools.filter((tool) => !pathExists(join(bin, tool)));
        const download = missing.length > 0;
        if (download &&
            !(await ask(`File-search helpers missing: ${missing.join(", ")}. Allow bundled Pi to download only missing helpers into private Jared state (up to 180 seconds; no login/model/registration permission)?`)))
            return false;
        fixture = mkdtempSync(join(root, "prepare-"));
        (hooks.prepare ?? runSearchPreparation)(fixture, bin, download);
        for (const tool of missing) {
            const downloaded = join(fixture, "pi/bin", tool);
            // Pi may have found an existing system tool instead of downloading.
            const source = pathExists(downloaded)
                ? downloaded
                : (hooks.discover ?? existingBinary)(tool);
            requireThat(source, "search_tool_missing_rerun_setup");
            cache(source, tool);
        }
        searchToolPath(stateDir);
        return true;
    }
    catch (error) {
        // Roll back only our own publications, never a pre-existing/concurrent entry.
        for (const entry of created) {
            try {
                const current = lstatSync(entry.path);
                if (current.dev === entry.dev && current.ino === entry.ino)
                    unlinkSync(entry.path);
            }
            catch (cleanupError) {
                if (cleanupError.code !== "ENOENT")
                    throw cleanupError;
            }
        }
        throw error;
    }
    finally {
        if (fixture)
            rmSync(fixture, { recursive: true, force: true });
    }
}
