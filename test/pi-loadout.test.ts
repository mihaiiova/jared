import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { scopedAuditPath } from "../src/audit-guard.js";
import {
  PiExecutor,
  neutralPacket,
  codexLaunchCommand,
} from "../src/executor.js";
import { bundledAgent } from "../src/config.js";
import { OwnedProcess } from "../src/process.js";
import { fixture, waitFor } from "./helpers.js";
for (const [mode, role] of [
  ["api-key-cli", "lead"],
  ["api-key-cli", "ui-reviewer"],
  ["codex-sdk", "lead"],
  ["codex-sdk", "ui-reviewer"],
] as const)
  test(`real Pi ${mode} ${role} no-prompt RPC startup: only explicit guard, scoped tools, no ambient/product extension execution`, async () => {
    const f = await fixture();
    const home = join(f.dir, "pi-home"),
      agent = join(home, "controlled");
    mkdirSync(agent, { recursive: true, mode: 0o700 });
    const global = join(home, ".pi", "agent");
    mkdirSync(global, { recursive: true });
    const canary = join(f.dir, "ambient-ran");
    const evil = join(f.dir, "evil.ts");
    writeFileSync(
      evil,
      `import {writeFileSync} from 'node:fs';export default ()=>writeFileSync(${JSON.stringify(canary)},'unexpected');`,
    );
    writeFileSync(
      join(global, "settings.json"),
      JSON.stringify({ extensions: [evil] }),
    );
    writeFileSync(
      join(f.repo, ".pi", "settings.json"),
      JSON.stringify({ extensions: [evil], defaultTools: ["bash", "write"] }),
    );
    const loadout = join(f.dir, "guard-loadout.json");
    const auth = mkdtempSync(join(tmpdir(), "jared-loadout-auth-"));
    writeFileSync(
      join(auth, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", key: `!touch ${canary}` },
        "openai-codex": {
          type: "oauth",
          access: "offline-placeholder",
          refresh: "offline-placeholder",
          accountId: "offline-account",
          expires: Date.now() + 3600000,
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(auth, "settings.json"),
      JSON.stringify({ extensions: [evil] }),
    );
    writeFileSync(join(auth, "models.json"), "not-json-should-never-load");
    const beforeAuth = readFileSync(join(auth, "auth.json"), "utf8");
    const networkAttempts = join(f.dir, "startup-network-attempts");
    const networkGuard = join(f.dir, "deny-network.mjs");
    // Child-local test instrumentation: record and reject requests before they leave
    // the process. No production preload/environment escape hatch is introduced.
    writeFileSync(
      networkGuard,
      `
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => {
  appendFileSync(${JSON.stringify(networkAttempts)}, new Error('attempt').stack + '\\n');
  throw new Error('test forbids startup network');
};
// The pinned CLI calls undici.install(), which otherwise replaces a plain stub.
Object.defineProperty(globalThis, 'fetch', { get: () => deny, set: () => {}, configurable: false });
http.request = http.get = https.request = https.get = deny;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof options === 'string' ? options : options?.path;
  // Permit only local Unix sockets (tsx's test-loader IPC), never TCP.
  if (typeof path === 'string' && path.startsWith('/')) return connect.apply(this, args);
  return deny();
};
tls.connect = deny;
syncBuiltinESMExports();
`,
    );
    // Capture the *actual* production role policy/argv. A handwritten fixture
    // policy missed that the bundled reviewer starts with YAML frontmatter.
    let launch: string[] | undefined;
    class CaptureLaunch extends PiExecutor {
      protected override startProcess(args: string[]): OwnedProcess {
        launch = args;
        throw new Error("captured_without_launch");
      }
    }
    const credential = join(auth, "api-key");
    writeFileSync(credential, "synthetic-no-provider-request", {
      mode: 0o600,
    });
    const executor = new CaptureLaunch(
      mode === "codex-sdk"
        ? {
            jaredDir: bundledAgent(),
            provider: "openai-codex",
            model: "gpt-6.1-sol",
            authSource: { kind: "dedicated", path: join(auth, "auth.json") },
          }
        : {
            jaredDir: bundledAgent(),
            provider: "openai",
            model: "gpt-4o",
            credentialEnv: "OPENAI_API_KEY",
            credentialFile: credential,
          },
    );
    await assert.rejects(
      executor.run({
        role,
        runId: randomUUID(),
        worktree: f.repo,
        outputDir: join(f.dir, "captured-run"),
        packet: neutralPacket(
          randomUUID(),
          f.commit,
          "fixture",
          "No-prompt startup probe",
          "web",
          "Preserve semantics",
          "flow",
          ["README.md"],
        ),
        signal: new AbortController().signal,
        observe: () => {},
      }),
      /captured_without_launch/,
    );
    assert(launch);
    const p = new OwnedProcess(
      process.execPath,
      ["--import", networkGuard, ...launch],
      f.repo,
      {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        ...(mode === "codex-sdk"
          ? { JARED_CODEX_AUTH_PATH: join(auth, "auth.json") }
          : { OPENAI_API_KEY: "synthetic-no-provider-request" }),
        JARED_AUDIT_GUARD_RECEIPT: loadout,
      },
      () => {},
    );
    let stdout = "",
      exited = false;
    void p.exited.then(() => {
      exited = true;
    });
    p.child.stdout.on("data", (b) => (stdout += b.toString()));
    p.child.stderr.resume();
    try {
      p.child.stdin.write('{"type":"get_commands","id":"probe"}\n');
      await waitFor(
        () =>
          exited ||
          stdout.split("\n").some((line) => {
            try {
              return JSON.parse(line).id === "probe";
            } catch {
              return false;
            }
          }),
        15000,
      );
      const response = stdout
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return {};
          }
        })
        .find((r) => r.id === "probe");
      assert.equal(
        response?.success,
        true,
        `${mode}/${role} exited before the native guard handshake`,
      );
      assert.deepEqual(
        response.data.commands.map((c: { name: string }) => c.name),
        ["jared-audit-guard-v1"],
      );
      const receipt = JSON.parse(readFileSync(loadout, "utf8"));
      assert.equal(receipt.valid, true);
      assert.deepEqual(receipt.tools, ["find", "grep", "ls", "read"]);
      assert.equal(receipt.cwd, f.repo);
      assert(!existsSync(canary));
      p.child.stdin.write('{"type":"get_state","id":"state"}\n');
      await waitFor(() => stdout.includes('"id":"state"'));
      const state = stdout
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return {};
          }
        })
        .find((r) => r.id === "state");
      if (mode === "codex-sdk") {
        assert.equal(state.data.model.provider, "openai-codex");
        assert.equal(state.data.model.id, "gpt-6.1-sol");
        assert(!existsSync(join(agent, "auth.json")));
      }
      // The real API-key CLI uses production launch flags, not PI_OFFLINE.
      // Let fire-and-forget startup work run while all outbound calls are denied.
      await delay(2000);
      assert(
        !existsSync(networkAttempts),
        "startup must not attempt a catalog/provider request",
      );
      assert(!stdout.includes("offline-placeholder"));
      assert.equal(readFileSync(join(auth, "auth.json"), "utf8"), beforeAuth);
      assert.equal(
        scopedAuditPath(f.repo, "README.md"),
        join(f.repo, "README.md"),
      );
      assert.throws(() => scopedAuditPath(f.repo, join(auth, "auth.json")));
      for (const path of [
        "/etc/passwd",
        "../evil.ts",
        "~/.pi/agent/auth.json",
        "@/etc/passwd",
        ".git/config",
        "\u202f/etc/passwd",
      ])
        assert.throws(() => scopedAuditPath(f.repo, path));
      symlinkSync("/etc/passwd", join(f.repo, "outside"));
      assert.throws(() => scopedAuditPath(f.repo, "outside"));
    } finally {
      await p.stop(() => p.child.stdin.write('{"type":"abort"}\n'));
      await f.service.close();
    }
  });

test("Codex SDK bootstrap refuses missing, duplicate or malformed explicit model/provider/policy before RPC startup", () => {
  const root = mkdtempSync(join(tmpdir(), "jared-codex-argv-"));
  const auth = join(root, "auth");
  const agent = join(root, "agent");
  mkdirSync(auth, { mode: 0o700 });
  mkdirSync(agent, { mode: 0o700 });
  writeFileSync(
    join(auth, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "offline-placeholder",
        refresh: "offline-placeholder",
        accountId: "offline-account",
        expires: Date.now() + 3600000,
      },
    }),
    { mode: 0o600 },
  );
  const provider = ["--provider", "openai-codex"];
  const model = ["--model", "gpt-6.1-sol"];
  const policy = ["--system-prompt", "Trusted fixture system policy"];
  for (const args of [
    [...provider, ...model, "--system-prompt"],
    [...provider, "--system-prompt", ...model],
    [...provider, ...model, "--system-prompt", ""],
    [...provider, ...model, "--system-prompt", "  "],
    [...provider, ...policy, "--model"],
    [...provider, ...policy, "--model", "--no-mcp"],
    [...provider, ...policy, "--model", "gpt-6.1-sol\n"],
    [...model, ...policy],
    [...model, ...policy, "--provider"],
    ["--provider", "openai", ...model, ...policy],
    [...provider, ...model, ...policy, ...policy],
  ]) {
    const result = spawnSync(
      process.execPath,
      [...codexLaunchCommand(), ...args],
      {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: agent,
          JARED_CODEX_AUTH_PATH: join(auth, "auth.json"),
        },
        input: '{"type":"get_state","id":"probe"}\n',
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "dedicated_codex_startup_failed");
  }
});
