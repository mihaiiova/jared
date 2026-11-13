import { spawnSync } from "node:child_process";
import { supportedPlatform, bootIdentity, processInfo, processGroupAlive, } from "./platform.js";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { bootstrap, executionConfig, loadLocalConfig, localPaths, saveAuthSource, } from "./local-config.js";
import { bundledAgent } from "./config.js";
import { outsideCheckouts, outsideRoots } from "./operator-paths.js";
import { inspectCodexAuth, oauthPath, safeAuthPath, createCodexRuntime, } from "./codex-auth.js";
import { noSymlinks, ownerLock, pathExists } from "./safety.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { requireThat } from "./contracts.js";
import { socketPath } from "./worker.js";
import { prepareSearchTools, searchToolPath } from "./search-tools.js";
export function verifyAssets() {
    const root = bundledAgent();
    const manifest = JSON.parse(readFileSync(join(root, "provenance.json"), "utf8"));
    requireThat(Object.keys(manifest.files).length === 10, "bundled_assets_incomplete");
    for (const [file, expected] of Object.entries(manifest.files))
        requireThat(createHash("sha256")
            .update(readFileSync(join(root, file)))
            .digest("hex") === expected, "bundled_asset_hash_mismatch");
}
function onPath(command) {
    return (process.env.PATH || "").split(delimiter).some((dir) => {
        try {
            return (statSync(join(dir, command)).isFile() &&
                (statSync(join(dir, command)).mode & 0o111) !== 0);
        }
        catch {
            return false;
        }
    });
}
function piRegistration() {
    try {
        const p = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "mcp.json");
        return JSON.parse(readFileSync(p, "utf8")).mcpServers?.jared;
    }
    catch {
        return undefined;
    }
}
export function piAuthPath() {
    return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "auth.json");
}
/** Public native login only; no settings, model files, resources or credential copies. */
export async function bundledLogin(path, interaction, create = ModelRuntime.create) {
    safeAuthPath(path, true);
    const runtime = await createCodexRuntime(path, create);
    try {
        await runtime.login("openai-codex", "oauth", interaction);
    }
    finally {
        await runtime.settleCredentialWrites();
    }
}
// Dependency arguments are offline test seams, never operator configuration.
export async function setup(options, hooks = {}) {
    supportedPlatform();
    verifyAssets();
    requireThat(!(options.usePiAuth && options.dedicated), "conflicting_auth_choices");
    let c = bootstrap(options.api);
    console.log(`Jared local setup: ${c.pi.provider}/${c.pi.model}\nPrivate configuration and state prepared; readiness checked below. Existing choices/auth are preserved.`);
    const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
    const ask = hooks.ask ??
        (async (message) => {
            if (!interactive)
                return false;
            const rl = createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            try {
                return /^y(es)?$/i.test((await rl.question(`${message} [y/N] `)).trim());
            }
            finally {
                rl.close();
            }
        });
    let toolsReady = false;
    try {
        toolsReady = await prepareSearchTools(c.stateDir, ask);
    }
    catch {
        console.log("File-search preparation failed. Rerun jared setup; check private state permissions and, if downloads were approved, connectivity.");
    }
    console.log(toolsReady
        ? "File-search helpers ready: native find and grep verified; shared private cache reused across jobs/roles."
        : "Audits BLOCKED: file-search helpers unavailable. Rerun jared setup and approve bundled Pi helper provisioning, or provide executable fd/fdfind and rg on setup PATH / Pi bin cache. No sudo/apt required.");
    if (!toolsReady)
        process.exitCode = 1;
    let authReady = false;
    try {
        executionConfig(c);
        authReady = true;
    }
    catch { }
    if (c.pi.provider === "openai-codex" &&
        (!authReady || options.usePiAuth || options.dedicated)) {
        // Existing valid choices are preserved even when a different initial mode was requested.
        if (authReady)
            console.log("Existing valid auth source preserved.");
        else {
            const path = options.dedicated
                ? join(localPaths().configDir, "codex-auth/auth.json")
                : piAuthPath();
            const kind = options.dedicated ? "dedicated" : "pi";
            let present = false;
            try {
                inspectCodexAuth(path);
                present = true;
            }
            catch { }
            const scope = `openai-codex/${c.pi.model} at ${JSON.stringify(path)}. Native refresh writes update this same ${kind === "pi" ? "shared" : "dedicated"} file; unrelated provider records are preserved. No Pi settings, extensions, MCP, models, prompts or skills are loaded`;
            const consent = present &&
                (options.usePiAuth ||
                    (!options.noLogin &&
                        (await ask(`Reuse your ${kind === "dedicated" ? "existing dedicated Codex" : "Pi"} login for ${scope}?`))));
            const loginConsent = !present &&
                !options.noLogin &&
                (await ask(`No valid selected OAuth login. Sign in using bundled Pi SDK 1.5.2 for ${scope}? (provider login only, no model prompt)`));
            if (consent || loginConsent) {
                let release;
                try {
                    release = await ownerLock(c.stateDir);
                }
                catch {
                    console.log("Auth change blocked: close Jared clients, cancel active jobs and wait for the owned worker to exit, then rerun setup. No processes were killed.");
                    throw new Error("active_worker_auth_change_blocked");
                }
                try {
                    outsideRoots(path, [
                        c.stateDir,
                        bundledAgent(),
                        localPaths().configFile,
                    ]);
                    if (loginConsent) {
                        outsideCheckouts(path);
                        // Validate existing ancestor before creating only the missing auth parent.
                        let ancestor = dirname(path);
                        while (!pathExists(ancestor))
                            ancestor = dirname(ancestor);
                        noSymlinks(ancestor);
                        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
                        safeAuthPath(path, true);
                        // Do not overwrite an existing malformed/command-key selected record.
                        if (existsSync(path)) {
                            const data = JSON.parse(readFileSync(path, "utf8"));
                            requireThat(data &&
                                typeof data === "object" &&
                                !Array.isArray(data) &&
                                !Object.hasOwn(data, "openai-codex"), "existing_selected_auth_preserved_repair_explicitly");
                        }
                        const login = hooks.login ??
                            (async (authPath) => {
                                const rl = createInterface({
                                    input: process.stdin,
                                    output: process.stdout,
                                });
                                try {
                                    await bundledLogin(authPath, {
                                        async prompt(p) {
                                            if (p.type === "select") {
                                                // Native Pi's default browser flow; URLs are displayed, not opened by Jared.
                                                requireThat(p.options.length > 0, "native_login_options_missing");
                                                return p.options[0].id;
                                            }
                                            return rl.question(`${p.message}: `, {
                                                signal: p.signal,
                                            });
                                        },
                                        notify(e) {
                                            if (e.type === "auth_url")
                                                console.log(`Open in your browser: ${e.url}\n${e.instructions ?? ""}`);
                                            else if (e.type === "device_code")
                                                console.log(`Open ${e.verificationUri} and enter ${e.userCode}`);
                                            else
                                                console.log(e.message);
                                        },
                                    });
                                }
                                finally {
                                    rl.close();
                                }
                            });
                        await login(path);
                    }
                    inspectCodexAuth(path);
                    c = saveAuthSource(c, { kind, path });
                    executionConfig(c);
                    authReady = true;
                }
                finally {
                    await release();
                }
            }
        }
    }
    console.log(authReady
        ? "Credentials present locally; provider/model availability is NOT verified."
        : c.pi.provider === "openai-codex"
            ? "Audits BLOCKED: no valid selected auth. Run jared setup to reuse your Pi login or sign in; MCP discovery/setup_project without model calls still work."
            : `Audits BLOCKED: no valid selected auth. Restore the private credentialFile for ${c.pi.provider}/${c.pi.credentialEnv}, then rerun jared setup; MCP discovery/setup_project without model calls still work.`);
    if (!options.noRegister) {
        const command = [
            process.execPath,
            fileURLToPath(new URL("./main.js", import.meta.url)),
            "mcp",
        ];
        const argv = ["mcp", "add", "jared", "--", ...command];
        console.log(`Pi opt-in preview (writes Pi user mcp.json, no connection yet):\npi ${argv.map((s) => JSON.stringify(s)).join(" ")}`);
        if (onPath("pi") &&
            !piRegistration() &&
            (await ask("Run this registration command?"))) {
            const r = spawnSync("pi", argv, {
                cwd: localPaths().configDir,
                stdio: ["ignore", "pipe", "pipe"],
                env: process.env,
            });
            requireThat(r.status === 0, "pi_registration_failed_no_diagnostics_echoed");
            console.log("Pi registered. Restart the coding agent; use /mcp to confirm connection.");
        }
        else
            console.log("No client settings changed. Existing registrations are never replaced automatically.");
    }
    console.log("Ask your coding agent: Read get_jared_guide, then set up Jared in this explicitly identified Git root and audit an exact local commit.");
}
export function doctor() {
    let healthy = true;
    const check = (fn, good, bad) => {
        try {
            fn();
            console.log(`OK: ${good}`);
        }
        catch {
            healthy = false;
            console.log(`MISSING: ${bad}`);
        }
    };
    check(() => {
        supportedPlatform();
        const [major, minor] = process.versions.node.split(".").map(Number);
        requireThat(major > 22 || (major === 22 && minor >= 19), "node_required");
    }, "Linux or macOS / supported Node", "Linux or macOS and Node >=22.19 required; Windows unsupported");
    check(verifyAssets, "10 bundled native assets match provenance", "Reinstall this local package; native asset hashes differ/missing");
    check(() => {
        requireThat(bootIdentity().length > 0, "missing_boot_identity");
        requireThat(processInfo(process.pid), "missing_process_identity");
        processGroupAlive(process.pid);
    }, "Native process inspection available", "System process inspection unavailable (Linux /proc; macOS ps and sysctl)");
    for (const tool of ["git"])
        check(() => {
            requireThat([`/usr/bin/${tool}`, `/bin/${tool}`].some((p) => {
                try {
                    const st = statSync(p);
                    return st.isFile() && (st.mode & 0o111) !== 0;
                }
                catch {
                    return false;
                }
            }), "missing_tool");
        }, `${tool} installed`, `Install system ${tool} (no auto download)`);
    check(() => {
        searchToolPath(loadLocalConfig().stateDir);
    }, "Managed fd and rg pass file-safety checks (same paths used by workers; rerun setup for native execution check)", "Run jared setup to prepare file-search helpers; doctor never downloads");
    check(() => {
        socketPath(loadLocalConfig());
    }, "Private local config/state ready", "Run jared setup --no-login --no-register; check private paths/permissions");
    check(() => {
        const c = loadLocalConfig();
        if (c.pi.provider === "openai-codex") {
            const path = oauthPath(c.pi);
            console.log(`Auth source: ${c.pi.authSource?.kind ?? "dedicated (legacy)"} at ${JSON.stringify(path)}`);
            const auth = inspectCodexAuth(path);
            console.log(auth.expires <= Date.now() + 300000
                ? "OAuth present: expired or needs-refresh before use; NOT live verified."
                : "OAuth present: locally unexpired; NOT live verified.");
        }
        executionConfig(c);
        console.log(`Model: ${c.pi.provider}/${c.pi.model}`);
    }, "Selected credentials present (not live verified)", "Audits blocked: missing/invalid selected auth; run jared setup to reuse your Pi login or sign in");
    console.log(`Pi: ${onPath("pi") ? "installed" : "not installed"}; Jared ${piRegistration() ? "registration present" : "not registered"}; connection NOT checked (use Pi /mcp).`);
    for (const client of ["claude", "codex"])
        console.log(`${client}: ${onPath(client) ? "installed" : "not installed"}; registration/connection not checked. Configure stdio: jared mcp.`);
    console.log("Read-only inspection only: no login, network, provider request, or client connection performed. Source-only; visuals not verified.");
    return healthy;
}
