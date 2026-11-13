---
name: ui-evaluate
description: Independently evaluate UI evidence or source against an approved direction with a consistent evidence-based rubric.
---
# Independent UI evaluation
Input: minimal fresh packet: product purpose, user task, platform, approved design direction, exact reviewedCommit, scope and neutral source/rendered/check evidence references. No implementer reasoning, draft findings, self-rating or persuasive explanation.
1. Confirm SHA/provenance and inspect evidence independently. Read relevant product sources/approved decisions, not implementation-session transcripts or self-review. Do not edit product files, run setup or request additional specialists.
2. Rate inspectable typography, hierarchy, spacing/density, color/contrast, iconography, consistency/polish, clarity, interaction/accessibility and overall quality.
3. Scale: 1 unusable; 2 major problems; 3 adequate; 4 strong; 5 exceptional. Each score requires concrete evidence and confidence. Use N/A with the missing evidence for aspects not inspectable. Never assign visual scores from code-only evidence. No overall visual score when rendered evidence is insufficient.
4. Separate measured checks (include method/result) from subjective judgments. Screenshots alone do not establish interaction, screen-reader support or native behavior. Source-derived token contrast is not proof for all rendered combinations.
5. Report blockers independently of scores: broken core task, serious accessibility issue, approved-contract violation or missing required verification. No average or high overall score overrides them.
Return report text only, sections: Reviewed commit/scope; Evidence and limitations; Score table (dimension, score/N/A, evidence, measured/judgment, confidence); Prioritized findings (severity, location, impact, action, recheck); Acceptance assessment (pass/fail/partial against supplied approved criteria). Lead/host saves it as <outputDir>/reviews/round-<n>.md.
In code-only audits assess source-backed risks and documentation consistency; visual acceptance is not assessable. Recommendations are advisory, never approval to change the product or release it.
