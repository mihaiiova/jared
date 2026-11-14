import { searchToolPath } from "../src/search-tools.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "./temp.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiExecutor, neutralPacket, type RunContext } from "../src/executor.js";
import { OwnedProcess, type ProcessObserver } from "../src/process.js";
import { groupAlive } from "../src/safety.js";
import { fixture, submit, terminal, waitFor } from "./helpers.js";

// Only the CLI process is substituted. Production PiExecutor owns JSONL parsing,
// prompt/guard handshake, abort/stop, report storage and durable run receipts.
const stub = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mode = process.argv[2];
const root = path.dirname(process.env.JARED_AUDIT_GUARD_RECEIPT);
const send = e => process.stdout.write(JSON.stringify(e) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const cmd = JSON.parse(line);
  fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify(cmd) + '\n');
  if (cmd.type === 'abort') { process.exit(0); }
  if (cmd.type === 'get_commands') {
    if (mode === 'early-exit') { process.exit(1); }
    if (mode === 'settled-only-exit') { send({ type: 'agent_settled' }); process.exit(0); }
    if (mode === 'malformed') { process.stdout.write('not JSON: sensitive-provider-text\n'); return; }
    const loadout = { valid: mode !== 'guard-invalid', cwd: process.cwd(), tools: ['find','grep','ls','read'] };
    fs.writeFileSync(process.env.JARED_AUDIT_GUARD_RECEIPT, mode === 'guard-oversized' ? 'x'.repeat(9000) : JSON.stringify(loadout));
    send({ type: 'response', id: cmd.id, command: 'get_commands', success: true, data: { commands: mode === 'guard-missing' ? [] : [{ name: 'jared-audit-guard-v1', source: 'extension' }] } });
  }
  if (cmd.type === 'prompt') {
    if (mode === 'prompt-rejected') { send({ type: 'response', id: cmd.id, command: 'prompt', success: false, error: 'sensitive-provider-text' }); return; }
    send({ type: 'response', id: cmd.id, command: 'prompt', success: true, data: { disposition: 'started' } });
    if (mode === 'wait') return;
    if (mode === 'accepted-only-exit') { process.exit(0); }
    const packet = JSON.parse(cmd.message);
    const report = { schemaVersion: 1, jobId: packet.jobId, reviewedCommit: packet.reviewedCommit, summary: 'Offline RPC fixture; no provider ran.', findings: [], inspectedPaths: ['README.md'], limitations: ['Synthetic protocol response'], visualVerification: 'not_run' };
    send({ type: 'message_end', message: { role: 'assistant', stopReason: mode === 'agent-error' ? 'error' : mode === 'agent-aborted' ? 'aborted' : mode === 'truncated' ? 'length' : 'stop', content: [{ type: 'text', text: JSON.stringify(report) }] } });
    send({ type: 'agent_settled' });
  }
});
`;

function offlineExecutor(
  mode: string,
  authKind: "api-key" | "codex" = "api-key",
) {
  const root = mkdtempSync(join(tmpdir(), "jared-pi-executor-"));
  const jaredDir = join(root, "policy-fixture");
  for (const [file, text] of Object.entries({
    ".pi/APPEND_SYSTEM.md": "Fixture lead policy",
    ".pi/agents/ui-reviewer.md": "Fixture reviewer policy",
    ".pi/skills/ui-evaluate/SKILL.md": "Fixture evaluation policy",
    ".pi/skills/ui-audit/SKILL.md": "Fixture audit policy",
  })) {
    mkdirSync(join(jaredDir, file, ".."), { recursive: true });
    writeFileSync(join(jaredDir, file), text);
  }
  const credentialFile = join(root, "credential-fixture");
  // Deliberately inert placeholder, not a generated or usable secret.
  writeFileSync(credentialFile, "offline-test-placeholder", { mode: 0o600 });
  const authDir = mkdtempSync(join(tmpdir(), "jared-executor-auth-"));
  writeFileSync(
    join(authDir, "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "oauth-access-placeholder",
        refresh: "oauth-refresh-placeholder",
        accountId: "offline-account",
        expires: Date.now() + 3600000,
      },
    }),
    { mode: 0o600 },
  );
  const script = join(root, "rpc-stub.cjs");
  writeFileSync(script, stub);
  class OfflinePiExecutor extends PiExecutor {
    protected override startProcess(
      args: string[],
      cwd: string,
      env: NodeJS.ProcessEnv,
      observe: ProcessObserver,
    ) {
      if (authKind === "api-key") {
        assert(args.includes("--offline"));
        assert(args.includes("--no-mcp"));
        assert(args.includes("--no-context-files"));
        assert(args.includes("read,ls,find,grep"));
      }
      // OAuth tools/resources are fixed by codex-rpc, exercised by pi-loadout.test.
      assert.equal(
        args[args.indexOf("--provider") + 1],
        authKind === "codex" ? "openai-codex" : "openai",
      );
      assert(
        args[args.indexOf("--system-prompt") + 1].includes(
          "HOST OVERRIDE: Source-only audit.",
        ),
      );
      assert.equal(
        env.OPENAI_API_KEY,
        authKind === "api-key" ? "offline-test-placeholder" : undefined,
      );
      assert.equal(
        env.JARED_CODEX_AUTH_PATH,
        authKind === "codex" ? join(authDir, "auth.json") : undefined,
      );
      assert.equal(env.PI_OFFLINE, undefined);
      assert.equal(env.PATH, searchToolPath());
      assert.equal(env.GIT_SSH, undefined);
      assert.equal(env.GIT_SSH_COMMAND, undefined);
      assert.equal(env.JARED_GIT_IDENTITY, undefined);
      assert.equal(env.JARED_GIT_KNOWN_HOSTS, undefined);
      assert(!JSON.stringify(args).includes("oauth-access-placeholder"));
      assert(!JSON.stringify(args).includes("oauth-refresh-placeholder"));
      assert.notEqual(env.PI_CODING_AGENT_DIR, authDir);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.SSH_AUTH_SOCK, undefined);
      return new OwnedProcess(
        process.execPath,
        [script, mode],
        cwd,
        env,
        observe,
      );
    }
  }
  const executor = new OfflinePiExecutor(
    authKind === "codex"
      ? {
          jaredDir,
          provider: "openai-codex",
          model: "gpt-6.1-sol",
          authSource: { kind: "pi", path: join(authDir, "auth.json") },
        }
      : {
          jaredDir,
          provider: "openai",
          model: "offline-fixture-only",
          credentialEnv: "OPENAI_API_KEY",
          credentialFile,
        },
  );
  const outputDir = join(root, "evidence");
  const context: RunContext = {
    role: "lead",
    runId: randomUUID(),
    worktree: root,
    outputDir,
    packet: neutralPacket(
      randomUUID(),
      "a".repeat(40),
      "fixture",
      "Source audit",
      "web",
      "fixture",
      "product",
      ["README.md"],
    ),
    signal: new AbortController().signal,
    observe: () => {},
  };
  const receipt = () =>
    JSON.parse(readFileSync(join(outputDir, "run-receipt.json"), "utf8"));
  const commands = () =>
    readFileSync(join(outputDir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return {
    executor,
    context,
    receipt,
    commands,
    authPath: join(authDir, "auth.json"),
  };
}

test("PiExecutor offline RPC success requires guard, acceptance, final stop and settlement; persists stopped receipt", async () => {
  const f = offlineExecutor("success");
  const out = await f.executor.run(f.context);
  assert.equal(out.agentOutcome, "completed");
  assert.equal(
    JSON.parse(readFileSync(out.reportPath, "utf8")).jobId,
    f.context.packet.jobId,
  );
  assert.deepEqual(
    f.commands().map((c) => c.type),
    ["get_commands", "prompt", "abort"],
  );
  const r = f.receipt();
  assert.equal(r.runId, f.context.runId);
  assert.equal(r.role, "lead");
  for (const key of ["accepted", "settled", "guardVerified", "stopConfirmed"])
    assert.equal(r[key], true);
  assert.equal(r.lastStop, "stop");
  assert.match(r.guardHash, /^[a-f0-9]{64}$/);
  assert(!groupAlive(r.group.pid));
});

test("PiExecutor offline RPC failures are bounded, fail closed and keep safe guard diagnostics", async (t) => {
  for (const [mode, code] of [
    ["early-exit", "pi_protocol_or_agent_failure"],
    ["settled-only-exit", "pi_protocol_or_agent_failure"],
    ["accepted-only-exit", "pi_protocol_or_agent_failure"],
    ["malformed", "pi_protocol_or_agent_failure"],
    ["prompt-rejected", "pi_protocol_or_agent_failure"],
    ["guard-missing", "audit_guard_not_loaded"],
    ["guard-invalid", "audit_loadout_mismatch"],
    ["guard-oversized", "invalid_artifact_size_or_type"],
    ["agent-error", "pi_incomplete_output"],
    ["agent-aborted", "pi_incomplete_output"],
    ["truncated", "pi_incomplete_output"],
  ])
    await t.test(mode, { timeout: 10000 }, async () => {
      const f = offlineExecutor(mode);
      await assert.rejects(f.executor.run(f.context), (error) => {
        assert(error instanceof Error);
        assert.equal(error.message, code);
        assert(!error.message.includes("sensitive-provider-text"));
        return true;
      });
      const r = f.receipt();
      assert.equal(r.stopConfirmed, true);
      assert(!groupAlive(r.group.pid));
      assert(!existsSync(join(f.context.outputDir, "report.json")));
      if (mode.startsWith("guard-") || mode === "malformed") {
        assert.equal(r.guardVerified, false);
        assert(!f.commands().some((c) => c.type === "prompt"));
      }
    });
});

test("PiExecutor offline abort/deadline signals send native abort and stop the group", async (t) => {
  for (const trigger of ["caller", "deadline"])
    await t.test(trigger, { timeout: 10000 }, async () => {
      const f = offlineExecutor("wait");
      const controller = new AbortController();
      const signal =
        trigger === "deadline" ? AbortSignal.timeout(400) : controller.signal;
      const run = f.executor.run({ ...f.context, signal });
      const rejected = assert.rejects(run, /pi_aborted/);
      if (trigger === "caller") {
        await waitFor(
          () =>
            existsSync(join(f.context.outputDir, "commands.jsonl")) &&
            f.commands().some((c) => c.type === "prompt"),
        );
        controller.abort();
      }
      await rejected;
      assert(f.commands().some((c) => c.type === "abort"));
      assert.equal(f.receipt().stopConfirmed, true);
      assert(!groupAlive(f.receipt().group.pid));
    });
});

test("real adapter offline guard failure reaches persistent job diagnostic; provider text does not", async () => {
  const { executor } = offlineExecutor("guard-invalid");
  const f = await fixture(executor);
  try {
    await f.service.invoke("setup_project", f.registration());
    const job = await terminal(
      f.service,
      await submit(f.service, f.submission()),
    );
    assert.equal(job.taskOutcome, "failed");
    assert.equal(job.failurePhase, "lead");
    assert.equal(job.diagnostic, "audit_loadout_mismatch");
    assert.equal(job.result, undefined);
  } finally {
    await f.service.close();
  }
});

test("selected OAuth removed after adapter creation reaches the persistent job auth diagnostic", async () => {
  const { executor, authPath } = offlineExecutor("success", "codex");
  const f = await fixture(executor);
  try {
    await f.service.invoke("setup_project", f.registration());
    unlinkSync(authPath);
    const job = await terminal(
      f.service,
      await submit(f.service, f.submission()),
    );
    assert.equal(job.taskOutcome, "failed");
    assert.equal(job.failurePhase, "lead");
    assert.equal(job.diagnostic, "invalid_codex_oauth");
    assert.equal(job.result, undefined);
  } finally {
    await f.service.close();
  }
});

test("Codex PiExecutor uses private roles, selected native authPath and same native handshake, without SSH or credential argv/receipt leakage", async () => {
  const f = offlineExecutor("success", "codex");
  const out = await f.executor.run(f.context);
  assert.equal(out.agentOutcome, "completed");
  assert.equal(
    f.receipt().credentialSource,
    "explicit native Pi OAuth authPath",
  );
  const artifacts = [
    f.receipt(),
    f.commands(),
    JSON.parse(readFileSync(out.reportPath, "utf8")),
  ];
  assert(!JSON.stringify(artifacts).includes("oauth-access-placeholder"));
  assert(!JSON.stringify(artifacts).includes("oauth-refresh-placeholder"));
});
