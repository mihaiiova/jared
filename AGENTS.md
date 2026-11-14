# Jared contributor guide

## Development workspace versus runtime agent

This repository builds the Jared CLI and local stdio MCP product. Start your normal coding agent at the repository root to develop it. The root deliberately has no Jared-persona `.pi/` configuration.

`agent/v1/.pi/` contains the bundled audit-agent policies, reviewer and skills used by the installed product. They are product assets, not the development agent's identity. Do not load them as the maintainer's own instructions. Repository maintenance does not grant additional capabilities to the installed audit agents.

## Project map

- `src/`: CLI, setup, local worker, audit execution and safety boundaries.
- `dist/src/`: committed generated runtime, required for Git-based npm installs.
- `agent/v1/`: self-contained native audit assets and hash provenance.
- `vendor/tools/`: pinned upstream fd/rg binaries for four OS/CPU targets, manifest and licenses.
- `test/`: deterministic unit/integration and isolated install coverage.
- `scripts/`: asset verification, local compilation and committed-content Git-install regression.
- `docs/`: operator instructions, security/lifecycle contract and verification evidence.

There is one product repository, named `jared`; no sibling design workspace or `jared-service` checkout is required. The original separate design workspace is retired. Normal builds verify the bundled assets without reading any external checkout or running Faur.

## Checks and Git installation

Use Node >=22.19 and system Git. Native search tests use the packaged fd/rg and a fresh HOME; host tools/Pi caches must not be prerequisites. Normal builds, setup and tests never download helpers. Do not run provider-backed workloads without authorization.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
```

`npm test` rebuilds locally and verifies the vendored runtime manifest. Commit the resulting `dist/src/` files with TypeScript changes. Reject tracked or untracked drift in generated code and vendored tools after rebuilding. `npm run vendor:refresh` is a maintainer-only download of pinned upstream release archives, verified before extraction; update all checksums/licenses deliberately. Never put it in an install or setup hook. Do not add a `prepare` hook or a script named `build` without retesting npm's global Git-dependency installation behavior; the local compiler command is `npm run build:local`.

After committing the candidate, run `npm run test:git-install`. It installs committed HEAD into an isolated prefix using cached dependencies; it intentionally ignores rebuilt/uncommitted files. An explicit remote-ref argument enables public downloads and must be authorized. No test success establishes provider entitlement, native Mac behavior or product acceptance beyond the exercised checks.

## Preserve boundaries and evidence

Keep source-audit roles read-only, exact-commit snapshots isolated, ownership locking crash-safe, and uncertain process stops/evidence retained. Preserve explicit project roots, credential consent, canonical/no-follow paths and report linkage. Keep credentials and private reports out of Git. Review the exact outgoing files and refs before any authorized publication.

Bundled asset changes must be intentional and reviewed with their provenance; do not regenerate or weaken their permissions as a side effect of maintainer-workspace changes. Keep public documentation honest about WIP status and unverified behavior. Merge, release, publication and cleanup require the authority of the active development session; these instructions do not override its permission boundaries.
