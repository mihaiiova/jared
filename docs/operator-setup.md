# Local operator details

## Included runtime tools

Install from Git with npm as shown in the README. Node >=22.19 and system Git remain prerequisites. Pi and native `fd`/`rg` binaries for macOS/Linux x64/ARM64 are included. Linux ARM64's ripgrep is a GNU libc build; Alpine ARM64 is not supported by this bundle.

Setup configures authentication and client registration, not helpers. Search tools are resolved only from this installation's `vendor/tools/<OS>-<CPU>/` directory, with pinned checksums, file-safety checks and upstream licenses. No host PATH/Pi cache discovery, executable copying, helper downloads or mutable managed cache is used. Both roles receive that package directory plus `/usr/bin:/bin` as their search PATH.

Setup and doctor execute the packaged tools' `--version` with bounded, credential-free subprocesses. Actual Pi find/grep operation is covered by the native and install tests. Doctor does not download, refresh auth, call a model or connect an MCP client. A missing/corrupt package is repaired by reinstalling, not rerunning helper setup; submissions fail with `packaged_search_tools_unavailable_reinstall_jared`.

`PI_OFFLINE=1` and the API-key worker's `--offline` suppress automatic catalog/tool downloads, **not provider inference**. The Codex SDK disables catalog discovery/availability network checks, not selected-provider calls or OAuth refresh. Audits require internet for the selected provider. Login/shared-auth-write consent and client-registration consent remain separate; `--no-login --no-register` grants neither.

## Configuration and selected auth

The normal interface is `jared setup`, `jared doctor`, `jared mcp`. There is no manual JSON configuration step. This WIP package accepts Linux and macOS with Node >=22.19 and system `/usr/bin/git`. Ownership uses Node's SQLite OS locks, not `flock`. Linux process inspection uses `/proc`; macOS uses `/bin/ps` and `/usr/sbin/sysctl`. Native macOS verification is pending. Windows is unsupported. Use a private local filesystem, not NFS. On macOS, install Apple's command-line tools if system Git is missing (`xcode-select --install`).

Before upgrading an older Linux installation, stop its Jared jobs/workers: the old `flock` protocol and new SQLite lock do not coordinate. On macOS a hard worker crash with surviving descendants retains unconfirmed work rather than killing a stale PID; inspect/stop the actual orphan and restart to reconcile. See [security and lifecycle](security-and-lifecycle.md).

## One-time setup

1. Install from Git (or a locally built tarball) as described in README. `jared --help` needs no configuration. Restart clients after upgrading so an old worker does not keep using the previous implementation.
2. Run `jared setup` in a terminal. It creates private user directories, keeps existing configuration/auth, and offers to reuse your existing Pi login with explicit consent. If missing, one bundled Pi **1.5.2 SDK** login step is offered; standalone Pi is not required. Default provider/model come from bundled native settings, not a new model choice. No model prompt is sent; login itself contacts the provider only after consent.
3. Setup previews the exact Pi command using this installation's absolute Node/CLI paths:
   `pi mcp add jared -- /absolute/node /absolute/package/dist/src/main.js mcp`.
   It runs only after interactive consent, using Pi's actual documented CLI. It does not replace an existing Jared registration. Restart Pi; use `/mcp` to check connection. `pi mcp list` connects **all** configured servers and is deliberately not run by doctor.
4. Ask the coding agent to read `get_jared_guide` and explicitly identify the Git root and commit. Setup does **not** onboard or audit a live project itself.

For discovery without login or registration: `jared setup --no-login --no-register`. The installed tools are ready without a helper cache or download consent, including in noninteractive execution. No browser installation is performed. Audits return `authentication_missing_or_invalid_run_jared_setup` until valid selected credentials exist. `setup_project` and exact source-context reads do not require a provider.

Pi is the supported guided registration client. Doctor detects Pi/Claude/Codex executables without connecting them. For Claude/Codex or another MCP client, configure a stdio command `jared` with argument `mcp` using that client's own interface; no automatic edits or claims of a verified connection are made. Setup always prints Pi's explicit opt-in command unless `--no-register` was requested.

## Private paths and choices

- `${XDG_CONFIG_HOME:-~/.config}/jared-local/config.json`: automatic mode-0600 settings in a mode-0700 directory.
- Default shared auth: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json`. Setup asks to reuse only `openai-codex` for the bundled model, explicitly disclosing that native refresh writes update this same shared file. The local config stores an `authSource` pointer, never credential contents. Other provider records are preserved semantically; native JSON formatting may change on a write. No shared settings, extensions, MCP, models, prompts or skills are loaded.
- Without selected OAuth, setup offers bundled SDK login into that normal Pi auth store. URLs/codes appear only in the interactive terminal; no model prompt is sent. Existing malformed/command-key selected entries require explicit repair, not automatic replacement. No standalone Pi install or manual JSON edit is required.
- Advanced: `jared setup --dedicated` selects private `codex-auth/auth.json` when auth is missing. Valid existing dedicated/shared/API-key choices are always preserved, even with later flags. Generated empty 0.2.0 dedicated setup does not prevent the default reuse offer. Legacy valid `oauthDir` configurations remain supported.
- `jared setup --use-pi-auth --no-login --no-register` is explicit noninteractive consent to reuse a present valid selected login. Without `--use-pi-auth`, noninteractive setup and `--no-login` never grant reuse. `--no-register` controls registration only; it never grants auth consent. Missing auth never triggers noninteractive login.
- `${XDG_STATE_HOME:-~/.local/state}/jared-local/`: private SQLite registry/jobs/source caches and internal Unix socket. Keep this path short enough for a Unix socket (under 104 bytes including `/worker.sock`).

Set XDG variables **before** setup and consistently in the coding agent launch environment if moving these directories. Paths must be canonical, symlink-free, owned and outside Git checkouts/state/assets. Shared auth must be a safe regular single-link non-world-readable file; its owned parent must not be group/world writable, but may be 0755 and contain normal Pi configuration. Setup preserves existing choices rather than migrating paths automatically.

An explicit initial API-key alternative is supported without entering secret text in argv or JSON:

```sh
jared setup --no-login --no-register --provider openai \
  --model YOUR_EXACT_MODEL --api-key-file /private/credentials/key
```

`anthropic` is the other supported key provider. The key file must already be owned, regular, single-link, mode 0600, in a private 0700 directory outside all Git checkouts/state/assets. No ambient key is borrowed, file contents are never printed, and no provider/model fallback is chosen. Existing choices are preserved even if different initial flags are later supplied.

## Recovering retained orphan processes

A new macOS owner deliberately retains live groups from a crashed worker as unconfirmed. Reconnecting an MCP client is **not** a worker restart.

1. Disable/disconnect Jared in every MCP client so clients do not reconnect during recovery. Preserve the reports, SQLite state and worktrees.
2. Inspect the retained job/source diagnostics and the actual process tree (`ps -axo pid=,ppid=,pgid=,command=`). A stored PID alone is not identity proof. Verify the orphan belongs to this Jared run before stopping it; seek operator help if identity is ambiguous. Do not use broad `pkill node`/`pkill jared` commands.
3. Identify this installation's internal Node process whose command points to `dist/src/worker-main.js`. Verify its working directory is the configured Jared state directory (`lsof -a -p VERIFIED_WORKER_PID -d cwd` on macOS). Gracefully stop **that verified worker only** with `kill -TERM VERIFIED_WORKER_PID`, then wait for it to exit. This is not `jared mcp`; do not delete the lock or socket to force ownership.
4. Re-enable Jared in the client. It starts a new owner, which reconciles dead orphan groups without replay. If any group is still live or inspection fails, work remains blocked; repeat inspection rather than bypassing the safeguard.

This manual recovery procedure is source-reviewed but not yet exercised on a native Mac. Normal cancellation and graceful worker shutdown do not require this crash-recovery procedure.

## Projects and cleanup

`setup_project` requires `projectId`, `projectPath`, `platform` (`web|flutter`), `purpose`, `approvedDirection`, `setupProfile:"source-only-v1"`, and repository-relative `designPaths`. The root must be a same-user canonical SHA-1 Git repository with a real `.git` directory. Linked Git worktrees (`.git` file), bare roots, SHA-256 repositories, symlink roots and conflicting `.jared` content are currently unsupported. Registration is idempotent for the exact same input; changing the project ID/path/context in place is refused. No duplicate design documents are created: use existing source paths for approved product knowledge.

Setup creates only `.jared/config.json`, `.jared/.gitignore` (`runs/`) and `.jared/runs/`. It does not edit root `.gitignore`, branch, product source, `.pi` or global settings. These setup metadata files may appear as untracked files; the operator decides whether to version them. Tracked run artifacts are refused. Generated reports are private, ignored, exclusive per job, and never adopted/overwritten from a pre-existing run directory.

Jobs persist after MCP disconnect. A private worker starts automatically and exits shortly after all clients disconnect **and** accepted jobs/source reads finish. It needs no daemon command/service installation. Do not delete state/lock files to stop it. Use explicit project/job `cancel_job`; only explicit project/job `acknowledge_handoff` removes an unchanged clean stopped worktree. Failed/dirty/undelivered work and evidence are retained. There is no TTL or quota: monitor disk space.

## Repair and migration

Run doctor first; it never refreshes credentials or spends on a provider. Credential presence is not entitlement/model verification. Git remains a system prerequisite; `flock` is no longer required. For missing, modified or non-executable packaged tools, reinstall the supported Git ref and restart MCP clients; doctor uses package-owned binaries and never downloads. The obsolete state/search-tools cache is retained but ignored; do not delete unrelated state, credentials or retained audit evidence. For an existing OpenAI/Anthropic API-key configuration with missing or invalid auth, restore its selected private `credentialFile` for `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` and rerun setup; a Pi OAuth login cannot repair an API-key configuration.

Before changing an auth source, setup takes the existing worker ownership lock. If a worker is active, setup fails clearly: cancel known jobs, close clients and wait for its socket to exit, then rerun. It never kills unrelated processes or resets state. No config change is made on this refusal.

If selected OAuth disappears before execution (for example, after Pi logout), the job records `invalid_codex_oauth` rather than a generic execution failure. Restore the selected login through setup before retrying.

Doctor reads selected OAuth presence/expiry without locks, refresh or provider verification. Expired or within five minutes of expiry means needs-refresh on actual use, not missing auth. A locally unexpired record still does not establish live account/model availability. Native Pi owns locked refresh and in-place file writes (not atomic rename/fsync guarantees); power loss during rotation may require a new login. Preserve/back up problematic files and repair only after workers stop. Never delete retained job/state data to fix auth.

The remote prototype's config, credentials and private state are **not imported, reset or deleted**. Its HTTP/token/admin/SSH provisioning source and docs are removed from this package; an external mode-0600 archive preserves the old source. Close any old prototype process through its operator before using the local product; local setup does not manage old listeners, tunnels, keys or client registrations. Replace old HTTP client entries manually only with explicit approval. Remote support is future work, not a hidden local setup mode.
