# Verification — self-contained Git install candidate (0.3.0)

## Scope

This revision replaces setup-time host/Pi search-helper discovery, copying, download consent and managed caches with package-owned runtime binaries. Node >=22.19 and system Git remain prerequisites for the supported npm-from-Git installation. No Docker, standalone Pi, global fd/rg or Pi helper cache is required.

The previous Git-install fix and its Linux 93-test baseline remain recorded in Git history. Fresh checks for this revision on Linux x64/Node 22.23.2/npm 10.9.8: build, type-check and the full sequential suite passed **94 tests, 0 failures, 0 skipped**. The suite includes actual installed-package Pi find/grep and two production stdio clients. A package inventory check found all eight executable binaries and licenses, no retired preparation helper, and no research notes in the archive (about 13.9 MB compressed / 32.6 MB unpacked, excluding installed npm dependencies).

## Runtime provenance and platform limits

`vendor/tools/manifest.json` records eight binaries across macOS/Linux x64/ARM64, their upstream archive URLs/SHA256, extracted file SHA256, versions and licenses. The explicit developer-only `scripts/vendor-tools.mjs` verifies the pinned upstream archive hashes before extracting only the named binaries/licenses. Normal installation/setup/build does not fetch tools.

- fd 10.3.0 is pinned because it supplies both Mac architectures; later upstream fd releases dropped Intel Mac binaries.
- ripgrep 15.1.0 is pinned for all targets.
- Linux x64 uses musl builds. Linux ARM64 ripgrep is a GNU libc build (its ELF version requirements include glibc 2.18); Alpine ARM64 is not a supported runtime bundle.
- Both Mac bundles have upstream bytes/checksums verified here, **not native execution proof**. Native Mac CI/user execution remains required.
- `scripts/verify-runtime-tools.mjs` checks the complete matrix/licenses without executing foreign-platform binaries.

## Required checks

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
```

The sequential suite includes native Pi find/grep with packaged binaries, fresh HOME/no Pi cache, no helper-download prompts, package checksum/path/mode rejection, missing/damaged installation guidance, source-only guards, auth consent, durable jobs, cancellation and retention. The standalone tarball install uses an isolated prefix and no global helper fixture.

The first test run used an excessively long disk-backed TMPDIR and hit the existing Unix-socket path limit; it also caught an ESM-only SDK resolution error in the new native test probe. Those are not accepted passes. The probe now resolves the installed SDK's package entry correctly, and the successful full run used a short canonical temp root.

After committing the candidate:

```sh
npm run test:git-install
```

This tests real global installation from committed Git content with an isolated HOME/prefix and cached npm dependencies. It runs setup without login/registration, then the installed SDK's actual find/grep tools with downloads disabled, plus CLI help and MCP runtime imports. It does not use rebuilt/uncommitted files to mask missing package artifacts.

Explicit remote-ref validation is also available:

```sh
npm run test:git-install -- 'git+https://github.com/mihaiiova/jared.git#REF'
```

Remote mode allows public GitHub/dependency downloads; local mode uses npm offline. Neither mode logs in, runs inference or changes the user's installed prefix. CI checks generated/vendored drift, including untracked files, and exercises the supported OS/CPU targets without installing host search helpers.

## Evidence limitations

No independent reviewer acceptance is claimed for this revision: this existing session's subagent launcher still references the retired workspace's extension path. No alternate launcher or policy bypass was used. No live login/model entitlement or product-quality audit is established by these installation tests. Provider-backed checks require separate authorization and budget. No installed user CLI, existing credentials, registration or retained job state is changed by the isolated tests. Old managed helper caches are not migrated or removed; workers ignore them after restart.

A failed/missing/modified package is not repaired by setup. Doctor distinguishes installation readiness from selected auth presence and client registration. Native tool `--version` checks do not replace real find/grep coverage or a full audit.

The preexisting macOS hard-crash rule remains: a new owner retains uncertain live orphans instead of signalling stale PIDs. Follow the documented operator recovery procedure. No browser/Flutter/rendered visual verification is part of this source-audit iteration.
