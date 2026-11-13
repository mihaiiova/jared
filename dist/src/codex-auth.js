import { lstatSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ModelRuntime, readStoredCredential, } from "@earendil-works/pi-coding-agent";
import { outsideCheckouts } from "./operator-paths.js";
import { noSymlinks } from "./safety.js";
import { requireThat, ServiceError } from "./contracts.js";
export const codexProvider = "openai-codex";
export function oauthPath(pi) {
    requireThat(!!pi.oauthDir !== !!pi.authSource, "one_auth_source_required");
    return pi.authSource?.path ?? join(pi.oauthDir, "auth.json");
}
/** Normal Pi parents may contain settings/resources and need not be 0700.
 * They are never used as a resource root. Reject writable-by-others parents.
 */
export function safeAuthPath(path, allowMissing = false) {
    outsideCheckouts(path);
    noSymlinks(dirname(path));
    const parent = statSync(dirname(path));
    requireThat(parent.isDirectory() &&
        parent.uid === process.getuid?.() &&
        (parent.mode & 0o022) === 0, "unsafe_auth_parent");
    let st;
    try {
        st = lstatSync(path);
    }
    catch (e) {
        if (allowMissing && e.code === "ENOENT")
            return path;
        throw e;
    }
    noSymlinks(path);
    requireThat(st.isFile() &&
        st.nlink === 1 &&
        st.uid === process.getuid?.() &&
        (st.mode & 0o177) === 0 &&
        st.size > 0 &&
        st.size <= 256 * 1024, "safe_auth_file_required");
    return path;
}
/** Native one-off read does not resolve command keys, lock, refresh or write. */
export function inspectCodexAuth(path) {
    try {
        safeAuthPath(path);
        const c = readStoredCredential(codexProvider, path);
        requireThat(c &&
            c.type === "oauth" &&
            Object.keys(c).every((k) => ["type", "access", "refresh", "expires", "accountId"].includes(k)) &&
            [c.access, c.refresh, c.accountId].every((v) => typeof v === "string" &&
                v.length > 0 &&
                v.length <= 128 * 1024 &&
                !/[\x00-\x20\x7f]/.test(v)) &&
            Number.isSafeInteger(c.expires) &&
            c.expires > 0, "invalid_codex_oauth");
        return c;
    }
    catch {
        throw new ServiceError("invalid_codex_oauth");
    }
}
/** Pinned SDK services refresh all providers by default. Scope that public call
 * so unrelated command/API-key entries are never resolved during bootstrap.
 * allowModelNetwork:false disables catalog discovery, NOT model inference/OAuth refresh. */
export async function createCodexRuntime(path, create = ModelRuntime.create) {
    const runtime = await create({
        authPath: path,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    const refresh = runtime.refresh.bind(runtime);
    runtime.refresh = (options = {}) => refresh({ ...options, providers: [codexProvider], allowNetwork: false });
    return runtime;
}
