import { SettingsManager, SessionManager, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, runRpcMode, } from "@earendil-works/pi-coding-agent";
import { inspectCodexAuth, codexProvider, createCodexRuntime, } from "./codex-auth.js";
import { auditGuardPath } from "./executor.js";
import { requireThat } from "./contracts.js";
// Only the trusted executor launches this entrypoint. Auth path is not a Pi config directory.
async function main() {
    process.umask(0o077);
    const authPath = process.env.JARED_CODEX_AUTH_PATH;
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    requireThat(authPath && agentDir, "dedicated_codex_configuration_required");
    const index = process.argv.indexOf("--system-prompt");
    const modelIndex = process.argv.indexOf("--model");
    const providerIndex = process.argv.indexOf("--provider");
    const policy = process.argv[index + 1];
    const modelId = process.argv[modelIndex + 1];
    requireThat(["--system-prompt", "--model", "--provider"].every((flag) => process.argv.filter((arg) => arg === flag).length === 1) &&
        index >= 0 &&
        typeof policy === "string" &&
        policy.trim().length > 0 &&
        !policy.startsWith("--") &&
        modelIndex >= 0 &&
        typeof modelId === "string" &&
        !/\s/.test(modelId) &&
        /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(modelId) &&
        providerIndex >= 0 &&
        process.argv[providerIndex + 1] === codexProvider, "explicit_model_and_policy_required");
    inspectCodexAuth(authPath);
    const modelRuntime = await createCodexRuntime(authPath);
    const model = modelRuntime.getModel(codexProvider, modelId);
    requireThat(model, "configured_codex_model_not_in_pinned_catalog");
    const runtime = await createAgentSessionRuntime(async (target) => {
        const settingsManager = SettingsManager.inMemory({
            packages: [],
            extensions: [],
            enableSkillCommands: false,
            compaction: { enabled: false },
            retry: { enabled: false },
        });
        const services = await createAgentSessionServices({
            cwd: target.cwd,
            agentDir,
            settingsManager,
            modelRuntime,
            resourceLoaderOptions: {
                noExtensions: true,
                additionalExtensionPaths: [auditGuardPath()],
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                systemPrompt: policy,
                agentsFilesOverride: () => ({ agentsFiles: [] }),
                appendSystemPromptOverride: () => [],
            },
        });
        const result = await createAgentSessionFromServices({
            services,
            sessionManager: target.sessionManager,
            model,
            tools: ["read", "ls", "find", "grep"],
            sessionStartEvent: target.sessionStartEvent,
        });
        return { ...result, services, diagnostics: services.diagnostics };
    }, {
        cwd: process.cwd(),
        agentDir,
        sessionManager: SessionManager.inMemory(process.cwd()),
    });
    await runRpcMode(runtime);
}
void main().catch(() => {
    // Provider/library exception causes can contain token response bodies. Never echo them.
    process.stderr.write("dedicated_codex_startup_failed\n");
    process.exitCode = 1;
});
