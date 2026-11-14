import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { bundledAgent, piConfigSchema, validatePiConfig, } from "./config.js";
import { privateDirectory, outsideCheckouts, outsideRoots, } from "./operator-paths.js";
import { oauthPath } from "./codex-auth.js";
import { noSymlinks, pathExists } from "./safety.js";
import { requireThat, ServiceError } from "./contracts.js";
const storedPi = z.union([
    piConfigSchema.options[0].omit({ jaredDir: true }),
    piConfigSchema.options[1].omit({ jaredDir: true }),
]);
const schema = z.strictObject({
    schemaVersion: z.literal(1),
    stateDir: z.string(),
    pi: storedPi,
});
export function socketPath(c) {
    const path = join(c.stateDir, "worker.sock");
    requireThat(Buffer.byteLength(path) < 104, "state_path_too_long_for_unix_socket");
    return path;
}
export function localPaths() {
    const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jared-local");
    const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "jared-local");
    for (const path of [configDir, stateDir])
        requireThat(isAbsolute(path) && resolve(path) === path, "absolute_xdg_path_required");
    return { configDir, stateDir, configFile: join(configDir, "config.json") };
}
export function ensurePrivateDirectory(path) {
    outsideCheckouts(path);
    let parent = path;
    while (!pathExists(parent))
        parent = dirname(parent);
    noSymlinks(parent);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    privateDirectory(path);
    return path;
}
export function configuredModel() {
    const s = JSON.parse(readFileSync(join(bundledAgent(), ".pi/settings.json"), "utf8"));
    requireThat(s.defaultProvider === "openai-codex" && typeof s.defaultModel === "string", "bundled_model_invalid");
    return {
        provider: s.defaultProvider,
        model: s.defaultModel,
    };
}
export function loadLocalConfig() {
    const { configDir, configFile } = localPaths();
    privateDirectory(configDir);
    noSymlinks(configFile);
    const st = statSync(configFile);
    requireThat(st.isFile() &&
        st.nlink === 1 &&
        (st.mode & 0o777) === 0o600 &&
        st.uid === process.getuid?.(), "private_config_file_required");
    const c = schema.parse(JSON.parse(readFileSync(configFile, "utf8")));
    privateDirectory(c.stateDir);
    outsideRoots(c.stateDir, [configDir, bundledAgent()]);
    outsideRoots(c.pi.provider === "openai-codex" ? oauthPath(c.pi) : c.pi.credentialFile, [c.stateDir, bundledAgent()]);
    return c;
}
export function bootstrap(api) {
    const paths = localPaths();
    if (existsSync(paths.configFile))
        return loadLocalConfig(); // Never reset choices or auth.
    ensurePrivateDirectory(paths.configDir);
    ensurePrivateDirectory(paths.stateDir);
    const pi = api
        ? {
            ...api,
            credentialEnv: api.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY",
        }
        : {
            ...configuredModel(),
            oauthDir: ensurePrivateDirectory(join(paths.configDir, "codex-auth")),
        };
    if (api)
        validatePiConfig({ ...pi, jaredDir: bundledAgent() });
    const c = schema.parse({ schemaVersion: 1, stateDir: paths.stateDir, pi });
    writeFileSync(paths.configFile, JSON.stringify(c, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
    });
    return loadLocalConfig();
}
export function executionConfig(c) {
    try {
        return validatePiConfig({ ...c.pi, jaredDir: bundledAgent() });
    }
    catch {
        throw new ServiceError("authentication_missing_or_invalid_run_jared_setup");
    }
}
/** Caller must hold the state owner lock, so an existing worker cannot retain old choices. */
export function saveAuthSource(c, source) {
    requireThat(c.pi.provider === "openai-codex", "oauth_provider_required");
    outsideRoots(source.path, [
        c.stateDir,
        bundledAgent(),
        localPaths().configFile,
    ]);
    const next = schema.parse({
        ...c,
        pi: { provider: c.pi.provider, model: c.pi.model, authSource: source },
    });
    writeFileSync(localPaths().configFile, JSON.stringify(next, null, 2) + "\n", {
        mode: 0o600,
    });
    return loadLocalConfig();
}
