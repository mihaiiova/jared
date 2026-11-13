import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditService } from "./service.js";
import {
  setupProjectSchema,
  submitSchema,
  integrationSchema,
  jobSchema,
  contextSchema,
  ackSchema,
  ServiceError,
} from "./contracts.js";
export const guide = `Jared performs exact-local-commit source audits only, not code implementation or visual verification.
1. Get the caller's explicit canonical absolute Git root. Never infer it from the MCP process cwd.
2. setup_project({projectId:"product",projectPath:"/absolute/git/root",platform:"web",purpose:"Product purpose",approvedDirection:"Existing approved direction",setupProfile:"source-only-v1",designPaths:["README.md"]}). This WRITES .jared/config.json, .jared/.gitignore and .jared/runs, and registers the project. Disclose these writes before calling. Existing conflicts/symlinks are refused. Reuse the same projectId and projectPath to update metadata or recreate a removed .jared directory; partial/conflicting state may require operator repair. Changing the registered root is refused. Keep authoritative design knowledge in product-native files.
3. submit_job({projectId:"product",baseCommit:"<40 lowercase hex local commit>",kind:"audit",request:"Audit source accessibility",scope:"product",idempotencyKey:"audit-1"}). Unpushed commits work; dirty original files are excluded and preserved. Audits require operator-selected auth (jared setup); no auth is needed for discovery/setup_project.
4. Poll get_job({projectId:"product",jobId:"<returned UUID>"}); then get_result/get_report with the same route. Reports are at that project's .jared/runs/<jobId>. Audit findings are not execution failure. Visual verification is always not_run.
5. cancel_job uses the same project/job route. acknowledge_handoff additionally requires disposition:"acknowledged" or "abandoned"; only an explicit acknowledgement removes a clean stopped worktree, never reports or dirty work.
read_design_context requires projectId, exact commit and a registered design path. review_integration accepts projectId, originalJobId, integratedCommit, request and idempotencyKey; it is another read-only source review, not integration approval.
One installation supports multiple projects and simultaneous clients. Local clients have same-user operator authority, NOT multi-tenant isolation. Jobs survive client disconnect; interrupted worker jobs are marked crashed on restart, not replayed. Private source snapshots/evidence persist until explicit safe cleanup. Linux and experimental macOS; native macOS verification pending. Windows unsupported. On macOS, a hard worker crash may leave live orphan groups stop_unconfirmed; retained evidence is not cleaned up and stale PIDs are not signalled by a new owner. No setup commands, product source edits, browser, network Git, pushes, merges or deployment. Do not send secrets in requests.`;
export function createMcpServer(service: AuditService) {
  const server = new McpServer(
    { name: "jared", version: "0.2.0" },
    { instructions: guide },
  );
  const schemas = {
    get_jared_guide: z.strictObject({}),
    setup_project: setupProjectSchema,
    submit_job: submitSchema,
    get_job: jobSchema,
    get_result: jobSchema,
    get_report: jobSchema,
    cancel_job: jobSchema,
    review_integration: integrationSchema,
    acknowledge_handoff: ackSchema,
    read_design_context: contextSchema,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const readOnly = [
      "get_jared_guide",
      "get_job",
      "get_result",
      "get_report",
    ].includes(name);
    server.registerTool(
      name,
      {
        description:
          name === "setup_project"
            ? "WRITE: register explicit canonical local Git root or update its metadata; recreates a removed .jared directory, never overwrites conflicts or changes a registered root."
            : name === "get_jared_guide"
              ? "Read exact usage, project authority and source-only limitations before using Jared."
              : name === "submit_job"
                ? "Queue provider-backed source-only audit of an exact locally present commit (may incur cost); dirty files excluded. No implementation."
                : name.replaceAll("_", " "),
        inputSchema: schema as z.ZodType,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: name === "acknowledge_handoff",
          openWorldHint: ["submit_job", "review_integration"].includes(name),
        },
      },
      async (input) => {
        try {
          const output =
            name === "get_jared_guide"
              ? { guide }
              : await service.invoke(name, input);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
          };
        } catch (e) {
          const error =
            e instanceof ServiceError
              ? e.code
              : e instanceof z.ZodError
                ? "invalid_input"
                : "operation_failed";
          return {
            isError: true,
            content: [
              { type: "text" as const, text: JSON.stringify({ error }) },
            ],
          };
        }
      },
    );
  }
  return server;
}
