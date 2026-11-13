---
name: ui-audit
description: Review a component, screen, design system, implemented UI or user flow; supports a codebase-only first audit.
---
# UI audit
Input: worktree, exact commit, scope (component/screen/system/product/flow), product purpose, platform, approved direction, job ID, outputDir, and optional identified runtime/evidence.
1. Confirm the SHA and inspect onboarding sources, prior open findings and accepted decisions. Determine the inspected set and sampling before claiming coverage.
2. In codebase-only mode, inspect source/docs/tests without running setup, tests, app or network actions. Never modify the product, add Widgetbook, or publish. Propose fixes only.
3. Trace component reuse, semantic tokens, variants, inputs/events, composition, state handling, accessibility semantics, responsive/text scaling/localization behavior and realistic content. Verify documentation claims against code. Cite file:line and commit.
4. Request a fresh independent review using ui-evaluate. Pass only purpose, user task, platform, approved direction and neutral source/evidence references. Do not pass your draft findings, reasoning or self-rating. No forked implementation context. Reviewer returns its report; the lead persists it.
5. Distinguish source observations, historical evidence, measured current checks and subjective judgments. Code alone cannot establish rendered polish, contrast in all states, screen-reader behavior or native runtime correctness. Mark uninspectable dimensions N/A.
Output: <outputDir>/audit.md, sections: Commit/scope; Executive summary; Inventory and approved baseline; Prioritized findings; Independent evaluation; Proposed improvements; Inspected/sampled/not inspected; Verification and limitations. Findings: severity, evidence, user impact, recommendation and verification step. Priorities: blocker/high/medium/low. Preserve unresolved findings and label superseded findings on revision.
Also <outputDir>/result.json: jobId, reviewedCommit, taskOutcome, verification, reportPaths, blockingFindings, limitations. No agent assertion alone establishes verified success.
Whole-product and flow audits must name inspected screens/transitions, samples and remaining unknowns. Reports are job artifacts, not authoritative design-system copies.
Rules are advisory; a code audit is not a visual acceptance or integration pass.
