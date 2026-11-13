import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
export const auditTools = ["find", "grep", "ls", "read"];
export function scopedAuditPath(root: string, input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 1024 ||
    !input ||
    input.startsWith("@") ||
    input.includes("~") ||
    input.includes("\\") ||
    /[^\x20-\x7e]/.test(input) ||
    input.split("/").some((p) => p === ".." || p === ".git")
  )
    throw new Error("audit_path_denied");
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("/"))
    throw new Error("audit_path_denied");
  let current = root;
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root)
    throw new Error("audit_path_denied");
  for (const part of rel.split("/").filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("audit_path_denied");
  }
  const st = lstatSync(path);
  if (!st.isFile() && !st.isDirectory()) throw new Error("audit_path_denied");
  return path;
}
export default function auditGuard(pi: ExtensionAPI) {
  const root = realpathSync(process.cwd());
  pi.registerCommand("jared-audit-guard-v1", {
    description: "Service-owned scoped source-read guard",
    handler: async () => {},
  });
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getActiveTools().sort();
    const valid =
      ctx.cwd === root && JSON.stringify(tools) === JSON.stringify(auditTools);
    const path = process.env.JARED_AUDIT_GUARD_RECEIPT;
    if (path)
      writeFileSync(
        path,
        JSON.stringify({ schemaVersion: 1, cwd: ctx.cwd, tools, valid }),
        { mode: 0o600, flag: "wx" },
      );
  });
  pi.on("tool_call", (event) => {
    try {
      if (!auditTools.includes(event.toolName))
        throw new Error("audit_tool_denied");
      // Replace with a checked canonical absolute path, so Pi's ~/@/Unicode
      // normalization cannot resolve a different resource after this gate.
      const input = event.input as Record<string, unknown>;
      input.path = scopedAuditPath(root, input.path ?? ".");
    } catch {
      return {
        block: true,
        reason:
          "Source audit permits only non-symlink paths inside its exact-commit worktree, excluding Git metadata.",
      };
    }
  });
}
