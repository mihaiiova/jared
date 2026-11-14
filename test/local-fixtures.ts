import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./temp.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
export function isolated() {
  const root = mkdtempSync(join(tmpdir(), "jared-local-"));
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    PI_CODING_AGENT_DIR: join(root, "global-pi"),
  };
  mkdirSync(env.HOME);
  mkdirSync(env.PI_CODING_AGENT_DIR);
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR, "settings.json"),
    '{"sentinel":"do-not-change"}\n',
  );
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR, "auth.json"),
    '{"sentinel":"GLOBAL-SECRET-DO-NOT-IMPORT"}\n',
    { mode: 0o600 },
  );
  // Deliberately no global Pi helper cache or host-tool discovery.
  return { root, env };
}
export function project(root: string, name: string) {
  const path = join(root, name);
  mkdirSync(path);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: path,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  git("init", "-q");
  writeFileSync(join(path, "README.md"), `# ${name} committed only\n`);
  git("add", ".");
  git("commit", "-qm", "unpushed local fixture");
  return { path, git, commit: git("rev-parse", "HEAD") };
}
export async function client(
  cli: string,
  env: Record<string, string>,
  cwd: string,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    env,
    cwd,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const c = new Client({ name: "synthetic-main-agent", version: "1" });
  await c.connect(transport);
  return c;
}
export async function call(
  c: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0].text;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  return { error: !!r.isError, data };
}
