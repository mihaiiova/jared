# Verification — self-contained Git install candidate (0.3.0)

## Scope

This revision replaces setup-time host/Pi search-helper discovery, copying, download consent and managed caches with package-owned runtime binaries. Node >=22.19 and system Git remain prerequisites for the supported npm-from-Git installation. No Docker, standalone Pi, global fd/rg or Pi helper cache is required.

The previous Git-install fix and its Linux 93-test baseline remain recorded in Git history. Fresh checks for this revision on Linux x64/Node 22.23.2/npm 10.9.8: build, type-check and the full sequential suite passed **96 tests, 0 failures, 0 skipped** after the CI fixes below. The suite includes actual installed-package Pi find/grep and two production stdio clients. A package inventory check found all eight executable binaries and licenses, no retired preparation helper, and no research notes in the archive (about 13.9 MB compressed / 32.6 MB unpacked, excluding installed npm dependencies).

## Runtime provenance and platform limits

`vendor/tools/manifest.json` records eight binaries across macOS/Linux x64/ARM64, their upstream archive URLs/SHA256, extracted file SHA256, versions and licenses. The explicit developer-only `scripts/vendor-tools.mjs` verifies the pinned upstream archive hashes before extracting only the named binaries/licenses. Normal installation/setup/build does not fetch tools.

- fd 10.3.0 is pinned because it supplies both Mac architectures; later upstream fd releases dropped Intel Mac binaries.
- ripgrep 15.1.0 is pinned for all targets.
- Linux x64 uses musl builds. Linux ARM64 ripgrep is a GNU libc build (its ELF version requirements include glibc 2.18); Alpine ARM64 is not a supported runtime bundle.
- Upstream bytes/checksums are verified independently of execution. Native CI on both Mac architectures passed for runtime commit `e90bf20` ([push matrix](https://github.com/mihaiiova/jared/actions/runs/43695451228)), including installed Pi find/grep. A human Mac trial and provider-backed audit remain separate, unverified outcomes.
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

This passed for the committed 0.3.0 candidate on Linux x64: installation, noninteractive setup without login/registration, no helper cache/download, real installed Pi find/grep and MCP imports. It tests real global installation from committed Git content with an isolated HOME/prefix with npm cache preference; install-time registry metadata/dependencies may be fetched. It runs setup without login/registration, then the installed SDK's actual find/grep tools with downloads disabled, plus CLI help and MCP runtime imports. It does not use rebuilt/uncommitted files to mask missing package artifacts.

Explicit remote-ref validation is also available:

```sh
npm run test:git-install -- 'git+https://github.com/mihaiiova/jared.git#REF'
```

Both modes use `--prefer-offline` for npm dependency installation. A fresh `npm ci` cache can contain tarballs without registry metadata, so requiring `--offline` made CI fail with `ENOTCACHED` even though runtime helpers were packaged. Local mode uses a local Git source; remote mode additionally downloads public GitHub source. Setup/native-search probes still disable helper downloads and do not call a provider. Neither mode logs in, runs inference or changes the user's installed prefix. CI checks generated/vendored drift, including untracked files, and is configured to exercise the supported OS/CPU targets without installing host search helpers. Current public-runner labels are Ubuntu x64/ARM64 and macOS 15 ARM64/Intel; the retired `macos-14` label was replaced. Runner mapping was checked against GitHub's current hosted-runner reference; workflow configuration is not a passing CI result.

## CI failure diagnosis and fixes

The first four-platform CI run failed in npm installation because `--offline` assumed registry metadata was cached. A clean local reproduction seeded only through `npm ci` failed with the same `ENOTCACHED`; allowing cache-preferred npm registry access made that install and no-login setup pass. This changes installation-test networking, not runtime helper downloads or provider access.

Mac CI also failed in the process-state parser during cleanup. Apple's [`ps/tasks.c`](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/tasks.c) explicitly maps unknown Mach thread states to `?`; the original parser rejected that valid state. A regression fixture reproduced `process_inspection_failed` before the fix and passes afterward. Both identity and group parsing accept `?` while treating it as live/uncertain, never as confirmed termination. Malformed output still fails closed and the conservative cross-owner Mac receipt policy is unchanged. The exact transient row was not logged by the earlier CI run. Runtime commit `e90bf20` passed the complete four-platform push matrix; its paired PR run passed Linux and Mac ARM but exposed two intermittent Intel Mac fixture races.

Those fixture races have deterministic slow-caller reproductions: leaving the injected worker unconnected beyond its 1.5-second idle window starts an uninjected worker and produces the expected auth rejection; delaying cancellation beyond the fixture's two-second deadline produces `timed_out` rather than `cancelled`. The stdio fixture now pins its injected worker only until actual CLI clients connect, explicitly tests a two-second startup delay, and prints bounded submit error codes on failure. The cancellation fixture waits for executor entry, includes slow-caller delay, and allows a 30-second end-to-end deadline (including native Git preparation), with a 60-second terminal observation bound for that job. It still requires queued cancellation without execution, owned-child settlement, retained workspaces, and a real `timed_out` outcome. No production idle window, deadline, authentication check or process-ownership policy was relaxed.

A subsequent slow Intel PR run exposed the same class of assumptions elsewhere: the RPC deadline could fire before a command receipt existed, non-deadline fixture jobs could expire during native preparation, and 160ms executor sleeps did not guarantee overlap. Controlled 600ms peer startup and paced submissions reproduced the first and third failures locally. RPC abort-command checks now wait for prompt readiness before arming a real timeout; a separate pre-readiness deadline test verifies confirmed group stop without requiring impossible command receipts. Concurrency uses an explicit release barrier, asserts exactly two executing phases plus queued same-project/overflow jobs, then requires delivery and serialization. Non-deadline fixtures use the existing 120-second production budget and bounded 60-second observations, rather than racing a ten-second test-only deadline. The integration-review test now asserts its original job was delivered before testing linkage. Both injected-worker starts are pinned only through actual frontend connection; no runtime configuration or authentication bypass was added.

## Evidence limitations

No independent reviewer acceptance is claimed for this revision: this existing session's subagent launcher still references the retired workspace's extension path. No alternate launcher or policy bypass was used. No live login/model entitlement or product-quality audit is established by these installation tests. Provider-backed checks require separate authorization and budget. No installed user CLI, existing credentials, registration or retained job state is changed by the isolated tests. Old managed helper caches are not migrated or removed; workers ignore them after restart.

A failed/missing/modified package is not repaired by setup. Doctor distinguishes installation readiness from selected auth presence and client registration. Native tool `--version` checks do not replace real find/grep coverage or a full audit.

The preexisting macOS hard-crash rule remains: a new owner retains uncertain live orphans instead of signalling stale PIDs. Follow the documented operator recovery procedure. No browser/Flutter/rendered visual verification is part of this source-audit iteration.
