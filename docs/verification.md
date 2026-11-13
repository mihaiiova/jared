# Verification — WIP

## Recorded Linux checks

On Linux with Node 22.23.2/npm 10.9.8, `npm run typecheck` passed and `npm test` (including its build step) passed **93 tests, 0 failures, 0 skipped** after the Git-install fix. The separate real Git-install regression also passed.

The suite includes:

- Standalone packed/offline installation and managed native find+grep.
- Two production stdio clients, explicit project routing and worker restart.
- Ownership exclusion and lock release after SIGKILL.
- Cancellation, retained-job recovery and receipt-persistence failure cleanup.
- Isolated native Pi startup with synthetic credentials and child-local network denial; no model prompt, inference or login.

The initial portability run exposed a SQLite import warning in the isolated Codex error protocol. SQLite now loads lazily when acquiring the ownership lock; the strict startup protocol test then passed unchanged.

Ten bundled native assets remain hash-verified. The independent current-files source review identified CLI/documentation inconsistencies and missing internal-worker restart instructions, which were corrected. That review was not exact-commit or product-integration approval.

## Git installation fix

`TMPDIR=/a/private/disk-backed/temp npm run test:git-install` exercises a real global installation from a clone of committed HEAD and an isolated HOME/prefix, using only the existing npm cache. It intentionally excludes uncommitted/rebuilt files; commit the candidate before running it. It reproduced the missing TypeScript error before the fix. A bounded probe confirmed that npm 10.9.8 passed `npm_config_global=true` into its nested Git preparation install: the working directory was correct, but it had no local `node_modules`.

The fix ships generated `dist/src/` JavaScript in Git and removes both the `prepare` hook and npm's special `build` script name, avoiding dependency preparation entirely. Development compilation is explicit (`npm run build:local`). Runtime imports and the installed `jared --help` now pass after a real isolated Git-based global install on Linux/npm 10.9.8. The installed package excludes development sources, tests and the TypeScript compiler. CI rebuilds and rejects generated-code drift, including untracked generated modules, and runs the Git-install regression against committed content on every platform in its matrix. A synthetic negative control deliberately committed an import while leaving its generated module untracked: the drift guard rejected it, and the committed-content install failed with `ERR_MODULE_NOT_FOUND` rather than silently copying the missing module from the worktree.

The regression can also validate an explicitly pushed Jared ref: `npm run test:git-install -- 'git+https://github.com/mihaiiova/jared.git#REF'`. Remote mode uses `--prefer-offline` and allows downloads of the public GitHub archive and dependencies missing from the npm cache; default local mode uses `--offline`. Tests do not authenticate with a provider, change the user install prefix or run setup. CI configuration is not proof of a native Mac result. Repository delivery, installability and provider/product success remain separate outcomes.

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
npm run test:git-install
npm run smoke --ignore-scripts
npm pack --dry-run
```

The standalone and Git-install tests install only into temporary prefixes. Synthetic fixture credentials are not real logins. Keep generated reports, snapshots, auth and local test artifacts private; they are not publication inputs.
