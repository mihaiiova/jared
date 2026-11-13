#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
process.umask(0o077);
const help = `Jared — WIP local-only source audits (Linux/macOS, Node >=22.19)

  jared setup [--use-pi-auth | --dedicated] [--no-login] [--no-register]
  jared doctor                 Read-only requirements/auth status; nonzero if missing
  jared mcp                    Stdio MCP; coding agents launch this automatically
  jared --help

setup preserves valid choices; offers to reuse your Pi login (with consent), or
bundled Pi SDK login when missing; --dedicated is optional advanced mode.
--use-pi-auth explicitly consents to the shared auth pointer (never login). Offers
preview/consent Pi MCP registration. Bootstrap without auth/registration:
--no-login --no-register (does not grant helper-download consent).
Setup reuses fd/fdfind and rg, or asks before native Pi helper downloads.
Optional initial API-key alternative: --api-key-file /private/file
  --provider openai|anthropic --model exact-model-id (never auto-substituted).
No published package claim. No HTTP/token/remote Git setup. No implementation,
visual verification, pushes, merges or deployment. Linux/macOS; Windows unsupported.
macOS support is experimental pending native verification.
`;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "no-login": { type: "boolean" },
      "no-register": { type: "boolean" },
      "use-pi-auth": { type: "boolean" },
      dedicated: { type: "boolean" },
      "api-key-file": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) console.log(help);
  else if (positionals.length !== 1) throw new Error("one_command_required");
  else if (command === "setup") {
    const { setup } = await import("./setup.js");
    let api;
    if (values["api-key-file"] || values.provider || values.model) {
      if (
        !values["api-key-file"] ||
        !values.model ||
        !["openai", "anthropic"].includes(values.provider || "")
      )
        throw new Error("api_alternative_requires_file_provider_model");
      api = {
        credentialFile: resolve(values["api-key-file"]),
        provider: values.provider as "openai" | "anthropic",
        model: values.model,
      };
    }
    await setup({
      noLogin: !!values["no-login"],
      noRegister: !!values["no-register"],
      api,
      usePiAuth: !!values["use-pi-auth"],
      dedicated: !!values.dedicated,
    });
  } else if (Object.keys(values).length)
    throw new Error("flags_only_supported_for_setup");
  else if (command === "doctor") {
    const { doctor } = await import("./setup.js");
    if (!doctor()) process.exitCode = 1;
  } else if (command === "mcp") {
    const { loadLocalConfig } = await import("./local-config.js");
    const { connectWorker } = await import("./worker.js");
    const socket = await connectWorker(loadLocalConfig());
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on("error", () => {
      process.exitCode = 1;
      socket.destroy();
      process.stdin.destroy();
    });
    socket.once("close", () => process.stdin.destroy());
    process.stdout.on("error", () => {
      socket.destroy();
      process.stdin.destroy();
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        socket.destroy();
        process.stdin.destroy();
      });
  } else throw new Error("unknown_command_use_help");
} catch (error) {
  // Only the fixed worker startup diagnostic is safe to expose; never echo
  // arbitrary exception messages, paths, provider output or credentials.
  if (
    error instanceof Error &&
    /^local_worker_start_failed_(socket_unavailable|spawn_error|exit_(\d+|null)|signal_SIG[A-Z0-9]+)_run_jared_doctor$/.test(
      error.message,
    )
  )
    console.error(`Jared worker startup failed: ${error.message}`);
  else
    console.error(
      "Jared could not complete this command. Use jared --help / jared doctor; check private local configuration and permissions. No secrets are printed.",
    );
  process.exitCode = 1;
}
