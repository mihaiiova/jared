# Job deadlines, progress and logs

## Operator-controlled deadline

The default remains **120 seconds**. Workspace preparation, the lead audit, independent review and host validation share this whole-job budget. Waiting in the queue does not consume it. Expiry requests cancellation; confirming owned-process termination can take additional time. A larger budget is permission to spend more time on the selected provider, not a promise of completion or a retry.

After closing MCP clients, cancelling active jobs and waiting for the owned worker to exit:

```sh
jared setup --job-timeout-seconds 600 --no-login --no-register
jared doctor
```

The explicit setup option accepts integer seconds from **1 to 3600**. It stores `jobTimeoutMs` in the private local configuration, preserving authentication and unrelated choices. Old configurations without this field continue to use 120 seconds. Invalid/unbounded values are refused. An active owner lock blocks configuration changes instead of silently leaving an old worker with a different budget; no processes are killed to apply configuration.

New jobs capture the configured budget when accepted, expose it in the submission response and retain it in their progress record. Their deadline timestamp is assigned when execution starts. Existing jobs with captured budgets retain those budgets across queued-worker restarts. Interrupted running jobs remain crashed/stop-unconfirmed rather than being replayed. Source-context reads retain their separate 120-second native-I/O limit. No automatic paid retries are added.

## From a coding agent (MCP)

Poll `get_job({projectId, jobId})`. `progress` reports:

- current phase and when it began;
- role/run identity while an audit agent is active;
- configured budget and deadline;
- last observed activity, its timestamp, and cumulative activity-event count;
- `observedAt` and `quietForMs`, not a guessed completion percentage.

Phases are `queued`, `fetch`, `lead`, `lead_report_validation`, `ui-reviewer`, `ui-reviewer_report_validation`, `host_validation`, and `terminal`. Terminal execution/outcome fields distinguish delivery, timeout, cancellation, crash and unconfirmed process stop. `failurePhase` identifies where an interrupted job failed.

For history:

```json
{ "projectId": "product", "jobId": "<UUID>", "after": 0, "limit": 100 }
```

Call `get_job_logs` with these arguments. Reuse `nextCursor` as `after`; drain additional pages while `hasMore` is true. Each page contains at most 100 events. `get_job` includes only its latest 20 lifecycle/event records; use the paginated tool for retained history. Project/job routing is required and cross-project access is refused.

## From a terminal

```sh
jared logs --project product --job <UUID>
jared logs --project product --job <UUID> --follow
jared logs --project product --job <UUID> --after 123 --limit 100
```

Output is JSONL: a `status` record followed by `event` records. Non-follow mode reads one page and includes the continuation cursor. Follow mode drains pages, polls each second and prints an observation/status at least every five seconds while running; Ctrl-C stops observation. It finishes when all retained events for a terminal job have been read. `stop_unconfirmed` remains explicitly uncertain, not a successful stop.

The CLI opens the existing private database read-only. It does **not** start a worker, reconcile jobs, authenticate, call a provider or retry anything. If an owner crashed without reconciliation, retained state can still say `running`; a quiet log does not establish that a worker or model is alive. Use ordinary worker recovery and the documented orphan-recovery procedure, never broad process killing or state deletion.

## What the logs mean—and omit

Progress records are host phases and observed RPC milestones: process start, guard verification, prompt acceptance, model-update headers, allowlisted tool start/end headers, settlement and stop confirmation. Native workspace subprocess starts also count as observed activity. These are observations, **not proof of useful reasoning, provider health, cost, exhaustive coverage or a stall**. Some providers can remain quiet during legitimate work.

No prompts, reasoning/text deltas, tool arguments/results, file contents, arbitrary tool names, raw stderr, credentials or provider exception bodies are copied into these metadata logs. Only known host diagnostic codes are exposed; unclassified codes use a fixed fallback. Existing private audit evidence/report retention is unchanged and may contain source/model report text—metadata-only logs do not make those artifacts safe to publish.

Noisy model/tool/native-I/O events are sampled at most once per second; counters and the latest observed timestamp aggregate intervening events. Protocol milestones persist immediately, and pending activity flushes within about one second while the event loop/storage is responsive. There is no token-by-token transcript or complete per-tool-call trace.

At most **1000 new progress samples per job** are retained, in addition to the preexisting lifecycle/ownership history, which is never pruned by this feature. Responses remain bounded to 100 events. `truncated` and `prunedThrough` explicitly identify a cursor that predates pruned progress samples; earlier lifecycle records can still be present. Sequence gaps caused by other jobs alone do not count as truncation. Logs survive restart and explicit clean-worktree acknowledgement. Pre-upgrade jobs can have `progress: null`; unknown historical activity/budgets are not fabricated.

## Verification boundaries

Offline fixtures cover configuration/defaults/validation and owner-lock refusal, real executor RPC event mapping and payload omission, cleanup after progress-storage failure, live status and CLI database reads, project routing, pagination and bounded retention. These checks do not reproduce a particular provider stall or establish live model entitlement. No paid audit is required for regression tests.
