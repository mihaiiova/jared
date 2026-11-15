import { z } from "zod";

export const jobTimeoutSchema = z.number().int().min(1000).max(3600000);
export const phases = [
  "queued",
  "fetch",
  "lead",
  "lead_report_validation",
  "ui-reviewer",
  "ui-reviewer_report_validation",
  "host_validation",
  "terminal",
] as const;
export const activitySchema = z.strictObject({
  kind: z.enum([
    "workspace_activity",
    "process_started",
    "guard_verified",
    "prompt_accepted",
    "model_activity",
    "tool_started",
    "tool_finished",
    "agent_settled",
    "stop_requested",
    "stop_confirmed",
    "deadline_expired",
  ]),
  tool: z.enum(["read", "ls", "find", "grep"]).optional(),
});
export type Activity = z.infer<typeof activitySchema>;
export type Phase = (typeof phases)[number];
export const progressSchema = z.strictObject({
  phase: z.enum(phases),
  phaseStartedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  timeoutMs: z.number().int().positive().max(3600000),
  deadlineAt: z.iso.datetime().optional(),
  role: z.enum(["lead", "ui-reviewer"]).optional(),
  runId: z.string().uuid().optional(),
  activityCount: z.number().int().nonnegative(),
  lastActivityAt: z.iso.datetime().optional(),
  lastActivity: activitySchema.shape.kind.optional(),
  tool: activitySchema.shape.tool,
});
export type Progress = z.infer<typeof progressSchema>;
export function progressView(progress?: Progress) {
  if (!progress) return null; // Legacy jobs have no trustworthy historical phase/budget.
  const value = progressSchema.parse(progress);
  const now = Date.now();
  return {
    ...value,
    observedAt: new Date(now).toISOString(),
    quietForMs: Math.max(
      0,
      now - Date.parse(value.lastActivityAt ?? value.phaseStartedAt),
    ),
  };
}

// Explicit allowlists: never turn arbitrary RPC/provider payloads into log bodies.
export function diagnosticView(value?: string) {
  if (value === undefined) return undefined;
  const known = [
    "progress_storage_failed",
    "execution_aborted",
    "service_shutdown",
    "execution_or_report_validation_failed",
    "operator_process_reconciliation_required",
    "source_reconciliation_required",
    "interrupted_no_replay",
    "report_linkage_failed",
    "agent_not_completed",
    "audit_loadout_mismatch",
    "audit_guard_not_loaded",
    "pi_incomplete_output",
    "invalid_codex_oauth",
    "missing_provider_credential",
    "invalid_artifact_size_or_type",
    "audit_mutated_workspace",
    "owned_process_still_running",
    "checkout_receipt_failed",
  ];
  return known.includes(value) ? value : "unclassified_execution_failure";
}
const lifecycleKinds = [
  "queued",
  "started",
  "terminal",
  "cancelled",
  "owned_process",
  "restart_reconciliation",
  "explicit_cleanup",
  "source_reconciliation_required",
  "validated_report",
  "project_status_publication_failed",
  "progress",
];
const logBody = z.object({
  execution: z
    .enum([
      "queued",
      "running",
      "stopped",
      "cancelled",
      "timed_out",
      "crashed",
      "stop_unconfirmed",
    ])
    .optional(),
  agentOutcome: z
    .enum(["not_run", "completed", "errored", "aborted"])
    .optional(),
  taskOutcome: z.enum(["pending", "delivered", "failed", "blocked"]).optional(),
  verification: z.enum(["not_run", "partial", "failed"]).optional(),
  phase: progressSchema.shape.phase.optional(),
  role: progressSchema.shape.role,
  runId: progressSchema.shape.runId,
  activity: activitySchema.shape.kind.optional(),
  tool: activitySchema.shape.tool,
  activityCount: progressSchema.shape.activityCount.optional(),
});
export function publicLogEvent(row: Record<string, unknown>) {
  const kind = String(row.kind);
  const body = logBody.safeParse(JSON.parse(String(row.body)));
  return {
    seq: Number(row.seq),
    time: String(row.time),
    kind: lifecycleKinds.includes(kind) ? kind : "lifecycle_event",
    body: body.success ? body.data : {},
  };
}
