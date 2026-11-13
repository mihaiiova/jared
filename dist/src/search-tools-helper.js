import { mkdirSync, writeFileSync } from "node:fs";
// Service-owned preparation entrypoint, launched only with a sanitized environment.
// No session, auth store, resource loader, provider or model is constructed.
async function main() {
    process.umask(0o077);
    for (const path of [process.env.HOME, process.env.PI_CODING_AGENT_DIR]) {
        if (!path)
            throw new Error("private_fixture_required");
        mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const cwd = process.cwd();
    writeFileSync("jared-search-probe.txt", "JARED_SEARCH_PROBE\n", {
        mode: 0o600,
        flag: "wx",
    });
    const { createFindToolDefinition, createGrepToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const find = createFindToolDefinition(cwd);
    const grep = createGrepToolDefinition(cwd);
    // Native local find/grep only use cwd from the session context. No session is needed.
    const ctx = { cwd };
    const signal = AbortSignal.timeout(170_000);
    const found = await find.execute("prepare-find", { pattern: "jared-search-probe.txt" }, signal, undefined, ctx);
    const matched = await grep.execute("prepare-grep", { pattern: "JARED_SEARCH_PROBE", glob: "jared-search-probe.txt" }, signal, undefined, ctx);
    for (const result of [found, matched]) {
        if (!result.content.some((c) => c.type === "text" && c.text.includes("jared-search-probe.txt")))
            throw new Error("native_search_failed");
    }
    process.stdout.write("native find + grep OK\n");
}
void main().catch(() => {
    process.stderr.write("native_search_preparation_failed\n");
    process.exitCode = 1;
});
