# Jared — WIP

> **Work in progress.** Experimental software, not a production-ready release. Linux and macOS code paths are implemented; native macOS verification is still pending.

Jared provides exact-commit **source audits** with a fresh independent UI reviewer. One local installation serves multiple Git projects and coding agents. Implementation jobs and visual/runtime verification are **not supported** yet.

## Platform status

| Platform | Status                                                                                 |
| -------- | -------------------------------------------------------------------------------------- |
| Linux    | Locally regression-tested; Node >=22.19 and system Git required                        |
| macOS    | Experimental; Node >=22.19, system Git, `ps` and `sysctl`; native verification pending |
| Windows  | Unsupported                                                                            |

Ownership uses SQLite's crash-released OS locks, not `flock`. macOS uses system `ps` and `sysctl` instead of Linux `/proc`. macOS CI covers both Apple Silicon and Intel runners once this source is hosted and the workflow runs; the workflow file alone is not evidence of success.

**macOS crash safety:** normal cancellation stops owned process groups. After a hard worker crash, a new owner does not signal a still-live orphan from a previous owner: `ps` start times have insufficient precision to rule out PID reuse. Such jobs remain `stop_unconfirmed` with evidence retained; orphaned source reads block new work. Inspect and stop the actual orphan, then restart the **internal worker**, not just the MCP client, to reconcile dead groups. Follow the [operator recovery procedure](docs/operator-setup.md#recovering-retained-orphan-processes). Do not blindly kill a stored PID or delete state to bypass this safeguard.

**Upgrading an older Linux installation:** stop its existing Jared workers and jobs before installing this revision. Old `flock` workers do not participate in the new ownership lock; do not run both versions against the same state.

## Install from Git

**WIP — Git installation is not yet verified working.** The intended command for this repository, once the dependency-preparation failure below is resolved, is:

```sh
npm install --global 'git+https://github.com/mihaiiova/jared.git'
jared setup
jared doctor
```

For a repeatable install, append `#FULL_COMMIT_SHA` to the Git URL. The repository root must be this package directory, containing `package.json`. npm runs the `prepare` build when installing from Git, so compiled output need not be committed. Do not use `--ignore-scripts` for Git installation: the CLI needs that build. The Git build requires dev dependencies; the resulting installed package contains only the declared runtime/package files. A Linux/npm 10.9.8 isolated Git-based global install currently fails during dependency preparation with a missing local TypeScript compiler; this path is **not verified working**. Use the source-checkout/tarball route below for now.

## Install from a source checkout

No npm publication or standalone Pi installation is required. Use Node **>=22.19** (for example via your preferred Node version manager) and system Git. On macOS, install Apple's command-line tools with `xcode-select --install` if Git is unavailable. `jared setup` handles file-search helpers (`fd`/`fdfind` and `rg`); no apt fd prerequisite. Windows is unsupported. From this checkout:

```sh
npm ci --ignore-scripts
npm pack
npm install --global ./jared-local-cli-0.2.2.tgz
```

The shipped `npm-shrinkwrap.json` pins the dependency tree for packed installs. The package name is `@jared-local/cli`, **not a published npm release**. `private: true` prevents accidental npm registry publication; it does not prevent installation from Git. Native policies, six skills and reviewer definitions ship inside it; no sibling checkout or Faur is needed.

## Set up once

```sh
jared setup
```

Setup first offers to **reuse your Pi login** for bundled `openai-codex/gpt-6.1-sol`, with explicit consent to refresh that same shared auth file. Without a login it offers one bundled Pi SDK sign-in step; no standalone Pi install is needed. Valid existing choices are preserved. `--dedicated` is optional advanced isolation. Setup then previews an opt-in Pi registration command; client settings never change without consent. No credentials are copied and no global Pi settings/resources are loaded. Bootstrap without login/registration: `jared setup --no-login --no-register` (discovery works; audits stay blocked). Setup reuses existing file-search executables, including the Pi bin cache, or asks before bundled Pi downloads missing helpers. This separate permission never grants auth or registration consent.

Coding agents launch **`jared mcp`** over stdio automatically after registration. There is no HTTP listener, token, admin role, deploy key, remote Git or tunnel to configure. Other MCP clients can launch the same command; see [setup details](docs/operator-setup.md).

## Ask your coding agent

> Read Jared's `get_jared_guide`. Set it up in this explicitly identified local Git root, then audit this full local commit. Don't modify product source.

`setup_project` is a write action: it registers the explicit canonical Git root and creates `.jared/config.json`, `.jared/.gitignore` and ignored `.jared/runs/`. Reports go to **that project's** `.jared/runs/<jobId>/`. Existing conflicts/symlinks are refused. Unpushed commits work; dirty originals are excluded and preserved. Every task/lookup names its project. Local clients have same-user operator authority, **not multi-tenant isolation**.

## Check status

```sh
jared doctor
jared --help
```

Doctor is read-only/no-network and exits nonzero for missing requirements or auth. Credential presence, client registration, connection and provider verification are distinct; it makes no provider call. Audit agents need internet for their selected provider; there is no “offline agent” mode. Jobs survive client disconnect; source snapshots/evidence remain private and retained until explicit safe cleanup. See [security/lifecycle and migration](docs/security-and-lifecycle.md) and [developer verification](docs/verification.md).
