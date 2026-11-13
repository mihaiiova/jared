import { z } from "zod";
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const sourcePath = z
  .string()
  .max(240)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/)
  .refine(
    (p) =>
      p
        .split("/")
        .every((s) => s !== "." && s !== ".." && s !== "" && s !== ".git"),
    "unsafe source path",
  );
export const setupProjectSchema = z.strictObject({
  projectId: id,
  projectPath: z.string().min(1),
  platform: z.enum(["web", "flutter"]),
  purpose: z.string().min(1).max(4000),
  approvedDirection: z.string().max(4000),
  setupProfile: z.literal("source-only-v1"),
  designPaths: z.array(sourcePath).max(30),
});
export type Project = z.infer<typeof setupProjectSchema>;
export const submitSchema = z.strictObject({
  projectId: id,
  baseCommit: sha,
  kind: z.enum(["audit", "implement"]),
  request: z.string().min(1).max(8000),
  scope: z.enum(["component", "screen", "system", "product", "flow"]),
  idempotencyKey: z.string().min(1).max(120),
});
export const integrationSchema = z.strictObject({
  projectId: id,
  originalJobId: z.string().uuid(),
  integratedCommit: sha,
  request: z.string().min(1).max(8000),
  idempotencyKey: z.string().min(1).max(120),
});
export type Submission = z.infer<typeof submitSchema> & {
  originalJobId?: string;
};
export const jobSchema = z.strictObject({
  projectId: id,
  jobId: z.string().uuid(),
});
export const contextSchema = z.strictObject({
  projectId: id,
  commit: sha,
  path: sourcePath,
});
export const ackSchema = z.strictObject({
  projectId: id,
  jobId: z.string().uuid(),
  disposition: z.enum(["acknowledged", "abandoned"]),
});
export const agentReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.string().uuid(),
  reviewedCommit: sha,
  summary: z.string().min(1).max(12000),
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(["blocker", "high", "medium", "low"]),
        path: sourcePath,
        line: z.number().int().positive(),
        observation: z.string().min(1).max(4000),
        recommendation: z.string().max(4000),
      }),
    )
    .max(200),
  inspectedPaths: z.array(sourcePath).min(1).max(500),
  limitations: z.array(z.string().max(2000)).min(1).max(50),
  visualVerification: z.literal("not_run"),
});
export type AgentReport = z.infer<typeof agentReportSchema>;
export type Execution =
  | "queued"
  | "running"
  | "stopped"
  | "cancelled"
  | "timed_out"
  | "crashed"
  | "stop_unconfirmed";
export type Job = {
  jobId: string;
  projectId: string;
  callerId: string;
  submission: Submission;
  fingerprint: string;
  execution: Execution;
  agentOutcome: "not_run" | "completed" | "errored" | "aborted";
  taskOutcome: "pending" | "delivered" | "failed" | "blocked";
  verification: "not_run" | "partial" | "failed";
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  failurePhase?: string;
  diagnostic?: string;
  result?: Result;
  acknowledgement?: string;
  groups: GroupReceipt[];
};
export type GroupReceipt = { pid: number; start: string; boot: string };
export const resultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.string().uuid(),
  reviewedCommit: sha,
  actualCommit: sha,
  clean: z.literal(true),
  taskOutcome: z.literal("delivered"),
  verification: z.literal("partial"),
  sourceValidation: z.literal("passed"),
  visualVerification: z.literal("not_run"),
  coverage: z.literal("agent-reported paths, not exhaustive coverage"),
  lead: agentReportSchema,
  reviewer: agentReportSchema,
  provenance: z.strictObject({
    leadRun: z.string().uuid(),
    reviewerRun: z.string().uuid(),
    reviewerName: z.literal("ui-reviewer"),
    packetHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewerDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    evaluateSkillHash: z.string().regex(/^[a-f0-9]{64}$/),
    executor: z.enum(["fake", "pi-rpc"]),
  }),
  limitations: z.array(z.string()),
});
export type Result = z.infer<typeof resultSchema>;
export class ServiceError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new ServiceError(code);
}
