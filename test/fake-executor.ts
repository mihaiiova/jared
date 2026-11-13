import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../src/safety.js";
import type { AgentReport } from "../src/contracts.js";
import type { Executor, RunContext, RunOutput } from "../src/executor.js";
/** Test seam only: not selectable by the production entrypoint. */
export class FakeExecutor implements Executor {
  readonly kind = "fake" as const;
  readonly reviewerDefinitionHash = digest("fake-ui-reviewer");
  readonly evaluateSkillHash = digest("fake-ui-evaluate");
  constructor(
    private behavior?: (c: RunContext) => Promise<RunOutput | undefined>,
  ) {}
  async run(c: RunContext): Promise<RunOutput> {
    const custom = await this.behavior?.(c);
    if (custom) return custom;
    c.signal.throwIfAborted();
    const report: AgentReport = {
      schemaVersion: 1,
      jobId: c.packet.jobId,
      reviewedCommit: c.packet.reviewedCommit,
      summary: `Synthetic ${c.role} audit; no provider ran.`,
      findings: [],
      inspectedPaths: c.packet.designPaths.length
        ? c.packet.designPaths
        : ["README.md"],
      limitations: ["Synthetic executor, no visual inspection."],
      visualVerification: "not_run",
    };
    const reportPath = join(c.outputDir, "report.json");
    writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
    return { agentOutcome: "completed", reportPath };
  }
}
