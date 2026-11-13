# Verification — WIP

## Recorded Linux checks

On Linux with Node 22.23.2, `npm run typecheck` passed and `npm test` (including its build step) passed **93 tests, 0 failures, 0 skipped** before the subsequent package lifecycle change from `prepack` to `prepare`.

The suite includes:

- Standalone packed/offline installation and managed native find+grep.
- Two production stdio clients, explicit project routing and worker restart.
- Ownership exclusion and lock release after SIGKILL.
- Cancellation, retained-job recovery and receipt-persistence failure cleanup.
- Isolated native Pi startup with synthetic credentials and child-local network denial; no model prompt, inference or login.

The initial portability run exposed a SQLite import warning in the isolated Codex error protocol. SQLite now loads lazily when acquiring the ownership lock; the strict startup protocol test then passed unchanged.

Ten bundled native assets remain hash-verified. The independent current-files source review identified CLI/documentation inconsistencies and missing internal-worker restart instructions, which were corrected. That review was not exact-commit or product-integration approval.

## Git installation: known failure

The package now uses `prepare` rather than `prepack` so npm can build a Git dependency. Two isolated Linux/npm 10.9.8 global installs from a local Git fixture failed during dependency preparation: the nested npm installation did not leave a local `node_modules/typescript/bin/tsc`, and npm emitted extraction warnings. One attempt used an explicit isolated prefix; the retry configured a fresh prefix in a synthetic HOME. Neither is accepted as working Git-install evidence. The 93-test result above predates this lifecycle-only change.

Use the source-checkout/tarball route in the README while Git installation is unresolved. Repository publication does not establish installation success.

## macOS: native verification pending

Platform acceptance and Darwin `ps` parsers have deterministic source-level tests. `.github/workflows/ci.yml` configures Linux, Apple Silicon macOS and Intel macOS checks. Workflow configuration alone is not execution evidence; inspect actual CI results for the exact commit.

Native Mac setup, rapid subprocess startup, cancellation and manual orphan recovery have not been exercised locally. After a hard service crash on macOS, live orphan identities are deliberately unconfirmed across owner sessions and are not speculatively killed. Follow the [operator recovery procedure](operator-setup.md#recovering-retained-orphan-processes). Older Linux `flock` workers must be stopped before switching ownership-lock protocols.

No live provider inference or product audit establishes audit quality or model entitlement. Fresh-machine helper provisioning has mocked coverage; live download connectivity remains unverified. Earlier exploratory network controls were not reliable and are not accepted as proof of network containment; the final child-local startup guard denies outbound fetch/TCP/TLS attempts. SQLite experimental warnings in ordinary service processes are expected.

## Reproduce

Use Node >=22.19, Git and installed `fd`/`fdfind` and `rg` for native helper tests. Tests do not grant automatic prerequisite-download consent.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke --ignore-scripts
npm pack --dry-run
```

The standalone test installs only into a temporary prefix. Synthetic fixture credentials are not real logins. Keep generated reports, snapshots, auth and local test artifacts private; they are not publication inputs.
