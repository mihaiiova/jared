---
name: ui-integration-review
description: Review an exact integrated commit linked to a delivered UI task; do not confuse component delivery with integration success.
---
# Integration review
Input: originalJobId, original delivery/base SHAs, exact fetchable integratedCommit, dedicated review worktree, product/task/platform/direction, outputDir, optional identified preview plus commit provenance.
1. Confirm original task linkage and checkout SHA. Read API/events/variants/usage/misuse documentation and compare the integrated usage with the delivery.
2. Inspect composition, application-logic/event wiring, state handling, accessibility and preserved design decisions. Audit relevant cross-screen flows and realistic responsive/text/localization states.
3. Run approved reproducible checks/runtime if available. Establish preview-to-commit provenance; otherwise label preview evidence unverified. Do not treat prior component checks as integrated behavior proof.
4. Request fresh independent ui-evaluate review with neutral task/direction/evidence and no implementer narrative. Integration review is read-only; propose fixes rather than silently apply them.
Output: <outputDir>/integration-review.md: Original task/delivery; Reviewed integrated SHA; Inspected flows/components; Findings and integration misuses; Current evidence and independent evaluation; Unverified behavior; Acceptance and next actions.
Also <outputDir>/result.json: jobId, originalJobId, reviewedCommit, taskOutcome, verification, reportPaths, blockingFindings, limitations. Preserve prior reports; never replace original delivery evidence with integration claims.
Only explicit caller acknowledgement permits the host to clean up the original delivered worktree. These rules are advisory.
