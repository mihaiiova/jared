# Jared — WIP

Jared is a local UI/source-audit agent exposed through a CLI and stdio MCP. Your coding agent gives it an exact local Git commit; Jared runs an audit and a fresh independent review, then saves reports in that project's `.jared/runs/`.

> Work in progress. Source audits only: no implementation jobs or rendered UI/runtime verification. Linux regression coverage is available; native Mac behavior must be checked against the actual CI/user results for the installed commit.

## Install

Requires **Node >=22.19 and system Git**. On macOS, `/usr/bin/git` must work; install Apple's command-line tools if needed. Windows is unsupported.

```sh
npm install -g git+https://github.com/mihaiiova/jared.git
jared setup
jared doctor
```

To install a particular candidate or version, append `#BRANCH_OR_FULL_COMMIT_SHA` to the Git URL. There is no npm registry release.

**The installation includes Pi, Jared's agent assets, and `fd`/`rg` binaries.** There is no Docker requirement, standalone Pi requirement, search-helper download prompt, Homebrew helper prerequisite or user-managed helper cache. Node and Git are installation/system prerequisites, not duplicated inside the package.

Supported runtime bundles:

| Target              | Packaged search tools                                       |
| ------------------- | ----------------------------------------------------------- |
| macOS Apple Silicon | fd 10.3.0, ripgrep 15.1.0                                   |
| macOS Intel         | fd 10.3.0, ripgrep 15.1.0                                   |
| Linux x64           | fd 10.3.0, ripgrep 15.1.0; musl builds                      |
| Linux ARM64         | fd 10.3.0; ripgrep 15.1.0 GNU libc build (not Alpine ARM64) |

All four targets ship together so Git installation needs no preparation/build hook. These are pinned upstream release binaries, with archive/file checksums and licenses under `vendor/tools/`. Bundling is not proof of native execution on every target; check CI and verification evidence.

## Setup once

`jared setup` verifies the packaged tools, then offers:

1. Reuse an existing Pi Codex login with explicit shared-refresh consent, or sign in through bundled Pi. Credentials are not copied. Advanced dedicated credentials and explicit OpenAI/Anthropic API-key files are also supported.
2. Preview and optionally register Jared with Pi. No client settings change without consent.

Model access and billing remain your provider's responsibility. Credential presence is not live provider verification. Setup does not run an audit or spend on inference.

Restart your coding client after installation or upgrade. For another MCP client, configure a stdio server with command `jared` and argument `mcp`. See [operator details](docs/operator-setup.md).

Bootstrap without login or registration:

```sh
jared setup --no-login --no-register
```

This needs no tool downloads. Discovery and project registration can work without model credentials; audits remain blocked until selected authentication is available.

## Use from your coding agent

Open your app's Git repository and ask:

> Read Jared's `get_jared_guide`. Register this explicitly identified Git root, then audit its current committed HEAD. Don't modify product source.

MCP does not automatically pass the caller's repository to Jared. Every registration/task/result lookup names its project. Exact commits already present locally are supported, including unpushed commits. Dirty/uncommitted changes are preserved but excluded from the audited snapshot.

`setup_project` explicitly writes `.jared/config.json`, `.jared/.gitignore` and `.jared/runs/`. Reports are private and project-local. Registration is not an audit; successful registration does not prove model execution.

## Upgrade and troubleshooting

Reinstall the desired Git ref, then restart Jared's MCP clients so old workers can exit. Selected configuration/authentication and retained reports are preserved. The old `state/search-tools` cache is no longer consulted, copied or automatically deleted.

If packaged tools are missing, modified or cannot execute, **reinstall Jared**; rerunning setup cannot repair package files. Doctor verifies their checksums, ownership/modes and native version execution without downloading anything or connecting to a model.

macOS process start times lack enough precision for speculative orphan termination after a hard worker crash. Unconfirmed jobs/evidence remain retained. Follow the [operator recovery procedure](docs/operator-setup.md#recovering-retained-orphan-processes), not broad process killing or state deletion. Before upgrading an older Linux `flock` installation, stop its jobs/workers; old/new ownership protocols do not coordinate.

## Develop Jared

This repository is the sole `jared/` development workspace. Run your normal coding agent here; `AGENTS.md` contains contributor instructions. The nested `agent/v1/.pi/` files are bundled product assets, not the development agent's persona. Faur and a sibling design checkout are not runtime/build prerequisites.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
```

For a local tarball install, run `npm run build:local`, then `npm pack`, then `npm install -g ./jared-local-cli-0.3.0.tgz`.

Commit generated `dist/src/` with TypeScript changes. `npm run vendor:verify` checks all packaged binaries/licenses without downloading or executing foreign-platform tools; `npm run vendor:refresh` is an explicit maintainer-only refresh of pinned upstream archives. No install or setup lifecycle invokes it.

After committing a candidate, `npm run test:git-install` tests actual installation from committed Git content. CI rebuilds, detects generated/runtime drift and tests each platform without installing host `fd` or `rg`.

See [security and lifecycle](docs/security-and-lifecycle.md) and [verification](docs/verification.md). Local MCP clients have same-user authority, not multi-tenant isolation. Keep credentials, reports and snapshots private; no provider/product success is inferred from installation alone.
